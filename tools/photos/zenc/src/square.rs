// square.rs — the geometry step: short edge to `size`, then the centre square.
//
// NOT WIRED INTO THE PIPELINE. add-photos.sh still runs the sips chain. This is
// a candidate for tools/photos/resample-probe.ts to judge, and the probe is what
// decides whether it ever replaces anything. Two earlier attempts were adopted
// in a branch before being measured and both were wrong; this one is measured
// first on purpose.
use crate::resample::{linear_to_srgb, resample, srgb_to_linear, Filter};
use image::{DynamicImage, GrayImage, ImageBuffer, Luma, Rgb, RgbImage};
use std::path::Path;

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

    let img = match image::open(Path::new(input)) {
        Ok(i) => i,
        Err(e) => return err(&format!("cannot read {input}: {e}")),
    };
    let (w, h) = (img.width(), img.height());
    if w == 0 || h == 0 {
        return err("source has a zero dimension");
    }
    // Short edge lands on `size`. sips reaches the same crop from the long edge,
    // which is one more piece of arithmetic to get wrong.
    let (nw, nh) = if w <= h {
        (size, (h as u64 * size as u64).div_ceil(w as u64) as u32)
    } else {
        ((w as u64 * size as u64).div_ceil(h as u64) as u32, size)
    };
    let (cx, cy) = ((nw.saturating_sub(size)) / 2, (nh.saturating_sub(size)) / 2);

    // COLOUR TYPE IS PRESERVED. A grayscale frame stays one channel end to end.
    // Attempt 1 promoted Luma8 to RGBA here and the resulting byte comparison
    // was meaningless, which took a while to notice.
    let saved = match img {
        DynamicImage::ImageLuma8(g) => {
            let lin: Vec<f32> = g.pixels().map(|p| srgb_to_linear(p[0])).collect();
            let rs = resample(&lin, w as usize, h as usize, 1, nw as usize, nh as usize, filter);
            let full: GrayImage = ImageBuffer::from_fn(nw, nh, |x, y| {
                Luma([linear_to_srgb(rs[y as usize * nw as usize + x as usize])])
            });
            image::imageops::crop_imm(&full, cx, cy, size, size).to_image().save(Path::new(out))
        }
        other => {
            let rgb = other.to_rgb8();
            let mut lin = Vec::with_capacity((w * h * 3) as usize);
            for p in rgb.pixels() {
                lin.push(srgb_to_linear(p[0]));
                lin.push(srgb_to_linear(p[1]));
                lin.push(srgb_to_linear(p[2]));
            }
            let rs = resample(&lin, w as usize, h as usize, 3, nw as usize, nh as usize, filter);
            let full: RgbImage = ImageBuffer::from_fn(nw, nh, |x, y| {
                let i = (y as usize * nw as usize + x as usize) * 3;
                Rgb([linear_to_srgb(rs[i]), linear_to_srgb(rs[i + 1]), linear_to_srgb(rs[i + 2])])
            });
            image::imageops::crop_imm(&full, cx, cy, size, size).to_image().save(Path::new(out))
        }
    };
    match saved {
        Ok(()) => 0,
        Err(e) => err(&format!("cannot write {out}: {e}")),
    }
}

fn err(msg: &str) -> i32 {
    eprintln!("zenc square: {msg}");
    2
}
