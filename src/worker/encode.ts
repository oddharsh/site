// encode.js — what did your encoder actually do?
//
// ── why this fits in a Worker at all ──────────────────────────────────────
// Cloudflare Images cannot take HEIC without Enterprise and cannot take RAW at
// all, and a Worker has no decoder. That blocked every "resize my photo" idea.
//
// But none of the interesting questions about an encode need PIXELS. They are all
// answered by the container: a JPEG's quantization tables, its scan script, its
// component sampling factors; an AVIF's av1C configuration record. Reading those
// is byte walking — microseconds, no decoder, comfortably inside the free plan's
// 10ms. The blocker was never "images are hard", it was "decoding is hard", and
// these two are not the same problem.
//
// ── what it is FOR ────────────────────────────────────────────────────────
// This site has spent real effort on delivery encoding: zenc (zenjpeg hybrid
// trellis + 64-candidate progressive scan search), 10-bit AVIF for a free ~6%,
// the 4:2:2 archive decision and the butteraugli/ssimulacra2 disagreement behind
// it, and /pixel-peeper's thesis that 4:4:4 is a byte tax nobody can see. All of
// that knowledge is currently locked in prose. This turns it into a verdict on
// a file somebody else made.
//
// ── the honesty rule, again ───────────────────────────────────────────────
// Quality is ESTIMATED and says so. There is no quality number in a JPEG — only
// quantization tables — and every "quality: 82" any tool prints is an inference
// from those tables. The method is named in the output so the number can be
// argued with rather than believed.
import { COLS, blank, fit, kv, rows, rule, s, wrap } from "./lib/tui.ts";

const INNER = COLS - 4;

// Markers live in the first few KB, but a PROGRESSIVE file spreads its scans
// through the whole thing, so counting them means walking further. 1MB bounds
// the walk; past that the scan count reports as a floor rather than a total.
export const ENCODE_CAP = 1024 * 1024;

// The IJG Annex K luma table. libjpeg and everything derived from it scales this
// by quality; mozjpeg and jpegli ship their own tuned tables. Comparing against
// it is how "standard table at ~q80" gets distinguished from "custom table",
// which is a real signal about which encoder made the file.
const ANNEX_K_LUMA = [
  16, 11, 10, 16, 24, 40, 51, 61, 12, 12, 14, 19, 26, 58, 60, 55,
  14, 13, 16, 24, 40, 57, 69, 56, 14, 17, 22, 29, 51, 87, 80, 62,
  18, 22, 37, 56, 68, 109, 103, 77, 24, 35, 55, 64, 81, 104, 113, 92,
  49, 64, 78, 87, 103, 121, 120, 101, 72, 92, 95, 98, 112, 100, 103, 99,
];

/**
 * Estimate quality by asking which Annex K scaling best explains this table.
 *
 * This is the standard inference (the one libjpeg's own scaling defines in
 * reverse) and it is only meaningful for tables that ARE scaled Annex K. When
 * the residual is large the table is custom, and the honest answer is to say so
 * rather than print a confident number derived from the wrong model.
 */
export function estimateQuality(table) {
  let best = { quality: null, residual: Infinity };
  for (let q = 1; q <= 100; q++) {
    const scale = q < 50 ? 5000 / q : 200 - q * 2;
    let residual = 0;
    for (let i = 0; i < 64; i++) {
      const want = Math.min(255, Math.max(1, Math.floor((ANNEX_K_LUMA[i] * scale + 50) / 100)));
      residual += Math.abs(want - table[i]);
    }
    if (residual < best.residual) best = { quality: q, residual };
  }
  // Mean absolute deviation per coefficient. Under ~1 is a match; a genuinely
  // custom table lands far above it.
  const mad = best.residual / 64;
  return { quality: best.quality, mad, standard: mad < 1.0 };
}

const SUBSAMPLING = { "2,2": "4:2:0", "2,1": "4:2:2", "1,1": "4:4:4", "1,2": "4:4:0", "4,1": "4:1:1" };

/**
 * Walk JPEG markers. Pure byte reading — no decode, no allocation per pixel.
 *
 * Returns what the container SAYS. Anything it cannot determine is left null
 * rather than guessed, the same discipline the photo pipeline applies to EXIF.
 */
export function parseJpeg(bytes) {
  const out = {
    format: "jpeg", width: null, height: null, progressive: null, scans: 0,
    subsampling: null, components: null, precision: null, tables: [],
    icc: false, exif: false, xmp: false, jfif: false, restartInterval: null,
    truncated: false, comments: [],
  };
  let i = 2;   // past SOI
  const u16 = (at) => (bytes[at] << 8) | bytes[at + 1];

  while (i < bytes.length - 1) {
    if (bytes[i] !== 0xFF) { i++; continue; }
    const marker = bytes[i + 1];
    if (marker === 0xFF || marker === 0x00) { i++; continue; }
    if (marker === 0xD9) break;                       // EOI
    if (marker >= 0xD0 && marker <= 0xD7) { i += 2; continue; }   // RSTn

    const length = u16(i + 2);
    const payload = i + 4;

    if (marker === 0xDB) {                            // DQT
      let p = payload;
      while (p < payload + length - 2) {
        const spec = bytes[p];
        const precision = spec >> 4;
        const values = [];
        for (let k = 0; k < 64; k++) values.push(precision ? u16(p + 1 + k * 2) : bytes[p + 1 + k]);
        out.tables.push({ id: spec & 0x0F, precision, values });
        p += 1 + (precision ? 128 : 64);
      }
    } else if (marker === 0xC0 || marker === 0xC1 || marker === 0xC2) {
      out.progressive = marker === 0xC2;
      out.precision = bytes[payload];
      out.height = u16(payload + 1);
      out.width = u16(payload + 3);
      const n = bytes[payload + 5];
      out.components = n;
      if (n >= 1) {
        const h = bytes[payload + 7] >> 4, v = bytes[payload + 7] & 0x0F;
        out.subsampling = n === 1 ? "grayscale" : (SUBSAMPLING[`${h},${v}`] || `${h}x${v}`);
      }
    } else if (marker === 0xDA) {
      out.scans += 1;
      // Entropy-coded data follows and contains 0xFF00 stuffing. Skip to the
      // next real marker rather than trusting a length field that is not there.
      let p = payload + length - 2;
      while (p < bytes.length - 1) {
        if (bytes[p] === 0xFF && bytes[p + 1] !== 0x00 && !(bytes[p + 1] >= 0xD0 && bytes[p + 1] <= 0xD7)) break;
        p++;
      }
      i = p;
      continue;
    } else if (marker === 0xDD) {
      out.restartInterval = u16(payload);
    } else if (marker === 0xE0) { out.jfif = true; }
    else if (marker === 0xE1) {
      const tag = String.fromCharCode(...bytes.slice(payload, payload + 4));
      if (tag === "Exif") out.exif = true;
      if (tag === "http") out.xmp = true;
    } else if (marker === 0xE2) {
      if (String.fromCharCode(...bytes.slice(payload, payload + 4)) === "ICC_") out.icc = true;
    } else if (marker === 0xFE) {
      out.comments.push(String.fromCharCode(...bytes.slice(payload, Math.min(payload + 40, payload + length - 2))));
    }
    i += 2 + length;
  }
  return out;
}

/**
 * Read an AVIF's av1C configuration record out of the ISOBMFF box tree.
 *
 * Same trick as EXIF-in-HEIF: the interesting facts are in a box, not in the
 * pixels. Deliberately shallow — brand, bit depth, subsampling, alpha — because
 * anything deeper starts wanting a real parser and this is a lint, not a demuxer.
 */
export function parseAvif(bytes) {
  const out = { format: "avif", brand: null, bitDepth: null, subsampling: null, monochrome: null, alpha: false };
  const ascii = (at, n) => String.fromCharCode(...bytes.slice(at, at + n));
  if (ascii(4, 4) !== "ftyp") return null;
  out.brand = ascii(8, 4);

  // Scan for the av1C box rather than walking the full tree: it is a leaf deep
  // inside meta/iprp/ipco, and locating it by signature is honest here because a
  // false positive would have to be four exact bytes followed by a valid record.
  for (let i = 0; i < bytes.length - 8; i++) {
    if (ascii(i, 4) !== "av1C") continue;
    const p = i + 4;
    // av1C: marker+version, seq_profile+seq_level_idx_0, then the flags byte
    const b2 = bytes[p + 2];
    out.monochrome = !!(b2 & 0x10);
    const high = !!(b2 & 0x40), twelve = !!(b2 & 0x20);
    out.bitDepth = high ? (twelve ? 12 : 10) : 8;
    const subX = !!(b2 & 0x08), subY = !!(b2 & 0x04);
    out.subsampling = out.monochrome ? "grayscale"
      : subX && subY ? "4:2:0" : subX ? "4:2:2" : "4:4:4";
    break;
  }
  if (bytes.length) {
    // An alpha plane shows up as an auxiliary item; the tag is enough for a lint.
    for (let i = 0; i < bytes.length - 4; i++) {
      if (ascii(i, 4) === "auxC") { out.alpha = true; break; }
    }
  }
  return out.bitDepth === null ? null : out;
}

// ── the verdicts, which are where this site's measurements pay off ─────────
export function judgeEncode(info, byteLength) {
  const findings = [];
  const add = (id, verdict, detail) => findings.push({ id, verdict, detail });
  const pixels = info.width && info.height ? info.width * info.height : null;
  const bpp = pixels ? (byteLength * 8) / pixels : null;

  if (info.format === "jpeg") {
    // 4:4:4 is the one that costs real bytes for chroma detail nobody can see at
    // delivery sizes — /pixel-peeper's whole thesis. 4:2:2 is the deliberate
    // ARCHIVE choice here (Fuji HIF is 4:2:2 native), so it is not a fault.
    if (info.subsampling === "4:4:4") {
      add("chroma", "warn", "4:4:4 — full chroma resolution. At delivery sizes this is a byte tax for detail the eye does not resolve; 4:2:0 is usually free.");
    } else if (info.subsampling === "4:2:2") {
      add("chroma", "ok", "4:2:2 — the archive choice (and what a Fuji HIF is natively). Defensible for masters, more than delivery needs.");
    } else if (info.subsampling === "4:2:0") {
      add("chroma", "ok", "4:2:0 — the right default for delivery");
    } else if (info.subsampling) {
      add("chroma", "ok", info.subsampling);
    }

    // Progressive is free bytes and this site searches 64 scan scripts for them.
    if (info.progressive === true) {
      add("scan", "ok", `progressive, ${info.scans} scan${info.scans === 1 ? "" : "s"}${info.truncated ? "+ (walk truncated)" : ""} — typically several percent smaller than baseline at equal quality`);
    } else if (info.progressive === false) {
      add("scan", "warn", "baseline. Progressive is usually a few percent smaller at identical quality and costs nothing but encoder time.");
    }

    const luma = info.tables.find((t) => t.id === 0);
    if (luma) {
      const q = estimateQuality(luma.values);
      if (q.standard) {
        add("quality", "ok", `~q${q.quality} against the IJG Annex K table (deviation ${q.mad.toFixed(2)}/coefficient) — a libjpeg-family encoder`);
      } else {
        add("quality", "ok", `custom quantization table, closest Annex K fit ~q${q.quality} but deviation ${q.mad.toFixed(2)}/coefficient. Tuned encoder: mozjpeg, jpegli, zenjpeg or similar.`);
      }
    }

    const metaBytes = [];
    if (info.icc) metaBytes.push("ICC");
    if (info.exif) metaBytes.push("EXIF");
    if (info.xmp) metaBytes.push("XMP");
    add("metadata", metaBytes.length ? "warn" : "ok",
      metaBytes.length
        ? `carries ${metaBytes.join(", ")} — fine for an archive, dead weight on a thumbnail`
        : "stripped, which is what a delivery tier wants");
  }

  if (info.format === "avif") {
    if (info.bitDepth === 8) {
      add("depth", "warn", "8-bit. 10-bit AVIF measured ~6% smaller at equal quality on this site's corpus, for free — the extra depth improves the transform, it does not cost bytes.");
    } else if (info.bitDepth) {
      add("depth", "ok", `${info.bitDepth}-bit — the free win; 10-bit beats 8-bit at equal quality`);
    }
    if (info.subsampling === "4:4:4") add("chroma", "warn", "4:4:4 — same byte tax as in JPEG, and rarely worth it at delivery sizes");
    else if (info.subsampling) add("chroma", "ok", info.subsampling);
    if (info.brand) add("brand", "ok", info.brand);
  }

  if (bpp !== null) {
    // Bytes per pixel is the number this site's own pipeline is tuned against,
    // so it is reported as an anchor rather than graded — a portrait at 0.9 and
    // a flat graphic at 0.9 are not the same story.
    add("density", "ok", `${bpp.toFixed(2)} bits/pixel over ${info.width}x${info.height}`);
  }

  return { findings, warns: findings.filter((f) => f.verdict === "warn") };
}

export function encodeReadout(info, byteLength) {
  const { findings, warns } = judgeEncode(info, byteLength);
  const MARK = { ok: "  ok  ", warn: " warn " };
  return rows(
    kv("format", info.format, INNER, { gutter: 14 }),
    kv("dimensions", info.width ? `${info.width} x ${info.height}` : null, INNER, { gutter: 14 }),
    kv("bytes", byteLength.toLocaleString(), INNER, { gutter: 14 }),
    info.truncated ? [s("  (read the first 1 MB — scan count is a floor, not a total)", "warn")] : blank(),
    blank(),
    rule(INNER, "what the encoder did"),
    ...findings.map((f) => [
      s(MARK[f.verdict] || "  ??  ", f.verdict === "warn" ? "warn" : "ok"),
      ...fit([s(f.id, "strong")], 12),
      s(f.detail, "dim"),
    ]),
    blank(),
    warns.length
      ? [s(`  ${warns.length} thing${warns.length === 1 ? "" : "s"} worth changing, above.`, "warn")]
      : [s("  Nothing here is leaving bytes on the table.", "ok")],
    blank(),
    ...wrap("No pixels were decoded. Every fact above comes from the container — quantization tables, the scan script, component sampling factors, the av1C record — which is why this runs in a Worker at all.", INNER).map((row) => [s(row, "dim")]),
  );
}

/**
 * Fetch an image as BYTES, bounded.
 *
 * Deliberately not lensReadCapped, which returns TEXT: decoding image bytes as
 * UTF-8 replaces every invalid sequence with U+FFFD, so a quantization table
 * would arrive as mojibake and the parse would silently read garbage. Binary
 * needs a binary reader, and the failure mode of getting this wrong is a
 * confident wrong verdict rather than an error.
 */
export async function fetchImageBytes(url, env, lensFetch) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await lensFetch(url, env, controller.signal, "image/avif,image/jpeg,image/*;q=0.8");
    if (!res.ok) return { ok: false, why: `HTTP ${res.status}` };
    const type = (res.headers.get("content-type") || "").split(";")[0].trim();
    const reader = res.body?.getReader();
    if (!reader) return { ok: false, why: "no body" };
    const chunks = [];
    let total = 0, truncated = false;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.length;
      if (total >= ENCODE_CAP) { truncated = true; try { await reader.cancel(); } catch { /* done */ } break; }
    }
    const bytes = new Uint8Array(total);
    let at = 0;
    for (const c of chunks) { bytes.set(c.subarray(0, Math.min(c.length, total - at)), at); at += c.length; if (at >= total) break; }
    return { ok: true, bytes, type, truncated, declaredLength: Number(res.headers.get("content-length")) || total };
  } catch (error) {
    return { ok: false, unreadable: true, why: String(error?.message || error).slice(0, 80) };
  } finally { clearTimeout(timer); }
}

/** Sniff the container from magic bytes rather than trusting content-type. */
export function sniff(bytes) {
  if (bytes.length > 3 && bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF) return "jpeg";
  if (bytes.length > 12 && String.fromCharCode(...bytes.slice(4, 8)) === "ftyp") {
    const brand = String.fromCharCode(...bytes.slice(8, 12));
    if (brand.startsWith("avif") || brand.startsWith("avis")) return "avif";
    if (brand.startsWith("heic") || brand.startsWith("heix") || brand.startsWith("mif1")) return "heif";
    return "isobmff";
  }
  if (bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50) return "png";
  if (bytes.length > 12 && String.fromCharCode(...bytes.slice(8, 12)) === "WEBP") return "webp";
  return null;
}
