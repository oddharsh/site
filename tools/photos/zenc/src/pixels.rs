// pixels.rs — the I/O half of a resample: decode to linear light, encode back.
//
// Extracted because `square` and `resize` are the same operation wearing
// different geometry, and the part that is easy to get wrong is shared: which
// colour type survives, and whether the average is taken over light. Attempt 1
// at the square crop promoted a grayscale JPEG to RGBA and the resulting byte
// comparison was meaningless, so this is the one place that decision lives.
use crate::resample::{linear_to_srgb, resample, srgb_to_linear, Filter};
use image::{DynamicImage, GrayImage, ImageBuffer, ImageReader, Luma, Rgb, RgbImage};
use std::path::Path;

pub struct Frame {
    pub w: u32,
    pub h: u32,
    /// Linear-light samples, interleaved, 1 or 3 channels.
    pub data: Vec<f32>,
    /// One channel in, one channel out. Preserved end to end.
    pub gray: bool,
}

pub fn load_linear(path: &str) -> Result<Frame, String> {
    // `image::open` applies a default allocation ceiling that a full-resolution
    // intermediate blows straight through: sips writes a 7728x5152 HIF as a
    // 311MB 16-bit TIFF, and the decode is refused with "Memory limit exceeded"
    // rather than with anything naming a size. The ceiling is there to stop a
    // hostile file from exhausting memory, which is not the threat model for a
    // temp file this pipeline just wrote itself, so it is lifted explicitly
    // rather than raised to a number that would need revisiting per camera.
    let mut r = ImageReader::open(Path::new(path))
        .map_err(|e| format!("cannot read {path}: {e}"))?
        .with_guessed_format()
        .map_err(|e| format!("cannot read {path}: {e}"))?;
    r.no_limits();
    let img = r.decode().map_err(|e| format!("cannot decode {path}: {e}"))?;
    let (w, h) = (img.width(), img.height());
    if w == 0 || h == 0 {
        return Err("source has a zero dimension".into());
    }
    Ok(match img {
        DynamicImage::ImageLuma8(g) => Frame {
            w, h, gray: true,
            data: g.pixels().map(|p| srgb_to_linear(p[0])).collect(),
        },
        other => {
            let rgb = other.to_rgb8();
            let mut data = Vec::with_capacity((w * h * 3) as usize);
            for p in rgb.pixels() {
                data.push(srgb_to_linear(p[0]));
                data.push(srgb_to_linear(p[1]));
                data.push(srgb_to_linear(p[2]));
            }
            Frame { w, h, gray: false, data }
        }
    })
}

/// Resample to an exact size, still in linear light.
pub fn scale(f: &Frame, dw: u32, dh: u32, filter: Filter) -> Frame {
    let ch = if f.gray { 1 } else { 3 };
    Frame {
        w: dw,
        h: dh,
        gray: f.gray,
        data: resample(&f.data, f.w as usize, f.h as usize, ch, dw as usize, dh as usize, filter),
    }
}

pub fn save_srgb(f: &Frame, path: &str) -> Result<(), String> {
    let r = if f.gray {
        let out: GrayImage = ImageBuffer::from_fn(f.w, f.h, |x, y| {
            Luma([linear_to_srgb(f.data[y as usize * f.w as usize + x as usize])])
        });
        out.save(Path::new(path))
    } else {
        let out: RgbImage = ImageBuffer::from_fn(f.w, f.h, |x, y| {
            let i = (y as usize * f.w as usize + x as usize) * 3;
            Rgb([linear_to_srgb(f.data[i]), linear_to_srgb(f.data[i + 1]), linear_to_srgb(f.data[i + 2])])
        });
        out.save(Path::new(path))
    };
    r.map_err(|e| format!("cannot write {path}: {e}"))
}

pub fn parse_filter(s: Option<&str>) -> Result<Filter, String> {
    match s {
        Some("box") => Ok(Filter::Box),
        Some("lanczos3") => Ok(Filter::Lanczos3),
        Some("mitchell") => Ok(Filter::Mitchell),
        other => Err(format!("--filter wants box|lanczos3|mitchell, got {other:?}")),
    }
}

/// Apply an EXIF orientation (1..=8) as a pure sample permutation.
///
/// This is why rotation lives HERE rather than in jpegtran: a 90-degree
/// rotation is re-indexing, exact in any domain, at any dimensions. jpegtran's
/// DCT-domain rotation is only lossless when the constraint edge is
/// iMCU-aligned (16px at 4:2:0), and without `-perfect` it degrades silently —
/// measured 2026-08-26 on the pipeline's 2000x1333 intermediates, `-rotate 90`
/// and `-rotate 180` shipped a +5px frame shift plus a garbled edge strip
/// (XT507876) while `-rotate 270` happened to be exact.
///
/// The value is the EXIF Orientation tag: the transform that brings the STORED
/// samples upright. 1 is the identity; 2/4 mirror, 3 is 180, 5..=8 swap the
/// axes (5 transpose, 6 rotate 90 CW, 7 transverse, 8 rotate 90 CCW). Same
/// mapping the retired `exif_to_jpegtran` table in add-photos.sh used.
///
/// A permutation commutes with the per-pixel transfer function, so orienting
/// in linear light and orienting the decoded bytes give the same samples.
pub fn orient(f: &Frame, o: u8) -> Frame {
    let ch = if f.gray { 1 } else { 3 };
    let (sw, sh) = (f.w as usize, f.h as usize);
    let (dw, dh) = if (5..=8).contains(&o) { (sh, sw) } else { (sw, sh) };
    let mut data = vec![0.0f32; dw * dh * ch];
    for dy in 0..dh {
        for dx in 0..dw {
            // Destination (dx, dy) reads source (sx, sy). Derived from the
            // forward maps (rotate 90 CW sends source (x, y) to (sh-1-y, x),
            // and so on) and pinned per value by the tests below.
            let (sx, sy) = match o {
                2 => (sw - 1 - dx, dy),
                3 => (sw - 1 - dx, sh - 1 - dy),
                4 => (dx, sh - 1 - dy),
                5 => (dy, dx),
                6 => (dy, sh - 1 - dx),
                7 => (sw - 1 - dy, sh - 1 - dx),
                8 => (sw - 1 - dy, dx),
                _ => (dx, dy),
            };
            let s = (sy * sw + sx) * ch;
            let d = (dy * dw + dx) * ch;
            data[d..d + ch].copy_from_slice(&f.data[s..s + ch]);
        }
    }
    Frame { w: dw as u32, h: dh as u32, gray: f.gray, data }
}

/// Parse an `--orient` argument: the EXIF Orientation values and nothing else.
pub fn parse_orient(s: Option<&str>) -> Result<u8, String> {
    match s.and_then(|v| v.parse::<u8>().ok()) {
        Some(o) if (1..=8).contains(&o) => Ok(o),
        _ => Err(format!("--orient wants an EXIF orientation 1..8, got {s:?}")),
    }
}

/// Select a window. A crop is pure selection, so it commutes with the per-pixel
/// transfer function: cropping in linear light and cropping after the sRGB
/// encode give the same bytes. That is what lets `square` share this path.
pub fn crop(f: &Frame, x: u32, y: u32, w: u32, h: u32) -> Frame {
    let ch = if f.gray { 1 } else { 3 };
    let mut data = Vec::with_capacity((w * h) as usize * ch);
    for row in 0..h {
        let src = ((y + row) as usize * f.w as usize + x as usize) * ch;
        data.extend_from_slice(&f.data[src..src + w as usize * ch]);
    }
    Frame { w, h, gray: f.gray, data }
}

#[cfg(test)]
mod orient_tests {
    use super::*;

    fn frame(w: u32, h: u32) -> Frame {
        // Every sample distinct, so a permutation error cannot cancel.
        Frame {
            w,
            h,
            gray: true,
            data: (0..w * h).map(|i| i as f32).collect(),
        }
    }

    /// The oracle: every orientation pinned analytically on one asymmetric
    /// frame, bitwise. Source is 3x2, row-major:
    ///
    ///   0 1 2
    ///   3 4 5
    #[test]
    fn every_orientation_is_pinned_on_an_asymmetric_frame() {
        let src = frame(3, 2);
        // (value, dest w, dest h, dest samples row-major)
        let cases: [(u8, u32, u32, [f32; 6]); 8] = [
            (1, 3, 2, [0., 1., 2., 3., 4., 5.]),
            // mirror across the vertical axis
            (2, 3, 2, [2., 1., 0., 5., 4., 3.]),
            (3, 3, 2, [5., 4., 3., 2., 1., 0.]),
            // mirror across the horizontal axis
            (4, 3, 2, [3., 4., 5., 0., 1., 2.]),
            // transpose: flip across the top-left/bottom-right diagonal
            (5, 2, 3, [0., 3., 1., 4., 2., 5.]),
            // rotate 90 CW: the top row becomes the right column
            (6, 2, 3, [3., 0., 4., 1., 5., 2.]),
            // transverse: flip across the top-right/bottom-left diagonal
            (7, 2, 3, [5., 2., 4., 1., 3., 0.]),
            // rotate 90 CCW: the top row becomes the left column
            (8, 2, 3, [2., 5., 1., 4., 0., 3.]),
        ];
        for (o, dw, dh, want) in cases {
            let out = orient(&src, o);
            assert_eq!((out.w, out.h), (dw, dh), "orientation {o} dims");
            assert_eq!(out.data, want, "orientation {o} layout");
        }
    }

    /// A permutation composed with its inverse is the identity, bitwise. The
    /// mirrors, 180 and the two diagonal flips are their own inverse; the two
    /// quarter turns invert each other.
    #[test]
    fn each_orientation_composed_with_its_inverse_is_identity() {
        let src = frame(7, 5);
        for (o, inv) in [(2, 2), (3, 3), (4, 4), (5, 5), (6, 8), (7, 7), (8, 6)] {
            let back = orient(&orient(&src, o), inv);
            assert_eq!((back.w, back.h), (src.w, src.h), "{o} then {inv} dims");
            assert_eq!(back.data, src.data, "{o} then {inv} moved a sample");
        }
    }

    /// Three channels move together: the permutation re-indexes pixels, never
    /// planes, so a pixel's RGB triple survives intact.
    #[test]
    fn rgb_triples_travel_as_one_pixel() {
        let (w, h) = (4u32, 3u32);
        let mut data = Vec::new();
        for i in 0..w * h {
            data.extend_from_slice(&[i as f32, i as f32 + 0.25, i as f32 + 0.5]);
        }
        let src = Frame { w, h, gray: false, data };
        let out = orient(&src, 6);
        assert_eq!((out.w, out.h), (h, w));
        for px in out.data.chunks_exact(3) {
            assert_eq!(px[1], px[0] + 0.25, "green separated from its pixel");
            assert_eq!(px[2], px[0] + 0.5, "blue separated from its pixel");
        }
        // and it is a permutation: the same pixels, each exactly once
        let mut seen: Vec<u32> = out.data.chunks_exact(3).map(|p| p[0] as u32).collect();
        seen.sort_unstable();
        assert_eq!(seen, (0..w * h).collect::<Vec<_>>());
    }

    #[test]
    fn parse_orient_refuses_what_exif_does_not_define() {
        for bad in [None, Some("0"), Some("9"), Some("-1"), Some("six"), Some("")] {
            assert!(parse_orient(bad).is_err(), "accepted {bad:?}");
        }
        for good in 1..=8u8 {
            assert_eq!(parse_orient(Some(&good.to_string())), Ok(good));
        }
    }
}
