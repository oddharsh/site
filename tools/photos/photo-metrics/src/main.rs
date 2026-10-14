// photo-metrics: SSIMULACRA2 and butteraugli for hif-archive.ts.
//
//   photo-metrics <reference> <distorted>
//
// Prints one JSON line: {"s2": <ssimulacra2>, "ba": <butteraugli max>,
// "ba3": <butteraugli 3-norm>}. The 3-norm is what `butteraugli_main --pnorm 3`
// prints second, and the number hif-archive.ts compares.
//
// Both images are read at 16 bits, whatever they hold. hif-archive.ts's
// reference is sips's 16-bit decode of the HIF, its candidates are djxl's 16-bit
// decodes, and its baseline is djpeg's 8-bit PPM; widening 8 bits to 16 is exact
// (v * 257), so every input reaches the metrics at full precision, the way
// libjxl's own tools read them.
//
// It replaced libjxl's `ssimulacra2` and `butteraugli_main` on 2026-10-14.
// Cargo.toml has the parity measurement and why the pins are exact.
use butteraugli::{ButteraugliParams, Img, RGB};
use fast_ssim2::{PixelDescriptor, PixelSlice, compute_ssimulacra2};

struct Rgb16 {
    px: Vec<[u16; 3]>,
    w: usize,
    h: usize,
}

fn load(path: &str) -> Result<Rgb16, String> {
    let img = image::open(path).map_err(|e| format!("{path}: {e}"))?.to_rgb16();
    let (w, h) = (img.width() as usize, img.height() as usize);
    Ok(Rgb16 { px: img.pixels().map(|p| p.0).collect(), w, h })
}

/// The sRGB EOTF, for butteraugli's linear-light entry point.
fn srgb_to_linear(v: f32) -> f32 {
    if v <= 0.04045 { v / 12.92 } else { ((v + 0.055) / 1.055).powf(2.4) }
}

fn slice<'a>(bytes: &'a [u8], w: usize, h: usize) -> Result<PixelSlice<'a>, String> {
    PixelSlice::new(bytes, w as u32, h as u32, w * 6, PixelDescriptor::RGB16_SRGB).map_err(|e| e.to_string())
}

fn ssimulacra2(r: &Rgb16, d: &Rgb16) -> Result<f64, String> {
    let bytes = |img: &Rgb16| -> Vec<u8> { img.px.iter().flat_map(|p| p.iter().flat_map(|c| c.to_ne_bytes())).collect() };
    let (rb, db) = (bytes(r), bytes(d));
    compute_ssimulacra2(&slice(&rb, r.w, r.h)?, &slice(&db, d.w, d.h)?).map_err(|e| e.to_string())
}

fn butteraugli(r: &Rgb16, d: &Rgb16) -> Result<(f64, f64), String> {
    let linear = |img: &Rgb16| -> Vec<RGB<f32>> {
        img.px
            .iter()
            .map(|p| {
                let [a, b, c] = p.map(|v| srgb_to_linear(v as f32 / 65535.0));
                RGB::new(a, b, c)
            })
            .collect()
    };
    let (rl, dl) = (linear(r), linear(d));
    let res = butteraugli::butteraugli_linear(
        Img::new(&rl[..], r.w, r.h),
        Img::new(&dl[..], d.w, d.h),
        &ButteraugliParams::default(),
    )
    .map_err(|e| e.to_string())?;
    Ok((res.score, res.pnorm_3))
}

fn run(reference: &str, distorted: &str) -> Result<String, String> {
    let (r, d) = (load(reference)?, load(distorted)?);
    if (r.w, r.h) != (d.w, d.h) {
        return Err(format!("{reference} is {}x{} but {distorted} is {}x{}", r.w, r.h, d.w, d.h));
    }
    let s2 = ssimulacra2(&r, &d)?;
    let (ba, ba3) = butteraugli(&r, &d)?;
    Ok(format!("{{\"s2\":{s2},\"ba\":{ba},\"ba3\":{ba3}}}"))
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let [reference, distorted] = args.as_slice() else {
        eprintln!("usage: photo-metrics <reference> <distorted>");
        std::process::exit(2);
    };
    match run(reference, distorted) {
        Ok(line) => println!("{line}"),
        Err(e) => {
            eprintln!("photo-metrics: {e}");
            std::process::exit(1);
        }
    }
}
