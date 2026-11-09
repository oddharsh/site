// jixel-enc: hif-archive.ts's lossy JPEG XL encoder.
//
//   jixel-enc <in.png> <out.jxl> <distance>
//
// Reads an 8- or 16-bit RGB PNG and writes jixel's Speed::Slow encode with
// progressive DC on and progressive AC off. Its iCCP profile is carried over.
// When the PNG has an eXIf chunk, its orientation goes into the codestream
// header and the whole chunk into a raw `Exif` box, which makes the output a
// container: exif-sooc refuses a bare codestream ("has no box to hold
// metadata"), and it cannot read a Brotli `brob` box, so none is written.
use jixel::{EncodeConfig, Orientation, Speed};
use std::process::ExitCode;

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let [input, output, distance] = args.as_slice() else {
        eprintln!("usage: jixel-enc <in.png> <out.jxl> <distance>");
        return ExitCode::from(2);
    };
    match encode(input, output, distance) {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("jixel-enc: {input}: {e}");
            ExitCode::FAILURE
        }
    }
}

fn encode(input: &str, output: &str, distance: &str) -> Result<(), String> {
    let distance: f32 = distance.parse().map_err(|_| format!("distance {distance:?} is not a number"))?;
    let png = std::fs::read(input).map_err(|e| e.to_string())?;
    let out = encode_png(&png, distance)?;
    std::fs::write(output, out).map_err(|e| format!("write {output}: {e}"))
}

/// The archive settings. progressive_dc stores the 1:8 LF image as its own
/// squeezed frame, which is what lets Chrome paint a whole frame from the
/// first 8 to 11 KB; jixel's `progressive` only reorders AC and paints no
/// earlier than a plain encode (measured 2026-10-17, docs/PHOTO-PIPELINE.md).
fn config(distance: f32) -> EncodeConfig {
    EncodeConfig::default()
        .with_distance(distance)
        .with_speed(Speed::Slow)
        .with_progressive_dc(true)
        .with_progressive(false)
}

fn encode_png(png: &[u8], distance: f32) -> Result<Vec<u8>, String> {
    let mut decoder = png::Decoder::new(std::io::Cursor::new(png));
    decoder.set_transformations(png::Transformations::IDENTITY);
    let mut reader = decoder.read_info().map_err(|e| e.to_string())?;
    let icc = reader.info().icc_profile.as_ref().map(|c| c.to_vec());
    let mut buf = vec![0; reader.output_buffer_size().ok_or("PNG too large")?];
    let frame = reader.next_frame(&mut buf).map_err(|e| e.to_string())?;
    if frame.color_type != png::ColorType::Rgb {
        return Err(format!("{:?} PNG; only RGB is supported", frame.color_type));
    }
    let (w, h) = (frame.width as usize, frame.height as usize);
    let pixels = &buf[..frame.buffer_size()];

    let mut cfg = config(distance);
    if let Some(icc) = icc {
        cfg = cfg.with_icc_profile(icc);
    }
    if let Some(tiff) = exif_chunk(png) {
        if let Some(o) = tiff_orientation(tiff).and_then(Orientation::from_exif) {
            cfg = cfg.with_orientation(o);
        }
        cfg = cfg.with_exif(tiff.to_vec());
    }
    match frame.bit_depth {
        png::BitDepth::Sixteen => {
            let px: Vec<u16> = pixels.as_chunks::<2>().0.iter().map(|c| u16::from_be_bytes(*c)).collect();
            jixel::encode_image_16bit(&px, w, h, &cfg)
        }
        png::BitDepth::Eight => jixel::encode_image(pixels, w, h, &cfg),
        d => return Err(format!("{d:?}-bit PNG; only 8 and 16 are supported")),
    }
    .map_err(|e| format!("{e:?}"))
}

/// The payload of a PNG's eXIf chunk: raw TIFF bytes starting at the II/MM
/// byte-order mark. png 0.17 only writes this chunk; its decoder never fills
/// `Info::exif_metadata`, so the chunks are walked here (gotcha 95).
fn exif_chunk(png: &[u8]) -> Option<&[u8]> {
    let mut i = 8;
    while i + 8 <= png.len() {
        let len = u32::from_be_bytes(png[i..i + 4].try_into().ok()?) as usize;
        let kind = &png[i + 4..i + 8];
        let body = png.get(i + 8..i + 8 + len)?;
        if kind == b"eXIf" {
            return Some(body);
        }
        if kind == b"IDAT" || kind == b"IEND" {
            // eXIf must precede IDAT (PNG 3rd edition), so stop at the pixels.
            return None;
        }
        i += 12 + len;
    }
    None
}

/// Tag 0x0112 (Orientation) from IFD0 of a TIFF stream, either byte order.
fn tiff_orientation(t: &[u8]) -> Option<u8> {
    let be = match t.get(..2)? {
        b"MM" => true,
        b"II" => false,
        _ => return None,
    };
    let u16_at = |o: usize| t.get(o..o + 2).map(|b| if be { u16::from_be_bytes([b[0], b[1]]) } else { u16::from_le_bytes([b[0], b[1]]) });
    let u32_at = |o: usize| {
        t.get(o..o + 4).map(|b| {
            let b = [b[0], b[1], b[2], b[3]];
            if be { u32::from_be_bytes(b) } else { u32::from_le_bytes(b) }
        })
    };
    let ifd = u32_at(4)? as usize;
    for n in 0..u16_at(ifd)? as usize {
        let entry = ifd + 2 + n * 12;
        // A SHORT value sits left-justified in the 4-byte value field.
        if u16_at(entry)? == 0x0112 && u16_at(entry + 2)? == 3 {
            return u8::try_from(u16_at(entry + 8)?).ok();
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A TIFF stream holding only IFD0 with one Orientation entry.
    fn tiff(be: bool, orientation: u16) -> Vec<u8> {
        // Header, 1 IFD entry (tag, type SHORT, count 1, value), next-IFD 0.
        let fields: [(u32, usize); 9] = [(42, 2), (8, 4), (1, 2), (0x0112, 2), (3, 2), (1, 4), (orientation as u32, 2), (0, 2), (0, 4)];
        let mut t = Vec::from(if be { b"MM" } else { b"II" });
        for (v, width) in fields {
            let bytes = if be { v.to_be_bytes() } else { v.to_le_bytes() };
            t.extend_from_slice(if be { &bytes[4 - width..] } else { &bytes[..width] });
        }
        t
    }

    /// A 16-bit RGB gradient PNG, with an eXIf chunk when `exif` is given.
    fn png16(w: u32, h: u32, exif: Option<&[u8]>) -> Vec<u8> {
        let mut out = Vec::new();
        let mut enc = png::Encoder::new(&mut out, w, h);
        enc.set_color(png::ColorType::Rgb);
        enc.set_depth(png::BitDepth::Sixteen);
        let mut wr = enc.write_header().unwrap();
        if let Some(e) = exif {
            wr.write_chunk(png::chunk::ChunkType(*b"eXIf"), e).unwrap();
        }
        let px: Vec<u8> = (0..w * h * 3).flat_map(|i| ((i * 97 % 65536) as u16).to_be_bytes()).collect();
        wr.write_image_data(&px).unwrap();
        wr.finish().unwrap();
        out
    }

    fn boxes(jxl: &[u8]) -> Vec<[u8; 4]> {
        let mut out = Vec::new();
        let mut o = 0;
        while o + 8 <= jxl.len() {
            let size = u32::from_be_bytes(jxl[o..o + 4].try_into().unwrap()) as usize;
            out.push(jxl[o + 4..o + 8].try_into().unwrap());
            o += size;
        }
        out
    }

    #[test]
    fn reads_orientation_in_both_byte_orders() {
        assert_eq!(tiff_orientation(&tiff(false, 8)), Some(8));
        assert_eq!(tiff_orientation(&tiff(true, 6)), Some(6));
        assert_eq!(tiff_orientation(b"XX\0*"), None);
    }

    #[test]
    fn finds_the_exif_chunk_png_0_17_will_not_decode() {
        let t = tiff(true, 8);
        assert_eq!(exif_chunk(&png16(16, 16, Some(&t))), Some(&t[..]));
        assert_eq!(exif_chunk(&png16(16, 16, None)), None);
    }

    #[test]
    fn exif_makes_a_container_with_a_raw_exif_box() {
        let with = encode_png(&png16(64, 48, Some(&tiff(false, 8))), 0.5).unwrap();
        assert_eq!(boxes(&with), [*b"JXL ", *b"ftyp", *b"jxll", *b"jxlc", *b"Exif"]);
        let without = encode_png(&png16(64, 48, None), 0.5).unwrap();
        assert_eq!(&without[..2], &[0xff, 0x0a]);
    }

    /// Gotcha 94: djxl's partial decode can't render the DC frame, so it reads
    /// progressive DC as doing nothing. Chrome paints from 8 KB with it on and
    /// waits for 750 KB to 1.4 MB without it.
    #[test]
    fn keeps_progressive_dc_on_and_progressive_ac_off() {
        let c = config(0.1);
        assert!(c.progressive_dc);
        assert!(!c.progressive);
        assert_eq!(c.speed, Speed::Slow);
        assert_eq!(c.distance, 0.1);
    }

    #[test]
    fn encodes_are_deterministic() {
        let png = png16(64, 48, None);
        assert_eq!(encode_png(&png, 0.3).unwrap(), encode_png(&png, 0.3).unwrap());
    }
}
