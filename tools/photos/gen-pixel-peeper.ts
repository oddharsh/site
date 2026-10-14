#!/usr/bin/env node
// gen-pixel-peeper.ts — rebuild the /pixel-peeper trial set from the canonical
// photo source.
//
// Usage:
//     bun tools/photos/gen-pixel-peeper.ts                  # full rebuild
//     bun tools/photos/gen-pixel-peeper.ts --dry-run        # measure, write nothing
//     bun tools/photos/gen-pixel-peeper.ts --sheet x.html   # a contact sheet to eyeball
//     bun tools/photos/gen-pixel-peeper.ts --only chroma    # one axis, implies --dry-run
//     bun tools/photos/gen-pixel-peeper.ts --merge format   # rebuild ONE axis into the committed set
//     bun tools/photos/gen-pixel-peeper.ts --only format --src <dir>   # measure on other originals
//
// Needs: zenc (cargo build in tools/photos/zenc), mozjpeg's cjpeg, sips,
// ssimulacra2, butteraugli_main, and the source folder. The format axis also
// needs cjxl, djxl, avifenc, avifdec, and for AV2 the tuned av2-tone build
// (`bun run av2:build`).

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AV2_BUILD_COMMAND, AV2_TUNED_BUILD } from "./av2-tone.ts";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
// --src points the generator at another folder of originals, the way
// av2-tile-probe.ts takes one. The canonical folder is the default, and the
// only one a committed trial set comes from.
const SRC_FLAG = process.argv.indexOf("--src");
const SRC_DIR = SRC_FLAG >= 0 ? path.resolve(process.argv[SRC_FLAG + 1]) : "/Users/aadharsh/Downloads/to post (from ssd)";
const OUT_DIR = path.join(REPO, "public", "pixel-peeper");
const TILES_DIR = path.join(OUT_DIR, "tiles");

const which = (name: string): string | null => {
  const r = spawnSync("sh", ["-c", `command -v ${name}`], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : null;
};
const ZENC = path.join(REPO, "tools", "photos", "zenc", "target", "release", "zenc");
const SIPS = which("sips") ?? "/usr/bin/sips";
const CJPEG = which("cjpeg") ?? (() => {
  const r = spawnSync("brew", ["--prefix", "mozjpeg"], { encoding: "utf8" });
  return path.join(r.status === 0 ? r.stdout.trim() : "/opt/homebrew/opt/mozjpeg", "bin", "cjpeg");
})();
const SSIMULACRA2 = which("ssimulacra2") ?? "/opt/zerobrew/prefix/bin/ssimulacra2";
const BUTTERAUGLI = which("butteraugli_main") ?? "/opt/zerobrew/prefix/bin/butteraugli_main";
const CJXL = which("cjxl"), DJXL = which("djxl");
const AVIFENC = which("avifenc"), AVIFDEC = which("avifdec");
// AV2 comes from the TUNED av2-tone build (`bun run av2:build`), the one that
// carries the qmseg patch AV2_ARGS turns on. The
// pristine build refuses those flags one encode at a time, so preflight checks
// for the tuned binary up front. AVM_BUILD_DIR overrides the directory, as it
// does for codec-knob-probe.ts.
const AV2_BUILD = process.env.AVM_BUILD_DIR ?? AV2_TUNED_BUILD;
const AVIFENC_AV2 = path.join(AV2_BUILD, "avifenc"), AVIFDEC_AV2 = path.join(AV2_BUILD, "avifdec");

const TILE = 320;
const BUDGET_TOL = 0.02;

type Intent = "detail" | "color";
type Axis = "quality" | "encoder" | "chroma" | "tradeoff" | "resample" | "format";
export const CANDIDATES: Record<Axis, [Intent, number, string[]]> = {
  quality: ["detail", 8, [
    "XT507494",
    "XT509278",
    "XT507955",
    "XT509986",
    "XT508055",
    "XT507517",
    "XT509535",
    "XT509509",
    "XT509965",
    "XT507940",
    "XT509488",
  ]],
  encoder: ["detail", 6, [
    "XT509794",
    "XT509848",
    "XT509388",
    "XT509540",
    "XT508890",
    "XT509276",
    "XT509446",
    "XT509892",
    "XT507343",
    "XT509721",
    "XT508756",
    "XT509698",
    "XT508790",
  ]],
  chroma: ["color", 3, [
    "XT509540",
    "XT507343",
    "XT509814",
    "XT509839",
    "XT509779",
    "XT509276",
    "XT509085",
    "XT509446",
    "XT509892",
    "XT509794",
    "XT508947",
    "XT508890",
    "XT509535",
    "XT509987",
  ]],
  tradeoff: ["color", 3, [
    "XT509987",
    "XT509315",
    "XT509534",
    "XT509535",
    "XT508947",
    "XT509509",
    "XT509809",
    "XT509346",
  ]],
  resample: ["detail", 6, [
    "XT507494",
    "XT509278",
    "XT507955",
    "XT509986",
    "XT509509",
    "XT507517",
    "XT509535",
  ]],
  // 44 is every stem at every tier, since 2026-10-14: calls with AV2 skip the
  // legibility gate (buildFormatTier), and ranking on spread would otherwise
  // drop exactly the close AV2 calls the gate now lets through.
  format: ["detail", 44, [
    "XT507494",
    "XT509794",
    "XT508890",
    "XT509986",
    "XT509721",
    "XT507517",
    "XT509509",
    "XT508756",
    "XT509276",
    "XT509446",
    "XT509892",
  ]],
};

type Option = { label: string; bytes: number; s2: number | null; butter: number | null; light?: number; q: number; path: string; chroma?: string; s2best?: boolean; butterbest?: boolean; src?: string; decoded?: string };
type Trial = { axis: Axis; crop: string; options: Option[]; disagree: boolean; spread?: number; budget?: number; budget_drift?: number; penalty?: number; rejected?: string[]; crop_score?: number; tier?: string; lossless?: { jxl: number; avif: number; av2: number } };

const RANK: Record<Axis, (t: Trial) => number | [number, number]> = {
  quality: (t) => t.spread as number,
  encoder: (t) => t.spread as number,
  chroma: (t) => t.spread as number,
  tradeoff: (t) => [t.disagree ? 1 : 0, t.penalty ?? 0],
  resample: (t) => t.spread as number,
  format: (t) => t.spread as number,
};
const rankKey = (axis: Axis, t: Trial): number => { const k = RANK[axis](t); return Array.isArray(k) ? k[0] * 1e6 + k[1] : k; };

const QUALITY_MID_GAP = 10.0;
const QUALITY_LOW_GAP = 26.0;
const QUALITY_MIN_SPREAD = 18.0;
const ENCODER_MIN_SPREAD = 3.5;
const CHROMA_MIN_BUTTER = 0.25;
const CHROMA_MIN_S2 = 3.0;
const COLOR_MIN_SAT = 34.0;
const DETAIL_MIN_STRUCT = 12.0;

const QUALITY_LADDER = [20, 25, 30, 35, 40, 45, 50, 55, 60, 65, 70, 75, 80, 85, 88, 91, 94, 96];

const log = (msg: string) => process.stderr.write(`${msg}\n`);
const run = (cmd: string[]) => spawnSync(cmd[0], cmd.slice(1), { encoding: "utf8" });
const zenc = (args: string[]): string => execFileSync(ZENC, args, { encoding: "utf8" });

type Source = { file: string; orient: number; stem: string };

export function loadSource(stem: string, tmp: string): Source {
  const match = fs.readdirSync(SRC_DIR).find((f) => path.parse(f).name === stem);
  if (!match) throw new Error(`${stem} not in ${SRC_DIR}`);
  const original = path.join(SRC_DIR, match);
  const o = run(["exif-sooc", "-s", "-s", "-s", "-n", "-Orientation", original]).stdout.trim();
  const orient = /^[1-8]$/.test(o) ? Number(o) : 1;
  const ext = path.extname(match).toLowerCase();
  if (ext === ".hif" || ext === ".heic") {
    const tif = path.join(tmp, `${stem}-src.tiff`);
    const r = run([SIPS, "-s", "format", "tiff", original, "--out", tif]);
    if (r.status !== 0 || !fs.existsSync(tif)) throw new Error(`sips could not decode ${match}: ${r.stderr.trim()}`);
    return { file: tif, orient, stem };
  }
  return { file: original, orient, stem };
}

type Rgb = { w: number; h: number; px: Uint8Array };

function readPpm(file: string): Rgb {
  const buf = fs.readFileSync(file);
  const m = /^P6\s+(\d+)\s+(\d+)\s+255\s/.exec(buf.subarray(0, 40).toString("latin1"));
  if (!m) throw new Error(`${file} is not the P6 zenc writes`);
  const w = Number(m[1]), h = Number(m[2]);
  return { w, h, px: new Uint8Array(buf.buffer, buf.byteOffset + m[0].length, w * h * 3) };
}

/** Pillow's RGB to L: ITU-R 601-2 luma in its fixed-point form, the L24 macro
 *  shifted right by 16.
 *  https://github.com/python-pillow/Pillow/blob/12.3.0/src/libImaging/Convert.c#L42 */
function toGray(im: Rgb): Uint8Array {
  const out = new Uint8Array(im.w * im.h);
  for (let i = 0, p = 0; i < out.length; i += 1, p += 3) out[i] = (im.px[p] * 19595 + im.px[p + 1] * 38470 + im.px[p + 2] * 7471 + 0x8000) >> 16;
  return out;
}

/** Pillow's FIND_EDGES: the 3x3 kernel (-1 all round, 8 in the centre),
 *  clipped to 0..255, with the one-pixel border copied from the input.
 *  Kernel: https://github.com/python-pillow/Pillow/blob/12.3.0/src/PIL/ImageFilter.py#L337-L345
 *  Border: https://github.com/python-pillow/Pillow/blob/12.3.0/src/libImaging/Filter.c#L124-L272 */
function findEdges(src: Uint8Array, w: number, h: number): Uint8Array {
  const out = new Uint8Array(src);
  for (let y = 1; y < h - 1; y += 1) {
    for (let x = 1; x < w - 1; x += 1) {
      const i = y * w + x;
      const v = 8 * src[i] - src[i - w - 1] - src[i - w] - src[i - w + 1] - src[i - 1] - src[i + 1] - src[i + w - 1] - src[i + w] - src[i + w + 1];
      out[i] = v < 0 ? 0 : v > 255 ? 255 : v;
    }
  }
  return out;
}

/** Pillow's ImageStat: population mean and stddev over one band, the
 *  (sum2 - sum^2/n)/n form.
 *  https://github.com/python-pillow/Pillow/blob/12.3.0/src/PIL/ImageStat.py#L149-L159 */
function stats(band: Uint8Array): { mean: number; stddev: number } {
  let sum = 0, sq = 0;
  for (let i = 0; i < band.length; i += 1) { sum += band[i]; sq += band[i] * band[i]; }
  const n = band.length, mean = sum / n;
  return { mean, stddev: Math.sqrt(Math.max(0, sq / n - mean * mean)) };
}

/** max(r,g,b) - min(r,g,b) per pixel: Pillow's lighter/darker chain.
 *  https://github.com/python-pillow/Pillow/blob/12.3.0/src/libImaging/Chops.c#L88-L95 */
function saturation(im: Rgb): Uint8Array {
  const out = new Uint8Array(im.w * im.h);
  for (let i = 0, p = 0; i < out.length; i += 1, p += 3) {
    const r = im.px[p], g = im.px[p + 1], b = im.px[p + 2];
    out[i] = Math.max(r, g, b) - Math.min(r, g, b);
  }
  return out;
}

function redBlueDifference(im: Rgb): Uint8Array {
  const out = new Uint8Array(im.w * im.h);
  for (let i = 0, p = 0; i < out.length; i += 1, p += 3) out[i] = Math.abs(im.px[p] - im.px[p + 2]);
  return out;
}

function window(im: Rgb, x0: number, y0: number, size: number): Rgb {
  const px = new Uint8Array(size * size * 3);
  for (let y = 0; y < size; y += 1) px.set(im.px.subarray(((y0 + y) * im.w + x0) * 3, ((y0 + y) * im.w + x0 + size) * 3), y * size * 3);
  return { w: size, h: size, px };
}

function structure(gray: Uint8Array, w: number, h: number): number {
  const cells = new Uint8Array(256);
  for (let cy = 0; cy < 16; cy += 1) {
    const y0 = Math.floor((cy * h) / 16), y1 = Math.max(y0 + 1, Math.floor(((cy + 1) * h) / 16));
    for (let cx = 0; cx < 16; cx += 1) {
      const x0 = Math.floor((cx * w) / 16), x1 = Math.max(x0 + 1, Math.floor(((cx + 1) * w) / 16));
      let sum = 0, n = 0;
      for (let y = y0; y < y1; y += 1) for (let x = x0; x < x1; x += 1) { sum += gray[y * w + x]; n += 1; }
      cells[cy * 16 + cx] = Math.round(sum / n);
    }
  }
  return stats(cells).stddev;
}

function scoreWindow(win: Rgb, intent: Intent): number {
  const gray = toGray(win);
  const detail = stats(findEdges(gray, win.w, win.h)).stddev;
  if (intent === "detail") {
    if (structure(gray, win.w, win.h) < DETAIL_MIN_STRUCT) return -1e6;
    return detail;
  }
  const sat = saturation(win);
  if (stats(sat).mean < COLOR_MIN_SAT) return -1e6;
  const coarse = stats(findEdges(sat, win.w, win.h)).stddev + stats(findEdges(redBlueDifference(win), win.w, win.h)).stddev;
  return coarse + detail * 0.05;
}

type Crop = { png: string; ppm: string; score: number };

export function bestCrop(src: Source, intent: Intent, tmp: string, boxPx = TILE, name = "crop"): Crop {
  const proxyPpm = path.join(tmp, `${name}-proxy.ppm`);
  const dims = zenc(["frame", src.file, "--orient", String(src.orient), "--fit", "1400", "--out", proxyPpm]).trim().split(/\s+/).map(Number);
  const [W, H] = dims;
  if (W < boxPx || H < boxPx) throw new Error(`source smaller than a ${boxPx}px window: ${W}x${H}`);
  const scale = Math.min(1, 1400 / Math.max(W, H));
  const proxy = readPpm(proxyPpm);
  let box = Math.max(8, Math.floor(boxPx * scale));
  if (box > Math.min(proxy.w, proxy.h)) box = Math.min(proxy.w, proxy.h);
  const stride = Math.max(4, Math.floor(box / 3));
  let best: [number, number] | null = null, bestS = -1e9;
  for (let y = 0; y + box <= proxy.h; y += stride) {
    for (let x = 0; x + box <= proxy.w; x += stride) {
      const s = scoreWindow(window(proxy, x, y, box), intent);
      if (s > bestS) { bestS = s; best = [x, y]; }
    }
  }
  if (bestS <= -1e5 || !best) throw new Error(`no window carries enough colour (mean sat < ${COLOR_MIN_SAT})`);
  const nx = Math.min(W - boxPx, Math.max(0, Math.floor(best[0] / scale)));
  const ny = Math.min(H - boxPx, Math.max(0, Math.floor(best[1] / scale)));
  const png = path.join(tmp, `${name}.png`), ppm = path.join(tmp, `${name}.ppm`);
  zenc(["frame", src.file, "--orient", String(src.orient), "--crop", String(nx), String(ny), String(boxPx), String(boxPx), "--out", png, "--out", ppm]);
  return { png, ppm, score: bestS };
}

const MOZ_SAMPLE: Record<string, string> = { "444": "1x1", "422": "2x1", "420": "2x2" };
type Kind = "zenc" | "mozjpeg" | "sips";
export type Srcs = { png: string; ppm: string };

export function encode(kind: Kind, srcs: Srcs, out: string, q: number, chroma = "420"): number {
  let r;
  if (kind === "zenc") r = run([ZENC, srcs.png, out, "-q", String(q), "--yuv", chroma]);
  else if (kind === "mozjpeg") r = run([CJPEG, "-quality", String(q), "-sample", MOZ_SAMPLE[chroma], "-outfile", out, srcs.ppm]);
  else {
    // sips exposes no chroma control at all: it picks its own subsampling per
    // quality. That is a real property of the macOS encoder, not a gap in the
    // harness, and the encoder axis asks what you get for N bytes.
    if (fs.existsSync(out)) fs.unlinkSync(out);
    r = run([SIPS, "-s", "format", "jpeg", "-s", "formatOptions", String(q), srcs.png, "--out", out]);
  }
  if (!fs.existsSync(out) || fs.statSync(out).size === 0) throw new Error(`${kind} q=${q} produced nothing: ${(r.stderr || "").trim().slice(0, 200)}`);
  return fs.statSync(out).size;
}

function searchQuality(kind: Kind, srcs: Srcs, tmp: string, target: number, chroma = "420", lo = 5, hi = 100): { q: number; bytes: number; path: string } | null {
  if (lo > hi) return null;
  if (kind === "zenc") {
    const out = path.join(tmp, "search-zenc.jpg");
    const result = JSON.parse(zenc(["jpeg-search", srcs.png, out, String(target), chroma, String(lo), String(hi)])) as { q: number; bytes: number };
    const keep = path.join(tmp, `cand-zenc-${result.q}.jpg`);
    fs.copyFileSync(out, keep);
    return { ...result, path: keep };
  }
  const out = path.join(tmp, `search-${kind}.jpg`);
  let best: { q: number; bytes: number; path: string } | null = null;
  const seen = new Set<number>();
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (seen.has(mid)) break;
    const size = encode(kind, srcs, out, mid, chroma);
    seen.add(mid);
    const keep = path.join(tmp, `cand-${kind}-${mid}.jpg`);
    fs.copyFileSync(out, keep);
    if (best === null || Math.abs(size - target) < Math.abs(best.bytes - target)) best = { q: mid, bytes: size, path: keep };
    if (size > target) hi = mid - 1;
    else if (size < target) lo = mid + 1;
    else break;
  }
  return best;
}

const toPng = (jpg: string, png: string): string => { zenc(["frame", jpg, "--out", png]); return png; };
const firstFloat = (tool: string, r: ReturnType<typeof run>): number => {
  const m = /-?\d+\.\d+/.exec(r.stdout || "");
  if (!m) throw new Error(`${tool} said: ${(r.stdout || "").trim()} ${(r.stderr || "").trim()}`);
  return Number(m[0]);
};
export const ssim2 = (ref: string, test: string): number => Number(firstFloat("ssimulacra2", run([SSIMULACRA2, ref, test])).toFixed(2));
export const butter = (ref: string, test: string): number => Number(firstFloat("butteraugli", run([BUTTERAUGLI, ref, test])).toFixed(3));
function measure(refPng: string, jpg: string, tmp: string, both = true): [number, number | null] {
  const png = toPng(jpg, path.join(tmp, `${path.parse(jpg).name}-dec.png`));
  return [ssim2(refPng, png), both ? butter(refPng, png) : null];
}

function markWinners(options: Option[]): boolean {
  const bestS2 = Math.max(...options.map((o) => o.s2 as number));
  const bestBu = Math.min(...options.map((o) => o.butter as number));  // butteraugli: lower is better
  for (const o of options) { o.s2best = o.s2 === bestS2; o.butterbest = o.butter === bestBu; }
  return options.find((o) => o.s2best) !== options.find((o) => o.butterbest);
}

type Built = [Trial, null] | [null, string];

function buildQuality(cropId: string, srcs: Srcs, refPng: string, tmp: string): Built {
  const rungs = QUALITY_LADDER.map((q) => {
    const p = path.join(tmp, `q${q}.jpg`);
    const size = encode("zenc", srcs, p, q, "420");
    return { q, bytes: size, s2: ssim2(refPng, toPng(p, path.join(tmp, `q${q}.png`))), path: p };
  });
  const top = rungs.reduce((a, b) => (b.s2 > a.s2 ? b : a));
  const pick = (gap: number) => rungs.reduce((a, b) => (Math.abs((top.s2 - b.s2) - gap) < Math.abs((top.s2 - a.s2) - gap) ? b : a));
  const chosen: typeof rungs = [];
  for (const r of [pick(QUALITY_LOW_GAP), pick(QUALITY_MID_GAP), top]) if (!chosen.some((c) => c.q === r.q)) chosen.push(r);
  if (chosen.length < 3) return [null, "ladder collapsed: fewer than 3 distinct rungs"];
  const spread = chosen[chosen.length - 1].s2 - chosen[0].s2;
  if (spread < QUALITY_MIN_SPREAD) return [null, `spread only ${spread.toFixed(1)} s2 (want ${QUALITY_MIN_SPREAD})`];
  const options: Option[] = chosen.map((r) => { const [s2, bu] = measure(refPng, r.path, tmp); return { label: `quality ${r.q}`, bytes: r.bytes, s2, butter: bu, q: r.q, path: r.path }; });
  return [{ axis: "quality", crop: cropId, options, disagree: markWinners(options), spread: Number(spread.toFixed(1)) }, null];
}

function buildEncoder(cropId: string, srcs: Srcs, refPng: string, tmp: string): Built {
  const target = encode("zenc", srcs, path.join(tmp, "budget-probe.jpg"), 72, "420");
  let options: Option[] = [];
  const rejected: string[] = [];
  for (const kind of ["zenc", "mozjpeg", "sips"] as Kind[]) {
    let got;
    try { got = searchQuality(kind, srcs, tmp, target, "420"); }
    catch (e) { rejected.push(`${kind}: ${e instanceof Error ? e.message : String(e)}`); continue; }
    if (got === null) { rejected.push(`${kind}: search found nothing`); continue; }
    const drift = Math.abs(got.bytes - target) / target;
    if (drift > BUDGET_TOL) { rejected.push(`${kind}: closest was ${got.bytes}B, ${(drift * 100).toFixed(1)}% off budget`); continue; }
    const [s2, bu] = measure(refPng, got.path, tmp);
    options.push({ label: kind, bytes: got.bytes, s2, butter: bu, q: got.q, path: got.path });
  }
  if (options.length < 2) return [null, `only ${options.length} encoder(s) hit the budget; ${JSON.stringify(rejected)}`];
  options.sort((a, b) => (a.s2 as number) - (b.s2 as number));
  if (options.length > 3) {
    const lo = options[0], hi = options[options.length - 1];
    const mid = options.slice(1, -1).reduce((a, b) => {
      const d = (o: Option) => Math.min(Math.abs((o.s2 as number) - (lo.s2 as number)), Math.abs((o.s2 as number) - (hi.s2 as number)));
      return d(b) > d(a) ? b : a;
    });
    options = [lo, mid, hi];
  }
  const spread = (options[options.length - 1].s2 as number) - (options[0].s2 as number);
  if (spread < ENCODER_MIN_SPREAD) return [null, `encoders within ${spread.toFixed(1)} s2 at equal bytes: nothing to see`];
  const budgetDrift = Math.max(...options.map((o) => Math.abs(o.bytes - target))) / target;
  return [{ axis: "encoder", crop: cropId, options, disagree: markWinners(options), spread: Number(spread.toFixed(1)), budget: target, budget_drift: Number((budgetDrift * 100).toFixed(2)), rejected }, null];
}

function buildChroma(cropId: string, srcs: Srcs, refPng: string, tmp: string): Built {
  const Q = 80;
  const out: Option[] = [];
  for (const [chroma, label] of [["422", "4:2:2 · full source color"], ["420", "4:2:0 · color halved"]]) {
    const p = path.join(tmp, `chroma-${chroma}.jpg`);
    const size = encode("zenc", srcs, p, Q, chroma);
    const [s2, bu] = measure(refPng, p, tmp);
    out.push({ label, bytes: size, s2, butter: bu, q: Q, chroma, path: p });
  }
  const penalty = (out[1].butter as number) - (out[0].butter as number);
  if (penalty < CHROMA_MIN_BUTTER) return [null, `4:2:0 only costs ${penalty.toFixed(3)} butteraugli: invisible, skip it`];
  const spread = Math.abs((out[0].s2 as number) - (out[1].s2 as number));
  if (spread < CHROMA_MIN_S2) return [null, `4:2:0 costs only ${spread.toFixed(2)} s2: the colour tell is not visible`];
  return [{ axis: "chroma", crop: cropId, options: out, disagree: markWinners(out), penalty: Number(penalty.toFixed(3)), spread: Number(spread.toFixed(2)) }, null];
}

function buildTradeoff(cropId: string, srcs: Srcs, refPng: string, tmp: string): Built {
  const Q422 = 80;
  const p422 = path.join(tmp, "trade-422.jpg");
  const target = encode("zenc", srcs, p422, Q422, "422");
  const got = searchQuality("zenc", srcs, tmp, target, "420");
  if (got === null) return [null, "no 4:2:0 quality hits the 4:2:2 budget"];
  const drift = Math.abs(got.bytes - target) / target;
  if (drift > BUDGET_TOL) return [null, `4:2:0 closest was ${got.bytes}B vs ${target}B (${(drift * 100).toFixed(1)}% off)`];
  const options: Option[] = [];
  for (const [p, label, q, chroma, size] of [[got.path, "4:2:0 · sharper, color halved", got.q, "420", got.bytes], [p422, "4:2:2 · full source color, softer", Q422, "422", target]] as [string, string, number, string, number][]) {
    const [s2, bu] = measure(refPng, p, tmp);
    options.push({ label, bytes: size, s2, butter: bu, q, chroma, path: p });
  }
  const disagree = markWinners(options);
  const budgetDrift = Math.abs(options[0].bytes - options[1].bytes) / target;
  return [{ axis: "tradeoff", crop: cropId, options, disagree, budget: target, budget_drift: Number((budgetDrift * 100).toFixed(2)),
    penalty: Number(Math.abs((options[0].butter as number) - (options[1].butter as number)).toFixed(3)) }, null];
}

const RESAMPLE_REDUCTION = 3;
const RESAMPLE_MIN_SPREAD = 8.0;

// sRGB's transfer curve, decoded: 8-bit code value to linear light (IEC 61966-2-1).
const SRGB_TO_LINEAR = Float64Array.from({ length: 256 }, (_, i) => { const c = i / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
/** Mean linear-light luminance (Rec. 709 weights) of a P6 PPM. */
function meanLight(ppm: string): number {
  const { w, h, px } = readPpm(ppm);
  let sum = 0;
  for (let i = 0; i < px.length; i += 3) sum += 0.2126 * SRGB_TO_LINEAR[px[i]] + 0.7152 * SRGB_TO_LINEAR[px[i + 1]] + 0.0722 * SRGB_TO_LINEAR[px[i + 2]];
  return sum / (w * h);
}

/** sips against the linear-light kernel, at one byte budget.
 *
 *  NOT scored against a reference, and that is the design rather than a
 *  shortcut. Every other axis compares encodes of ONE set of pixels, so the
 *  native crop is a legitimate reference and ssimulacra2 measures encode damage.
 *  Here the candidates are different downscales of a larger region, so there is
 *  no common-size truth to score against, and manufacturing one means choosing a
 *  downscaler, which is choosing the winner. That mistake cost this repository
 *  two wrong conclusions before the probe in resample-probe.ts replaced
 *  reference-similarity with analytically-known answers.
 *
 *  So the number here is the two candidates against EACH OTHER. That is the
 *  question the page exists to answer: whether a person looking at two tiles
 *  can tell them apart at all.
 *
 *  Each tile does get one per-tile number with a known answer: LIGHT KEPT, its
 *  decoded mean linear luminance over the source window's. Averaging in light
 *  conserves that mean exactly, at any reduction, so a correct downscale reads
 *  100% before the encoder rounds it, and the light averaging sRGB numbers
 *  throws away shows up as the shortfall. It needs no common-size reference,
 *  only the window both tiles came from. The TILE-sized crop the main loop cut is unused;
 *  this re-cuts a RESAMPLE_REDUCTION x larger window from the same source,
 *  because a downscale needs something to reduce. */
function buildResample(src: Source, tmp: string): Built {
  const big = bestCrop(src, "detail", tmp, TILE * RESAMPLE_REDUCTION, "resample-src");
  const made: Record<string, string> = {};
  for (const label of ["sips", "zenc"]) {
    const out = path.join(tmp, `resample-${label}.png`);
    if (label === "sips") run([SIPS, "-Z", String(TILE), big.png, "--out", out]);
    else run([ZENC, "square", big.png, "--size", String(TILE), "--out", out, "--filter", "box"]);
    if (!fs.existsSync(out)) return [null, `${label} produced no output`];
    made[label] = out;
  }
  const target = encode("zenc", { png: made.sips, ppm: made.sips }, path.join(tmp, "resample-budget.jpg"), 72, "420");
  const srcLight = meanLight(big.ppm);
  const options: Option[] = [];
  const rejected: string[] = [];
  for (const [label, png] of Object.entries(made)) {
    const sub = path.join(tmp, `rs-${label}`);
    fs.mkdirSync(sub, { recursive: true });
    const got = searchQuality("zenc", { png, ppm: png }, sub, target, "420");
    if (got === null) { rejected.push(`${label}: search found nothing`); continue; }
    const drift = Math.abs(got.bytes - target) / target;
    if (drift > BUDGET_TOL) { rejected.push(`${label}: closest was ${got.bytes}B, ${(drift * 100).toFixed(1)}% off budget`); continue; }
    const dec = path.join(sub, "decoded.ppm");
    zenc(["frame", got.path, "--out", dec]);
    const light = Number(((100 * meanLight(dec)) / srcLight).toFixed(1));
    options.push({ label, bytes: got.bytes, q: got.q, path: got.path, s2: null, butter: null, light });
  }
  if (options.length !== 2) return [null, `only ${options.length} geometry hit the budget; ${JSON.stringify(rejected)}`];
  const spread = 100.0 - ssim2(toPng(options[0].path, path.join(tmp, "resample-a-dec.png")), toPng(options[1].path, path.join(tmp, "resample-b-dec.png")));
  if (spread < RESAMPLE_MIN_SPREAD) return [null, `the two geometries differ by only ${spread.toFixed(1)} at this budget (want ${RESAMPLE_MIN_SPREAD}); nobody could call this tile`];
  return [{ axis: "resample", crop: src.stem, options, spread: Number(spread.toFixed(1)), disagree: false, budget: target }, null];
}

// JPEG XL against AVIF at one byte budget, and AV2 on the same budget since
// 2026-10-14. Three decisions carry the axis, and one exclusion:
//
//   1. THE BUDGET IS ANCHORED ON THE COARSEST KNOB. avifenc's -q is an integer
//      over ~64 quantizer steps, so on a 320px tile consecutive values move the
//      file 3-6% and AVIF often cannot land inside BUDGET_TOL of an arbitrary
//      number. cjxl's distance is continuous. So AVIF is encoded first and its
//      ACTUAL output size becomes the budget JXL is searched onto, which it can
//      hit to well under 1%. AV2 is searched onto it too, on its own 0..255
//      quantizer rather than libavif's -q, which moves an AV2 file up to 40% a
//      step (/garage/av2).
//   2. FOUR TIERS, each budget taken from what this site ships rather than
//      picked. The ranking between these formats depends on bitrate (AVIF's
//      reputation is built low, JXL's high), so one budget would teach whichever
//      half of that the budget happened to favour.
//        low-tier:  the shipped 600px AVIF tier's median bits per pixel, spent
//                   on this crop. AVIF is searched onto it.
//        avif-tier: avifenc at the photo pipeline's own flags, -q 63. The AVIF
//                   tile IS the shipping encode, no search at all.
//        jpeg-tier: what zenc spends at q84, the shipping JPEG fallback. AVIF
//                   is then searched onto that.
//        repack:    JXL's home ground. You start from the shipping JPEG, as
//                   most of the web must: JXL repacks it losslessly, AVIF has
//                   to decode it and encode again. AVIF is searched onto the
//                   repack's size. Scored against the ORIGINAL crop, so the
//                   JPEG's own damage counts against both.
//   3. EACH FORMAT AT A SERIOUS SETTING, NOT A DEFAULT. AVIF gets the shipping
//      flags (10-bit, speed 2, 4:4:4). JXL gets effort 9 with decoder smoothing off (JXL_ARGS
//      says why), effort 9 being near the top of cjxl's range the way speed
//      2 is near the top of aom's. Effort 7 (cjxl's default) was measured
//      first and scored 0.0-4.5 s2 lower at equal bytes; holding JXL at its
//      default against AVIF at its slow preset would decide the call by preset.
//      Defaults on both would compare two speed presets and call it a format
//      comparison. AV2 gets the best setup /garage/av2 measured, AV2_ARGS.
//
// WHY AV2 IS HERE. The question the axis asks is which format to ship, and
// AV2 is the codec AVIF's AV1 is turning into. Putting it on the same budgets,
// crops and metrics as the other two answers three questions at once: where
// AV2 improves on AV1, where it lands against JPEG XL, and whether any tier
// is a different format's ground. No browser decodes AV2, so its tile ships
// as the raw file and the page decodes it with the AVM WebAssembly build
// /garage/av2 already ships, never through an <img> (gotcha 7: an AV2 file
// typed image/avif draws broken and its fallback never loads).

export type Fmt = "jxl" | "avif" | "av2";
// AV2's file is an AVIF container whose image item is av02, so it keeps the
// .avif name libavif gives it. The page tells the two apart by label.
const FMT_EXT: Record<Fmt, string> = { jxl: "jxl", avif: "avif", av2: "avif" };
const FMT_NAME: Record<Fmt, string> = { jxl: "JPEG XL", avif: "AVIF", av2: "AV2" };
export const FORMAT_TIER_ANCHOR = {
  "avif-tier": { enc: "avif", q: 63 },
  "jpeg-tier": { enc: "zenc", q: 84, chroma: "420" },
} as const;
const FORMAT_TIERS = ["low-tier", "avif-tier", "jpeg-tier", "repack"] as const;
type FormatTier = (typeof FORMAT_TIERS)[number];
const LOW_TIER_BPP = 0.66;
const FMT_KNOB: Record<Fmt, { lo: number; hi: number; up: boolean; int: boolean }> = {
  jxl: { lo: 0.1, hi: 15, up: false, int: false },   // butteraugli distance: smaller is bigger
  avif: { lo: 0, hi: 100, up: true, int: true },
  av2: { lo: 0, hi: 255, up: true, int: true },      // 255 - AV2's qp, so bytes rise with it
};

export const JXL_ARGS = ["-e", "9", "--gaborish=0", "--epf=0"];

export const AVIF_ARGS = ["-d", "10", "--speed", "2", "--yuv", "444"];

// AV2's flags beyond its quantizer: the best setup /garage/av2 measured, all
// of it from that page's probes (codec-knob-probe.ts --codec avm and
// av2-tile-probe.ts), none tuned here.
//   speed 3   beat speed 6 on all 32 crop calls and closed about a third of
//             AV2's gap to the shipped AVIF there, at 41x the AVIF's encode
//             time. cpu-used 1 ran past 8 minutes on one frame.
//   sb-size   128, pinned, because at 320px AVM picks 64 on its own and a real
//             600px tile gets 128; 64 cost 1.31 and 1.38 s2 on two tiles.
//   qmseg     per-segment quantization matrices at level 12, the one tuned-build
//             patch that paid: +0.14 s2 on the holdout crops, +0.12 on the 38
//             tiles. It is syntax AV1 doesn't have, so it is the setting that
//             asks what AV2 adds rather than what its encoder inherited.
//   tune      left at libavif's ssim. psnr doubled butteraugli wins and cost
//             about half a point of ssimulacra2; neither is a still-image
//             tune, which AVM doesn't have yet.
// Measured at speed 6. Speed 3 with qmseg is this axis's first run of the two
// together, so its numbers are the record, not a re-run of the probes'.
export const AV2_ARGS = ["-c", "avm", "-d", "10", "--speed", "3", "--yuv", "444", "-a", "sb-size=128",
  "-a", "enable-qm=1", "-a", "qm-curve=1", "-a", "qmseg=1", "-a", "qmseg-level=12"];

export function encodeFmt(fmt: Fmt, png: string, out: string, knob: number, jxlArgs: string[] = JXL_ARGS, avifArgs: string[] = AVIF_ARGS): number {
  if (fs.existsSync(out)) fs.unlinkSync(out);
  let r;
  if (fmt === "jxl") r = run([CJXL as string, png, out, "-d", knob.toFixed(4), ...jxlArgs, "--quiet"]);
  // AV2's quantizer through `-a qp=`, which overrides -q. -q stays at 50 so
  // libavif never reads the request as lossless (codec-knob-probe.ts, AVM).
  else if (fmt === "av2") r = run([AVIFENC_AV2, "-q", "50", "-a", `qp=${255 - Math.round(knob)}`, ...AV2_ARGS, "--jobs", "4", "--ignore-icc", "--ignore-exif", "--ignore-xmp", png, out]);
  // --jobs is pinned to the pipeline's 4, because it changes AVIF output bytes
  // (gotcha 43), so this tile is byte-identical to a shipping encode at that -q.
  else r = run([AVIFENC as string, "-q", String(Math.round(knob)), ...avifArgs, "--jobs", "4", "--ignore-icc", "--ignore-exif", "--ignore-xmp", png, out]);
  if (!fs.existsSync(out) || fs.statSync(out).size === 0) throw new Error(`${fmt} knob=${knob} produced nothing: ${(r.stderr || "").trim().slice(0, 200)}`);
  return fs.statSync(out).size;
}

/** Decode with the format's reference decoder to an 8-bit PNG. avifdec would
 *  otherwise write 16 bits for a 10-bit file, and the metrics compare against
 *  an 8-bit reference. */
export function decodeFmt(fmt: Fmt, file: string, png: string): string {
  const r = fmt === "jxl" ? run([DJXL as string, file, png, "--bits_per_sample=8", "--quiet"])
    : run([fmt === "av2" ? AVIFDEC_AV2 : AVIFDEC as string, "-d", "8", file, png]);
  if (!fs.existsSync(png)) throw new Error(`${fmt} decode failed: ${(r.stderr || r.stdout || "").trim().slice(0, 200)}`);
  return png;
}

export function searchFmt(fmt: Fmt, png: string, tmp: string, target: number, jxlArgs: string[] = JXL_ARGS, avifArgs: string[] = AVIF_ARGS): { knob: number; bytes: number; path: string } {
  const k = FMT_KNOB[fmt];
  let lo = k.lo, hi = k.hi, best: { knob: number; bytes: number; path: string } | null = null;
  for (let step = 0; step < 18; step += 1) {
    const mid = k.int ? Math.floor((lo + hi) / 2) : (lo + hi) / 2;
    const out = path.join(tmp, `fmt-${fmt}-${step}.${FMT_EXT[fmt]}`);
    const size = encodeFmt(fmt, png, out, mid, jxlArgs, avifArgs);
    if (best === null || Math.abs(size - target) < Math.abs(best.bytes - target)) best = { knob: mid, bytes: size, path: out };
    if (size === target || Math.abs(size - target) / target < 0.002) break;
    const tooBig = size > target;
    if (tooBig === k.up) hi = k.int ? mid - 1 : mid; else lo = k.int ? mid + 1 : mid;
    if (k.int && lo > hi) break;
  }
  return best as { knob: number; bytes: number; path: string };
}

// The page reads a format option's format off its label's first word, so an
// AV2 label must start "AV2 " and nothing else may (the contract
// pixel-peeper-av2-tiles-are-av02 holds the files to it).
const knobLabel = (fmt: Fmt, knob: number): string =>
  fmt === "jxl" ? `JPEG XL · distance ${knob.toFixed(2)}` : fmt === "av2" ? `AV2 · qp ${255 - Math.round(knob)}` : `AVIF · q${Math.round(knob)}`;

/** Each format's LOSSLESS size for the crop. Not a call, since identical
 *  pixels make no eye test, but it is the one place the gap is large (JXL ran
 *  53-79% of AVIF's bytes over 16 crops, 2026-10-07), so the page states it
 *  as a number beside the call. AVIF and AV2 lossless are 8-bit RGB through
 *  the identity matrix, which is what avifenc -l writes. AV2's ran 29% larger
 *  than AV1's on the same 16 crops (/garage/av2), against AOM listing better
 *  lossless coding among AV2's tools, so the page shows that number too. */
function losslessBytes(png: string, tmp: string): { jxl: number; avif: number; av2: number } {
  const jxl = path.join(tmp, "lossless.jxl"), avif = path.join(tmp, "lossless.avif"), av2 = path.join(tmp, "lossless-av2.avif");
  const quiet = ["--jobs", "4", "--ignore-icc", "--ignore-exif", "--ignore-xmp"];
  run([CJXL as string, png, jxl, "-d", "0", "-e", "9", "--quiet"]);
  run([AVIFENC as string, "-l", "-d", "8", "--speed", "2", ...quiet, png, avif]);
  run([AVIFENC_AV2, "-c", "avm", "-l", "-d", "8", "--speed", "3", ...quiet, png, av2]);
  for (const f of [jxl, avif, av2]) if (!fs.existsSync(f)) throw new Error(`lossless encode wrote no ${path.basename(f)}`);
  return { jxl: fs.statSync(jxl).size, avif: fs.statSync(avif).size, av2: fs.statSync(av2).size };
}

// Every format tier this run SCORED, before the legibility gate or the ranking
// drops any. The calls a player sees are chosen for being easy to tell apart,
// which favours whichever format loses biggest, so a tally over the shipped
// calls would describe the gate as much as the formats. This pool is what the
// page's "where each format wins" table and the run's summary are built from.
type PoolFmt = { bytes: number; s2: number; bu: number };
type PoolRow = { crop: string; tier: FormatTier; budget: number; bpp: number } & Partial<Record<Fmt, PoolFmt>>;
const formatPool: PoolRow[] = [];

function buildFormat(cropId: string, srcs: Srcs, refPng: string, tmp: string): Built[] {
  const lossless = losslessBytes(srcs.png, tmp);
  return FORMAT_TIERS.map((tier): Built => {
    try {
      const built = buildFormatTier(tier, cropId, srcs, refPng, tmp);
      if (built[0]) built[0].lossless = lossless;
      return built;
    }
    catch (e) { return [null, `${tier}: ${e instanceof Error ? e.message : String(e)}`]; }
  });
}

type Got = { knob: number; bytes: number; path: string };

/** The repack tier's two files. JXL's is the shipping JPEG repacked
 *  losslessly (cjxl --lossless_jpeg=1, which is the default for a JPEG input,
 *  spelled out), without the reconstruction box: a browser decodes pixels and
 *  never needs the original JPEG bytes back, so the box is overhead, and
 *  codec-knob-probe measured dropping it at +0.37 s2 at matched bytes. AVIF
 *  and AV2 get what any re-encoder gets, the JPEG's decoded pixels. */
function repackSet(srcs: Srcs, sub: string): [Fmt, Got][] {
  const jpg = path.join(sub, "have.jpg");
  encode("zenc", srcs, jpg, 84, "420");
  const jxl = path.join(sub, "repack.jxl");
  const r = run([CJXL as string, jpg, jxl, "--lossless_jpeg=1", "-e", "9", "--allow_jpeg_reconstruction=0", "--quiet"]);
  if (!fs.existsSync(jxl)) throw new Error(`cjxl repack failed: ${(r.stderr || "").trim().slice(0, 200)}`);
  const pixels = toPng(jpg, path.join(sub, "have-dec.png"));
  const target = fs.statSync(jxl).size;
  return [["jxl", { knob: 0, bytes: target, path: jxl }], ["avif", searchFmt("avif", pixels, sub, target)], ["av2", searchFmt("av2", pixels, sub, target)]];
}

function buildFormatTier(tier: FormatTier, cropId: string, srcs: Srcs, refPng: string, tmp: string): Built {
  {
    const sub = path.join(tmp, tier);
    fs.mkdirSync(sub, { recursive: true });
    let got: [Fmt, Got][];
    if (tier === "repack") {
      got = repackSet(srcs, sub);   // here the JXL file sets the budget, since its size is fixed
    } else {
      const avif = tier === "avif-tier"
        ? (() => { const a = FORMAT_TIER_ANCHOR[tier]; const p = path.join(sub, "ship.avif"); return { knob: a.q, bytes: encodeFmt("avif", srcs.png, p, a.q), path: p }; })()
        : tier === "jpeg-tier"
          ? (() => { const a = FORMAT_TIER_ANCHOR[tier]; return searchFmt("avif", srcs.png, sub, encode("zenc", srcs, path.join(sub, "jpeg-anchor.jpg"), a.q, a.chroma)); })()
          : (() => {
            const low = Math.round((TILE * TILE * LOW_TIER_BPP) / 8);
            const ship = encodeFmt("avif", srcs.png, path.join(sub, "ship-check.avif"), FORMAT_TIER_ANCHOR["avif-tier"].q);
            if (ship <= low * (1 + BUDGET_TOL)) throw new Error(`shipping AVIF is already ${ship}B, no tighter than the ${low}B tier`);
            return searchFmt("avif", srcs.png, sub, low);
          })();
      got = [["avif", avif], ["jxl", searchFmt("jxl", srcs.png, sub, avif.bytes)], ["av2", searchFmt("av2", srcs.png, sub, avif.bytes)]];
    }
    const target = got[0][1].bytes;
    const rejected: string[] = [];
    const options: Option[] = [];
    const row: PoolRow = { crop: cropId, tier, budget: target, bpp: Number(((target * 8) / (TILE * TILE)).toFixed(3)) };
    for (const [fmt, g] of got) {
      const drift = Math.abs(g.bytes - target) / target;
      if (drift > BUDGET_TOL) { rejected.push(`${fmt}: closest was ${g.bytes}B, ${(drift * 100).toFixed(1)}% off ${target}B`); continue; }
      const dec = decodeFmt(fmt, g.path, path.join(sub, `${fmt}-dec.png`));
      const label = tier !== "repack" ? knobLabel(fmt, g.knob)
        : fmt === "jxl" ? "JPEG XL · the JPEG, repacked losslessly" : `${knobLabel(fmt, g.knob)}, re-encoded from the JPEG`;
      const o: Option = { label, bytes: g.bytes, s2: ssim2(refPng, dec), butter: butter(refPng, dec), q: Number(g.knob.toFixed(4)), path: g.path, decoded: dec };
      options.push(o);
      row[fmt] = { bytes: o.bytes, s2: o.s2 as number, bu: o.butter as number };
    }
    if (options.length >= 2) formatPool.push(row);
    if (options.length < 2) return [null, `${tier}: only ${options.length} format(s) hit ${target}B; ${JSON.stringify(rejected)}`];
    options.sort((a, b) => (a.s2 as number) - (b.s2 as number));
    // best minus worst: with three formats a call is legible when SOME tile is
    // visibly worse, which is what the gate has always asked of two
    const spread = (options[options.length - 1].s2 as number) - (options[0].s2 as number);
    const summary = options.map((o) => `${o.label.split(" · ")[0]} ${o.s2}`).join(", ");
    // A call with an AV2 tile ships however close it lands. The gate exists so
    // nobody is asked a call they cannot see, but whether AV2 can be told from
    // AV1 and JPEG XL at all is the question the owner wants to judge by eye,
    // and on 2026-10-14 the gate dropped 12 of 22 AV2 calls on seven crops.
    const hasAv2 = options.some((o) => o.label.startsWith("AV2 "));
    if (spread < ENCODER_MIN_SPREAD && !hasAv2) return [null, `${tier} @ ${target}B: formats within ${spread.toFixed(1)} s2 (${summary}); nothing to see`];
    const budgetDrift = Math.max(...options.map((o) => Math.abs(o.bytes - target))) / target;
    const trial: Trial = { axis: "format", crop: cropId, tier, options, disagree: markWinners(options), spread: Number(spread.toFixed(1)), budget: target, budget_drift: Number((budgetDrift * 100).toFixed(2)) };
    if (rejected.length) trial.rejected = rejected;   // a format that missed the budget sits this call out, and the log says so
    return [trial, null];
  }
}

// The pool, pairwise: for each pair of formats, over the tiers where both hit
// the budget, the first one's mean ssimulacra2 lead and how many calls it took
// on each metric. The page computes the same table from the same rows.
const PAIRS: [Fmt, Fmt][] = [["av2", "avif"], ["av2", "jxl"], ["jxl", "avif"]];
const BPP_BANDS: [string, number, number][] = [["under 0.5 bpp", 0, 0.5], ["0.5 to 1 bpp", 0.5, 1], ["over 1 bpp", 1, Infinity]];
function pairLine(rows: PoolRow[], [a, b]: [Fmt, Fmt]): string {
  const both = rows.filter((r) => r[a] && r[b]) as (PoolRow & Record<Fmt, PoolFmt>)[];
  if (!both.length) return "n/a".padEnd(26);
  const d = both.reduce((n, r) => n + r[a].s2 - r[b].s2, 0) / both.length;
  const s2 = both.filter((r) => r[a].s2 > r[b].s2).length, bu = both.filter((r) => r[a].bu < r[b].bu).length;
  return `${d >= 0 ? "+" : ""}${d.toFixed(2)}  s2 ${s2}/${both.length}  bu ${bu}/${both.length}`.padEnd(26);
}
function logPool(pool: PoolRow[]): void {
  if (!pool.length) return;
  log(`\nformat pool: ${pool.length} scored calls, before the legibility gate. each pair: mean s2 lead, s2 wins, butteraugli wins`);
  log(`${"".padEnd(18)}${PAIRS.map(([a, b]) => `${FMT_NAME[a]} vs ${FMT_NAME[b]}`.padEnd(26)).join("")}`);
  // bits per pixel decides AV2 against AV1 (/garage/av2), so the fresh-photo
  // tiers are also pooled by it; repack starts from a JPEG and stays out
  const groups: [string, PoolRow[]][] = [
    ...FORMAT_TIERS.map((tier): [string, PoolRow[]] => [tier, pool.filter((r) => r.tier === tier)]),
    ...BPP_BANDS.map(([name, lo, hi]): [string, PoolRow[]] => [name, pool.filter((r) => r.tier !== "repack" && r.bpp >= lo && r.bpp < hi)]),
    ["all", pool],
  ];
  for (const [name, rows] of groups) if (rows.length) log(`${`${name} (${rows.length})`.padEnd(18)}${PAIRS.map((p) => pairLine(rows, p)).join("")}`);
}

function describe(t: Trial): string {
  let bits = (t.tier ? `[${t.tier}] ` : "") + t.options.map((o) => `${o.label.split(" · ")[0]}=${o.bytes}B/${o.light !== undefined ? `light ${o.light}%` : `s2 ${o.s2}`}${o.butter !== null ? `/bu ${o.butter}` : ""}`).join(" ");
  if (t.budget_drift !== undefined) bits += ` [budget ${t.budget}B, drift ${t.budget_drift}%]`;
  if (t.spread !== undefined) bits += ` spread ${t.spread}`;
  if (t.penalty !== undefined) bits += ` penalty ${t.penalty}`;
  if (t.disagree) bits += " SPLIT";
  if (t.rejected?.length) bits += ` (off budget, left out: ${t.rejected.join("; ")})`;
  return bits;
}

function writeSheet(trials: Trial[], file: string): void {
  if (!trials.length) return;
  const dir = `${file}.tiles`;
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));
  const rows = trials.map((t) => `<div class="row">${t.options.map((o, i) => {
    const name = `${t.axis}-${t.tier ?? ""}-${t.crop}-${i}.${o.decoded ? "png" : "jpg"}`;
    fs.copyFileSync(o.decoded ?? o.path, path.join(dir, name));
    return `<figure><figcaption>${esc(`${t.axis}${t.tier ? `[${t.tier}]` : ""}/${t.crop} ${o.label.split(" · ")[0]} ${o.bytes}B s2=${o.s2} bu=${o.butter}`)}</figcaption><img src="${esc(path.basename(dir))}/${name}" width="${TILE}" height="${TILE}" alt=""></figure>`;
  }).join("")}</div>`).join("\n");
  fs.writeFileSync(file, `<!doctype html><meta charset="utf-8"><title>pixel-peeper contact sheet</title>
<style>body{background:#ECE9D8;color:#1a1a1a;font:12px Tahoma,Verdana,sans-serif;margin:10px}.row{display:flex;gap:10px;margin-bottom:10px}figure{margin:0}figcaption{height:20px;line-height:20px;white-space:nowrap;overflow:hidden}img{display:block;image-rendering:pixelated}</style>
${rows}
`);
  log(`contact sheet: ${file}`);
}

function preflight(axes: string[]): void {
  const missing = [["zenc", ZENC], ["mozjpeg cjpeg", CJPEG], ["ssimulacra2", SSIMULACRA2], ["butteraugli_main", BUTTERAUGLI]].filter(([, p]) => !fs.existsSync(p)).map(([n]) => n);
  if (!which("exif-sooc")) missing.push("exif-sooc");
  if (!fs.existsSync(SRC_DIR)) missing.push(`source photos at ${SRC_DIR}`);
  if (axes.includes("format")) {
    for (const [n, p] of [["cjxl", CJXL], ["djxl", DJXL], ["avifenc", AVIFENC], ["avifdec", AVIFDEC]] as const) if (!p) missing.push(n);
    for (const p of [AVIFENC_AV2, AVIFDEC_AV2]) if (!fs.existsSync(p)) missing.push(`AV2 ${path.basename(p)} at ${p}`);
  }
  if (missing.length) {
    log(`missing: ${missing.join(", ")}`);
    log("  zenc:  cargo build --release --locked --manifest-path tools/photos/zenc/Cargo.toml");
    if (missing.some((m) => m.startsWith("AV2 "))) log(`  AV2:   ${AV2_BUILD_COMMAND}`);
    process.exit(1);
  }
}

function stageTiles(trials: Trial[]): Map<string, Buffer> {
  const staged = new Map<string, Buffer>();
  for (const t of trials) {
    for (const o of t.options) {
      const data = fs.readFileSync(o.path);
      const name = `${createHash("sha256").update(data).digest("hex").slice(0, 12)}${path.extname(o.path)}`;
      staged.set(name, data);
      o.src = `/pixel-peeper/tiles/${name}`;
      delete (o as Partial<Option>).path;
      delete o.decoded;
    }
    delete t.rejected;
  }
  return staged;
}

function writeMerged(axis: Axis, fresh: Trial[]): number {
  if (fresh.length < 2) { log(`\nrefusing to merge: only ${fresh.length} ${axis} trial(s) survived, want >= 2`); return 1; }
  const manifestFile = path.join(OUT_DIR, "manifest.json");
  const current = JSON.parse(fs.readFileSync(manifestFile, "utf8")) as { tile: number; trials: Trial[]; format_pool?: PoolRow[] };
  const kept = current.trials.filter((t) => t.axis !== axis);
  const staged = stageTiles(fresh);
  for (const [name, data] of staged) fs.writeFileSync(path.join(TILES_DIR, name), data);
  const trials = [...kept, ...fresh];
  const referenced = new Set(trials.flatMap((t) => t.options.map((o) => path.basename(o.src as string))));
  let pruned = 0;
  for (const f of fs.readdirSync(TILES_DIR)) if (!referenced.has(f)) { fs.rmSync(path.join(TILES_DIR, f)); pruned += 1; }
  const next = { ...current, trials };
  if (axis === "format") next.format_pool = formatPool;   // the pool is the format axis's, so it is rebuilt with it
  fs.writeFileSync(manifestFile, `${JSON.stringify(next)}\n`);
  log(`\nmerged ${fresh.length} ${axis} trial(s) over ${current.trials.length - kept.length} old; kept ${kept.length} others byte-identical; wrote ${staged.size} tiles, pruned ${pruned}`);
  return 0;
}

function main(): number {
  const argv = process.argv.slice(2);
  const merge = argv.includes("--merge") ? argv[argv.indexOf("--merge") + 1] as Axis : null;
  if (merge && !(merge in CANDIDATES)) { log(`--merge wants one of ${Object.keys(CANDIDATES).join(", ")}`); return 2; }
  const only = merge ?? (argv.includes("--only") ? argv[argv.indexOf("--only") + 1] as Axis : null);
  if (only && !(only in CANDIDATES)) { log(`--only wants one of ${Object.keys(CANDIDATES).join(", ")}`); return 2; }
  const dryRun = argv.includes("--dry-run") || (only !== null && merge === null);
  const sheet = argv.includes("--sheet") ? argv[argv.indexOf("--sheet") + 1] : null;
  // SHARDING, for the format axis above all: an AV2 encode at speed 3 runs on
  // one core, so 11 crops in series took about 3 hours on 14 cores. A shard
  // builds the crops --stems names and --emit saves what it built (trials,
  // their files, drops, pool rows) without ranking. --collect then loads every
  // shard, puts the trials back in author order so ranking ties break as a
  // serial run's would, and ranks and writes exactly as one process does.
  const arg = (f: string): string | null => (argv.includes(f) ? argv[argv.indexOf(f) + 1] : null);
  const stemFilter = arg("--stems")?.split(",") ?? null;
  const emit = arg("--emit");
  const collect = arg("--collect")?.split(",") ?? null;
  if (emit && !only) { log("--emit wants --only <axis>"); return 2; }
  preflight(only ? [only] : Object.keys(CANDIDATES));

  const built: Trial[] = [];
  const dropped: [string, string, string][] = [];
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "pixel-peeper-"));
  try {
    if (collect) {
      const order = (t: { axis: string; crop: string; tier?: string }) => {
        const stems = CANDIDATES[t.axis as Axis][2];
        return stems.indexOf(t.crop) * 10 + (t.tier ? FORMAT_TIERS.indexOf(t.tier as FormatTier) : 0);
      };
      const shards = collect.map((d) => JSON.parse(fs.readFileSync(path.join(d, "built.json"), "utf8")) as { built: Trial[]; dropped: [string, string, string][]; pool: PoolRow[] });
      built.push(...shards.flatMap((s) => s.built).sort((a, b) => order(a) - order(b)));
      dropped.push(...shards.flatMap((s) => s.dropped));
      formatPool.push(...shards.flatMap((s) => s.pool).sort((a, b) => order({ axis: "format", ...a }) - order({ axis: "format", ...b })));
      log(`collected ${built.length} built trial(s) from ${collect.length} shard(s)`);
    }
    for (const [axis, [intent, , stems]] of Object.entries(CANDIDATES) as [Axis, [Intent, number, string[]]][]) {
      if (collect) break;
      if (only && axis !== only) continue;
      for (const stem of [...new Set(stems)]) {
        if (stemFilter && !stemFilter.includes(stem)) continue;
        const tmp = path.join(work, `${axis}-${stem}`);
        fs.mkdirSync(tmp);
        let src: Source, crop: Crop;
        try { src = loadSource(stem, tmp); crop = bestCrop(src, intent, tmp); }
        catch (e) { const why = `source: ${e instanceof Error ? e.message : String(e)}`; dropped.push([axis, stem, why]); log(`  x ${axis.padEnd(9)} ${stem}  ${why}`); continue; }
        const srcs: Srcs = { png: crop.png, ppm: crop.ppm };
        let results: Built[];
        try {
          results = axis === "format" ? buildFormat(stem, srcs, crop.png, tmp)
            : [axis === "quality" ? buildQuality(stem, srcs, crop.png, tmp)
            : axis === "encoder" ? buildEncoder(stem, srcs, crop.png, tmp)
            : axis === "chroma" ? buildChroma(stem, srcs, crop.png, tmp)
            : axis === "tradeoff" ? buildTradeoff(stem, srcs, crop.png, tmp)
            : buildResample(src, tmp)];
        } catch (e) { results = [[null, `${e instanceof Error ? e.constructor.name : "Error"}: ${e instanceof Error ? e.message : String(e)}`]]; }
        for (const [trial, why] of results) {
          if (trial === null) { dropped.push([axis, stem, why]); log(`  x ${axis.padEnd(9)} ${stem}  ${why}`); continue; }
          trial.crop_score = Number(crop.score.toFixed(1));
          built.push(trial);
          log(`  · ${axis.padEnd(9)} ${stem}  ${describe(trial)}`);
        }
      }
    }

    if (emit) {
      // the work dir is deleted below, so each option's file moves into the shard
      fs.mkdirSync(path.join(emit, "files"), { recursive: true });
      built.forEach((t, i) => t.options.forEach((o, j) => {
        for (const k of ["path", "decoded"] as const) {
          const from = o[k];
          if (!from) continue;
          const to = path.join(emit, "files", `${i}-${j}-${k}${path.extname(from)}`);
          fs.copyFileSync(from, to);
          o[k] = to;
        }
      }));
      fs.writeFileSync(path.join(emit, "built.json"), JSON.stringify({ built, dropped, pool: formatPool }));
      log(`\nemitted ${built.length} built trial(s) to ${emit}`);
      return 0;
    }

    const trials: Trial[] = [];
    for (const [axis, [, keep]] of Object.entries(CANDIDATES) as [Axis, [Intent, number, string[]]][]) {
      const groups = axis === "format" ? FORMAT_TIERS.map((tier) => built.filter((t) => t.axis === axis && t.tier === tier)) : [built.filter((t) => t.axis === axis)];
      const each = Math.ceil(keep / groups.length);
      for (const g of groups) {
        const pool = g.sort((a, b) => rankKey(axis, b) - rankKey(axis, a));
        for (const t of pool.slice(each)) dropped.push([axis, t.crop, `ranked ${JSON.stringify(RANK[axis](t))}, below the top ${each} on this axis`]);
        trials.push(...pool.slice(0, each));
      }
    }

    log("");
    const byAxis: Record<string, number> = {};
    for (const t of trials) byAxis[t.axis] = (byAxis[t.axis] ?? 0) + 1;
    log(`kept ${trials.length} of ${built.length} built: ${Object.entries(byAxis).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => `${k} ${v}`).join(", ")}`);
    log(`chroma-flavoured: ${(byAxis.chroma ?? 0) + (byAxis.tradeoff ?? 0)} of ${trials.length}`);
    const enc = trials.filter((t) => t.budget_drift !== undefined);
    if (enc.length) log(`worst equal-budget drift shipped: ${Math.max(...enc.map((t) => t.budget_drift as number))}%`);
    if (dropped.length) { log(`dropped ${dropped.length}:`); for (const [axis, stem, why] of dropped) log(`   ${axis}/${stem}: ${why}`); }
    logPool(formatPool);

    if (sheet) writeSheet(trials, sheet);
    if (dryRun) { log("\n--dry-run: no tiles or manifest written"); return 0; }
    if (merge) return writeMerged(merge, trials);
    if (trials.length < 12) { log(`\nrefusing to write: only ${trials.length} trials survived, want >= 12`); return 1; }

    const staged = stageTiles(trials);
    fs.rmSync(TILES_DIR, { recursive: true, force: true });
    fs.mkdirSync(TILES_DIR, { recursive: true });
    for (const [name, data] of staged) fs.writeFileSync(path.join(TILES_DIR, name), data);
    const manifestFile = path.join(OUT_DIR, "manifest.json");
    fs.writeFileSync(manifestFile, `${JSON.stringify({ tile: TILE, trials, format_pool: formatPool })}\n`);
    const total = [...staged.values()].reduce((n, d) => n + d.length, 0);
    log(`\nwrote ${staged.size} tiles (${Math.floor(total / 1024)} KB) + manifest.json (${fs.statSync(manifestFile).size} B)`);
    return 0;
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

if (import.meta.main) process.exit(main());
