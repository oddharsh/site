#!/usr/bin/env bun
// hif-archive.ts — a HIF photo's full-resolution archive, as JPEG XL encoded
// from the HIF's own 10-bit pixels.
//
// THE BAR MOVED (2026-10-13). The sweep scored the baseline through djpeg,
// but visitors never decode that JPEG: R2 serves it repacked as JPEG XL, and
// a JPEG XL decoder rebuilds its coefficients more precisely. Through libjxl
// at 8 bits the same bytes score +1.9 to +3.5 ssimulacra2 higher than
// through djpeg (6 of 6 photos; XT509890 90.52 -> 93.36), and jxl-rs, which
// Chrome ships, lands within 0.05 of libjxl. The sweep also scored its
// candidates at 16 bits against that 8-bit baseline. Both sides are now
// decoded the way a browser paints them: libjxl, 8 bits, its default dither.
// Re-measured against that bar (2026-10-14, 118 of the 119; halves agree
// within a point): the median distance falls to d0.163, 99 photos shrink
// (median -9.4%), 19 cannot beat the bar without growing and keep their
// repack, and the bucket's HIF archives come to -8.6%, not -33%.
//
// WHAT. Score the baseline against the HIF, then bisect cjxl's distance for
// the LARGEST one (fewest bytes) whose encode beats the baseline on both
// metrics. Both scores worsen monotonically as distance grows on every photo
// swept, which is what makes bisection sound. If not even the floor distance
// wins, the archive stays what it was: the baseline repacked losslessly. Both
// metrics come from tools/photos/photo-metrics (see score()).
//
// HOW, and the traps each step avoids:
//   - The reference is sips's 16-bit decode with its eXIf and XMP chunks
//     stripped. sips copies the HIF's EXIF into the PNG, and cjxl would carry
//     its orientation into the encode, so djxl would rotate the decode and it
//     would no longer line up with the reference. (sips -r is no way out: it
//     drops a 16-bit image to 8 bits.)
//   - The baseline is scored as the file a visitor downloads: repacked
//     losslessly as JPEG XL and decoded by djxl at 8 bits. Its Exif segment
//     is dropped first, because cjxl would carry the camera's orientation
//     into the codestream and djxl would rotate the decode. Exif is metadata,
//     not coefficients, so the pixels are the served file's; all three are
//     compared in sensor orientation.
//   - Candidates decode at 8 bits too. A 16-bit decode scored against an
//     8-bit baseline flatters the candidate (XT509890's chosen file: 91.41
//     at 16 bits, 91.24 at 8).
//   - Candidates are encoded from that stripped reference. The FINAL file is
//     encoded once more from the unstripped PNG at the chosen distance, so its
//     codestream carries the camera's orientation, which is the field a
//     decoder obeys. Orientation is header metadata, not pixels, so the two
//     codestreams match in size to within a few bytes; a gap means the
//     pixels differed, and it fails the photo.
//   - sips keeps 40 of a Fujifilm HIF's 75 EXIF tags and drops every maker
//     note (film simulation, grain, dynamic range), so the HIF's own EXIF and
//     XMP are copied on with exif-sooc 0.4.0, which also refuses any file
//     whose JPEG rebuild it would break.
//   - --compress_boxes=0, because cjxl Brotli-compresses metadata by default
//     and exif-sooc (no dependencies) cannot read a compressed box. Costs
//     about 5 KB on a 12.5 MB frame.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ARGS = ["-e", "7", "-p", "--compress_boxes=0"];
export const RANGE = { lo: 0.1, hi: 0.6, floor: 0.05, tolerance: 0.025 };

export type Score = { s2: number; ba3: number };
export const beats = (a: Score, base: Score) => a.s2 > base.s2 && a.ba3 < base.ba3;

export async function searchDistance(wins: (d: number) => Promise<boolean>, r = RANGE): Promise<number | null> {
  let lo = r.lo, hi = r.hi;
  if (!(await wins(lo))) {
    if (!(await wins(r.floor))) return null;
    hi = lo; lo = r.floor;
  }
  if (await wins(hi)) return hi;
  while (hi - lo > r.tolerance) {
    const mid = Math.round(((lo + hi) / 2) * 1000) / 1000;
    if (await wins(mid)) lo = mid; else hi = mid;
  }
  return lo;
}

/** Copy a JPEG without its Exif APP1 segments, so the lossless repack carries
 *  no orientation. Every other segment, and the scan, is kept byte for byte.
 *  Anything that is not a JPEG has no Exif segment to drop and is copied as
 *  is: cjxl then encodes its pixels, which is still the bar that file sets,
 *  and the transcode fallback refuses it, since djxl cannot rebuild it. */
export function stripJpegExif(src: string, dst: string) {
  const b = fs.readFileSync(src);
  if (b[0] !== 0xff || b[1] !== 0xd8) return fs.copyFileSync(src, dst);
  const out = [b.subarray(0, 2)];
  let i = 2;
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) throw new Error(`${path.basename(src)}: no marker at byte ${i}`);
    const marker = b[i + 1];
    // Start of scan: the rest is entropy-coded data and the trailer.
    if (marker === 0xda) { out.push(b.subarray(i)); break; }
    const end = i + 2 + b.readUInt16BE(i + 2);
    const exif = marker === 0xe1 && b.toString("latin1", i + 4, i + 10) === "Exif\0\0";
    if (!exif) out.push(b.subarray(i, end));
    i = end;
  }
  fs.writeFileSync(dst, Buffer.concat(out));
}

export function stripPng(src: string, dst: string) {
  const b = fs.readFileSync(src);
  const out = [b.subarray(0, 8)];
  let i = 8;
  while (i + 8 <= b.length) {
    const len = b.readUInt32BE(i), type = b.toString("latin1", i + 4, i + 8), end = Math.min(i + 12 + len, b.length);
    const xmp = type === "iTXt" && b.toString("latin1", i + 8, i + 30).startsWith("XML:com.adobe.xmp");
    if (type !== "eXIf" && !xmp) out.push(b.subarray(i, end));
    i = end;
  }
  fs.writeFileSync(dst, Buffer.concat(out));
}

export function codestreamBytes(file: string) {
  const b = fs.readFileSync(file);
  if (b[0] === 0xff && b[1] === 0x0a) return b.length;
  let o = 0, n = 0;
  while (o + 8 <= b.length) {
    const size = b.readUInt32BE(o) || b.length - o, type = b.toString("latin1", o + 4, o + 8);
    if (type === "jxlc" || type === "jxlp") n += size;
    o += size;
  }
  return n;
}

function sh(cmd: string[], tolerateExit = false): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd[0], cmd.slice(1), { stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    p.stdout.on("data", (c) => (out += c));
    p.stderr.on("data", (c) => (err += c));
    p.on("error", reject);
    p.on("close", (code) => {
      if (code !== 0 && !tolerateExit) reject(new Error(`${path.basename(cmd[0])} exited ${code}: ${err.trim().split("\n").at(-1)}`));
      else resolve(out.trim());
    });
  });
}

// Both metrics come from tools/photos/photo-metrics, imazen's Rust ports of
// SSIMULACRA2 and butteraugli, in one call per image. It replaced libjxl's
// `ssimulacra2` and `butteraugli_main` CLIs on 2026-10-14, after it picked the
// same distance as they did on 20 of 20 HIFs; its Cargo.toml has the numbers.
const METRICS = path.join(path.dirname(fileURLToPath(import.meta.url)), "photo-metrics");
let metricsBin: Promise<string> | undefined;

/** The scorer: PHOTO_METRICS_BIN when set (the contract tests' stub), else the
 *  in-tree crate, built once per process like zenc. The build runs even when a
 *  binary exists, because cargo is what checks it against the sources and lock. */
function metrics(): Promise<string> {
  const pinned = process.env.PHOTO_METRICS_BIN;
  if (pinned) return Promise.resolve(pinned);
  metricsBin ??= sh(["cargo", "build", "--release", "--locked", "--quiet", "--manifest-path", path.join(METRICS, "Cargo.toml")])
    .then(() => path.join(METRICS, "target/release/photo-metrics"));
  return metricsBin;
}

async function score(ref: string, img: string): Promise<Score> {
  const { s2, ba3 } = JSON.parse(await sh([await metrics(), ref, img])) as { s2: number; ba3: number };
  if (!Number.isFinite(s2) || !Number.isFinite(ba3)) throw new Error(`unreadable scores for ${path.basename(img)}`);
  return { s2, ba3 };
}

/** Width and height from a PNG's IHDR. */
function pngSize(file: string) {
  const b = fs.readFileSync(file).subarray(0, 24);
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
}

// The depth a browser paints at, and the one both sides are scored at.
export const DECODE = ["--bits_per_sample=8"];

export async function hifArchive(hif: string, baseline: string, out: string) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "hif-archive-"));
  try {
    const raw = path.join(work, "raw.png"), ref = path.join(work, "ref.png"), base = path.join(work, "base.png");
    const bare = path.join(work, "bare.jpg"), repack = path.join(work, "bare.jxl");
    await sh(["sips", "-s", "format", "png", hif, "--out", raw]);
    stripPng(raw, ref);
    const dims = await sh(["sips", "-g", "pixelWidth", "-g", "pixelHeight", ref]);
    const w = Number(dims.match(/pixelWidth: (\d+)/)?.[1]), h = Number(dims.match(/pixelHeight: (\d+)/)?.[1]);
    // Effort changes only the repack's size: the coefficients, and so the
    // decoded pixels, are the JPEG's either way.
    stripJpegExif(baseline, bare);
    await sh(["cjxl", "--quiet", "--lossless_jpeg=1", "-e", "1", bare, repack]);
    await sh(["djxl", repack, base, ...DECODE]);
    const bs = pngSize(base);
    const transcode = async (reason: string, dest = out) => {
      const rebuilt = path.join(work, "rebuilt.jpg");
      await sh(["cjxl", "--quiet", "--lossless_jpeg=1", "-e", "9", "--compress_boxes=0", baseline, dest]);
      await sh(["djxl", dest, rebuilt]);
      if (!fs.readFileSync(rebuilt).equals(fs.readFileSync(baseline))) throw new Error("the repacked baseline does not rebuild byte for byte");
      return { mode: "transcode" as const, reason, bytes: fs.statSync(dest).size };
    };
    if (bs.w !== w || bs.h !== h) return await transcode(`baseline is ${bs.w}x${bs.h}, the HIF ${w}x${h}`);
    const baseScore = await score(ref, base);

    const tried = new Map<number, Score & { bytes: number; codestream: number }>();
    const cand = path.join(work, "cand.jxl"), dec = path.join(work, "cand.png");
    const d = await searchDistance(async (dist) => {
      await sh(["cjxl", "--quiet", "-d", String(dist), ...ARGS, ref, cand]);
      await sh(["djxl", cand, dec, ...DECODE]);
      const s = await score(ref, dec);
      tried.set(dist, { ...s, bytes: fs.statSync(cand).size, codestream: codestreamBytes(cand) });
      return beats(s, baseScore);
    });
    if (d === null) return await transcode(`no distance down to ${RANGE.floor} beats the baseline on both metrics`);

    const chosen = tried.get(d)!;
    await sh(["cjxl", "--quiet", "-d", String(d), ...ARGS, raw, out]);
    const gap = Math.abs(codestreamBytes(out) - chosen.codestream);
    if (gap > 256) throw new Error(`the oriented encode's codestream differs from the scored one by ${gap} bytes`);
    await sh(["exif-sooc", "-TagsFromFile", hif, "-all:all", "-overwrite_original", out]);
    // Winning on quality is not enough: against the browser-decoded bar, a
    // quarter of the photos first re-measured (6 of 24) beat it only with a
    // file larger than the repack it would replace.
    const direct = fs.statSync(out).size, repacked = path.join(work, "repacked.jxl");
    const kept = await transcode("", repacked);
    if (direct >= kept.bytes) {
      fs.copyFileSync(repacked, out);
      return { ...kept, reason: `the smallest encode that beats the bar (d${d}, ${direct} B) is no smaller than the repack (${kept.bytes} B)` };
    }
    return {
      mode: "direct" as const,
      distance: d,
      bytes: fs.statSync(out).size,
      s2: chosen.s2,
      ba3: chosen.ba3,
      baseline: { ...baseScore, jpegBytes: fs.statSync(baseline).size },
      steps: tried.size,
    };
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const [hif, baseline, out] = process.argv.slice(2);
  if (!hif || !baseline || !out) {
    console.error("usage: bun tools/photos/hif-archive.ts <source.HIF> <baseline.jpg> <out.jxl>");
    process.exit(2);
  }
  try {
    console.log(JSON.stringify(await hifArchive(hif, baseline, out)));
  } catch (e) {
    fs.rmSync(out, { force: true });
    console.error(`hif-archive: ${path.basename(hif)}: ${(e as Error).message}`);
    process.exit(1);
  }
}
