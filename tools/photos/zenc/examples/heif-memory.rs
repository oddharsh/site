//! macOS-only experiment; not dispatched by the production CLI or ingest.
//! heif-memory compare SOURCE.HIF LOSSLESS.tif
//! heif-memory tiers SOURCE.HIF OUTDIR ORIENTATION
#[allow(dead_code)]
#[path = "../src/pixels.rs"] mod pixels;
#[allow(dead_code)]
#[path = "../src/square.rs"] mod square;
#[path = "../src/jpeg.rs"] mod jpeg;
#[path = "../src/avif.rs"] mod avif;
use std::{ffi::{c_char, c_void, CString}, path::Path, process::ExitCode, time::Instant};
use image::{DynamicImage, ImageDecoder, ImageReader};

extern "C" {
    fn site_heif_open(path: *const c_char, w: *mut u32, h: *mut u32, icc_len: *mut usize) -> *mut c_void;
    fn site_heif_decode(handle: *mut c_void, rgba: *mut u16, samples: usize, icc: *mut u8, icc_len: usize) -> i32;
    fn site_heif_close(handle: *mut c_void);
}
struct Native(*mut c_void);
impl Drop for Native { fn drop(&mut self) { unsafe { site_heif_close(self.0); } } }

fn decode(path: &str) -> Result<(DynamicImage, Vec<u8>), String> {
    let name = CString::new(path).map_err(|e| e.to_string())?;
    let (mut w, mut h, mut icc_len) = (0, 0, 0);
    // C retains its image; Native drops it on every return. Output pointers are
    // valid for the call. Decode receives complete caller-owned buffers.
    let native = Native(unsafe { site_heif_open(name.as_ptr(), &mut w, &mut h, &mut icc_len) });
    if native.0.is_null() { return Err(format!("ImageIO cannot decode supported RGB HEIF: {path}")); }
    let samples = (w as usize).checked_mul(h as usize).and_then(|n| n.checked_mul(4)).ok_or("image dimensions overflow")?;
    let mut rgba = vec![0u16; samples];
    let mut icc = vec![0u8; icc_len];
    if unsafe { site_heif_decode(native.0, rgba.as_mut_ptr(), rgba.len(), icc.as_mut_ptr(), icc.len()) } != 0 {
        return Err("ImageIO could not render a 16-bit buffer".into());
    }
    let buffer = image::ImageBuffer::from_raw(w, h, rgba).ok_or("invalid decoded dimensions")?;
    Ok((DynamicImage::ImageRgba16(buffer), icc))
}

fn decode_tiff(path: &str) -> Result<(DynamicImage, Vec<u8>), String> {
    let mut reader = ImageReader::open(path).map_err(|e| e.to_string())?;
    reader.no_limits();
    let mut decoder = reader.into_decoder().map_err(|e| e.to_string())?;
    let icc = decoder.icc_profile().map_err(|e| e.to_string())?.ok_or("TIFF has no ICC")?;
    Ok((DynamicImage::from_decoder(decoder).map_err(|e| e.to_string())?, icc))
}

fn run(args: &[String]) -> Result<(), String> {
    match args.first().map(String::as_str) {
        Some("compare") if args.len() == 3 => {
            let (native, icc) = decode(&args[1])?;
            let mut reader = ImageReader::open(&args[2]).map_err(|e| e.to_string())?;
            reader.no_limits();
            let mut decoder = reader.into_decoder().map_err(|e| e.to_string())?;
            let expected_icc = decoder.icc_profile().map_err(|e| e.to_string())?.ok_or("TIFF has no ICC")?;
            let expected = DynamicImage::from_decoder(decoder).map_err(|e| e.to_string())?;
            if native.width() != expected.width() || native.height() != expected.height() { return Err("dimensions differ".into()); }
            if icc != expected_icc { return Err("ICC bytes differ".into()); }
            let (width, height) = (native.width(), native.height());
            if native.into_rgba16() != expected.into_rgba16() {
                return Err("16-bit samples differ".into());
            }
            println!("{}", serde_json::json!({"width":width,"height":height,"iccBytes":icc.len(),"rgba16Equal":true}));
        }
        Some("tiers" | "tiff-tiers") if args.len() == 4 => {
            let orientation = pixels::Orientation::try_from(args[3].parse::<u8>().map_err(|e| e.to_string())?)?;
            let start = Instant::now();
            let (image, icc) = if args[0] == "tiers" { decode(&args[1])? } else { decode_tiff(&args[1])? };
            let decoded = Instant::now();
            let src = pixels::from_decoded(image, Some(&icc), pixels::TransferOption::Auto)?;
            let linear = Instant::now();
            let src = pixels::orient(src, orientation);
            let oriented = Instant::now();
            let root = Path::new(&args[2]);
            std::fs::create_dir_all(root).map_err(|e| e.to_string())?;
            for size in [600, 400, 200] {
                let tier = square::tier(&src, pixels::Orientation::Upright, size, halflight::Filter::Box);
                avif::write(&tier, &root.join(format!("{size}.avif")))?;
                if size == 600 {
                    let jpg = jpeg::encode(&tier, 84, zenjpeg::encoder::ChromaSubsampling::Quarter)?;
                    std::fs::write(root.join("600.jpg"), jpg).map_err(|e| e.to_string())?;
                }
            }
            println!("{}", serde_json::json!({
                "decodeMs": (decoded-start).as_secs_f64()*1000.0,
                "linearMs": (linear-decoded).as_secs_f64()*1000.0,
                "orientMs": (oriented-linear).as_secs_f64()*1000.0,
                "tiersMs": oriented.elapsed().as_secs_f64()*1000.0,
            }));
        }
        _ => return Err("usage: heif-memory compare SOURCE.HIF LOSSLESS.tif | tiers SOURCE.HIF OUTDIR ORIENTATION | tiff-tiers LOSSLESS.tif OUTDIR ORIENTATION".into()),
    }
    Ok(())
}
fn main() -> ExitCode {
    match run(&std::env::args().skip(1).collect::<Vec<_>>()) {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => { eprintln!("heif-memory: {e}"); ExitCode::FAILURE }
    }
}
