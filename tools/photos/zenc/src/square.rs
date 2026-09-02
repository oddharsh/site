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
use crate::pixels::{crop, load_linear, orient, parse_transfer, save, scale, Transfer};
use halflight::Filter;

pub fn run(args: &[String]) -> i32 {
    let mut input: Option<&str> = None;
    let mut sizes: Vec<u32> = Vec::new();
    let mut outs: Vec<&str> = Vec::new();
    let mut filter = Filter::Lanczos3;
    let mut transfer = Transfer::Auto;
    let mut exif: u8 = 1;
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
                    Some(s) => outs.push(s),
                    None => return err("--out needs a path"),
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
                match args.get(i).and_then(|s| s.parse::<u8>().ok()) {
                    Some(n) if (1..=8).contains(&n) => exif = n,
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
    // will. For orientation 1 this is a straight copy.
    let src = orient(&src, exif);
    let (w, h) = (src.w, src.h);

    for (size, out) in sizes.iter().copied().zip(outs.iter()) {
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
        if let Err(e) = save(&cropped, out) {
            return err(&e);
        }
    }
    0
}

fn err(msg: &str) -> i32 {
    eprintln!("zenc square: {msg}");
    2
}
