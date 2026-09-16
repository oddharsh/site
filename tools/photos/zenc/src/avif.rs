//! The installed libavif, with the grid's existing avifenc settings.
use std::{ffi::{CStr, CString}, path::Path};

extern "C" {
    fn site_avif_encode(pixels: *const u8, width: u32, height: u32, gray: i32, path: *const std::ffi::c_char) -> i32;
    fn site_avif_version(out: *mut std::ffi::c_char, size: usize);
}

#[allow(dead_code)] // The benchmark example needs encoding but not CLI version reporting.
pub fn version() -> String {
    let mut buffer = [0; 512];
    // C writes at most buffer.len() bytes and always terminates the string.
    unsafe { site_avif_version(buffer.as_mut_ptr(), buffer.len()); }
    unsafe { CStr::from_ptr(buffer.as_ptr()) }.to_string_lossy().into_owned()
}

pub fn write(image: &image::DynamicImage, path: &Path) -> Result<(), String> {
    let gray = match image {
        image::DynamicImage::ImageLuma8(_) => true,
        image::DynamicImage::ImageRgb8(_) => false,
        _ => return Err("AVIF expects the production 8-bit gray or RGB tier".into()),
    };
    // RGB input is supported by libavif 1.0 as well as current builds. For gray
    // output the codec still receives YUV400; repeated RGB values add no chroma.
    let rgb = image.to_rgb8();
    let name = CString::new(path.as_os_str().as_encoded_bytes()).map_err(|e| e.to_string())?;
    // The adapter borrows this complete packed buffer for the duration of the
    // call. It frees its own allocations and retains no pointer into Rust.
    let failed = unsafe { site_avif_encode(rgb.as_raw().as_ptr(), image.width(), image.height(), i32::from(gray), name.as_ptr()) };
    if failed != 0 { return Err(format!("AVIF encode failed for {}", path.display())); }
    Ok(())
}
