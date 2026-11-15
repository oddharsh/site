// photo-metrics: SSIMULACRA2 and butteraugli for hif-archive.ts, and through
// photo-metrics.ts and export-for-instagram.sh for every other photo tool.
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

/// The PNG chunk that would make libjxl's tools read this file's colours
/// differently from photo-metrics, which decodes every PNG as plain sRGB.
/// libjxl takes cICP first, then iCCP, then sRGB, then gAMA and cHRM, so gAMA
/// and cHRM beside an sRGB chunk change nothing; djxl writes all three on every
/// decode, and sips and ImageIO write a bare sRGB. Measured 2026-11-14 against
/// libjxl 0.13.0 on a 1024px crop and its q60 encode, same pixels, only the tag
/// spliced in: sRGB at any intent, alone or beside gAMA and cHRM of any value,
/// scored exactly as untagged, while gAMA alone moved libjxl's ssimulacra2 by
/// 4.15 to 6.08 and a Display P3 cHRM or cICP by 0.28 (gotcha 101).
fn colour_chunk(png: &[u8]) -> Option<&'static str> {
    let mut rest = png.strip_prefix(b"\x89PNG\r\n\x1a\n")?;
    let (mut srgb, mut fallback) = (false, None);
    while rest.len() >= 8 {
        let len = u32::from_be_bytes([rest[0], rest[1], rest[2], rest[3]]) as usize;
        match &rest[4..8] {
            b"cICP" => return Some("cICP"),
            b"iCCP" => return Some("iCCP"),
            b"sRGB" => srgb = true,
            b"gAMA" => fallback = fallback.or(Some("gAMA")),
            b"cHRM" => fallback = fallback.or(Some("cHRM")),
            // The PNG spec puts every colour chunk before the first IDAT.
            b"IDAT" => break,
            _ => {}
        }
        rest = rest.get(12 + len..).unwrap_or_default();
    }
    if srgb { None } else { fallback }
}

fn load(path: &str) -> Result<Rgb16, String> {
    let bytes = std::fs::read(path).map_err(|e| format!("{path}: {e}"))?;
    if let Some(chunk) = colour_chunk(&bytes) {
        return Err(format!(
            "{path} carries {chunk}, a colour chunk libjxl's tools honour and photo-metrics would read as plain sRGB; write it untagged or with a bare sRGB chunk"
        ));
    }
    let img = image::load_from_memory(&bytes).map_err(|e| format!("{path}: {e}"))?.to_rgb16();
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

#[cfg(test)]
mod tests {
    use super::run;
    use std::path::PathBuf;

    fn crc32(bytes: &[u8]) -> u32 {
        let mut crc = !0u32;
        for &b in bytes {
            crc ^= b as u32;
            for _ in 0..8 {
                crc = (crc >> 1) ^ (0xEDB8_8320 & (crc & 1).wrapping_neg());
            }
        }
        !crc
    }

    fn chunk(kind: &[u8; 4], data: &[u8]) -> Vec<u8> {
        let body = [kind.as_slice(), data].concat();
        [&(data.len() as u32).to_be_bytes()[..], &body, &crc32(&body).to_be_bytes()].concat()
    }

    /// A 64x64 PNG from `image`'s encoder, which writes no colour chunk, with
    /// `extra` spliced in after IHDR. The pixels never change, only the tag.
    fn png(name: &str, shift: u8, extra: &[Vec<u8>]) -> String {
        let img = image::RgbImage::from_fn(64, 64, |x, y| image::Rgb([(x * 4) as u8, (y * 4) as u8, ((x + y) as u8).wrapping_add(shift)]));
        let mut bytes = Vec::new();
        img.write_to(&mut std::io::Cursor::new(&mut bytes), image::ImageFormat::Png).unwrap();
        let ihdr_end = 8 + 12 + 13;
        let spliced = [&bytes[..ihdr_end], &extra.concat(), &bytes[ihdr_end..]].concat();
        let path: PathBuf = std::env::temp_dir().join(format!("photo-metrics-test-{}-{name}.png", std::process::id()));
        std::fs::write(&path, spliced).unwrap();
        path.to_str().unwrap().to_owned()
    }

    fn pair(name: &str, extra: &[Vec<u8>]) -> Result<String, String> {
        run(&png(&format!("{name}-ref"), 0, extra), &png(&format!("{name}-dist"), 9, extra))
    }

    fn srgb() -> Vec<u8> {
        chunk(b"sRGB", &[1])
    }
    fn gama() -> Vec<u8> {
        chunk(b"gAMA", &45455u32.to_be_bytes())
    }
    fn chrm() -> Vec<u8> {
        let v: [u32; 8] = [31270, 32900, 64000, 33000, 30000, 60000, 15000, 6000];
        chunk(b"cHRM", &v.iter().flat_map(|x| x.to_be_bytes()).collect::<Vec<_>>())
    }

    #[test]
    fn scores_srgb_tags_exactly_as_untagged() {
        let untagged = pair("untagged", &[]).unwrap();
        assert!(untagged.starts_with("{\"s2\":"), "{untagged}");
        assert_eq!(pair("srgb", &[srgb()]).unwrap(), untagged);
        // What djxl writes on every decode hif-archive.ts scores.
        assert_eq!(pair("djxl", &[srgb(), gama(), chrm()]).unwrap(), untagged);
    }

    #[test]
    fn refuses_a_colour_chunk_libjxl_would_honour() {
        for (name, extra, kind) in [
            ("gama", vec![gama()], "gAMA"),
            ("chrm", vec![chrm()], "cHRM"),
            ("iccp", vec![chunk(b"iCCP", b"Display P3\0\0x")], "iCCP"),
            ("iccp-srgb", vec![srgb(), chunk(b"iCCP", b"Display P3\0\0x")], "iCCP"),
            ("cicp", vec![chunk(b"cICP", &[12, 13, 0, 1])], "cICP"),
        ] {
            let err = pair(name, &extra).unwrap_err();
            assert!(err.ends_with(&format!("photo-metrics-test-{}-{name}-ref.png carries {kind}, a colour chunk libjxl's tools honour and photo-metrics would read as plain sRGB; write it untagged or with a bare sRGB chunk", std::process::id())), "{err}");
        }
    }
}
