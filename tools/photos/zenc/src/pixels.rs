// pixels.rs — the I/O half of a resample: decode to linear light, encode back.
//
// Extracted because `square` and `resize` are the same operation wearing
// different geometry, and the part that is easy to get wrong is shared: which
// colour type survives, which TRANSFER CURVE the bytes are encoded with, and
// whether the average is taken over light. Attempt 1 at the square crop
// promoted a grayscale JPEG to RGBA and the resulting byte comparison was
// meaningless, so this is the one place those decisions live.
//
// THE TRANSFER IS A PARAMETER because the corpus has two input flavours and
// they are encoded differently. Fuji sources carry sRGB. The Leica M Monochrom
// files carry Gray Gamma 2.2, a pure power law, and linearising them with the
// sRGB piecewise curve is measurably wrong: max 4 codes, mean 0.48 over all
// 2-sample averages, concentrated in the shadows a monochrome body exists for.
// The same curve is used for decode AND encode, so where no averaging happens
// values pass through exactly (round trip is exact at 8 bits, tested), and the
// shipped files keep the tone they always had under an sRGB-assuming viewer.
//
// 16-BIT SOURCES DECODE AT 16 BITS. The first version ran to_rgb8() on
// everything, which quantised a 10-bit HIF (arriving as a 16-bit TIFF) to 8
// bits BEFORE the resample. Measured cost after a 7x reduction was only ever
// 1 code, because the average recovers sub-LSB precision, but quantise-once-
// at-the-end is the principled shape and the 16-bit path costs nothing extra.
// It also fixes a real bug the 8-bit path had: a Luma16 TIFF missed the Luma8
// arm and was silently promoted to RGB.
use crate::resample::{
    g22_to_linear, linear_to_g22, linear_to_srgb, resample, srgb_to_linear, Filter,
};
use image::{DynamicImage, GrayImage, ImageBuffer, ImageReader, Luma, Rgb, RgbImage};
use std::path::Path;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Transfer {
    /// The sRGB piecewise curve. The default, and correct for everything here
    /// except the Monochrom files.
    Srgb,
    /// Pure gamma 2.2, what the Leica M Monochrom's Gray Gamma 2.2 profile
    /// declares. The caller decides from the source's profile; this file
    /// cannot read ICC and does not guess.
    G22,
}

impl Transfer {
    fn dec8(self, c: u8) -> f32 {
        match self {
            Transfer::Srgb => srgb_to_linear(c),
            Transfer::G22 => g22_to_linear(c),
        }
    }
    fn dec16(self, c: u16) -> f32 {
        let s = c as f32 / 65535.0;
        match self {
            Transfer::Srgb => {
                if s <= 0.040_449_936 { s / 12.92 } else { ((s + 0.055) / 1.055).powf(2.4) }
            }
            Transfer::G22 => s.powf(2.2),
        }
    }
    fn enc(self, l: f32) -> u8 {
        match self {
            Transfer::Srgb => linear_to_srgb(l),
            Transfer::G22 => linear_to_g22(l),
        }
    }
}

pub struct Frame {
    pub w: u32,
    pub h: u32,
    /// Linear-light samples, interleaved, 1 or 3 channels.
    pub data: Vec<f32>,
    /// One channel in, one channel out. Preserved end to end.
    pub gray: bool,
}

pub fn load_linear(path: &str, t: Transfer) -> Result<Frame, String> {
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
            data: g.pixels().map(|p| t.dec8(p[0])).collect(),
        },
        DynamicImage::ImageLuma16(g) => Frame {
            w, h, gray: true,
            data: g.pixels().map(|p| t.dec16(p[0])).collect(),
        },
        DynamicImage::ImageLumaA8(g) => Frame {
            w, h, gray: true,
            data: g.pixels().map(|p| t.dec8(p[0])).collect(),
        },
        DynamicImage::ImageLumaA16(g) => Frame {
            w, h, gray: true,
            data: g.pixels().map(|p| t.dec16(p[0])).collect(),
        },
        DynamicImage::ImageRgb16(_) | DynamicImage::ImageRgba16(_) => {
            let rgb = img.to_rgb16();
            let mut data = Vec::with_capacity((w * h * 3) as usize);
            for p in rgb.pixels() {
                data.push(t.dec16(p[0]));
                data.push(t.dec16(p[1]));
                data.push(t.dec16(p[2]));
            }
            Frame { w, h, gray: false, data }
        }
        other => {
            let rgb = other.to_rgb8();
            let mut data = Vec::with_capacity((w * h * 3) as usize);
            for p in rgb.pixels() {
                data.push(t.dec8(p[0]));
                data.push(t.dec8(p[1]));
                data.push(t.dec8(p[2]));
            }
            Frame { w, h, gray: false, data }
        }
    })
}

/// Apply an EXIF orientation (1-8) by re-indexing samples. Exact by
/// construction: a 90-degree rotation or a flip moves samples without inventing
/// any, so there is no kernel, no MCU grid, and no dimension constraint. This
/// exists because jpegtran's DCT-domain rotation is silently non-lossless when
/// the constraint edge is not iMCU-aligned: measured on a 2000x1333
/// intermediate, `-rotate 90` shifted the whole frame 5px and garbled a
/// 5-column strip, and the damage shipped in one photo's tiles.
pub fn orient(f: &Frame, o: u8) -> Frame {
    if o <= 1 || o > 8 {
        return Frame { w: f.w, h: f.h, gray: f.gray, data: f.data.clone() };
    }
    let ch = if f.gray { 1usize } else { 3 };
    let (sw, sh) = (f.w as usize, f.h as usize);
    let swapped = o >= 5;
    let (dw, dh) = if swapped { (sh, sw) } else { (sw, sh) };
    let mut data = vec![0.0f32; dw * dh * ch];
    for dy in 0..dh {
        for dx in 0..dw {
            // dst(dx,dy) reads src(sx,sy); the mapping is the INVERSE of the
            // display transform each EXIF value names.
            let (sx, sy) = match o {
                2 => (sw - 1 - dx, dy),              // mirror horizontal
                3 => (sw - 1 - dx, sh - 1 - dy),     // rotate 180
                4 => (dx, sh - 1 - dy),              // mirror vertical
                5 => (dy, dx),                       // transpose
                6 => (dy, sh - 1 - dx),              // rotate 90 CW
                7 => (sw - 1 - dy, sh - 1 - dx),     // transverse
                _ => (sw - 1 - dy, dx),              // 8: rotate 270 CW
            };
            let s = (sy * sw + sx) * ch;
            let d = (dy * dw + dx) * ch;
            data[d..d + ch].copy_from_slice(&f.data[s..s + ch]);
        }
    }
    Frame { w: dw as u32, h: dh as u32, gray: f.gray, data }
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

pub fn save(f: &Frame, path: &str, t: Transfer) -> Result<(), String> {
    let r = if f.gray {
        let out: GrayImage = ImageBuffer::from_fn(f.w, f.h, |x, y| {
            Luma([t.enc(f.data[y as usize * f.w as usize + x as usize])])
        });
        out.save(Path::new(path))
    } else {
        let out: RgbImage = ImageBuffer::from_fn(f.w, f.h, |x, y| {
            let i = (y as usize * f.w as usize + x as usize) * 3;
            Rgb([t.enc(f.data[i]), t.enc(f.data[i + 1]), t.enc(f.data[i + 2])])
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

pub fn parse_transfer(s: Option<&str>) -> Result<Transfer, String> {
    match s {
        Some("srgb") => Ok(Transfer::Srgb),
        Some("g22") => Ok(Transfer::G22),
        other => Err(format!("--transfer wants srgb|g22, got {other:?}")),
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
mod tests {
    use super::*;

    fn tiny() -> Frame {
        // 3x2, values chosen so every position is distinct
        Frame { w: 3, h: 2, gray: true, data: vec![1., 2., 3., 4., 5., 6.] }
    }

    /// Orientation is pure permutation, so each case is checkable by hand.
    /// The mappings are the INVERSE display transforms, verified against a
    /// spatial rotation of a real photo below the unit level (in the shell
    /// pipeline's verification, since sips is not available to cargo test).
    #[test]
    fn orient_cases_match_hand_computed_answers() {
        let f = tiny();
        // src:  1 2 3
        //       4 5 6
        let cases: [(u8, u32, u32, Vec<f32>); 8] = [
            (1, 3, 2, vec![1., 2., 3., 4., 5., 6.]),
            (2, 3, 2, vec![3., 2., 1., 6., 5., 4.]),         // mirror H
            (3, 3, 2, vec![6., 5., 4., 3., 2., 1.]),         // rot 180
            (4, 3, 2, vec![4., 5., 6., 1., 2., 3.]),         // mirror V
            (5, 2, 3, vec![1., 4., 2., 5., 3., 6.]),         // transpose
            (6, 2, 3, vec![4., 1., 5., 2., 6., 3.]),         // rot 90 CW
            (7, 2, 3, vec![6., 3., 5., 2., 4., 1.]),         // transverse
            (8, 2, 3, vec![3., 6., 2., 5., 1., 4.]),         // rot 270 CW
        ];
        for (o, w, h, want) in cases {
            let r = orient(&f, o);
            assert_eq!((r.w, r.h), (w, h), "orient {o} dims");
            assert_eq!(r.data, want, "orient {o} samples");
        }
    }

    /// Every orientation applied then inverted (or applied 4x for rotations)
    /// must return the original. Catches an inverse-vs-forward mix-up, which is
    /// the classic failure in this code and invisible on symmetric test data.
    #[test]
    fn orientations_compose_back_to_identity() {
        let f = tiny();
        for (o, inv) in [(2, 2), (3, 3), (4, 4), (5, 5), (6, 8), (7, 7), (8, 6)] {
            let r = orient(&orient(&f, o), inv);
            assert_eq!(r.data, f.data, "orient {o} then {inv} is not identity");
        }
    }

    /// The two tests above are GRAYSCALE, so neither can see a channel-stride
    /// bug: the permutation re-indexes pixels, and reading it as though it
    /// re-indexed samples would tear every RGB triple apart while leaving a
    /// 1-channel frame perfectly correct. Every colour photo in the library
    /// goes through this arm.
    #[test]
    fn rgb_triples_travel_as_one_pixel() {
        let (w, h) = (4u32, 3u32);
        let mut data = Vec::new();
        for i in 0..w * h {
            data.extend_from_slice(&[i as f32, i as f32 + 0.25, i as f32 + 0.5]);
        }
        let out = orient(&Frame { w, h, gray: false, data }, 6);
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
}
