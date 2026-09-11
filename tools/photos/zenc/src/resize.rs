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
use crate::pixels::{load_linear, orient, parse_filter, parse_transfer, save, scale, Orientation, TransferOption};

pub fn run(args: &[String]) -> i32 {
    let (mut input, mut out, mut width, mut height): (Option<&str>, Option<&str>, Option<u32>, Option<u32>) =
        (None, None, None, None);
    let mut filter_arg: Option<&str> = Some("box");
    let mut transfer = TransferOption::Auto;
    let mut exif = Orientation::Upright;
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
    let (Some(input), Some(out)) = (input, out) else {
        return err("usage: zenc resize <in> (--width N | --height N) --out <out.png> [--filter box|lanczos3|mitchell]");
    };
    if width.is_some() == height.is_some() {
        return err("give exactly one of --width or --height");
    }
    let filter = match parse_filter(filter_arg) { Ok(f) => f, Err(e) => return err(&e) };

    let src = match load_linear(input, transfer) { Ok(f) => f, Err(e) => return err(&e) };
    let src = orient(src, exif);

    let (dw, dh) = capped(src.w, src.h, width, height);

    // At or under the cap this is the identity case, and it is a real resample
    // rather than a copy on purpose: Box and Lanczos3 are interpolating, so
    // resampling to the same size returns the same samples (asserted in
    // resample.rs). Taking a shortcut here would be a second code path to keep
    // honest for no gain.
    let outf = scale(&src, dw, dh, filter);
    match save(&outf, out) { Ok(()) => 0, Err(e) => err(&e) }
}

/// The output size for a source of `w` x `h` under exactly one of the two caps.
///
/// Split out of `run` so it is checkable without touching a file. This is the
/// whole of this command's arithmetic and the half that can be wrong silently:
/// a source is still written, at dimensions nobody looked at.
///
/// Three properties the tests pin. A source at or under the cap passes through
/// UNCHANGED rather than being enlarged, which is the one meaning of the flag
/// (see the header). The free axis is rounded to NEAREST rather than truncated,
/// so a 3:2 frame does not lose a row to flooring. And it never returns a zero
/// dimension, which an extreme aspect ratio reaches by division alone.
///
/// Panics if both caps or neither are given. `run` rejects that before calling.
pub(crate) fn capped(w: u32, h: u32, width: Option<u32>, height: Option<u32>) -> (u32, u32) {
    match (width, height) {
        (Some(cap), None) => {
            if w <= cap { (w, h) }
            else { (cap, ((h as u64 * cap as u64 + w as u64 / 2) / w as u64).max(1) as u32) }
        }
        (None, Some(cap)) => {
            if h <= cap { (w, h) }
            else { (((w as u64 * cap as u64 + h as u64 / 2) / h as u64).max(1) as u32, cap) }
        }
        _ => unreachable!("run checks that exactly one cap is given"),
    }
}

fn err(msg: &str) -> i32 {
    eprintln!("zenc resize: {msg}");
    2
}

#[cfg(test)]
mod tests {
    use super::capped;

    /// A source at or under the cap is left alone. `sips --resampleWidth`
    /// enlarges instead, which is the behaviour export-for-instagram.sh had to
    /// spell as an if/else around two calls, and the reason this is a cap.
    #[test]
    fn a_source_inside_the_cap_passes_through_untouched() {
        assert_eq!(capped(800, 600, Some(1080), None), (800, 600));
        assert_eq!(capped(1080, 810, Some(1080), None), (1080, 810), "exactly at the cap is inside it");
        assert_eq!(capped(600, 800, None, Some(1350)), (600, 800));
        assert_eq!(capped(1080, 1350, None, Some(1350)), (1080, 1350));
    }

    /// The free axis rounds to NEAREST. Truncating is the reflexive way to
    /// write this and silently drops a row on most 3:2 frames, which is
    /// invisible in the output file and reads as a one-pixel aspect drift.
    #[test]
    fn the_free_axis_rounds_to_nearest_rather_than_flooring() {
        // 6000x4000 to width 1081: 4000*1081/6000 = 720.67, so 721 not 720.
        assert_eq!(capped(6000, 4000, Some(1081), None), (1081, 721));
        // The same fraction on the other axis, so an axis swap cannot pass.
        assert_eq!(capped(4000, 6000, None, Some(1081)), (721, 1081));
        // And a case where flooring and rounding agree, so the two above are
        // pinning the rounding rather than an arithmetic accident.
        assert_eq!(capped(6000, 4000, Some(1500), None), (1500, 1000));
    }

    /// Division alone reaches zero on an extreme aspect ratio, and a zero
    /// dimension is a panic several frames later rather than an error here.
    #[test]
    fn no_cap_can_produce_a_zero_dimension() {
        assert_eq!(capped(10_000, 3, Some(10), None), (10, 1));
        assert_eq!(capped(3, 10_000, None, Some(10)), (1, 10));
    }

    /// The aspect ratio survives the cap to within the rounding pinned above.
    /// Checked over a spread rather than at one point, because a sign error or
    /// an axis swap is exactly the bug a single hand-picked case passes.
    #[test]
    fn the_aspect_ratio_survives_both_axes() {
        for (w, h) in [(6000u32, 4000u32), (4000, 6000), (5976, 3992), (1, 9999), (9999, 1), (4032, 3024)] {
            for cap in [1u32, 7, 320, 1080, 2048] {
                let (dw, dh) = capped(w, h, Some(cap), None);
                assert!(dw >= 1 && dh >= 1, "{w}x{h} capped to width {cap} gave {dw}x{dh}");
                assert!(dw <= w.max(cap), "capping cannot enlarge the capped axis");
                if w > cap {
                    let want = h as f64 * cap as f64 / w as f64;
                    if want < 0.5 {
                        // Below half a pixel the CLAMP is the answer and it
                        // overrides the ratio on purpose. Asserting the ratio
                        // here would be asserting against the clamp.
                        assert_eq!(dh, 1, "{w}x{h} to width {cap} wants {want} rows, which must clamp to 1");
                    } else {
                        assert!((dh as f64 - want).abs() <= 0.5 + f64::EPSILON,
                            "{w}x{h} to width {cap}: free axis {dh} is more than half a pixel from {want}");
                    }
                }
            }
        }
    }
}
