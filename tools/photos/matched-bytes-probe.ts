#!/usr/bin/env node
// matched-bytes-probe.ts — at EQUAL bytes, is the gamma-correct geometry better?
//
// THE ANSWER IS NO, measured 2026-08-25 over 8 real sources. sips at q84 beats
// the zenc geometry q-matched to the same bytes on 7 of 8 photos under EVERY
// reference, including zenc's own kernel as the reference, which is the
// direction that would have flattered it. Matching bytes costs the zenc path
// q84 -> q76..79, and that quality drop costs more than gamma correctness gains.
//
// The reference-free metric says the opposite about a different thing, and
// both are true: zenc preserves mean linear luminance 77% better (0.00027
// against 0.00118), so its geometry really is more correct. It just cannot be
// had for free. The +26.7% in bytes IS the quality, and there is no q-tuning
// that recovers it.
//
// The trap on this thread has twice been the instrument, so two defences:
//
//   1. THE REFERENCE IS A VARIABLE. Scoring a 600px result against a native
//      crop needs the crop resampled to 600, and that resampler is the bias. So
//      every candidate is scored against THREE references (sips, zenc, ffmpeg).
//      A result that holds under all three is real; one that flips is reported
//      as inconclusive rather than as a winner.
//
//   2. ONE METRIC NEEDS NO REFERENCE AT ALL. A downscale is an average, so it
//      must preserve MEAN LINEAR LUMINANCE exactly. That is scale-invariant,
//      needs no resampling to compare, and has an analytically known target:
//      the native crop's own mean. It measures the gamma axis on real
//      photographs instead of synthetic patterns.
//
//   node tools/photos/matched-bytes-probe.ts <path-to-zenc> [--limit N] [--work DIR]
//
// Ported from matched-bytes-probe.py on 2026-09-15 with the subprocess graph
// unchanged, so the numbers it prints are the same measurement. --limit and
// --work are the two additions: the Python hardcoded the first 8 sources and
// /tmp/mb, and a port needs a cheaper run to be checked against its original.
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const argv = process.argv.slice(2);
const zencArg = argv.find((a) => !a.startsWith("--"));
if (!zencArg) { console.error("usage: matched-bytes-probe.ts <zenc> [--limit N] [--work DIR]"); process.exit(2); }
const ZENC: string = zencArg;
const flag = (name: string, fallback: string) => { const i = argv.indexOf(name); return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback; };
const SRC = "/Users/aadharsh/Downloads/to post (from ssd)";
const WORK = flag("--work", "/tmp/mb");
const LIMIT = Number(flag("--limit", "8"));
const SQ = 600;
fs.mkdirSync(WORK, { recursive: true });

/** Exit status only, output discarded, like the Python `run`. */
const run = (...a: string[]) => spawnSync(a[0], a.slice(1), { stdio: "ignore" }).status ?? 1;

function sipsGeom(work: string, out: string, sq: number): number {
  const d = execFileSync("sips", ["-g", "pixelWidth", "-g", "pixelHeight", work], { encoding: "utf8" });
  const dim = (key: string) => Number(d.split("\n").find((l) => l.includes(key))!.trim().split(/\s+/).at(-1));
  const W = dim("pixelWidth"), H = dim("pixelHeight");
  // Python's -(-a // b) is ceiling division.
  const tl = W <= H ? Math.ceil((sq * H) / W) : Math.ceil((sq * W) / H);
  const t = `${out}.t.tif`, s = `${out}.s.tif`;
  run("sips", "-s", "format", "tiff", work, "--out", t);
  run("sips", "-Z", String(tl), t);
  run("sips", "-c", String(sq), String(sq), t, "--out", s);
  run("sips", "-s", "format", "png", s, "--out", out);
  return Math.min(W, H);
}
const zencGeom = (work: string, out: string, sq: number) => run(ZENC, "square", work, "--size", String(sq), "--out", out, "--filter", "box");
const ffmpegGeom = (srcPng: string, out: string, sq: number) =>
  run("ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", srcPng, "-sws_flags", "lanczos", "-vf", `scale=${sq}:${sq}`, out);

function enc(png: string, jpg: string, q: number): number {
  run(ZENC, png, jpg, "-q", String(q));
  return fs.statSync(jpg).size;
}

/** Lowest-error quality that lands nearest the byte target. */
function searchQ(png: string, jpg: string, target: number, lo = 40, hi = 95): [number, number] {
  let best: [number, number] | null = null;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const n = enc(png, jpg, mid);
    if (best === null || Math.abs(n - target) < Math.abs(best[1] - target)) best = [mid, n];
    if (n < target) lo = mid + 1; else hi = mid - 1;
  }
  enc(png, jpg, best![0]);
  return best!;
}

function s2(a: string, b: string): number {
  const r = spawnSync("ssimulacra2", [a, b], { encoding: "utf8" });
  const first = (r.stdout || "").trim().split("\n")[0];
  const v = Number.parseFloat(first);
  return Number.isFinite(v) ? v : Number.NaN;
}

const LUT = Array.from({ length: 256 }, (_, v) => (v / 255 <= 0.040449936 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4));

/** Mean LINEAR luminance, read through ffmpeg's raw output so no PNG parser of
 *  ours is in the measurement path. Scale-invariant, so comparing a 600px
 *  result to a 1333px crop needs no resampling and therefore carries no bias. */
function meanLinear(file: string): number {
  const r = spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", file, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], { maxBuffer: 1 << 30 });
  const b: Buffer = r.stdout;
  if (!b || !b.length) return Number.NaN;
  // Sample rather than sum every byte: 200k samples is far inside the noise of
  // a mean over millions and keeps the whole sweep interactive. Same stride as
  // the Python's b[::step], so the two agree to the last digit.
  const step = Math.max(1, Math.floor(b.length / 200000));
  let sum = 0, n = 0;
  for (let i = 0; i < b.length; i += step) { sum += LUT[b[i]]; n += 1; }
  return sum / n;
}

const srcs = fs.readdirSync(SRC).sort().map((f) => path.join(SRC, f)).filter((f) => /\.(jpg|hif)$/i.test(f)).slice(0, LIMIT);
type Row = Record<string, number | string>;
const rows: Row[] = [];
for (const [idx, f] of srcs.entries()) {
  const n = idx + 1;
  const b = `${WORK}/p${String(n).padStart(2, "0")}`;
  if (run("sips", "-Z", "2000", "-s", "format", "jpeg", "--setProperty", "formatOptions", "100", f, "--out", `${b}.w.jpg`)) continue;
  const short = sipsGeom(`${b}.w.jpg`, `${b}.sips.png`, SQ);
  zencGeom(`${b}.w.jpg`, `${b}.zenc.png`, SQ);
  // native square crop: pure crop, no resampling at all
  // `-s format png` is load-bearing: sips keeps the INPUT format unless told,
  // so without it this writes a JPEG named .png. That silently made the
  // "native crop, no resampling" reference a lossy re-encode, ffmpeg sniffed it
  // and scored anyway, and zenc correctly refused to read it.
  run("sips", "-c", String(short), String(short), `${b}.w.jpg`, "-s", "format", "png", "--out", `${b}.native.png`);
  // references: the native crop brought to 600 three different ways
  sipsGeom(`${b}.native.png`, `${b}.ref_sips.png`, SQ);
  zencGeom(`${b}.native.png`, `${b}.ref_zenc.png`, SQ);
  ffmpegGeom(`${b}.native.png`, `${b}.ref_ffmpeg.png`, SQ);
  // matched bytes: sips at q84 sets the budget, zenc searches to meet it
  const target = enc(`${b}.sips.png`, `${b}.sips.jpg`, 84);
  const [zq, zn] = searchQ(`${b}.zenc.png`, `${b}.zenc.jpg`, target);
  // decode the encoded jpgs back to png so the metric sees what ships
  run("sips", "-s", "format", "png", `${b}.sips.jpg`, "--out", `${b}.sips.dec.png`);
  run("sips", "-s", "format", "png", `${b}.zenc.jpg`, "--out", `${b}.zenc.dec.png`);
  const r: Row = { photo: `p${String(n).padStart(2, "0")}`, target, zq, zbytes: zn };
  for (const ref of ["sips", "zenc", "ffmpeg"]) {
    r[`A_${ref}`] = s2(`${b}.ref_${ref}.png`, `${b}.sips.dec.png`);
    r[`B_${ref}`] = s2(`${b}.ref_${ref}.png`, `${b}.zenc.dec.png`);
  }
  const nat = meanLinear(`${b}.native.png`);
  r.lin_A = Math.abs(meanLinear(`${b}.sips.dec.png`) - nat);
  r.lin_B = Math.abs(meanLinear(`${b}.zenc.dec.png`) - nat);
  rows.push(r);
  console.log(`  ${r.photo}  budget ${String(target).padStart(6)}  zenc q${zq} -> ${String(zn).padStart(6)}`);
}

const f2 = (v: unknown) => Number(v).toFixed(2).padStart(10);
console.log();
console.log("  ssimulacra2 at MATCHED BYTES, A=sips geometry q84, B=zenc geometry q-matched");
console.log(`  ${"photo".padEnd(7)} ${"A/refsips".padStart(10)} ${"B/refsips".padStart(10)} ${"A/refzenc".padStart(10)} ${"B/refzenc".padStart(10)} ${"A/refffm".padStart(10)} ${"B/refffm".padStart(10)}`);
const wins: Record<string, number> = { sips: 0, zenc: 0, ffmpeg: 0 };
for (const r of rows) {
  console.log(`  ${String(r.photo).padEnd(7)} ${f2(r.A_sips)} ${f2(r.B_sips)} ${f2(r.A_zenc)} ${f2(r.B_zenc)} ${f2(r.A_ffmpeg)} ${f2(r.B_ffmpeg)}`);
  for (const ref of Object.keys(wins)) if (Number(r[`B_${ref}`]) > Number(r[`A_${ref}`])) wins[ref] += 1;
}
console.log(`\n  B (zenc) wins, per reference, out of ${rows.length}:  ${Object.entries(wins).map(([k, v]) => `${k}=${v}`).join("  ")}`);
const mean = (key: string) => rows.reduce((acc, r) => acc + Number(r[key]), 0) / rows.length;
const la = mean("lin_A"), lb = mean("lin_B");
console.log("\n  REFERENCE-FREE: mean |linear-luminance error| vs the native crop");
console.log(`    sips geometry ${la.toFixed(5)}`);
console.log(`    zenc geometry ${lb.toFixed(5)}   (${lb < la ? "zenc closer" : "sips closer"}, ${(Math.abs(la - lb) / Math.max(la, lb) * 100).toFixed(0)}% apart)`);
