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
// `--size N --out P` repeats, paired in order. `--orient` takes the EXIF value
// (1-8) and applies it as sample re-indexing, exact at any dimensions.
// `--transfer` names the SOURCE's curve (srgb, or g22 for the Monochrom's
// Gray Gamma 2.2) and is used for decode and encode both, so unaveraged values
// pass through exactly.
use crate::pixels::{crop, load_linear, orient, parse_transfer, encoded, scale, Orientation, TransferOption};
use halflight::Filter;

pub fn run(args: &[String]) -> i32 {
    let mut input: Option<&str> = None;
    let mut sizes: Vec<u32> = Vec::new();
    let mut outs: Vec<(&str, Option<&str>)> = Vec::new();
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
                    Some(n) if n > 0 => sizes.push(n),
                    _ => return err("--size needs a positive number"),
                }
            }
            "--out" => {
                i += 1;
                match args.get(i) {
                    Some(s) => outs.push((s, None)),
                    None => return err("--out needs a path"),
                }
            }
            "--jpeg-out" => {
                i += 1;
                match (outs.last_mut(), args.get(i)) {
                    (Some((_, jpeg @ None)), Some(path)) => *jpeg = Some(path),
                    _ => return err("--jpeg-out needs a path after --out, at most once per tier"),
                }
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
        return err("usage: zenc square <in> --size <n> --out <p> [--size <n> --out <p> ...] [--filter box|lanczos3|mitchell] [--orient 1-8] [--transfer srgb|g22]");
    };
    if sizes.is_empty() || sizes.len() != outs.len() {
        return err("give --size and --out in pairs, at least one pair");
    }

    let src = match load_linear(input, transfer) {
        Ok(f) => f,
        Err(e) => return err(&e),
    };
    // Orient BEFORE the resample, so the crop math sees the frame the viewer
    // will. For orientation 1 the decoded buffer moves without copying.
    let src = orient(src, exif);
    let (w, h) = (src.w, src.h);

    for (size, (out, jpeg_out)) in sizes.iter().copied().zip(outs.iter()) {
        // Short edge lands on `size`. sips reaches the same crop from the long
        // edge, which is one more piece of arithmetic to get wrong.
        let (nw, nh) = if w <= h {
            (size, (h as u64 * size as u64).div_ceil(w as u64) as u32)
        } else {
            ((w as u64 * size as u64).div_ceil(h as u64) as u32, size)
        };
        let (cx, cy) = ((nw.saturating_sub(size)) / 2, (nh.saturating_sub(size)) / 2);
        let scaled = scale(&src, nw, nh, filter);
        let cropped = crop(&scaled, cx, cy, size.min(nw), size.min(nh));
        let pixels = encoded(&cropped);
        if let Err(e) = pixels.save(out) {
            return err(&format!("cannot write {out}: {e}"));
        }
        if let Some(path) = jpeg_out {
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
        ] {
            assert_eq!(run(&args.into_iter().map(str::to_string).collect::<Vec<_>>()), 2);
        }
    }
}
