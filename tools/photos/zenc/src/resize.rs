// resize.rs — cap one dimension, keep the whole frame.
//
// `square` crops; this does not, and that difference is why the Instagram export
// could not just call it. Instagram's constraint is horizontal resolution, so a
// 4:5 portrait wants 1080x1350 and the cap belongs on ONE axis with the aspect
// preserved. Cropping there would throw away framing the photographer chose.
//
// A CAP RATHER THAN A TARGET: a source already inside the cap passes through
// unchanged rather than being enlarged. That is what export-for-instagram.sh
// wanted from `sips --resampleWidth` and had to spell as an if/else around two
// different sips calls; here it is the one meaning of the flag.
use crate::pixels::{load_linear, orient, parse_filter, parse_transfer, save, scale, Transfer};

pub fn run(args: &[String]) -> i32 {
    let (mut input, mut out, mut width, mut height): (Option<&str>, Option<&str>, Option<u32>, Option<u32>) =
        (None, None, None, None);
    let mut filter_arg: Option<&str> = Some("box");
    let mut transfer = Transfer::Auto;
    let mut exif: u8 = 1;
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--width" => { i += 1; width = args.get(i).and_then(|s| s.parse().ok()); if width.is_none() { return err("--width needs a positive number") } }
            "--height" => { i += 1; height = args.get(i).and_then(|s| s.parse().ok()); if height.is_none() { return err("--height needs a positive number") } }
            "--out" => { i += 1; match args.get(i) { Some(s) => out = Some(s), None => return err("--out needs a path") } }
            "--filter" => { i += 1; filter_arg = args.get(i).map(String::as_str) }
            // The source's curve, decode and encode both. g22 is the Monochrom's
            // Gray Gamma 2.2; see pixels.rs for why the caller decides.
            "--transfer" => {
                i += 1;
                match parse_transfer(args.get(i).map(String::as_str)) {
                    Ok(t) => transfer = t,
                    Err(e) => return err(&e),
                }
            }
            // EXIF orientation, applied by sample re-indexing before the cap is
            // interpreted — so --width caps the DISPLAYED width, matching what
            // the caller sees, and CLAUDE.md gotcha 3's account of this flag.
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
    let (Some(input), Some(out)) = (input, out) else {
        return err("usage: zenc resize <in> (--width N | --height N) --out <out.png> [--filter box|lanczos3|mitchell]");
    };
    if width.is_some() == height.is_some() {
        return err("give exactly one of --width or --height");
    }
    let filter = match parse_filter(filter_arg) { Ok(f) => f, Err(e) => return err(&e) };

    let src = match load_linear(input, transfer) { Ok(f) => f, Err(e) => return err(&e) };
    let src = orient(&src, exif);

    // Which axis is capped decides the other. Integer-rounded to nearest rather
    // than truncated, so a 3:2 frame does not lose a row to flooring.
    let (dw, dh) = match (width, height) {
        (Some(cap), None) => {
            if src.w <= cap { (src.w, src.h) }
            else { (cap, ((src.h as u64 * cap as u64 + src.w as u64 / 2) / src.w as u64).max(1) as u32) }
        }
        (None, Some(cap)) => {
            if src.h <= cap { (src.w, src.h) }
            else { (((src.w as u64 * cap as u64 + src.h as u64 / 2) / src.h as u64).max(1) as u32, cap) }
        }
        _ => unreachable!("checked above"),
    };

    // At or under the cap this is the identity case, and it is a real resample
    // rather than a copy on purpose: Box and Lanczos3 are interpolating, so
    // resampling to the same size returns the same samples (asserted in
    // resample.rs). Taking a shortcut here would be a second code path to keep
    // honest for no gain.
    let outf = scale(&src, dw, dh, filter);
    match save(&outf, out) { Ok(()) => 0, Err(e) => err(&e) }
}

fn err(msg: &str) -> i32 {
    eprintln!("zenc resize: {msg}");
    2
}
