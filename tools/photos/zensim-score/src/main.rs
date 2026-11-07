// zensim-score: zensim 0.2.7 and zensim's codec-target profile on one pair.
//
// zensim-probe.ts drives this beside libjxl's ssimulacra2 and butteraugli_main.
// Both zensim generations score the same decoded pixels in one process, so a
// difference between them is the metric and never the decoder.
//
//   zensim-score canon <in.(png|jpg|ppm)> <out.png>   8-bit RGB PNG, no ICC
//   zensim-score batch [--st]        stdin "ref\tdist" lines, 8-bit path
//   zensim-score score16 <ref> <dist> [--st] [--q8]   16-bit path
//
// batch prints, per line: ref dist, then for 0.2.7 and for B in turn
// `score raw approx_ssim2 approx_butteraugli compute_ms`, then decode_ms.
// score16 prints `z02_score z02_raw z02_ms zB_score zB_ms`.
//
// --st computes single-threaded. --q8 rounds both images to 8 bits before the
// 16-bit path sees them: the control for whether 16 bits reach the metric at
// all. On 8-bit inputs it is a no-op, and the 16-bit path agrees with the
// 8-bit one to 0.006 points (its sRGB curve is computed, not tabulated).
use std::io::{BufRead, Write};
use std::time::Instant;

type Rgb8 = (Vec<[u8; 3]>, usize, usize);
type Rgba16Bytes = (Vec<u8>, usize, usize);

fn load8(p: &str) -> Rgb8 {
    let img = image::open(p).unwrap_or_else(|e| panic!("{p}: {e}")).to_rgb8();
    let (w, h) = (img.width() as usize, img.height() as usize);
    (img.pixels().map(|p| p.0).collect(), w, h)
}

fn load16(p: &str, q8: bool) -> Rgba16Bytes {
    let img = image::open(p).unwrap_or_else(|e| panic!("{p}: {e}")).to_rgba16();
    let (w, h) = (img.width() as usize, img.height() as usize);
    let mut v = img.into_raw();
    if q8 {
        for s in v.iter_mut() {
            *s = ((*s as u32 * 255 + 32767) / 65535 * 257) as u16;
        }
    }
    (v.iter().flat_map(|s| s.to_ne_bytes()).collect(), w, h)
}

fn ms(t: Instant) -> f64 {
    t.elapsed().as_secs_f64() * 1e3
}

fn score8(st: bool, r: &Rgb8, d: &Rgb8) -> String {
    assert_eq!((r.1, r.2), (d.1, d.2), "dimension mismatch");
    let z = z02::Zensim::new(z02::ZensimProfile::latest()).with_parallel(!st);
    let t = Instant::now();
    let a = z
        .compute(&z02::RgbSlice::new(&r.0, r.1, r.2), &z02::RgbSlice::new(&d.0, d.1, d.2))
        .unwrap();
    let a_ms = ms(t);
    let z = z03::Zensim::new(z03::ZensimProfile::codec_target()).with_parallel(!st);
    let t = Instant::now();
    let b = z
        .compute(&z03::RgbSlice::new(&r.0, r.1, r.2), &z03::RgbSlice::new(&d.0, d.1, d.2))
        .unwrap();
    let b_ms = ms(t);
    format!(
        "{:.4}\t{:.6}\t{:.4}\t{:.4}\t{a_ms:.2}\t{:.4}\t{:.6}\t{:.4}\t{:.4}\t{b_ms:.2}",
        a.score(),
        a.raw_distance(),
        a.approx_ssim2(),
        a.approx_butteraugli(),
        b.score(),
        b.raw_distance(),
        b.approx_ssim2(),
        b.approx_butteraugli(),
    )
}

fn score16(st: bool, r: &Rgba16Bytes, d: &Rgba16Bytes) -> String {
    assert_eq!((r.1, r.2), (d.1, d.2), "dimension mismatch");
    let (w, h) = (r.1, r.2);
    let a = {
        use z02::{AlphaMode, PixelFormat, StridedBytes};
        let s = StridedBytes::try_with_alpha_mode(&r.0, w, h, w * 8, PixelFormat::Srgb16Rgba, AlphaMode::Opaque).unwrap();
        let t = StridedBytes::try_with_alpha_mode(&d.0, w, h, w * 8, PixelFormat::Srgb16Rgba, AlphaMode::Opaque).unwrap();
        let z = z02::Zensim::new(z02::ZensimProfile::latest()).with_parallel(!st);
        let t0 = Instant::now();
        let res = z.compute(&s, &t).unwrap();
        format!("{:.4}\t{:.6}\t{:.2}", res.score(), res.raw_distance(), ms(t0))
    };
    let b = {
        use z03::{AlphaMode, PixelFormat, StridedBytes};
        let s = StridedBytes::try_with_alpha_mode(&r.0, w, h, w * 8, PixelFormat::Srgb16Rgba, AlphaMode::Opaque).unwrap();
        let t = StridedBytes::try_with_alpha_mode(&d.0, w, h, w * 8, PixelFormat::Srgb16Rgba, AlphaMode::Opaque).unwrap();
        let z = z03::Zensim::new(z03::ZensimProfile::codec_target()).with_parallel(!st);
        let t0 = Instant::now();
        let res = z.compute(&s, &t).unwrap();
        format!("{:.4}\t{:.2}", res.score(), ms(t0))
    };
    format!("{a}\t{b}")
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let st = args.iter().any(|a| a == "--st");
    let q8 = args.iter().any(|a| a == "--q8");
    let pos: Vec<&str> = args.iter().filter(|a| !a.starts_with("--")).map(|a| a.as_str()).collect();
    match pos.as_slice() {
        ["canon", src, out] => {
            let img = image::open(src).unwrap_or_else(|e| panic!("{src}: {e}")).to_rgb8();
            img.save_with_format(out, image::ImageFormat::Png).unwrap();
        }
        ["score16", r, d] => println!("{}", score16(st, &load16(r, q8), &load16(d, q8))),
        ["batch"] => {
            // The reference repeats down a ladder, so it is decoded once per run of lines.
            let mut cache: Option<(String, Rgb8)> = None;
            let mut out = std::io::stdout().lock();
            for line in std::io::stdin().lock().lines() {
                let line = line.unwrap();
                let Some((rp, dp)) = line.split_once('\t') else { continue };
                let t = Instant::now();
                if cache.as_ref().is_none_or(|c| c.0 != rp) {
                    cache = Some((rp.to_string(), load8(rp)));
                }
                let d = load8(dp);
                let dec = ms(t);
                writeln!(out, "{rp}\t{dp}\t{}\t{dec:.2}", score8(st, &cache.as_ref().unwrap().1, &d)).unwrap();
            }
        }
        _ => {
            eprintln!("usage: zensim-score canon <in> <out.png> | batch [--st] | score16 <ref> <dist> [--st] [--q8]");
            std::process::exit(2);
        }
    }
}
