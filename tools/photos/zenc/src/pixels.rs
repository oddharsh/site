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
