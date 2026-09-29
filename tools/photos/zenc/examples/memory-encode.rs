//! Experimental photo front end. Reuses production pixels/geometry/JPEG code.
//! `memory-encode tiers INPUT OUTDIR ORIENTATION` writes 600/400/200 AVIF and 600 JPEG.
//! `memory-encode jpeg-batch INPUT OUTDIR Q...` decodes once across quality trials.
//! The AVIF path delegates to the production encoder. This example retains the
//! original benchmark interface and the separate JPEG trial experiment.
#[allow(dead_code)]
#[path = "../src/pixels.rs"]
mod pixels;
#[allow(dead_code)]
#[path = "../src/square.rs"]
mod square;
#[path = "../src/jpeg.rs"]
mod jpeg;
#[path = "../src/avif.rs"]
mod avif;
use std::{path::Path, process::ExitCode};
use zenjpeg::encoder::ChromaSubsampling;

fn run(args: &[String]) -> Result<(), String> {
    if args.len() < 4 { return Err("usage: memory-encode tiers INPUT OUTDIR ORIENTATION | jpeg-batch INPUT OUTDIR Q...".into()); }
    let root = Path::new(&args[2]);
    match args[0].as_str() {
        "tiers" => {
            if args.len() != 4 { return Err("tiers expects INPUT OUTDIR ORIENTATION".into()); }
            let orientation = args[3].parse::<u8>().map_err(|e| e.to_string())?;
            let orientation = pixels::Orientation::try_from(orientation)?;
            let src = pixels::orient(pixels::load_linear(&args[1], pixels::TransferOption::Auto)?, orientation);
            std::fs::create_dir_all(root).map_err(|e| e.to_string())?;
            for size in [600, 400, 200] {
                let tier = square::tier(&src, pixels::Orientation::Upright, size, halflight::Filter::Box);
                avif::write(&tier, &root.join(format!("{size}.avif")))?;
                if size == 600 {
                    let encoded = jpeg::encode(&tier, 84, ChromaSubsampling::Quarter)?;
                    std::fs::write(root.join("600.jpg"), encoded).map_err(|e| e.to_string())?;
                }
            }
        }
        "jpeg-batch" => {
            let qualities = args[3..].iter().map(|q| q.parse::<u8>().map_err(|e| e.to_string()))
                .collect::<Result<Vec<_>, _>>()?;
            if qualities.iter().any(|q| !(1..=100).contains(q)) { return Err("quality must be 1..100".into()); }
            let image = image::open(&args[1]).map_err(|e| e.to_string())?;
            std::fs::create_dir_all(root).map_err(|e| e.to_string())?;
            for q in qualities {
                let encoded = jpeg::encode(&image, q, ChromaSubsampling::Quarter)?;
                std::fs::write(root.join(format!("{q}.jpg")), encoded).map_err(|e| e.to_string())?;
            }
        }
        _ => return Err("expected tiers or jpeg-batch".into()),
    }
    Ok(())
}
fn main() -> ExitCode {
    match run(&std::env::args().skip(1).collect::<Vec<_>>()) {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => { eprintln!("{e}"); ExitCode::FAILURE }
    }
}
