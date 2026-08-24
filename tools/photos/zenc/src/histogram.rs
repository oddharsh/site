// histogram.rs — the 64-bin RGB + luminance bake that rides in each per-photo
// meta file (public/images/meta/<stem>.json) under "hi".
//
// Ported from photo-histograms.py on 2026-08-14, which retired Pillow and with
// it the whole python3 + pip prerequisite of the photo pipeline. The port has to
// be BYTE-IDENTICAL against 158 committed meta files, because add-photos.sh
// re-bakes the entire library on every add and calls the no-op diff its
// idempotence check. Three things had to match exactly, and two of them are not
// what you would write from scratch:
//
//   1. LUMINANCE is Pillow's 16-bit fixed-point ITU-R 601-2, NOT the /1000 form
//      the docstring's "ITU-R 601-2" wording suggests:
//          L = (R*19595 + G*38470 + B*7471 + 0x8000) >> 16
//      Measured against Pillow 12.2.0 over one 360,000-pixel photo: this form
//      mismatches 0 pixels, `(R*299 + G*587 + B*114) / 1000` mismatches 169,740.
//
//   2. NORMALISATION rounds HALF TO EVEN, because the python was `int(round(x))`
//      and python 3's round() is banker's. `round_ties_even`, never `round`.
//      100*b/peak lands exactly on .5 often enough to matter at 64 bins.
//
//   3. The JSON is `json.dumps(separators=(",", ":"))` plus a trailing newline,
//      with existing keys left in their original ORDER (python dicts preserve
//      insertion order, and assigning an existing key keeps its position). Hence
//      serde_json's preserve_order. ensure_ascii is handled at the end.
//
// The decoders are NOT bit-identical, and that is fine and measured rather than
// assumed: zune-jpeg (image 0.25) and libjpeg-turbo (Pillow) disagree on roughly
// 0.07% of pixels by one level. 256 -> 64 binning plus normalisation to 0..100
// absorbs it. `--check` is what proves that per photo, and it is the mode to
// reach for if a future image/zune-jpeg bump is suspected of moving a bar.
use std::collections::BTreeMap;
use std::fmt::Write as _;
use std::path::{Path, PathBuf};

const BINS: usize = 64;

/// Pillow's RGB->L, exactly. See note 1 above.
#[inline]
fn luma(r: u8, g: u8, b: u8) -> usize {
    ((r as u32 * 19595 + g as u32 * 38470 + b as u32 * 7471 + 0x8000) >> 16) as usize
}

/// A 256-entry channel count -> 64 bins, each normalised so the tallest reads 100.
fn bin_normalize(raw: &[u32; 256]) -> Vec<i64> {
    let size = 256 / BINS;
    let binned: Vec<u32> = (0..BINS)
        .map(|i| raw[i * size..(i + 1) * size].iter().sum())
        .collect();
    let peak = binned.iter().copied().max().unwrap_or(0).max(1);
    binned
        .iter()
        // round_ties_even, not round: python's round() is banker's (note 2).
        .map(|&b| ((100.0 * b as f64) / peak as f64).round_ties_even() as i64)
        .collect()
}

/// The four channels for one already-decoded image.
fn channels(img: &image::RgbImage) -> BTreeMap<&'static str, Vec<i64>> {
    let (mut r, mut g, mut b, mut l) = ([0u32; 256], [0u32; 256], [0u32; 256], [0u32; 256]);
    for p in img.pixels() {
        let (pr, pg, pb) = (p.0[0], p.0[1], p.0[2]);
        r[pr as usize] += 1;
        g[pg as usize] += 1;
        b[pb as usize] += 1;
        l[luma(pr, pg, pb)] += 1;
    }
    // BTreeMap sorts to b, g, l, r; the emitted order is fixed explicitly below.
    let mut out = BTreeMap::new();
    out.insert("l", bin_normalize(&l));
    out.insert("r", bin_normalize(&r));
    out.insert("g", bin_normalize(&g));
    out.insert("b", bin_normalize(&b));
    out
}

/// json.dumps(..., ensure_ascii=True). Every JSON structural byte is ASCII, so
/// any char above 127 in a serialised document is necessarily inside a string
/// literal and can be escaped without parsing. Astral chars become a surrogate
/// pair, which is what python emits.
fn ensure_ascii(s: &str) -> String {
    if s.is_ascii() {
        return s.to_string();
    }
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        if c.is_ascii() {
            out.push(c);
        } else {
            let mut buf = [0u16; 2];
            for unit in c.encode_utf16(&mut buf) {
                let _ = write!(out, "\\u{unit:04x}");
            }
        }
    }
    out
}

/// The "hi" object, in the l/r/g/b order photo-histograms.py emitted.
fn hi_value(img: &image::RgbImage) -> serde_json::Value {
    let ch = channels(img);
    let mut map = serde_json::Map::new();
    for key in ["l", "r", "g", "b"] {
        map.insert(
            key.to_string(),
            serde_json::Value::Array(
                ch[key].iter().map(|&v| serde_json::Value::from(v)).collect(),
            ),
        );
    }
    serde_json::Value::Object(map)
}

struct Paths {
    images: PathBuf,
    hashed: PathBuf,
    meta: PathBuf,
}

pub fn run(args: &[String]) -> i32 {
    let (mut root, mut check, mut stems) = (None::<PathBuf>, false, Vec::<String>::new());
    let mut raw = false;
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--root" => {
                i += 1;
                match args.get(i) {
                    Some(v) => root = Some(PathBuf::from(v)),
                    None => {
                        eprintln!("zenc histogram: --root needs a path");
                        return 2;
                    }
                }
            }
            "--check" => check = true,
            // Diagnosis only: the 256-entry counts straight off the decoder,
            // before binning. This is what isolates a decoder difference from an
            // arithmetic one, which is the question any future image-crate bump
            // will raise. Not used by the pipeline.
            "--raw" => raw = true,
            "-h" | "--help" => {
                println!("usage: zenc histogram --root <www-dir> [--check] [STEM...]");
                println!("bakes 64-bin RGB+luma histograms into images/meta/<stem>.json under \"hi\".");
                println!("--check compares against what is on disk and writes nothing.");
                return 0;
            }
            s if s.starts_with('-') => {
                eprintln!("zenc histogram: unexpected flag {s}");
                return 2;
            }
            s => stems.push(s.to_string()),
        }
        i += 1;
    }
    let Some(root) = root else {
        eprintln!("zenc histogram: --root <www-dir> is required");
        return 2;
    };
    let p = Paths {
        images: root.join("images"),
        hashed: root.join("i"),
        meta: root.join("images").join("meta"),
    };

    let hashes_path = p.images.join("hashes.json");
    let hashes: serde_json::Value = match std::fs::read_to_string(&hashes_path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
    {
        Some(v) => v,
        None => {
            eprintln!("zenc histogram: cannot read {}", hashes_path.display());
            return 2;
        }
    };
    let Some(hash_map) = hashes.as_object() else {
        eprintln!("zenc histogram: hashes.json is not an object");
        return 2;
    };

    if stems.is_empty() {
        stems = hash_map.keys().cloned().collect();
        stems.sort();
    }
    if !check {
        let _ = std::fs::create_dir_all(&p.meta);
    }

    let (mut done, mut failed, mut drift) = (0usize, 0usize, Vec::<String>::new());
    for stem in &stems {
        let Some(j) = hash_map.get(stem).and_then(|h| h.get("j")).and_then(|v| v.as_str()) else {
            eprintln!("warn: {stem}: no hashed JPG in hashes.json, skipped");
            failed += 1;
            continue;
        };
        let jpg = p.hashed.join(format!("{stem}.{j}.jpg"));
        if !jpg.exists() {
            eprintln!(
                "warn: {stem}: {} missing, skipped",
                jpg.file_name().unwrap_or_default().to_string_lossy()
            );
            failed += 1;
            continue;
        }
        let img = match image::open(&jpg) {
            Ok(i) => i.to_rgb8(),
            Err(e) => {
                eprintln!("warn: {stem}: {e}");
                failed += 1;
                continue;
            }
        };
        if raw {
            let (mut r, mut g, mut b, mut l) = ([0u32; 256], [0u32; 256], [0u32; 256], [0u32; 256]);
            for px in img.pixels() {
                let (pr, pg, pb) = (px.0[0], px.0[1], px.0[2]);
                r[pr as usize] += 1;
                g[pg as usize] += 1;
                b[pb as usize] += 1;
                l[luma(pr, pg, pb)] += 1;
            }
            for (name, arr) in [("l", &l), ("r", &r), ("g", &g), ("b", &b)] {
                let joined: Vec<String> = arr.iter().map(|v| v.to_string()).collect();
                println!("{stem} {name} {}", joined.join(","));
            }
            done += 1;
            continue;
        }
        let hi = hi_value(&img);

        let meta_path = p.meta.join(format!("{stem}.json"));
        let existing = std::fs::read_to_string(&meta_path).unwrap_or_default();
        // A meta file that will not parse is replaced, matching the python's
        // `except: meta = {}`.
        let mut meta: serde_json::Value = serde_json::from_str(&existing)
            .unwrap_or_else(|_| serde_json::Value::Object(serde_json::Map::new()));
        if !meta.is_object() {
            meta = serde_json::Value::Object(serde_json::Map::new());
        }
        // preserve_order means an existing "hi" keeps its position and a new one
        // lands last, which is what assigning into a python dict does.
        meta.as_object_mut()
            .expect("object")
            .insert("hi".to_string(), hi);

        let mut text = ensure_ascii(&serde_json::to_string(&meta).expect("serialise"));
        text.push('\n');

        if check {
            if text != existing {
                drift.push(stem.clone());
            }
            done += 1;
            continue;
        }
        if text == existing {
            done += 1;
            continue;
        }
        if let Err(e) = write_atomic(&meta_path, text.as_bytes()) {
            eprintln!("warn: {stem}: {e}");
            failed += 1;
            continue;
        }
        done += 1;
    }

    if check {
        if drift.is_empty() {
            eprintln!("histograms match on disk for {done} photos");
            return 0;
        }
        eprintln!("histogram DRIFT in {} of {done}: {}", drift.len(), drift.join(", "));
        return 1;
    }
    eprint!("baked histograms into {done} meta files");
    if failed > 0 {
        eprint!(", {failed} skipped");
    }
    eprintln!();
    if failed > 0 { 1 } else { 0 }
}

fn write_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, bytes)?;
    std::fs::rename(&tmp, path)
}
