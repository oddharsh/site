// zenc — the site's JPEG thumbnail encoder.
//
// Reads an already-upright, metadata-stripped PNG/JPG (the photo pipeline bakes
// EXIF orientation in with jpegtran before this step) and writes a JPEG encoded
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

fn die(msg: String) -> ! {
    eprintln!("zenc: {msg}");
    exit(1)
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let (mut input, mut output, mut q): (Option<String>, Option<String>, u8) = (None, None, 82);
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
            "-h" | "--help" => {
                println!("usage: zenc <input.(png|jpg)> <output.jpg> [-q N]");
                println!("zenjpeg hybrid trellis + progressive scan search, 4:2:0. default q=82.");
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

    let img = image::open(&input)
        .unwrap_or_else(|e| die(format!("cannot read {input}: {e}")))
        .to_rgb8();
    let (w, h) = (img.width(), img.height());

    // Order matters: auto_optimize() resets scan_mode to plain Progressive, so
    // request the scan SEARCH after it or the 64-candidate search is clobbered.
    // sharp_yuv: linear-light 4:2:0 chroma downsampling. ~3x slower, ~free on
    // bytes, and worth ~+0.2 SSIMULACRA2 on color photos (measured on the corpus).
    // Unlike AVIF, where sharpyuv was a wash on aom's already-good conversion, the
    // JPEG default chroma path has room for it. See /garage/encoding.
    let cfg = EncoderConfig::ycbcr(q, ChromaSubsampling::Quarter)
        .auto_optimize(true)
        .scan_mode(ProgressiveScanMode::ProgressiveSearch)
        .sharp_yuv(true);

    let mut enc = cfg
        .encode_from_bytes(w, h, PixelLayout::Rgb8Srgb)
        .unwrap_or_else(|e| die(format!("encode init failed: {e}")));
    enc.push_packed(img.as_raw(), Unstoppable)
        .unwrap_or_else(|e| die(format!("push failed: {e}")));
    let jpeg = enc
        .finish()
        .unwrap_or_else(|e| die(format!("encode failed: {e}")));

    std::fs::write(&output, &jpeg).unwrap_or_else(|e| die(format!("cannot write {output}: {e}")));
}
