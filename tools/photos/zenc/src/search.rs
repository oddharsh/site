//! Adaptive JPEG byte-budget search with one decoded reference.
use image::DynamicImage;
use zenjpeg::encoder::ChromaSubsampling;

struct Best { q: u8, jpeg: Vec<u8> }

fn search(image: &DynamicImage, target: usize, chroma: ChromaSubsampling, mut lo: u8, mut hi: u8) -> Result<Best, String> {
    let mut best: Option<Best> = None;
    while lo <= hi {
        let q = lo + (hi - lo) / 2;
        let jpeg = crate::jpeg::encode(image, q, chroma)?;
        let size = jpeg.len();
        // Strict comparison preserves the first attempt on a tie, exactly as
        // gen-pixel-peeper's other encoder searches do. No monotonicity claim:
        // the winner is the closest VISITED quality, not a global optimum.
        if best.as_ref().is_none_or(|b| size.abs_diff(target) < b.jpeg.len().abs_diff(target)) {
            best = Some(Best { q, jpeg });
        }
        if size > target { hi = q - 1; }
        else if size < target { lo = q + 1; }
        else { break; }
    }
    best.ok_or_else(|| "empty quality range".into())
}

fn execute(args: &[String]) -> Result<(), String> {
    if args.len() != 6 {
        return Err("usage: zenc jpeg-search INPUT OUTPUT TARGET_BYTES YUV MIN_Q MAX_Q".into());
    }
    let target: usize = args[2].parse().map_err(|_| "TARGET_BYTES must be a positive integer")?;
    let chroma = match args[3].as_str() {
        "420" => ChromaSubsampling::Quarter,
        "422" => ChromaSubsampling::HalfHorizontal,
        "444" => ChromaSubsampling::None,
        _ => return Err("YUV takes 420, 422, or 444".into()),
    };
    let lo: u8 = args[4].parse().map_err(|_| "MIN_Q must be 1..100")?;
    let hi: u8 = args[5].parse().map_err(|_| "MAX_Q must be 1..100")?;
    if target == 0 || lo == 0 || lo > hi || hi > 100 {
        return Err("TARGET_BYTES must be positive and 1 <= MIN_Q <= MAX_Q <= 100".into());
    }
    let image = image::open(&args[0]).map_err(|e| format!("cannot read {}: {e}", args[0]))?;
    let best = search(&image, target, chroma, lo, hi)?;
    std::fs::write(&args[1], &best.jpeg).map_err(|e| format!("cannot write {}: {e}", args[1]))?;
    println!("{}", serde_json::json!({"q": best.q, "bytes": best.jpeg.len()}));
    Ok(())
}

pub fn run(args: &[String]) -> i32 {
    match execute(args) {
        Ok(()) => 0,
        Err(e) => { eprintln!("zenc jpeg-search: {e}"); 1 }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn exact_target_and_single_quality_keep_encoder_bytes() {
        let image = DynamicImage::ImageRgb8(image::RgbImage::from_fn(19, 17, |x,y| image::Rgb([(x*11) as u8, (y*13) as u8, ((x+y)*7) as u8])));
        for chroma in [ChromaSubsampling::Quarter, ChromaSubsampling::HalfHorizontal, ChromaSubsampling::None] {
            let expected = crate::jpeg::encode(&image, 52, chroma).unwrap();
            let best = search(&image, expected.len(), chroma, 5, 100).unwrap();
            assert_eq!(best.q, 52);
            assert_eq!(best.jpeg, expected);
            assert_eq!(search(&image, 1, chroma, 52, 52).unwrap().jpeg, expected);
        }
    }
    #[test]
    fn invalid_ranges_fail_before_read_or_write() {
        for (target, lo, hi) in [(0,5,100), (1,0,100), (1,90,80), (1,5,101)] {
            let args = ["missing".into(), "must-not-write".into(), target.to_string(), "420".into(), lo.to_string(), hi.to_string()];
            assert!(execute(&args).unwrap_err().starts_with("TARGET_BYTES"));
        }
    }
}
