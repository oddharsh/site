// square.rs — the geometry step: short edge to `size`, then the centre square.
//
// NOT WIRED INTO THE PIPELINE. add-photos.sh still runs the sips chain. This is
// a candidate for tools/photos/resample-probe.ts to judge, and the probe is what
// decides whether it ever replaces anything. Two earlier attempts were adopted
// in a branch before being measured and both were wrong; this one is measured
// first on purpose.
use crate::pixels::{crop, load_linear, save_srgb, scale};
use crate::resample::Filter;

pub fn run(args: &[String]) -> i32 {
    let (mut input, mut out): (Option<&str>, Option<&str>) = (None, None);
    let mut size: u32 = 600;
    let mut filter = Filter::Lanczos3;
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--size" => {
                i += 1;
                match args.get(i).and_then(|s| s.parse().ok()) {
                    Some(n) if n > 0 => size = n,
                    _ => return err("--size needs a positive number"),
                }
            }
            "--out" => {
                i += 1;
                match args.get(i) {
                    Some(s) => out = Some(s),
                    None => return err("--out needs a path"),
                }
            }
            "--filter" => {
                i += 1;
                filter = match args.get(i).map(String::as_str) {
                    Some("box") => Filter::Box,
                    Some("lanczos3") => Filter::Lanczos3,
                    Some("mitchell") => Filter::Mitchell,
                    other => return err(&format!("--filter wants box|lanczos3|mitchell, got {other:?}")),
                };
            }
            other if input.is_none() => input = Some(other),
            other => return err(&format!("unexpected argument {other:?}")),
        }
        i += 1;
    }
    let (Some(input), Some(out)) = (input, out) else {
        return err("usage: zenc square <in> --size <n> --out <out.png> [--filter box|lanczos3|mitchell]");
    };

    // Shared with `resize` through pixels.rs since 2026-08-25. It used to call
    // image::open and hand-roll the two colour-type arms, which was a second
    // copy of the one decision that is easy to get wrong (attempt 1 promoted
    // Luma8 to RGBA here and made a whole byte comparison meaningless). The
    // shared loader also lifts image's default allocation ceiling, so this can
    // now read a full-resolution TIFF; the old path answered "Memory limit
    // exceeded" on one.
    let src = match load_linear(input) { Ok(f) => f, Err(e) => return err(&e) };
    let (w, h) = (src.w, src.h);

    // Short edge lands on `size`. sips reaches the same crop from the long edge,
    // which is one more piece of arithmetic to get wrong.
    let (nw, nh) = if w <= h {
        (size, (h as u64 * size as u64).div_ceil(w as u64) as u32)
    } else {
        ((w as u64 * size as u64).div_ceil(h as u64) as u32, size)
    };
    let (cx, cy) = ((nw.saturating_sub(size)) / 2, (nh.saturating_sub(size)) / 2);

    let scaled = scale(&src, nw, nh, filter);
    let cropped = crop(&scaled, cx, cy, size.min(nw), size.min(nh));
    match save_srgb(&cropped, out) { Ok(()) => 0, Err(e) => err(&e) }
}

fn err(msg: &str) -> i32 {
    eprintln!("zenc square: {msg}");
    2
}
