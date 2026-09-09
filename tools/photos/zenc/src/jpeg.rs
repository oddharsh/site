use image::DynamicImage;
use std::borrow::Cow;
use zenjpeg::encoder::{ChromaSubsampling, EncoderConfig, PixelLayout, ProgressiveScanMode, Unstoppable};

/// The shared JPEG encoder for decoded inputs and generated tiers.
pub fn encode(decoded: &DynamicImage, q: u8, chroma: ChromaSubsampling) -> Result<Vec<u8>, String> {
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
            let img = match decoded {
                DynamicImage::ImageLuma8(img) => Cow::Borrowed(img),
                other => Cow::Owned(other.to_luma8()),
            };
            let (w, h) = (img.width(), img.height());
            // Same order rule as the colour arm: auto_optimize() resets
            // scan_mode, so the search is requested after it. No sharp_yuv,
            // since there is no chroma to downsample.
            let cfg = EncoderConfig::grayscale(q)
                .auto_optimize(true)
                .scan_mode(ProgressiveScanMode::ProgressiveSearch);
            let mut enc = cfg
                .encode_from_bytes(w, h, PixelLayout::Gray8Srgb)
                .map_err(|e| format!("encode init failed: {e}"))?;
            enc.push_packed(img.as_raw(), Unstoppable)
                .map_err(|e| format!("push failed: {e}"))?;
            enc.finish().map_err(|e| format!("encode failed: {e}"))?
        }
        other => {
            let img = match other {
                DynamicImage::ImageRgb8(img) => Cow::Borrowed(img),
                other => Cow::Owned(other.to_rgb8()),
            };
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
                    .map_err(|e| format!("encode init failed: {e}"))?;
                enc.push_packed(&gray, Unstoppable)
                    .map_err(|e| format!("push failed: {e}"))?;
                let jpeg = enc.finish().map_err(|e| format!("encode failed: {e}"))?;
                return Ok(jpeg);
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
                .map_err(|e| format!("encode init failed: {e}"))?;
            enc.push_packed(img.as_raw(), Unstoppable)
                .map_err(|e| format!("push failed: {e}"))?;
            enc.finish().map_err(|e| format!("encode failed: {e}"))?
        }
    };

    Ok(jpeg)
}
