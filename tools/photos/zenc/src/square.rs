// square.rs — the ingest step: decode once, orient, then every tier from the
// same linear-light frame.
//
// It grew from a single-size crop into the consolidation point on 2026-08-26,
// because the pipeline's defects were all seams BETWEEN tools: sips resampled
// in encoded sRGB before this ever saw the pixels, jpegtran's DCT rotation
// silently garbled non-MCU-aligned frames, the 400 and 200 tiers were resamples
// of the 600 tier rather than of the source, and a 10-bit HIF was quantised to
// 8 bits at the first step. One decode, oriented and resampled here, has none
// of those seams to get wrong.
//
//   zenc square in.tiff --orient 8 --transfer srgb --filter box \
//     --size 600 --out sq.png --size 400 --out sm.png --size 200 --out xs.png
//
// `--size N` starts a tier; --out, --avif-out and --jpeg-out select its outputs. `--orient` takes the EXIF value
// (1-8) and applies it as sample re-indexing, exact at any dimensions.
// `--transfer` names the SOURCE's curve (srgb, or g22 for the Monochrom's
// Gray Gamma 2.2) and is used for decode and encode both, so unaveraged values
// pass through exactly.
use crate::pixels::{crop, load_linear, orient, parse_transfer, encoded, scale, Frame, Orientation, TransferOption};
use halflight::Filter;
use std::path::Path;

/// The production geometry, shared with the benchmark front end.
pub fn tier(src: &Frame, size: u32, filter: Filter) -> image::DynamicImage {
    let (w, h) = (src.w, src.h);
    let (nw, nh) = if w <= h {
        (size, (h as u64 * size as u64).div_ceil(w as u64) as u32)
    } else {
        ((w as u64 * size as u64).div_ceil(h as u64) as u32, size)
    };
    let (cx, cy) = ((nw.saturating_sub(size)) / 2, (nh.saturating_sub(size)) / 2);
    let scaled = scale(src, nw, nh, filter);
    encoded(&crop(&scaled, cx, cy, size.min(nw), size.min(nh)))
}

#[derive(Default)]
struct Output<'a> {
    size: u32,
    png: Option<&'a str>,
    jpeg: Option<&'a str>,
    avif: Option<&'a str>,
}

pub fn run(args: &[String]) -> i32 {
    let mut input: Option<&str> = None;
    let mut outputs: Vec<Output<'_>> = Vec::new();
    let mut jpeg_quality: u8 = 84;
    let mut filter = Filter::Lanczos3;
    let mut transfer = TransferOption::Auto;
    let mut exif = Orientation::Upright;
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--size" => {
                i += 1;
                match args.get(i).and_then(|s| s.parse().ok()) {
                    Some(n) if n > 0 => outputs.push(Output { size: n, ..Output::default() }),
                    _ => return err("--size needs a positive number"),
                }
            }
            "--out" | "--jpeg-out" | "--avif-out" => {
                let option = args[i].as_str();
                i += 1;
                let (Some(paths), Some(path)) = (outputs.last_mut(), args.get(i)) else {
                    return err(&format!("{option} needs a path after --size"));
                };
                if path.starts_with("--") { return err(&format!("{option} needs a path")); }
                let slot = match option { "--out" => &mut paths.png, "--jpeg-out" => &mut paths.jpeg, _ => &mut paths.avif };
                if slot.is_some() { return err(&format!("{option} may occur only once per tier")); }
                *slot = Some(path);
            }
            "--jpeg-quality" => {
                i += 1;
                match args.get(i).and_then(|s| s.parse::<u8>().ok()) {
                    Some(q) if (1..=100).contains(&q) => jpeg_quality = q,
                    _ => return err("--jpeg-quality needs a number 1..100"),
                }
            }
            "--filter" => {
                i += 1;
                match crate::pixels::parse_filter(args.get(i).map(String::as_str)) {
                    Ok(f) => filter = f,
                    Err(e) => return err(&e),
                }
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
                match args.get(i).and_then(|s| s.parse::<u8>().ok()).and_then(|n| Orientation::try_from(n).ok()) {
                    Some(n) => exif = n,
                    _ => return err("--orient takes an EXIF orientation, 1-8"),
                }
            }
            other if input.is_none() => input = Some(other),
            other => return err(&format!("unexpected argument {other:?}")),
        }
        i += 1;
    }
    let Some(input) = input else {
        return err("usage: zenc square <in> --size <n> [--out <png>] [--avif-out <avif>] [--jpeg-out <jpg>] ... [--filter box|lanczos3|mitchell] [--orient 1-8] [--transfer srgb|g22]");
    };
    if outputs.is_empty() || outputs.iter().any(|paths| paths.png.is_none() && paths.jpeg.is_none() && paths.avif.is_none()) {
        return err("each --size needs --out, --jpeg-out, or --avif-out");
    }

    let src = match load_linear(input, transfer) {
        Ok(f) => f,
        Err(e) => return err(&e),
    };
    // Orient BEFORE the resample, so the crop math sees the frame the viewer
    // will. For orientation 1 the decoded buffer moves without copying.
    let src = orient(src, exif);
    for output in outputs {
        // Short edge lands on `size`. sips reaches the same crop from the long
        // edge, which is one more piece of arithmetic to get wrong.
        let pixels = tier(&src, output.size, filter);
        if let Some(path) = output.png {
            if let Err(e) = pixels.save(path) { return err(&format!("cannot write {path}: {e}")); }
        }
        if let Some(path) = output.avif {
            if let Err(e) = crate::avif::write(&pixels, Path::new(path)) { return err(&e); }
        }
        if let Some(path) = output.jpeg {
            let result = crate::jpeg::encode(&pixels, jpeg_quality, zenjpeg::encoder::ChromaSubsampling::Quarter)
                .and_then(|bytes| std::fs::write(path, bytes).map_err(|e| format!("cannot write {path}: {e}")));
            if let Err(e) = result { return err(&e); }
        }
    }
    0
}

fn err(msg: &str) -> i32 {
    eprintln!("zenc square: {msg}");
    2
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paired_jpeg_matches_encoding_the_png() {
        let root = std::env::temp_dir().join(format!("zenc-paired-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        for gray in [false, true] {
            let source = root.join("input.png");
            let png = root.join("tier.png");
            let jpg = root.join("tier.jpg");
            let image = image::RgbImage::from_fn(17, 23, |x, y| {
                let c = ((x * 13 + y * 7) % 256) as u8;
                image::Rgb(if gray { [c, c, c] } else { [c, c.wrapping_add(27), c.wrapping_mul(3)] })
            });
            image.save(&source).unwrap();
            let args: Vec<String> = ["square", source.to_str().unwrap(), "--size", "12", "--out", png.to_str().unwrap(), "--jpeg-out", jpg.to_str().unwrap(), "--orient", "6"].iter().map(|s| s.to_string()).collect();
            assert_eq!(run(&args[1..]), 0);
            let decoded = image::open(&png).unwrap();
            let expected = crate::jpeg::encode(&decoded, 84, zenjpeg::encoder::ChromaSubsampling::Quarter).unwrap();
            assert_eq!(std::fs::read(&jpg).unwrap(), expected);
        }
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn jpeg_options_fail_before_decoding() {
        for args in [
            vec!["missing.png", "--jpeg-out", "out.jpg"],
            vec!["missing.png", "--out", "out.png", "--jpeg-out"],
            vec!["missing.png", "--jpeg-quality", "0"],
            vec!["missing.png", "--jpeg-quality", "101"],
            vec!["missing.png", "--out", "out.png", "--jpeg-out", "one.jpg", "--jpeg-out", "two.jpg"],
            vec!["missing.png", "--size", "12"],
            vec!["missing.png", "--size", "12", "--avif-out"],
            vec!["missing.png", "--size", "12", "--avif-out", "one.avif", "--avif-out", "two.avif"],
        ] {
            assert_eq!(run(&args.into_iter().map(str::to_string).collect::<Vec<_>>()), 2);
        }
    }

    #[test]
    fn avif_tiers_match_the_installed_cli_for_gray_and_color() {
        let root = std::env::temp_dir().join(format!("zenc-avif-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        for gray in [false, true] {
            let source = root.join("input.png");
            let image = image::RgbImage::from_fn(17, 23, |x, y| {
                let c = ((x * 13 + y * 7) % 256) as u8;
                image::Rgb(if gray { [c; 3] } else { [c, c.wrapping_add(27), c.wrapping_mul(3)] })
            });
            image.save(&source).unwrap();
            for size in [12, 7] {
                let png = root.join("tier.png");
                let direct = root.join("direct.avif");
                let control = root.join("control.avif");
                let args: Vec<String> = [source.to_str().unwrap(), "--size", &size.to_string(),
                    "--out", png.to_str().unwrap(), "--avif-out", direct.to_str().unwrap(), "--orient", "6"]
                    .iter().map(|s| s.to_string()).collect();
                assert_eq!(run(&args), 0);
                let output = std::process::Command::new("avifenc").args([
                    "-q", "63", "-d", "10", "--ignore-icc", "--ignore-exif", "--ignore-xmp",
                    "--speed", "2", "--jobs", "4", "--yuv", if gray { "400" } else { "420" },
                    png.to_str().unwrap(), control.to_str().unwrap(),
                ]).output().expect("install avifenc alongside libavif to run the parity test");
                assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
                assert_eq!(std::fs::read(&direct).unwrap(), std::fs::read(&control).unwrap());
                // Exercise the production interface with no PNG destination.
                let jpeg = root.join("direct.jpg");
                let args: Vec<String> = [source.to_str().unwrap(), "--size", &size.to_string(),
                    "--avif-out", direct.to_str().unwrap(), "--jpeg-out", jpeg.to_str().unwrap(), "--orient", "6"]
                    .iter().map(|s| s.to_string()).collect();
                assert_eq!(run(&args), 0);
                assert_eq!(std::fs::read(&direct).unwrap(), std::fs::read(&control).unwrap());
                let expected = crate::jpeg::encode(&image::open(&png).unwrap(), 84, zenjpeg::encoder::ChromaSubsampling::Quarter).unwrap();
                assert_eq!(std::fs::read(&jpeg).unwrap(), expected);
            }
        }
        std::fs::remove_dir_all(root).unwrap();
    }
}
