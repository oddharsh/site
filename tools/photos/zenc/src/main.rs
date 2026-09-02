// zenc — the site's JPEG thumbnail encoder.
//
// Reads an already-upright, metadata-stripped PNG/JPG (the photo pipeline
// brings pixels upright with `zenc square --orient` before this step; it was
// jpegtran's DCT rotation until 2026-08-26, which is silently lossy off iMCU
// alignment — see pixels::orient) and writes a JPEG encoded
// with zenjpeg's hybrid trellis (jpegli adaptive quantization + rate-distortion)
// and a 64-candidate progressive scan search, 4:2:0. On the 158-photo corpus
// this is ~4% smaller than cjpegli at equal SSIMULACRA2 (see /garage/encoding).
//
//   zenc <input.(png|jpg)> <output.jpg> [-q N]     default q = 82
//
// Output carries no EXIF/ICC: encode_from_bytes only sees RGB pixels, matching
// the metadata-stripping cjpegli it replaces.
use std::process::exit;
use zenjpeg::encoder::{
    ChromaSubsampling, EncoderConfig, PixelLayout, ProgressiveScanMode, Unstoppable,
};

mod histogram;
mod pixels;
mod resize;
mod square;

fn die(msg: String) -> ! {
    eprintln!("zenc: {msg}");
    exit(1)
}

fn main() {
    let args: Vec<String> = std::env::args().collect();

    // Dispatched before the positional parse below, which would otherwise read
    // `--version` as an input path. It names the zenjpeg pin as well as this
    // crate, because the pin is what decides the bytes: zenc's own version has
    // not moved since the crate was written. build.rs reads it out of Cargo.lock
    // and config/tools.json matches this exact line.
    if matches!(args.get(1).map(String::as_str), Some("--version" | "-V")) {
        println!(
            "zenc {} (zenjpeg {})",
            env!("CARGO_PKG_VERSION"),
            env!("ZENJPEG_VERSION")
        );
        exit(0);
    }

    // One subcommand, dispatched before the positional encode interface so that
    // interface is untouched. The bake lives here rather than in its own binary
    // because it shares the JPEG decoder the encoder already links, which is the
    // entire reason it costs nothing to carry.
    if args.get(1).map(String::as_str) == Some("histogram") {
        exit(histogram::run(&args[2..]));
    }
    if args.get(1).map(String::as_str) == Some("square") {
        exit(square::run(&args[2..]));
    }
    // Caps one dimension and keeps the whole frame, which is what an Instagram
    // export wants and what `square` deliberately does not do.
    if args.get(1).map(String::as_str) == Some("resize") {
        exit(resize::run(&args[2..]));
    }

    let (mut input, mut output, mut q): (Option<String>, Option<String>, u8) = (None, None, 82);
    // Default 4:2:0 (thumbnails). --yuv 422 matches the Fuji HIF source (10-bit
    // 4:2:2) for the archive: it neither discards the sensor's vertical chroma
    // (as 4:2:0 does) nor fabricates horizontal chroma the sensor never sampled
    // (as 4:4:4 does).
    let mut chroma = ChromaSubsampling::Quarter;
    let mut i = 1;
    while i < args.len() {
        match args[i].as_str() {
            "-q" | "--quality" => {
                i += 1;
                q = args
                    .get(i)
                    .and_then(|s| s.parse().ok())
                    .unwrap_or_else(|| die("-q needs a number 1..100".into()));
            }
            "--yuv" => {
                i += 1;
                chroma = match args.get(i).map(String::as_str) {
                    Some("444") => ChromaSubsampling::None,
                    Some("422") => ChromaSubsampling::HalfHorizontal,
                    Some("420") => ChromaSubsampling::Quarter,
                    _ => die("--yuv takes 444, 422, or 420".into()),
                };
            }
            "-h" | "--help" => {
                println!("usage: zenc <input.(png|jpg)> <output.jpg> [-q N] [--yuv 444|422|420]");
                println!("zenjpeg hybrid trellis + progressive scan search. default q=82, 4:2:0.");
                println!("--yuv 422 matches the Fuji HIF source (archive); 4:2:0/4:2:2 add sharp_yuv.");
                exit(0);
            }
            s if input.is_none() => input = Some(s.to_string()),
            s if output.is_none() => output = Some(s.to_string()),
            s => die(format!("unexpected argument: {s}")),
        }
        i += 1;
    }
    let (input, output) = match (input, output) {
        (Some(a), Some(b)) => (a, b),
        _ => die("usage: zenc <input.(png|jpg)> <output.jpg> [-q N]".into()),
    };

    let decoded = image::open(&input).unwrap_or_else(|e| die(format!("cannot read {input}: {e}")));

    // A 1-CHANNEL INPUT ENCODES AS A 1-CHANNEL JPEG, detected rather than
    // flagged, so the pipeline scripts need no change and the correct
    // representation is unconditional. Until 2026-08-26 everything went
    // through to_rgb8(), so the Leica M Monochrom tiles shipped as 3-channel
    // YCbCr carrying two flat chroma planes — measured losslessly via
    // `jpegtran -grayscale` on the shipped files at 3.6-4.2% of their bytes.
    // --yuv is chroma layout and grayscale has no chroma, so it is ignored on
    // this path rather than refused: the scripts pass one command line for
    // both kinds of photo.
    let jpeg = match decoded {
        image::DynamicImage::ImageLuma8(_)
        | image::DynamicImage::ImageLumaA8(_)
        | image::DynamicImage::ImageLuma16(_)
        | image::DynamicImage::ImageLumaA16(_) => {
            let img = decoded.to_luma8();
            let (w, h) = (img.width(), img.height());
            // Same order rule as the colour arm: auto_optimize() resets
            // scan_mode, so the search is requested after it. No sharp_yuv,
            // since there is no chroma to downsample.
            let cfg = EncoderConfig::grayscale(q)
                .auto_optimize(true)
                .scan_mode(ProgressiveScanMode::ProgressiveSearch);
            let mut enc = cfg
                .encode_from_bytes(w, h, PixelLayout::Gray8Srgb)
                .unwrap_or_else(|e| die(format!("encode init failed: {e}")));
            enc.push_packed(img.as_raw(), Unstoppable)
                .unwrap_or_else(|e| die(format!("push failed: {e}")));
            enc.finish().unwrap_or_else(|e| die(format!("encode failed: {e}")))
        }
        other => {
            let img = other.to_rgb8();
            let (w, h) = (img.width(), img.height());
            // An RGB container holding R=G=B everywhere is a monochrome image
            // wearing the wrong coat, and converting it is LOSSLESS: Y equals
            // R when the channels agree, and the chroma planes are exactly
            // flat. L1009920.JPG, a Monochrom frame the camera stored as RGB,
            // is channel-equal on 100.00% of its 23.6M pixels. The scan is one
            // pass and bails on the first unequal pixel, so a real colour photo
            // pays almost nothing.
            //
            // pixels.rs makes the same call at the DECODE since 2026-08-27, so
            // a pipeline thumbnail now arrives already 1-channel and takes the
            // Luma8 arm above. This scan is still the only one that sees an
            // input no Frame ever touched, which is six call sites handing this
            // path bytes straight from sips or ffmpeg: add-photos.sh phase 2,
            // add-car-photo.sh, and the two gen-encoding scripts.
            if img.as_raw().chunks_exact(3).all(|p| p[0] == p[1] && p[1] == p[2]) {
                let gray: Vec<u8> = img.as_raw().chunks_exact(3).map(|p| p[0]).collect();
                let cfg = EncoderConfig::grayscale(q)
                    .auto_optimize(true)
                    .scan_mode(ProgressiveScanMode::ProgressiveSearch);
                let mut enc = cfg
                    .encode_from_bytes(w, h, PixelLayout::Gray8Srgb)
                    .unwrap_or_else(|e| die(format!("encode init failed: {e}")));
                enc.push_packed(&gray, Unstoppable)
                    .unwrap_or_else(|e| die(format!("push failed: {e}")));
                let jpeg = enc.finish().unwrap_or_else(|e| die(format!("encode failed: {e}")));
                std::fs::write(&output, &jpeg)
                    .unwrap_or_else(|e| die(format!("cannot write {output}: {e}")));
                return;
            }
            // Order matters: auto_optimize() resets scan_mode to plain Progressive, so
            // request the scan SEARCH after it or the 64-candidate search is clobbered.
            // sharp_yuv: linear-light chroma downsampling, ~+0.2 SSIMULACRA2 on color
            // photos (see /garage/encoding). It only affects the downsample filter, so
            // it's a no-op at 4:4:4 (nothing to sharpen) and helps at 4:2:2 / 4:2:0.
            let mut cfg = EncoderConfig::ycbcr(q, chroma)
                .auto_optimize(true)
                .scan_mode(ProgressiveScanMode::ProgressiveSearch);
            if chroma != ChromaSubsampling::None {
                cfg = cfg.sharp_yuv(true);
            }
            let mut enc = cfg
                .encode_from_bytes(w, h, PixelLayout::Rgb8Srgb)
                .unwrap_or_else(|e| die(format!("encode init failed: {e}")));
            enc.push_packed(img.as_raw(), Unstoppable)
                .unwrap_or_else(|e| die(format!("push failed: {e}")));
            enc.finish().unwrap_or_else(|e| die(format!("encode failed: {e}")))
        }
    };

    std::fs::write(&output, &jpeg).unwrap_or_else(|e| die(format!("cannot write {output}: {e}")));
}
