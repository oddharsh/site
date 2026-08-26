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
use crate::pixels::{load_linear, orient, parse_filter, parse_orient, save_srgb, scale};

pub fn run(args: &[String]) -> i32 {
    let (mut input, mut out, mut width, mut height): (Option<&str>, Option<&str>, Option<u32>, Option<u32>) =
        (None, None, None, None);
    let mut filter_arg: Option<&str> = Some("box");
    let mut ori: u8 = 1;
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--width" => { i += 1; width = args.get(i).and_then(|s| s.parse().ok()); if width.is_none() { return err("--width needs a positive number") } }
            "--height" => { i += 1; height = args.get(i).and_then(|s| s.parse().ok()); if height.is_none() { return err("--height needs a positive number") } }
            "--out" => { i += 1; match args.get(i) { Some(s) => out = Some(s), None => return err("--out needs a path") } }
            "--filter" => { i += 1; filter_arg = args.get(i).map(String::as_str) }
            "--orient" => { i += 1; ori = match parse_orient(args.get(i).map(String::as_str)) { Ok(o) => o, Err(e) => return err(&e) } }
            other if input.is_none() => input = Some(other),
            other => return err(&format!("unexpected argument {other:?}")),
        }
        i += 1;
    }
    let (Some(input), Some(out)) = (input, out) else {
        return err("usage: zenc resize <in> (--width N | --height N) --out <out.png> [--filter box|lanczos3|mitchell] [--orient 1..8]");
    };
    if width.is_some() == height.is_some() {
        return err("give exactly one of --width or --height");
    }
    let filter = match parse_filter(filter_arg) { Ok(f) => f, Err(e) => return err(&e) };

    let src = match load_linear(input) { Ok(f) => f, Err(e) => return err(&e) };
    // EXIF orientation first, so the cap below applies to the DISPLAYED axis.
    // A caller capping the delivered width of an Orientation 5-8 frame no
    // longer has to swap the axis itself (export-for-instagram.sh does that
    // dance today against the stored dims; with --orient it would not).
    // Skipped at 1 so an orient-less call is byte-identical to before.
    let src = if ori != 1 { orient(&src, ori) } else { src };

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
    match save_srgb(&outf, out) { Ok(()) => 0, Err(e) => err(&e) }
}

fn err(msg: &str) -> i32 {
    eprintln!("zenc resize: {msg}");
    2
}
