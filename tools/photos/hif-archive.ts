#!/usr/bin/env bun
// hif-archive.ts — a HIF photo's full-resolution archive, as JPEG XL encoded
// from the HIF's own 10-bit pixels.
//
// HOW, and the traps each step avoids:
//   - The reference is sips's 16-bit decode with its eXIf and XMP chunks
//     stripped. sips copies the HIF's EXIF into the PNG, and cjxl would carry
//     its orientation into the encode, so djxl would rotate the decode and it
//     would no longer line up with the reference. (sips -r is no way out: it
//     drops a 16-bit image to 8 bits.)
//   - The baseline is decoded by djpeg, which ignores EXIF orientation, so all
//     three are compared in sensor orientation.
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

async function score(ref: string, img: string): Promise<Score> {
  const s2 = Number.parseFloat(await sh(["ssimulacra2", ref, img]));
  // butteraugli_main exits non-zero on a large distance and still prints both
  // scores. Its 3-norm line is the one compared; a build that prints only the
  // max-norm is compared on that.
  const lines = (await sh(["butteraugli_main", ref, img, "--pnorm", "3"], true)).split("\n");
  const ba3 = Number.parseFloat(lines.find((l) => /3-norm/.test(l))?.split(":")[1] ?? lines[0]);
  if (!Number.isFinite(s2) || !Number.isFinite(ba3)) throw new Error(`unreadable scores for ${path.basename(img)}`);
  return { s2, ba3 };
}

function ppmSize(file: string) {
  const head = fs.readFileSync(file).subarray(0, 64).toString("latin1").split(/\s+/);
  return { w: Number(head[1]), h: Number(head[2]) };
}

export async function hifArchive(hif: string, baseline: string, out: string) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "hif-archive-"));
  try {
    const raw = path.join(work, "raw.png"), ref = path.join(work, "ref.png"), base = path.join(work, "base.ppm");
    await sh(["sips", "-s", "format", "png", hif, "--out", raw]);
    stripPng(raw, ref);
    const dims = await sh(["sips", "-g", "pixelWidth", "-g", "pixelHeight", ref]);
    const w = Number(dims.match(/pixelWidth: (\d+)/)?.[1]), h = Number(dims.match(/pixelHeight: (\d+)/)?.[1]);
    await sh(["djpeg", "-outfile", base, baseline]);
    const bs = ppmSize(base);
    const transcode = async (reason: string) => {
      const rebuilt = path.join(work, "rebuilt.jpg");
      await sh(["cjxl", "--quiet", "--lossless_jpeg=1", "-e", "9", "--compress_boxes=0", baseline, out]);
      await sh(["djxl", out, rebuilt]);
      if (!fs.readFileSync(rebuilt).equals(fs.readFileSync(baseline))) throw new Error("the repacked baseline does not rebuild byte for byte");
      return { mode: "transcode" as const, reason, bytes: fs.statSync(out).size };
    };
    if (bs.w !== w || bs.h !== h) return await transcode(`baseline is ${bs.w}x${bs.h}, the HIF ${w}x${h}`);
    const baseScore = await score(ref, base);

    const tried = new Map<number, Score & { bytes: number; codestream: number }>();
    const cand = path.join(work, "cand.jxl"), dec = path.join(work, "cand.png");
    const d = await searchDistance(async (dist) => {
      await sh(["cjxl", "--quiet", "-d", String(dist), ...ARGS, ref, cand]);
      await sh(["djxl", cand, dec]);
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
