#!/usr/bin/env bun
// gen-pixel-peeper-ladder.ts: the /pixel-peeper format ladder, every format's
// quality from a starved budget up to lossless, on the format axis's crops, at
// two scales.
//
// The format axis asks an eye to call tiles at four budgets, and a call is only
// a call while the tiles differ. That leaves out the two ends where the formats
// part ways most: the top, where pixels are identical and only bytes differ
// (JPEG XL's lossless lead), and the shape of the whole curve, which is where
// "AVIF wins tight budgets, they converge with room" comes from. This walks
// each format's own knob from bottom to top instead of searching it onto one
// budget, and writes the curves to ladder.json beside the manifest, for the
// page to draw and to read "bytes to reach a quality" off. It is its own file
// because only the format answers read it: the exam fetches manifest.json on
// load, and every player would pay for curves most never open.
//
// Two scales, because a resize changes the photo the encoder sees:
//   crop     the format axis's own 320px window at 1:1, the same bestCrop scan,
//            so its lossless bytes are the ones the format calls already show.
//   resized  the whole frame as this site ships it: `zenc square --filter box
//            --size 600`, add-photos.sh's own call. A downscale packs more
//            detail into each pixel, and it ends the lossless JPEG transcode:
//            a resized photo has no JPEG to carry over, so every format starts
//            from pixels.
//
// Formats and settings are the format axis's (JXL_ARGS, AVIF_ARGS), plus JPEG
// as the baseline every browser draws (zenc, 4:4:4 so its top rung is not
// capped by halved colour) and WebP at lossless only, its one remaining job.
// AV2 is left out: one AV2 encode at speed 3 costs about as much as this whole
// ladder for one crop, and its lossless sits in the format calls already.
//
// Lossless is checked, not assumed: each lossless file is decoded and must
// score exactly 100 against its source, or the run stops.
//
// Usage:
//     bun tools/photos/gen-pixel-peeper-ladder.ts             # measure, write ladder.json
//     bun tools/photos/gen-pixel-peeper-ladder.ts --dry-run   # measure and print, write nothing
//     bun tools/photos/gen-pixel-peeper-ladder.ts --stems XT507494,XT509794 --dry-run
//     bun tools/photos/gen-pixel-peeper-ladder.ts --json out.json   # every point, butteraugli too
//     bun tools/photos/gen-pixel-peeper-ladder.ts --from out.json   # rewrite ladder.json from a saved run
//
// WHAT IT FOUND, 2026-10-23, 11 photos (ssimulacra2; JPEG XL bytes as a share
// of AVIF's at the same score, median per photo):
//                 s2 60   s2 70   s2 80   s2 90   s2 95   lossless
//   crop           120%    114%    112%    109%    113%       68%
//   resized        155%    145%    135%    124%    125%       74%
// JPEG XL needed fewer bytes than AVIF on at most 3 of 11 crops at any lossy
// score, and on none of the 11 resized frames. Lossless JPEG XL was also 90%
// (crop) and 92% (resized) of lossless WebP. Every format's top lossy rung
// lands at s2 94-96, so the step from there to lossless costs 7-12 bits a
// pixel, and that step is where JPEG XL's lead is.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CANDIDATES, bestCrop, butter, decodeFmt, encode, encodeFmt, loadSource, ssim2 } from "./gen-pixel-peeper.ts";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ZENC = path.join(REPO, "tools", "photos", "zenc", "target", "release", "zenc");
const LADDER = path.join(REPO, "public", "pixel-peeper", "ladder.json");
const which = (name: string): string | null => {
  const r = spawnSync("sh", ["-c", `command -v ${name}`], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : null;
};
const CJXL = which("cjxl"), AVIFENC = which("avifenc"), CWEBP = which("cwebp"), DWEBP = which("dwebp");

const SHIP_EDGE = 600;   // add-photos.sh's SQ: the square every photo ships as
type Scale = "crop" | "resized";
const SCALES: Scale[] = ["crop", "resized"];
type Lossy = "jpeg" | "avif" | "jxl";
const LOSSY: Lossy[] = ["jpeg", "avif", "jxl"];
type Lossless = "jxl" | "avif" | "webp";

// Each knob from starved to as high as it goes short of lossless. The ends are
// set so every format's curve spans the others', and each top rung is the
// highest setting that is still lossy (JPEG q100, JXL distance 0.1, AVIF q97).
// AVIF stops at 97 because -q 100 with AVIF_ARGS IS lossless: on 2026-10-23 it
// scored exactly 100 on all four test ladders, at 12-17 bits per pixel, more
// than the 8-bit -l file below since it carries 10 bits. A rung that scores
// 100 is refused in ladder(), so a knob list that strays into lossless fails.
const KNOBS: Record<Lossy, number[]> = {
  jpeg: [20, 35, 50, 65, 75, 84, 90, 95, 98, 100],
  avif: [8, 20, 32, 44, 54, 63, 72, 80, 88, 94, 97],
  jxl: [9, 6, 4, 2.8, 2, 1.4, 1, 0.7, 0.45, 0.25, 0.1],
};

type Point = [bpp: number, s2: number, bu: number];
type CropResult = { stem: string; scale: Scale; px: number; curves: Record<Lossy, Point[]>; lossless: Record<Lossless, number> };

const log = (msg: string) => process.stderr.write(`${msg}\n`);
const run = (cmd: string[]) => spawnSync(cmd[0], cmd.slice(1), { encoding: "utf8" });
const zencFrame = (file: string, png: string): string => {
  const r = run([ZENC, "frame", file, "--out", png]);
  if (r.status !== 0) throw new Error(`zenc frame ${file}: ${r.stderr.trim()}`);
  return png;
};

function ladder(fmt: Lossy, ref: string, px: number, tmp: string): Point[] {
  return KNOBS[fmt].map((k, i) => {
    const out = path.join(tmp, `${fmt}-${i}.${fmt === "jpeg" ? "jpg" : fmt}`);
    const bytes = fmt === "jpeg" ? encode("zenc", { png: ref, ppm: ref }, out, k, "444") : encodeFmt(fmt, ref, out, k);
    const dec = path.join(tmp, `${fmt}-${i}-dec.png`);
    if (fmt === "jpeg") zencFrame(out, dec); else decodeFmt(fmt, out, dec);
    const s2 = ssim2(ref, dec);
    if (s2 === 100) throw new Error(`${fmt} at ${k} scored 100: that rung is lossless, and belongs in lossless()`);
    return [Number(((bytes * 8) / px).toFixed(4)), s2, butter(ref, dec)] as Point;
  }).sort((a, b) => a[0] - b[0]);
}

/** Lossless bytes, each one decoded and held to a perfect score. */
function lossless(ref: string, tmp: string): Record<Lossless, number> {
  const quiet = ["--jobs", "4", "--ignore-icc", "--ignore-exif", "--ignore-xmp"];
  const files: Record<Lossless, [string, string[], string[]]> = {
    // cjxl -e 9 and avifenc -l -s 2 are what the format calls' lossless line uses
    jxl: [path.join(tmp, "ll.jxl"), [CJXL as string, ref, path.join(tmp, "ll.jxl"), "-d", "0", "-e", "9", "--quiet"], ["jxl"]],
    avif: [path.join(tmp, "ll.avif"), [AVIFENC as string, "-l", "-d", "8", "--speed", "2", ...quiet, ref, path.join(tmp, "ll.avif")], ["avif"]],
    webp: [path.join(tmp, "ll.webp"), [CWEBP as string, "-lossless", "-z", "9", "-metadata", "none", "-quiet", ref, "-o", path.join(tmp, "ll.webp")], ["webp"]],
  };
  const out = {} as Record<Lossless, number>;
  for (const [fmt, [file, cmd]] of Object.entries(files) as [Lossless, [string, string[], string[]]][]) {
    const r = run(cmd);
    if (!fs.existsSync(file)) throw new Error(`lossless ${fmt} wrote nothing: ${(r.stderr || "").trim().slice(0, 200)}`);
    const dec = path.join(tmp, `ll-${fmt}-dec.png`);
    if (fmt === "webp") run([DWEBP as string, file, "-o", dec, "-quiet"]); else decodeFmt(fmt, file, dec);
    const s = ssim2(ref, dec);
    if (s !== 100) throw new Error(`lossless ${fmt} scored ${s}, not 100: it is not lossless`);
    out[fmt] = fs.statSync(file).size;
  }
  return out;
}

function one(stem: string): CropResult[] {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `pp-ladder-${stem}-`));
  try {
    const src = loadSource(stem, tmp);
    return SCALES.map((scale) => {
      const dir = path.join(tmp, scale);
      fs.mkdirSync(dir);
      let ref: string;
      if (scale === "crop") ref = bestCrop(src, "detail", dir).png;
      else {
        ref = path.join(dir, "ship.png");
        const r = run([ZENC, "square", src.file, "--orient", String(src.orient), "--filter", "box", "--size", String(SHIP_EDGE), "--out", ref]);
        if (!fs.existsSync(ref)) throw new Error(`zenc square: ${r.stderr.trim()}`);
      }
      const dims = run([ZENC, "frame", ref, "--out", path.join(dir, "probe.ppm")]).stdout.trim().split(/\s+/).map(Number);
      const px = dims[0] * dims[1];
      const curves = Object.fromEntries(LOSSY.map((f) => [f, ladder(f, ref, px, dir)])) as Record<Lossy, Point[]>;
      return { stem, scale, px, curves, lossless: lossless(ref, dir) };
    });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// ------------------------------------------------------------------ reading

// s2 as a function of bits per pixel, linear in log(bpp) between rungs. Off
// either end of a curve the answer is null: a format that never reached a
// quality has no byte count for it, and extrapolating would invent one.
function s2At(c: Point[], bpp: number): number | null {
  for (let i = 1; i < c.length; i += 1) {
    const [x0, y0] = c[i - 1], [x1, y1] = c[i];
    if (bpp >= x0 && bpp <= x1) { const t = Math.log(bpp / x0) / Math.log(x1 / x0 || 1); return y0 + t * (y1 - y0); }
  }
  return null;
}
// ...and its inverse: the fewest bits per pixel that reach `s2`. Walks up the
// curve and takes the first crossing, so a rung that dips does not hide it.
function bppFor(c: Point[], s2: number): number | null {
  for (let i = 1; i < c.length; i += 1) {
    const [x0, y0] = c[i - 1], [x1, y1] = c[i];
    if (y0 >= s2) return i === 1 ? x0 : null;   // already there at the bottom rung: not measured from below
    if (y1 >= s2) { const t = (s2 - y0) / (y1 - y0); return x0 * (x1 / x0) ** t; }
  }
  return null;
}
const median = (xs: number[]): number => { const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

// The page reads quality targets and budgets off these, so they live in the
// file rather than being repeated in the page.
// 95 is about as high as lossy goes: every format's top rung lands at 94-97.
const TARGETS = [60, 70, 80, 90, 95];
const BUDGETS = [0.25, 0.5, 1, 2, 4];

function summarize(results: CropResult[]): void {
  for (const scale of SCALES) {
    const rs = results.filter((r) => r.scale === scale);
    log(`\n${scale} (${rs.length} photos). median bits per pixel to reach each s2, and JPEG XL against AVIF per photo`);
    for (const t of TARGETS) {
      const by = (f: Lossy) => rs.map((r) => bppFor(r.curves[f], t));
      const [j, a, x] = LOSSY.map(by);
      const pairs = rs.map((_, i) => [x[i], a[i]]).filter(([p, q]) => p !== null && q !== null) as [number, number][];
      const fmt = (v: (number | null)[]) => { const ok = v.filter((n): n is number => n !== null); return ok.length ? `${median(ok).toFixed(2)} (${ok.length})` : "never"; };
      log(`  s2 ${t}: jpeg ${fmt(j)}  avif ${fmt(a)}  jxl ${fmt(x)}  jxl/avif ${pairs.length ? (100 * median(pairs.map(([p, q]) => p / q))).toFixed(0) : "-"}%, jxl fewer on ${pairs.filter(([p, q]) => p < q).length}/${pairs.length}`);
    }
    for (const b of BUDGETS) {
      const at = (f: Lossy) => rs.map((r) => s2At(r.curves[f], b));
      const [j, a, x] = LOSSY.map(at);
      const both = rs.map((_, i) => [x[i], a[i]]).filter(([p, q]) => p !== null && q !== null) as [number, number][];
      const mean = (v: (number | null)[]) => { const ok = v.filter((n): n is number => n !== null); return ok.length ? (ok.reduce((s, n) => s + n, 0) / ok.length).toFixed(1) : "-"; };
      log(`  ${b} bpp: jpeg ${mean(j)}  avif ${mean(a)}  jxl ${mean(x)}  jxl ahead on ${both.filter(([p, q]) => p > q).length}/${both.length}`);
    }
    const ll = (f: Lossless) => median(rs.map((r) => (r.lossless[f] * 8) / r.px));
    log(`  lossless bpp: jxl ${ll("jxl").toFixed(2)}  avif ${ll("avif").toFixed(2)}  webp ${ll("webp").toFixed(2)}  jxl/avif ${(100 * median(rs.map((r) => r.lossless.jxl / r.lossless.avif))).toFixed(0)}%  jxl/webp ${(100 * median(rs.map((r) => r.lossless.jxl / r.lossless.webp))).toFixed(0)}%`);
    const top = (f: Lossy) => median(rs.map((r) => r.curves[f][r.curves[f].length - 1][1]));
    log(`  top lossy rung, median s2: jpeg ${top("jpeg").toFixed(1)}  avif ${top("avif").toFixed(1)}  jxl ${top("jxl").toFixed(1)}`);
  }
}

// --------------------------------------------------------------------- main

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const arg = (f: string): string | null => (argv.includes(f) ? argv[argv.indexOf(f) + 1] : null);
  // A child does one photo and prints its JSON. The parent fans the photos out
  // over processes, since every tool here runs on one core at a time.
  const solo = arg("--one");
  if (solo) { process.stdout.write(JSON.stringify(one(solo))); return 0; }
  // --from rewrites ladder.json from a saved --json run without encoding
  // anything, for when only the shipped shape changed.
  const from = arg("--from");
  if (from) { const rs = JSON.parse(fs.readFileSync(from, "utf8")) as CropResult[]; summarize(rs); writeLadder(rs); return 0; }

  for (const [n, p] of [["zenc", fs.existsSync(ZENC) ? ZENC : null], ["cjxl", CJXL], ["avifenc", AVIFENC], ["cwebp", CWEBP], ["dwebp", DWEBP]] as const) {
    if (!p) { log(`missing: ${n}`); return 1; }
  }
  const stems = arg("--stems")?.split(",") ?? CANDIDATES.format[2];
  const jobs = Math.max(1, Math.floor(os.availableParallelism() / 2));
  log(`ladder: ${stems.length} photos x ${SCALES.length} scales, ${jobs} at a time`);
  const results: CropResult[] = [];
  const queue = [...stems];
  const srcArgs = argv.includes("--src") ? ["--src", arg("--src") as string] : [];
  const worker = async () => {
    for (let stem = queue.shift(); stem; stem = queue.shift()) {
      const s = stem;
      const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "--one", s, ...srcArgs], { stdio: ["ignore", "pipe", "inherit"] });
      let out = "";
      child.stdout.on("data", (d) => { out += d; });
      const code: number = await new Promise((resolve) => child.on("close", resolve));
      if (code !== 0) { log(`  x ${s}: exit ${code}`); continue; }
      results.push(...(JSON.parse(out) as CropResult[]));
      log(`  · ${s}`);
    }
  };
  await Promise.all(Array.from({ length: jobs }, worker));
  // author order, so ladder.json does not churn with which child finished first
  results.sort((a, b) => stems.indexOf(a.stem) - stems.indexOf(b.stem) || SCALES.indexOf(a.scale) - SCALES.indexOf(b.scale));
  if (results.length !== stems.length * SCALES.length) { log(`\nonly ${results.length} of ${stems.length * SCALES.length} ladders finished; writing nothing`); return 1; }
  summarize(results);

  const json = arg("--json");
  if (json) fs.writeFileSync(json, JSON.stringify(results, null, 1));
  if (argv.includes("--dry-run")) { log("\n--dry-run: ladder.json untouched"); return 0; }
  writeLadder(results);
  return 0;
}

/** The shipped file keeps what the page draws: bits per pixel and ssimulacra2
 *  per rung, lossless bytes, and the pixel count that turns bytes into bits per
 *  pixel. butteraugli stays in --json, since the chart plots one metric. */
function writeLadder(results: CropResult[]): void {
  const photos = results.map((r) => ({ stem: r.stem, scale: r.scale, px: r.px, lossless: r.lossless,
    curves: Object.fromEntries(LOSSY.map((f) => [f, r.curves[f].map(([b, s]) => [Number(b.toFixed(3)), Number(s.toFixed(2))])])) }));
  fs.writeFileSync(LADDER, `${JSON.stringify({ targets: TARGETS, budgets: BUDGETS, ship_edge: SHIP_EDGE, photos })}\n`);
  log(`\nwrote ${path.relative(REPO, LADDER)}: ${results.length} ladders, ${fs.statSync(LADDER).size} B`);
}

if (import.meta.main) process.exit(await main());
