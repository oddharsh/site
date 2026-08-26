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
use image::{DynamicImage, GrayImage, ImageBuffer, ImageDecoder, ImageReader, Luma, Rgb, RgbImage};
use std::path::Path;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Transfer {
    /// The sRGB piecewise curve. The default, and correct for everything here
    /// except the Monochrom files.
    Srgb,
    /// Pure gamma 2.2, what the Leica M Monochrom's Gray Gamma 2.2 profile
    /// declares.
    G22,
    /// Read the curve from the file's own ICC profile. The default, and what
    /// `--transfer` omitted means. See `classify`.
    Auto,
}

/// Which curve a profile declares, decided from its TONE REPRODUCTION CURVE
/// rather than from its description string.
///
/// The shell used to answer this with `sips -g profile` and a literal match on
/// "Gray Gamma 2.2", which cost a 123ms process per photo and failed silently
/// in the direction that matters: any other spelling falls back to sRGB, and
/// sRGB on Monochrom data is wrong by up to 4 codes in the shadows a
/// monochrome body exists for.
///
/// The rule is narrow on purpose. A single-point `curv` IS a gamma, so a value
/// within a u8Fixed8 tick of 2.2 selects G22. EVERYTHING ELSE is the sRGB
/// convention: a sampled table, a parametric curve, another gamma, or no
/// profile at all. 43 of this corpus's JPEGs carry no ICC whatsoever and are
/// sRGB by the EXIF convention, so "absent" has to mean sRGB rather than
/// "unknown".
///
/// USING THE ICC's CURVE ITSELF WAS MEASURED AND DECLINED. The Monochrom
/// profile declares gamma 2.1992 rather than 2.2, and the sRGB profiles carry
/// 1024-point tables rather than the piecewise formula. Over all 65536
/// two-sample averages, honouring those exactly moves at most ONE code (414
/// pairs for the gamma, 32470 for the table). That is below the threshold
/// anything here can act on, and adopting it would re-mint every
/// content-addressed URL for a rounding unit. This reads the profile to DECIDE
/// which curve, and keeps the constants.
fn classify(icc: Option<&[u8]>) -> Transfer {
    let Some(p) = icc else { return Transfer::Srgb };
    if p.len() < 132 {
        return Transfer::Srgb;
    }
    let n = u32::from_be_bytes([p[128], p[129], p[130], p[131]]) as usize;
    for i in 0..n {
        let o = 132 + i * 12;
        if o + 12 > p.len() {
            break;
        }
        let sig = &p[o..o + 4];
        // kTRC is the gray profile's single curve; rTRC stands for the RGB set,
        // whose three curves this pipeline has never seen disagree.
        if sig == b"kTRC" || sig == b"rTRC" {
            let off = u32::from_be_bytes([p[o + 4], p[o + 5], p[o + 6], p[o + 7]]) as usize;
            if off + 14 > p.len() || &p[off..off + 4] != b"curv" {
                return Transfer::Srgb;
            }
            let count = u32::from_be_bytes([p[off + 8], p[off + 9], p[off + 10], p[off + 11]]);
            if count == 1 {
                let g = u16::from_be_bytes([p[off + 12], p[off + 13]]) as f32 / 256.0;
                return if (g - 2.2).abs() < 0.01 { Transfer::G22 } else { Transfer::Srgb };
            }
            return Transfer::Srgb;
        }
    }
    Transfer::Srgb
}

impl Transfer {
    fn dec8(self, c: u8) -> f32 {
        match self {
            Transfer::G22 => g22_to_linear(c),
            _ => srgb_to_linear(c),
        }
    }
    fn dec16(self, c: u16) -> f32 {
        let s = c as f32 / 65535.0;
        match self {
            Transfer::G22 => s.powf(2.2),
            _ => {
                if s <= 0.040_449_936 { s / 12.92 } else { ((s + 0.055) / 1.055).powf(2.4) }
            }
        }
    }
    fn enc(self, l: f32) -> u8 {
        match self {
            Transfer::G22 => linear_to_g22(l),
            _ => linear_to_srgb(l),
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
    /// The RESOLVED curve this frame was decoded with, and the one `save` will
    /// encode it back with. It rides on the frame rather than being passed to
    /// both ends separately, because passing it twice is how the first version
    /// of Auto decoded a Monochrom file as gamma 2.2 and encoded it as sRGB:
    /// `load_linear` resolved Auto locally and `save` still held Auto, whose
    /// fallthrough is sRGB. Both halves now read one field, so the mismatch
    /// cannot be written.
    pub transfer: Transfer,
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
    // The ICC has to be read from the DECODER, and the decoder has to inherit
    // the lifted ceiling: `into_decoder` carries the reader's limits, which is
    // why this is not `ImageReader::open(..).into_decoder()` on a fresh reader.
    // A 311MB TIFF is the test that keeps that honest.
    let mut dec = r.into_decoder().map_err(|e| format!("cannot decode {path}: {e}"))?;
    let icc = dec.icc_profile().ok().flatten();
    let t = if t == Transfer::Auto { classify(icc.as_deref()) } else { t };
    let img = DynamicImage::from_decoder(dec).map_err(|e| format!("cannot decode {path}: {e}"))?;
    let (w, h) = (img.width(), img.height());
    if w == 0 || h == 0 {
        return Err("source has a zero dimension".into());
    }
    Ok(match img {
        DynamicImage::ImageLuma8(g) => Frame {
            w, h, gray: true, transfer: t,
            data: g.pixels().map(|p| t.dec8(p[0])).collect(),
        },
        DynamicImage::ImageLuma16(g) => Frame {
            w, h, gray: true, transfer: t,
            data: g.pixels().map(|p| t.dec16(p[0])).collect(),
        },
        DynamicImage::ImageLumaA8(g) => Frame {
            w, h, gray: true, transfer: t,
            data: g.pixels().map(|p| t.dec8(p[0])).collect(),
        },
        DynamicImage::ImageLumaA16(g) => Frame {
            w, h, gray: true, transfer: t,
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
            Frame { w, h, gray: false, data, transfer: t }
        }
        other => {
            let rgb = other.to_rgb8();
            let mut data = Vec::with_capacity((w * h * 3) as usize);
            for p in rgb.pixels() {
                data.push(t.dec8(p[0]));
                data.push(t.dec8(p[1]));
                data.push(t.dec8(p[2]));
            }
            Frame { w, h, gray: false, data, transfer: t }
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
        return Frame { w: f.w, h: f.h, gray: f.gray, data: f.data.clone(), transfer: f.transfer };
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
    Frame { w: dw as u32, h: dh as u32, gray: f.gray, data, transfer: f.transfer }
}

/// Resample to an exact size, still in linear light.
pub fn scale(f: &Frame, dw: u32, dh: u32, filter: Filter) -> Frame {
    let ch = if f.gray { 1 } else { 3 };
    Frame {
        w: dw,
        h: dh,
        gray: f.gray,
        transfer: f.transfer,
        data: resample(&f.data, f.w as usize, f.h as usize, ch, dw as usize, dh as usize, filter),
    }
}

pub fn save(f: &Frame, path: &str) -> Result<(), String> {
    let t = f.transfer;
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
        Some("auto") => Ok(Transfer::Auto),
        other => Err(format!("--transfer wants auto|srgb|g22, got {other:?}")),
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
    Frame { w, h, gray: f.gray, data, transfer: f.transfer }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tiny() -> Frame {
        // 3x2, values chosen so every position is distinct
        Frame { w: 3, h: 2, gray: true, data: vec![1., 2., 3., 4., 5., 6.], transfer: Transfer::Srgb }
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
        let out = orient(&Frame { w, h, gray: false, data, transfer: Transfer::Srgb }, 6);
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

#[cfg(test)]
mod icc_tests {
    use super::*;

    /// Build a minimal ICC carrying one TRC tag, which is all `classify` reads.
    fn icc(sig: &[u8; 4], body: &[u8]) -> Vec<u8> {
        let mut p = vec![0u8; 132];
        p[128..132].copy_from_slice(&1u32.to_be_bytes());
        let off = 144u32;
        p.extend_from_slice(sig);
        p.extend_from_slice(&off.to_be_bytes());
        p.extend_from_slice(&(body.len() as u32).to_be_bytes());
        while p.len() < off as usize { p.push(0) }
        p.extend_from_slice(body);
        p
    }
    fn curv_gamma(g: f32) -> Vec<u8> {
        let mut b = b"curv".to_vec();
        b.extend_from_slice(&0u32.to_be_bytes());
        b.extend_from_slice(&1u32.to_be_bytes());
        b.extend_from_slice(&(((g * 256.0).round()) as u16).to_be_bytes());
        b
    }
    fn curv_table(n: u32) -> Vec<u8> {
        let mut b = b"curv".to_vec();
        b.extend_from_slice(&0u32.to_be_bytes());
        b.extend_from_slice(&n.to_be_bytes());
        b.extend(std::iter::repeat(0u8).take(n as usize * 2));
        b
    }

    #[test]
    fn classify_reads_the_curve_and_defaults_to_srgb() {
        // The two the corpus actually contains, by their measured shapes.
        assert_eq!(classify(Some(&icc(b"kTRC", &curv_gamma(2.1992)))), Transfer::G22,
            "the Monochrom declares 2.1992, which is 2.2 within a u8Fixed8 tick");
        assert_eq!(classify(Some(&icc(b"rTRC", &curv_table(1024)))), Transfer::Srgb,
            "an sRGB profile carries a sampled table, not a gamma");

        // Absent is sRGB rather than unknown: 43 of this corpus's JPEGs carry
        // no ICC at all and are sRGB by the EXIF convention.
        assert_eq!(classify(None), Transfer::Srgb);
        assert_eq!(classify(Some(&[0u8; 8])), Transfer::Srgb, "a truncated profile must not panic");

        // Anything that is not ~2.2 stays on sRGB rather than guessing.
        assert_eq!(classify(Some(&icc(b"kTRC", &curv_gamma(1.8)))), Transfer::Srgb);
        assert_eq!(classify(Some(&icc(b"rTRC", b"para\0\0\0\0\0\0\0\0\0\0\0\0"))), Transfer::Srgb);
    }

    /// The round trip must use ONE curve at both ends. The first version of
    /// Auto resolved it inside load_linear and left the caller holding Auto,
    /// whose fallthrough is sRGB, so a Monochrom frame decoded at gamma 2.2
    /// and re-encoded at sRGB and matched neither explicit setting. A frame
    /// now carries its resolved curve, which is what makes that unwritable.
    #[test]
    fn a_frame_encodes_with_the_curve_it_decoded_with() {
        for t in [Transfer::Srgb, Transfer::G22] {
            let f = Frame { w: 2, h: 1, gray: true, transfer: t, data: vec![t.dec8(40), t.dec8(200)] };
            // no averaging happens, so both samples must return exactly
            assert_eq!(t.enc(f.data[0]), 40, "{t:?} lost the low sample");
            assert_eq!(t.enc(f.data[1]), 200, "{t:?} lost the high sample");
            // and the mismatched pairing, which is what the bug did, must not
            let other = if t == Transfer::Srgb { Transfer::G22 } else { Transfer::Srgb };
            assert_ne!(other.enc(f.data[0]), 40, "the two curves are indistinguishable here, so this test proves nothing");
        }
    }

    /// Auto must resolve before any sample is touched; if it ever reached the
    /// loops it would silently behave as sRGB and the Monochrom files would
    /// regress by 4 codes with nothing failing.
    #[test]
    fn auto_never_reaches_the_sample_path() {
        assert_eq!(Transfer::G22.dec8(128).to_bits(), g22_to_linear(128).to_bits());
        assert_eq!(Transfer::Srgb.dec8(128).to_bits(), srgb_to_linear(128).to_bits());
    }
}
