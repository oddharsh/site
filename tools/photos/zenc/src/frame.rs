// frame.rs — decode a source, orient it, optionally fit or crop it, and write
// the result as a plain frame: PNG, or the P6 PPM that mozjpeg's cjpeg reads.
//
//   zenc frame in.tiff --orient 8 --fit 1400 --out proxy.ppm
//   zenc frame in.tiff --orient 8 --crop 2200 1100 320 320 --out crop.png --out crop.ppm
//   zenc frame tile.jpg --out tile.png
//
// It exists for gen-pixel-peeper.ts, which replaced an 849-line Pillow script
// on 2026-09-15. Pillow did four pixel jobs there: decode with the EXIF
// orientation applied, a downscaled proxy to scan crop windows on, a native
// crop written as PNG and PPM, and JPEG decode for the metrics. Every one is a
// decode, an orient, a scale or a crop this crate already does for the
// thumbnail tiers, so this is the `square` path with the tier logic removed
// and a second output format added. The window SCORING stays in TypeScript,
// over the PPM bytes this writes, because it is arithmetic on a small proxy
// and belongs beside the byte-budget search that uses its answer.
//
// `--fit N` is Pillow's proxy rule, kept exactly so the scan geometry is the
// old script's: scale = min(1, N / max(w, h)), each dimension floored, never
// below 1, resampled with lanczos3 (Pillow's LANCZOS). The resample runs in
// linear light here where Pillow's ran in sRGB, which is the one deliberate
// difference: the proxy only ranks windows, and the set was regenerated.
//
// Prints `<oriented w> <oriented h> <written w> <written h>` to stdout, so the
// caller maps proxy coordinates back to the native frame without a second
// decode to learn the dimensions.
use crate::pixels::{
    crop, encoded, load_linear, orient, parse_transfer, save, scale, Orientation, TransferOption,
};
use halflight::Filter;
use std::io::Write;

pub fn run(args: &[String]) -> i32 {
    let mut input: Option<&str> = None;
    let mut outs: Vec<&str> = Vec::new();
    let mut transfer = TransferOption::Auto;
    let mut exif = Orientation::Upright;
    let mut fit: Option<u32> = None;
    let mut window: Option<(u32, u32, u32, u32)> = None;
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--out" => {
                i += 1;
                match args.get(i) {
                    Some(s) => outs.push(s),
                    None => return err("--out needs a path"),
                }
            }
            "--fit" => {
                i += 1;
                match args.get(i).and_then(|s| s.parse().ok()) {
                    Some(n) if n > 0 => fit = Some(n),
                    _ => return err("--fit needs a positive number"),
                }
            }
            "--crop" => {
                let nums: Vec<u32> = args
                    .iter()
                    .skip(i + 1)
                    .take(4)
                    .filter_map(|s| s.parse().ok())
                    .collect();
                if nums.len() != 4 || nums[2] == 0 || nums[3] == 0 {
                    return err("--crop needs x y w h, with w and h above zero");
                }
                window = Some((nums[0], nums[1], nums[2], nums[3]));
                i += 4;
            }
            "--transfer" => {
                i += 1;
                match parse_transfer(args.get(i).map(String::as_str)) {
                    Ok(t) => transfer = t,
                    Err(e) => return err(&e),
                }
            }
            "--orient" => {
                i += 1;
                match args
                    .get(i)
                    .and_then(|s| s.parse::<u8>().ok())
                    .and_then(|n| Orientation::try_from(n).ok())
                {
                    Some(o) => exif = o,
                    _ => return err("--orient takes an EXIF orientation, 1-8"),
                }
            }
            s if input.is_none() => input = Some(s),
            s => return err(&format!("unexpected argument: {s}")),
        }
        i += 1;
    }
    let Some(input) = input else {
        return err("usage: zenc frame <in> [--orient 1-8] [--transfer auto|srgb|g22] [--fit N | --crop x y w h] --out <p.png|p.ppm> [--out ...]");
    };
    if outs.is_empty() {
        return err("at least one --out is needed");
    }
    if fit.is_some() && window.is_some() {
        return err("--fit and --crop are two different jobs; ask for one");
    }
    for out in &outs {
        if !(out.ends_with(".png") || out.ends_with(".ppm")) {
            return err(&format!("--out writes .png or .ppm, got {out}"));
        }
    }

    let src = match load_linear(input, transfer) {
        Ok(f) => orient(f, exif),
        Err(e) => return err(&e),
    };
    let (nw, nh) = (src.w, src.h);
    let frame = if let Some(n) = fit {
        let s = f64::from(n) / f64::from(nw.max(nh));
        let s = if s < 1.0 { s } else { 1.0 };
        let fw = ((f64::from(nw) * s).floor() as u32).max(1);
        let fh = ((f64::from(nh) * s).floor() as u32).max(1);
        if (fw, fh) == (nw, nh) {
            src
        } else {
            scale(&src, fw, fh, Filter::Lanczos3)
        }
    } else if let Some((x, y, w, h)) = window {
        if x.saturating_add(w) > nw || y.saturating_add(h) > nh {
            return err(&format!(
                "--crop {x} {y} {w} {h} leaves the {nw}x{nh} frame"
            ));
        }
        crop(&src, x, y, w, h)
    } else {
        src
    };
    for out in &outs {
        let written = if out.ends_with(".ppm") {
            write_ppm(&frame, out)
        } else {
            save(&frame, out)
        };
        if let Err(e) = written {
            return err(&e);
        }
    }
    println!("{nw} {nh} {} {}", frame.w, frame.h);
    0
}

/// P6, binary, 8-bit, three channels, in the frame's encoded (sRGB or gamma
/// 2.2) values, which is exactly what `save` writes into a PNG. A gray frame
/// is written as three equal channels, since cjpeg reads P6 and the metrics
/// compare RGB.
fn write_ppm(f: &crate::pixels::Frame, path: &str) -> Result<(), String> {
    let rgb = encoded(f).into_rgb8();
    let mut file = std::fs::File::create(path).map_err(|e| format!("cannot write {path}: {e}"))?;
    write!(file, "P6\n{} {}\n255\n", rgb.width(), rgb.height())
        .map_err(|e| format!("cannot write {path}: {e}"))?;
    file.write_all(rgb.as_raw())
        .map_err(|e| format!("cannot write {path}: {e}"))
}

fn err(msg: &str) -> i32 {
    eprintln!("zenc frame: {msg}");
    2
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(name: &str) -> (std::path::PathBuf, std::path::PathBuf) {
        let root = std::env::temp_dir().join(format!("zenc-frame-{name}-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        let source = root.join("input.png");
        let image = image::RgbImage::from_fn(41, 29, |x, y| {
            let c = ((x * 13 + y * 7) % 256) as u8;
            image::Rgb([c, c.wrapping_add(27), c.wrapping_mul(3)])
        });
        image.save(&source).unwrap();
        (root, source)
    }
    fn argv(parts: &[&str]) -> Vec<String> {
        parts.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn ppm_carries_the_same_pixels_as_the_png() {
        let (root, source) = fixture("ppm");
        let png = root.join("crop.png");
        let ppm = root.join("crop.ppm");
        let args = argv(&[
            source.to_str().unwrap(),
            "--crop",
            "3",
            "5",
            "20",
            "10",
            "--out",
            png.to_str().unwrap(),
            "--out",
            ppm.to_str().unwrap(),
        ]);
        assert_eq!(run(&args), 0);
        let from_png = image::open(&png).unwrap().into_rgb8();
        let bytes = std::fs::read(&ppm).unwrap();
        let header = b"P6\n20 10\n255\n";
        assert_eq!(&bytes[..header.len()], header);
        assert_eq!(&bytes[header.len()..], from_png.as_raw().as_slice());
        // and the crop is the crop: pixel (0,0) of the tile is (3,5) of the source
        let src = image::open(&source).unwrap().into_rgb8();
        assert_eq!(from_png.get_pixel(0, 0), src.get_pixel(3, 5));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn fit_uses_pillows_proxy_rule_and_prints_both_sizes() {
        let (root, source) = fixture("fit");
        let out = root.join("proxy.ppm");
        // 41x29 fit to 20: scale = 20/41, floor(41*s)=20, floor(29*s)=14
        let args = argv(&[
            source.to_str().unwrap(),
            "--fit",
            "20",
            "--out",
            out.to_str().unwrap(),
        ]);
        assert_eq!(run(&args), 0);
        let bytes = std::fs::read(&out).unwrap();
        assert!(bytes.starts_with(b"P6\n20 14\n255\n"));
        // a fit LARGER than the frame is the identity, never an upscale
        let same = root.join("same.png");
        let args = argv(&[
            source.to_str().unwrap(),
            "--fit",
            "500",
            "--out",
            same.to_str().unwrap(),
        ]);
        assert_eq!(run(&args), 0);
        assert_eq!(
            image::open(&same).unwrap().into_rgb8().dimensions(),
            (41, 29)
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn orient_applies_before_fit_and_crop() {
        let (root, source) = fixture("orient");
        let out = root.join("rot.png");
        // orientation 6 is a 90 degree turn, so 41x29 becomes 29x41
        let args = argv(&[
            source.to_str().unwrap(),
            "--orient",
            "6",
            "--out",
            out.to_str().unwrap(),
        ]);
        assert_eq!(run(&args), 0);
        assert_eq!(
            image::open(&out).unwrap().into_rgb8().dimensions(),
            (29, 41)
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn refusals_happen_before_any_decode() {
        for args in [
            vec!["missing.png"],
            vec!["missing.png", "--out", "x.png", "--fit", "0"],
            vec![
                "missing.png",
                "--out",
                "x.png",
                "--crop",
                "1",
                "2",
                "0",
                "4",
            ],
            vec![
                "missing.png",
                "--out",
                "x.png",
                "--fit",
                "9",
                "--crop",
                "1",
                "1",
                "1",
                "1",
            ],
            vec!["missing.png", "--out", "x.tiff"],
            vec!["missing.png", "--out", "x.png", "--orient", "9"],
        ] {
            assert_eq!(run(&argv(&args)), 2, "{args:?}");
        }
        // a crop that leaves the frame is refused after the decode, by name
        let (root, source) = fixture("bounds");
        let args = argv(&[
            source.to_str().unwrap(),
            "--crop",
            "40",
            "0",
            "5",
            "5",
            "--out",
            root.join("x.png").to_str().unwrap(),
        ]);
        assert_eq!(run(&args), 2);
        std::fs::remove_dir_all(root).unwrap();
    }
}
