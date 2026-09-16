#!/usr/bin/env node
// gen-pixel-peeper.ts — rebuild the /pixel-peeper trial set from the canonical
// photo source.
//
// The first trial set was cut by hand and never committed a generator, which is
// exactly how its encoder trials ended up comparing encodes at different file
// sizes: `sips` was handed 23-43% more bytes than its rivals and then "won" the
// metrics for it. A trial that does not hold bytes constant teaches the wrong
// lesson, so the byte budget is enforced here by search rather than by hope.
//
// Three rules this script exists to enforce:
//
//   1. ENCODER trials share ONE byte budget. Every encoder's quality knob is
//      binary-searched until its output lands inside BUDGET_TOL of the target,
//      and an encoder that cannot reach the budget is dropped from the trial
//      rather than shipped as an unequal comparison.
//   2. QUALITY trials are picked for a WIDE, visible spread. The ladder is
//      encoded and measured first, then three rungs are chosen by their
//      ssimulacra2 distance from the top rung, so every quality call has a
//      clearly-worst option no matter how forgiving the crop turns out to be.
//   3. Trials that fail their axis's legibility threshold are REJECTED and
//      reported, not quietly shipped. A call nobody can see is not a test.
//
// Usage:
//     bun tools/photos/gen-pixel-peeper.ts                  # full rebuild
//     bun tools/photos/gen-pixel-peeper.ts --dry-run        # measure, write nothing
//     bun tools/photos/gen-pixel-peeper.ts --sheet x.html   # a contact sheet to eyeball
//     bun tools/photos/gen-pixel-peeper.ts --only chroma    # one axis, implies --dry-run
//
// Needs: zenc (cargo build in tools/photos/zenc), mozjpeg's cjpeg, sips,
// ssimulacra2, butteraugli_main, and the source folder.
//
// ── why this is TypeScript, since 2026-09-15 ──────────────────────────────
// It was gen-pixel-peeper.py, 849 lines, and the last Python in the tree. Its
// Pillow did four pixel jobs: decode with the EXIF orientation applied, a
// downscaled proxy to scan crop windows on, a native crop as PNG and PPM, and
// JPEG decode for the metrics. All four are `zenc frame` now, the same decoder
// and resampler the shipped tiers go through. The window SCORING is here, in
// arithmetic over the proxy's PPM bytes, ported operation for operation from
// Pillow (its luma weights, its FIND_EDGES kernel and border rule, its
// population stddev), with one named difference: the 16x16 structure collapse
// is an area average where Pillow's was lanczos, since at a 20x reduction only
// the big regions survive either way and that is the whole point of it.
//
// Two things changed on purpose with the port. cjpegli left the encoder
// lineup: config/retired.json banned it in July and the Python went on calling
// an unmanaged copy in ~/.local/bin that tools:check could not see, because
// the declaration scanner reads shell. And the contact sheet is an HTML page
// rather than a bitmap with drawn labels, so the browser draws the text and no
// font rasterizer has to be built for a review artifact.
//
// The trial set was REGENERATED with the port, so the committed tiles are this
// script's output, not the Python's: crop selection depends on the scorer's
// exact arithmetic, and reproducing Pillow's bytes was never the goal.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------- paths + tools

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SRC_DIR = "/Users/aadharsh/Downloads/to post (from ssd)";
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

const TILE = 320;         // tile edge, cropped at NATIVE resolution: 1:1 pixels is the point
const BUDGET_TOL = 0.02;  // equal-budget trials: every option within +/-2% of the target
// 2% is the floor an INTEGER quality knob can actually hold. The knob moves size in
// jumps of 2-5% near the working range, so demanding tighter than this just throws
// away good trials to no benefit. For scale, the hand-cut set this replaces ran
// 23-43% apart and called it an encoder comparison.

// --------------------------------------------------------------- the trial plan
//
// The mix is deliberately lopsided AWAY from chroma. The old set ran 9 of 18
// trials on chroma (3 "chroma" + 6 "tradeoff"), and chroma is the axis human
// eyes are worst at: the test read as brutal because half of it was asking
// people to see something their visual system does not resolve. Chroma is still
// worth teaching, so it stays, as a minority, on the most saturated crops
// available, where the effect is actually visible.

// Candidates are OVER-PROVISIONED and then ranked: every one is built and measured,
// and only the most legible `keep` survive per axis. That way the shipped set is
// chosen on measured visibility rather than on which photo I happened to like.
type Intent = "detail" | "color";
type Axis = "quality" | "encoder" | "chroma" | "tradeoff" | "resample";
const CANDIDATES: Record<Axis, [Intent, number, string[]]> = {
  quality: ["detail", 8, [
    "XT507494",   // chrome grille, fine mesh
    "XT509278",   // red grille, black mesh
    "XT507955",   // metal staircase, yellow stripes
    "XT509986",   // subway signage, text edges
    "XT508055",   // mountain road sign
    "XT507517",   // license plate lettering
    "XT509535",   // Coca-Cola livery, text on a curve
    "XT509509",   // train livery lettering
    "XT509965",   // pier sign
    "XT507940",   // framed painting
    "XT509488",   // hand + pen, skin detail
  ]],
  encoder: ["detail", 6, [
    "XT509794",   // brick road texture
    "XT509848",   // brick + paint
    "XT509388",   // coat of arms
    "XT509540",   // motorcycle number plate
    "XT508890",   // blossom, foliage is encoder-hard
    "XT509276",   // red car, white wheel
    "XT509446",   // staircase, yellow line
    "XT509892",   // two cars, mixed texture
    "XT507343",   // yellow/black sticker on glass
    "XT509721",   // shirt + cap weave
    "XT508756",   // knit + jacket texture
    "XT509698",   // jersey mesh
    "XT508790",   // roofline against sky
  ]],
  // Chroma is the axis where candidates die. The survivors all look the same:
  // a HIGH-CONTRAST TWO-TONE boundary (livery stripes, signage, a painted edge
  // against chrome), never a big saturated panel. Feed it accordingly, and
  // expect most of this list to be rejected: that rejection IS the finding.
  chroma: ["color", 3, [
    "XT509540",   // red/white motorcycle, livery stripes
    "XT507343",   // yellow/black sticker on glass
    "XT509814",   // blue car, yellow stripe
    "XT509839",   // red car, yellow sticker
    "XT509779",   // blue car beside a yellow taxi
    "XT509276",   // red car, white wheel
    "XT509085",   // yellow building, two figures
    "XT509446",   // staircase, yellow line
    "XT509892",   // black car beside a yellow one
    "XT509794",   // yellow car on brick
    "XT508947",   // beer crates, three saturated hues
    "XT508890",   // pink blossom against sky
    "XT509535",   // Coca-Cola red on white
    "XT509987",   // wings sign
  ]],
  tradeoff: ["color", 3, [
    "XT509987",   // wings sign
    "XT509315",   // colourful umbrella
    "XT509534",   // yellow car, red seat
    "XT509535",   // Coca-Cola red
    "XT508947",   // beer crates
    "XT509509",   // train livery
    "XT509809",   // yellow car, red interior
    "XT509346",   // orange mirror
  ]],
  // The geometry axis. Fine repeating detail is where a downscale's defects
  // live: gamma-incorrect averaging darkens texture, and aliasing shows on
  // anything periodic. A smooth subject would separate by nothing and the
  // legibility gate would correctly drop it, so the stems are chosen the same
  // way the quality axis chooses its own.
  resample: ["detail", 6, [
    "XT507494",   // chrome grille, fine mesh
    "XT509278",   // red grille, black mesh
    "XT507955",   // metal staircase, yellow stripes
    "XT509986",   // subway signage, text edges
    "XT509509",   // train livery lettering
    "XT507517",   // license plate lettering
    "XT509535",   // Coca-Cola livery, text on a curve
  ]],
};

type Option = { label: string; bytes: number; s2: number | null; butter: number | null; q: number; path: string; chroma?: string; s2best?: boolean; butterbest?: boolean; src?: string };
// `spread` is absent on a tradeoff trial, as it was in the Python: that axis
// ranks on the metric split and the penalty, and the manifest carries neither
// a spread it did not measure nor a placeholder.
type Trial = { axis: Axis; crop: string; options: Option[]; disagree: boolean; spread?: number; budget?: number; budget_drift?: number; penalty?: number; rejected?: string[]; crop_score?: number };

// How each axis ranks its survivors: bigger sorts first, so ships first.
//
// The two colour axes rank differently ON PURPOSE. `chroma` teaches a visible
// lesson, so it ranks on how much 4:2:0 actually costs. `tradeoff` exists to
// FEED the metric-alignment needle, which only reads calls where the two metrics
// disagree, so a tradeoff trial that splits them beats one that does not however
// pretty its numbers are.
const RANK: Record<Axis, (t: Trial) => number | [number, number]> = {
  quality: (t) => t.spread as number,
  encoder: (t) => t.spread as number,
  chroma: (t) => t.spread as number,   // structural damage is what a person can SEE
  tradeoff: (t) => [t.disagree ? 1 : 0, t.penalty ?? 0],
  resample: (t) => t.spread as number, // how far apart the two geometries land
};
const rankKey = (axis: Axis, t: Trial): number => { const k = RANK[axis](t); return Array.isArray(k) ? k[0] * 1e6 + k[1] : k; };

// Legibility thresholds. A trial that cannot clear these is dropped, because a
// call whose options are indistinguishable teaches nothing and just feels hard.
const QUALITY_MID_GAP = 10.0;   // ssimulacra2 points between top rung and middle rung
const QUALITY_LOW_GAP = 26.0;   // ...and between top rung and bottom rung
const QUALITY_MIN_SPREAD = 18.0;
const ENCODER_MIN_SPREAD = 3.5; // s2 points between the best and worst encoder at equal bytes
const CHROMA_MIN_BUTTER = 0.25; // butteraugli penalty 4:2:0 must take over 4:2:2
// ...and it has to cost STRUCTURE too. 1.2 was the first guess and it was too
// loose: it passed a flat orange panel whose two encodes are indistinguishable
// side by side, because at that margin the "gap" is measuring grain. 3.0 is where
// a contact sheet starts showing a difference a person can point at.
const CHROMA_MIN_S2 = 3.0;
const COLOR_MIN_SAT = 34.0;     // mean 0-255 saturation a 'color' crop must carry to qualify
// Large-scale contrast a 'detail' crop must have, so pure grain is excluded.
// Measured rather than guessed, and the gap is wide: the one ambiguous crop in
// the shipped set (flat grainy sky) scores 0.95, while every crop that made a
// legible call scores 16 to 58. Anywhere in between works; 12 keeps margin.
const DETAIL_MIN_STRUCT = 12.0;

const QUALITY_LADDER = [20, 25, 30, 35, 40, 45, 50, 55, 60, 65, 70, 75, 80, 85, 88, 91, 94, 96];

const log = (msg: string) => process.stderr.write(`${msg}\n`);
const run = (cmd: string[]) => spawnSync(cmd[0], cmd.slice(1), { encoding: "utf8" });
const zenc = (args: string[]): string => execFileSync(ZENC, args, { encoding: "utf8" });

// ------------------------------------------------------------------ source load

type Source = { file: string; orient: number; stem: string };

/** Find a source frame and its EXIF orientation. HIF goes through sips to a
 *  lossless TIFF (PNG spends its time deflating an intermediate that is deleted
 *  a moment later: 6.17s against 0.42s on one 7728x5152 frame); a JPEG is read
 *  by zenc directly. The orientation is read off the ORIGINAL, which is what
 *  add-photos.sh does too, since sips does not promise to carry the tag. */
function loadSource(stem: string, tmp: string): Source {
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

// ---------------------------------------------------------------- crop choosing
//
// Pixel arithmetic over a P6 PPM, ported from Pillow operation for operation.

type Rgb = { w: number; h: number; px: Uint8Array };

function readPpm(file: string): Rgb {
  const buf = fs.readFileSync(file);
  const m = /^P6\s+(\d+)\s+(\d+)\s+255\s/.exec(buf.subarray(0, 40).toString("latin1"));
  if (!m) throw new Error(`${file} is not the P6 zenc writes`);
  const w = Number(m[1]), h = Number(m[2]);
  return { w, h, px: new Uint8Array(buf.buffer, buf.byteOffset + m[0].length, w * h * 3) };
}

/** Pillow's RGB to L: ITU-R 601-2 luma in its fixed-point form. */
function toGray(im: Rgb): Uint8Array {
  const out = new Uint8Array(im.w * im.h);
  for (let i = 0, p = 0; i < out.length; i += 1, p += 3) out[i] = (im.px[p] * 19595 + im.px[p + 1] * 38470 + im.px[p + 2] * 7471 + 0x8000) >> 16;
  return out;
}

/** Pillow's FIND_EDGES: the 3x3 kernel (-1 all round, 8 in the centre),
 *  clipped to 0..255, with the one-pixel border copied from the input. */
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

/** Pillow's ImageStat: population mean and stddev over one band. */
function stats(band: Uint8Array): { mean: number; stddev: number } {
  let sum = 0, sq = 0;
  for (let i = 0; i < band.length; i += 1) { sum += band[i]; sq += band[i] * band[i]; }
  const n = band.length, mean = sum / n;
  return { mean, stddev: Math.sqrt(Math.max(0, sq / n - mean * mean)) };
}

/** max(r,g,b) - min(r,g,b) per pixel: Pillow's lighter/darker chain. */
function saturation(im: Rgb): Uint8Array {
  const out = new Uint8Array(im.w * im.h);
  for (let i = 0, p = 0; i < out.length; i += 1, p += 3) {
    const r = im.px[p], g = im.px[p + 1], b = im.px[p + 2];
    out[i] = Math.max(r, g, b) - Math.min(r, g, b);
  }
  return out;
}

/** |r - b| per pixel: ImageChops.difference on the two outer bands. */
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

/** How much large-scale light/dark SHAPE the window has. Grain scores ~0.
 *
 *  Every edge-energy measure tried here is really a grain meter, and grain is
 *  the thing that makes a call unanswerable: three encodes of a flat noisy sky
 *  differ only in how much grain survived, and "which looks best" then has no
 *  honest answer. Both FIND_EDGES stddev and its downsampled variant ranked
 *  that sky ABOVE a two-tone racing livery whose lettering visibly softens at
 *  every quality step.
 *
 *  Collapsing to 16x16 throws away all texture and leaves only the big regions.
 *  A livery (dark panel against pale lettering) keeps a wide spread; uniform
 *  grain averages to a flat field and scores near zero. That is the distinction
 *  that matters, because shapes are what a person can actually judge. An area
 *  average does the collapse here (Pillow's was lanczos); at 20x either one
 *  leaves only the regions. */
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

/** Higher is a better tile: SHAPES for 'detail', colour-EDGY for 'color'. */
function scoreWindow(win: Rgb, intent: Intent): number {
  const gray = toGray(win);
  const detail = stats(findEdges(gray, win.w, win.h)).stddev;
  if (intent === "detail") {
    // Fine detail RANKS (it is what falling quality destroys, and it reliably
    // finds grilles, brickwork and lettering). Structure only GATES. Ranking
    // on structure instead was tried and was worse across the board: it
    // picked big soft out-of-focus panels with one smooth boundary, which
    // have almost no fine detail for quality to take away. The narrow failure
    // being fixed is a crop of pure grain, nothing more.
    if (structure(gray, win.w, win.h) < DETAIL_MIN_STRUCT) return -1e6;
    return detail;
  }
  // 4:2:0 does not damage saturated FLAT areas: halving the resolution of a
  // field of solid red loses nothing. It damages saturated BOUNDARIES, where a
  // hue changes faster than the halved chroma plane can carry.
  //
  // Two wrong cuts of this got shipped to a contact sheet before this one.
  // Ranking by mean saturation picked big flat red panels (nothing to see).
  // Ranking by full-resolution chroma gradient was worse and sneakier: it
  // picked grey speckled STONE, because per-pixel colour noise has enormous
  // chroma gradient. That crop scored a 4.45 ssimulacra2 gap between 4:2:2 and
  // 4:2:0, a real number, measuring damage to noise nobody can see.
  //
  // Windows arrive here already downscaled ~5x by bestCrop's proxy, which is
  // what suppresses the pixel noise; the fix that mattered is the SATURATION
  // GATE below. Grey stone has huge chroma gradient and almost no saturation,
  // so gating on saturation is what tells the two apart.
  const sat = saturation(win);
  if (stats(sat).mean < COLOR_MIN_SAT) return -1e6;  // not a colour crop at all, whatever its gradients say
  // Saturation is a GATE, never a multiplier. Multiplying by it (the third wrong
  // cut) ranked a flat orange panel top of the pool: maximum saturation, no
  // boundary, nothing for 4:2:0 to damage. The boundary term has to lead.
  const coarse = stats(findEdges(sat, win.w, win.h)).stddev + stats(findEdges(redBlueDifference(win), win.w, win.h)).stddev;
  return coarse + detail * 0.05;
}

type Crop = { png: string; ppm: string; score: number };

/** Scan candidate windows on a coarse proxy, then cut the winner at native res.
 *
 *  `boxPx` is the NATIVE window edge. It defaults to TILE, which is every axis
 *  that compares encodes of one set of pixels. The resample axis asks for a
 *  larger window because what it compares is the DOWNSCALE, so it needs real
 *  reduction to happen inside the trial rather than a 1:1 cut. */
function bestCrop(src: Source, intent: Intent, tmp: string, boxPx = TILE, name = "crop"): Crop {
  const proxyPpm = path.join(tmp, `${name}-proxy.ppm`);
  const dims = zenc(["frame", src.file, "--orient", String(src.orient), "--fit", "1400", "--out", proxyPpm]).trim().split(/\s+/).map(Number);
  const [W, H] = dims;
  if (W < boxPx || H < boxPx) throw new Error(`source smaller than a ${boxPx}px window: ${W}x${H}`);
  // Score on a downscaled proxy so the scan is cheap, then map the window back.
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
  // Map proxy coords back to native, clamped so the tile stays inside the frame.
  const nx = Math.min(W - boxPx, Math.max(0, Math.floor(best[0] / scale)));
  const ny = Math.min(H - boxPx, Math.max(0, Math.floor(best[1] / scale)));
  const png = path.join(tmp, `${name}.png`), ppm = path.join(tmp, `${name}.ppm`);
  zenc(["frame", src.file, "--orient", String(src.orient), "--crop", String(nx), String(ny), String(boxPx), String(boxPx), "--out", png, "--out", ppm]);
  return { png, ppm, score: bestS };
}

// -------------------------------------------------------------------- encoders

const MOZ_SAMPLE: Record<string, string> = { "444": "1x1", "422": "2x1", "420": "2x2" };
type Kind = "zenc" | "mozjpeg" | "sips";
type Srcs = { png: string; ppm: string };

/** One encode. `srcs` carries the crop in each form an encoder can read. */
function encode(kind: Kind, srcs: Srcs, out: string, q: number, chroma = "420"): number {
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

/** Binary-search the quality knob until the output lands on `target` bytes.
 *  Returns the closest attempt, whether or not it made tolerance; the caller
 *  decides whether to keep it. */
function searchQuality(kind: Kind, srcs: Srcs, tmp: string, target: number, chroma = "420", lo = 5, hi = 100): { q: number; bytes: number; path: string } | null {
  if (lo > hi) return null;
  if (kind === "zenc") {
    const out = path.join(tmp, "search-zenc.jpg");
    const result = JSON.parse(zenc(["jpeg-search", srcs.png, out, String(target), chroma, String(lo), String(hi)])) as { q: number; bytes: number };
    // Keep the same returned filename/lifetime as the other encoder paths.
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

// --------------------------------------------------------------------- metrics

const toPng = (jpg: string, png: string): string => { zenc(["frame", jpg, "--out", png]); return png; };
const firstFloat = (tool: string, r: ReturnType<typeof run>): number => {
  const m = /-?\d+\.\d+/.exec(r.stdout || "");
  if (!m) throw new Error(`${tool} said: ${(r.stdout || "").trim()} ${(r.stderr || "").trim()}`);
  return Number(m[0]);
};
const ssim2 = (ref: string, test: string): number => Number(firstFloat("ssimulacra2", run([SSIMULACRA2, ref, test])).toFixed(2));
const butter = (ref: string, test: string): number => Number(firstFloat("butteraugli", run([BUTTERAUGLI, ref, test])).toFixed(3));
function measure(refPng: string, jpg: string, tmp: string, both = true): [number, number | null] {
  const png = toPng(jpg, path.join(tmp, `${path.parse(jpg).name}-dec.png`));
  return [ssim2(refPng, png), both ? butter(refPng, png) : null];
}

// ------------------------------------------------------------- trial builders

/** Tag each metric's favourite and say whether the two of them split. */
function markWinners(options: Option[]): boolean {
  const bestS2 = Math.max(...options.map((o) => o.s2 as number));
  const bestBu = Math.min(...options.map((o) => o.butter as number));  // butteraugli: lower is better
  for (const o of options) { o.s2best = o.s2 === bestS2; o.butterbest = o.butter === bestBu; }
  return options.find((o) => o.s2best) !== options.find((o) => o.butterbest);
}

type Built = [Trial, null] | [null, string];

/** Encode the ladder, then pick three rungs spread far enough apart to SEE. */
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

/** One byte budget, three encoders, each searched onto it. This is the fix. */
function buildEncoder(cropId: string, srcs: Srcs, refPng: string, tmp: string): Built {
  // The budget is whatever zenc spends at a middling quality: a real-world
  // web-export size for this crop rather than a number picked out of the air.
  const target = encode("zenc", srcs, path.join(tmp, "budget-probe.jpg"), 72, "420");
  let options: Option[] = [];
  const rejected: string[] = [];
  for (const kind of ["zenc", "mozjpeg", "sips"] as Kind[]) {
    let got;
    try { got = searchQuality(kind, srcs, tmp, target, "420"); }
    catch (e) { rejected.push(`${kind}: ${e instanceof Error ? e.message : String(e)}`); continue; }  // report, don't crash the run
    if (got === null) { rejected.push(`${kind}: search found nothing`); continue; }
    const drift = Math.abs(got.bytes - target) / target;
    if (drift > BUDGET_TOL) { rejected.push(`${kind}: closest was ${got.bytes}B, ${(drift * 100).toFixed(1)}% off budget`); continue; }
    const [s2, bu] = measure(refPng, got.path, tmp);
    options.push({ label: kind, bytes: got.bytes, s2, butter: bu, q: got.q, path: got.path });
  }
  if (options.length < 2) return [null, `only ${options.length} encoder(s) hit the budget; ${JSON.stringify(rejected)}`];
  // Three tiles is the widest the UI lays out, so keep the most separated set:
  // the s2 winner, the s2 loser, and whichever middle option sits furthest from
  // both, which is what makes the call readable instead of a three-way tie.
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

/** Same quality setting, full colour vs halved. Bytes differ: that IS the axis. */
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

/** Equal bytes, forced trade: 4:2:0 buys sharpness with the colour budget. */
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
    // how hard the two sides pull apart: the colour cost of 4:2:0 against the
    // sharpness it bought. A trade nobody can feel ranks last.
    penalty: Number(Math.abs((options[0].butter as number) - (options[1].butter as number)).toFixed(3)) }, null];
}

// The reduction the trial reproduces. The pipeline takes a ~1333px short edge to
// a 600px square, so ~2.2x; 3x here keeps the tile peepable while staying in the
// regime the site actually runs in. A 1:1 comparison would test nothing, since
// the whole difference between these two candidates IS the downscale.
const RESAMPLE_REDUCTION = 3;
// Two candidates that are meant to differ MUST separate by this much for the
// trial to ship. Below it, nobody can call the tile and the honest answer is that
// the difference does not survive at display size.
const RESAMPLE_MIN_SPREAD = 8.0;

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
 *  can tell them apart at all. The TILE-sized crop the main loop cut is unused;
 *  this re-cuts a RESAMPLE_REDUCTION x larger window from the same source,
 *  because a downscale needs something to reduce. */
function buildResample(src: Source, tmp: string): Built {
  const big = bestCrop(src, "detail", tmp, TILE * RESAMPLE_REDUCTION, "resample-src");
  const made: Record<string, string> = {};
  for (const label of ["sips", "zenc"]) {
    const out = path.join(tmp, `resample-${label}.png`);
    // sips: the shipping chain resized the short edge, then centre-cropped. The
    // window is already square, so this is the resize alone.
    if (label === "sips") run([SIPS, "-Z", String(TILE), big.png, "--out", out]);
    else run([ZENC, "square", big.png, "--size", String(TILE), "--out", out, "--filter", "box"]);
    if (!fs.existsSync(out)) return [null, `${label} produced no output`];
    made[label] = out;
  }
  // One byte budget, both searched onto it, so the tile is not secretly a
  // quality comparison. Same discipline the encoder axis uses.
  const target = encode("zenc", { png: made.sips, ppm: made.sips }, path.join(tmp, "resample-budget.jpg"), 72, "420");
  const options: Option[] = [];
  const rejected: string[] = [];
  for (const [label, png] of Object.entries(made)) {
    // A SUBDIRECTORY PER CANDIDATE, and it is load-bearing. searchQuality names
    // its output by encoder `kind`, and both candidates here are zenc, so a
    // shared tmp makes them write to the same cand-zenc-<q>.jpg. When the two
    // geometries happen to settle on the same quality the second silently
    // overwrites the first, both options point at one file, and the spread
    // reads exactly 0.0, which looks like "these are indistinguishable" and is
    // really "these are the same file". Two of seven crops reported that
    // before the split.
    const sub = path.join(tmp, `rs-${label}`);
    fs.mkdirSync(sub, { recursive: true });
    const got = searchQuality("zenc", { png, ppm: png }, sub, target, "420");
    if (got === null) { rejected.push(`${label}: search found nothing`); continue; }
    const drift = Math.abs(got.bytes - target) / target;
    if (drift > BUDGET_TOL) { rejected.push(`${label}: closest was ${got.bytes}B, ${(drift * 100).toFixed(1)}% off budget`); continue; }
    options.push({ label, bytes: got.bytes, q: got.q, path: got.path, s2: null, butter: null });
  }
  if (options.length !== 2) return [null, `only ${options.length} geometry hit the budget; ${JSON.stringify(rejected)}`];
  // The legibility gate: how far apart the two DECODED tiles are. A reference
  // is deliberately absent, so this is ssimulacra2 run candidate against
  // candidate, which is symmetric and needs no truth.
  const spread = 100.0 - ssim2(toPng(options[0].path, path.join(tmp, "resample-a-dec.png")), toPng(options[1].path, path.join(tmp, "resample-b-dec.png")));
  if (spread < RESAMPLE_MIN_SPREAD) return [null, `the two geometries differ by only ${spread.toFixed(1)} at this budget (want ${RESAMPLE_MIN_SPREAD}); nobody could call this tile`];
  return [{ axis: "resample", crop: src.stem, options, spread: Number(spread.toFixed(1)), disagree: false, budget: target }, null];
}

// ------------------------------------------------------------------------ main

function describe(t: Trial): string {
  let bits = t.options.map((o) => `${o.label.split(" · ")[0]}=${o.bytes}B/s2 ${o.s2}`).join(" ");
  if (t.budget_drift !== undefined) bits += ` [budget ${t.budget}B, drift ${t.budget_drift}%]`;
  if (t.spread !== undefined) bits += ` spread ${t.spread}`;
  if (t.penalty !== undefined) bits += ` penalty ${t.penalty}`;
  if (t.disagree) bits += " SPLIT";
  return bits;
}

/** Lay every trial's options side by side at 1:1 so a HUMAN can check them.
 *
 *  This exists because the metrics lie about visibility in a specific way: a
 *  crop of grey speckled stone scored a 4.45 ssimulacra2 gap between 4:2:2 and
 *  4:2:0, a big honest number measuring damage to colour noise that nobody can
 *  see. Numbers pick the candidates; the sheet is how you find out whether the
 *  call is winnable. Look at it before shipping a threshold change.
 *
 *  An HTML page beside a directory of the tiles, so the browser draws the
 *  labels; `image-rendering: pixelated` keeps the tiles at 1:1. */
function writeSheet(trials: Trial[], file: string): void {
  if (!trials.length) return;
  const dir = `${file}.tiles`;
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));
  const rows = trials.map((t) => `<div class="row">${t.options.map((o, i) => {
    const name = `${t.axis}-${t.crop}-${i}.jpg`;
    fs.copyFileSync(o.path, path.join(dir, name));
    return `<figure><figcaption>${esc(`${t.axis}/${t.crop} ${o.label.split(" · ")[0]} ${o.bytes}B s2=${o.s2} bu=${o.butter}`)}</figcaption><img src="${esc(path.basename(dir))}/${name}" width="${TILE}" height="${TILE}" alt=""></figure>`;
  }).join("")}</div>`).join("\n");
  fs.writeFileSync(file, `<!doctype html><meta charset="utf-8"><title>pixel-peeper contact sheet</title>
<style>body{background:#ECE9D8;color:#1a1a1a;font:12px Tahoma,Verdana,sans-serif;margin:10px}.row{display:flex;gap:10px;margin-bottom:10px}figure{margin:0}figcaption{height:20px;line-height:20px;white-space:nowrap;overflow:hidden}img{display:block;image-rendering:pixelated}</style>
${rows}
`);
  log(`contact sheet: ${file}`);
}

function preflight(): void {
  const missing = [["zenc", ZENC], ["mozjpeg cjpeg", CJPEG], ["ssimulacra2", SSIMULACRA2], ["butteraugli_main", BUTTERAUGLI]].filter(([, p]) => !fs.existsSync(p)).map(([n]) => n);
  if (!which("exif-sooc")) missing.push("exif-sooc");
  if (!fs.existsSync(SRC_DIR)) missing.push(`source photos at ${SRC_DIR}`);
  if (missing.length) {
    log(`missing: ${missing.join(", ")}`);
    log("  zenc:  cargo build --release --locked --manifest-path tools/photos/zenc/Cargo.toml");
    process.exit(1);
  }
}

function main(): number {
  const argv = process.argv.slice(2);
  const only = argv.includes("--only") ? argv[argv.indexOf("--only") + 1] as Axis : null;
  if (only && !(only in CANDIDATES)) { log(`--only wants one of ${Object.keys(CANDIDATES).join(", ")}`); return 2; }
  // --only implies --dry-run: a partial set must never be written, because the
  // manifest is all-or-nothing.
  const dryRun = argv.includes("--dry-run") || only !== null;
  const sheet = argv.includes("--sheet") ? argv[argv.indexOf("--sheet") + 1] : null;
  preflight();

  const built: Trial[] = [];
  const dropped: [string, string, string][] = [];
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "pixel-peeper-"));
  try {
    for (const [axis, [intent, , stems]] of Object.entries(CANDIDATES) as [Axis, [Intent, number, string[]]][]) {
      if (only && axis !== only) continue;
      for (const stem of [...new Set(stems)]) {          // dedupe, keep author order
        const tmp = path.join(work, `${axis}-${stem}`);
        fs.mkdirSync(tmp);
        let src: Source, crop: Crop;
        try { src = loadSource(stem, tmp); crop = bestCrop(src, intent, tmp); }
        catch (e) { const why = `source: ${e instanceof Error ? e.message : String(e)}`; dropped.push([axis, stem, why]); log(`  x ${axis.padEnd(9)} ${stem}  ${why}`); continue; }
        const srcs: Srcs = { png: crop.png, ppm: crop.ppm };
        let trial: Trial | null, why: string | null;
        try {
          [trial, why] = axis === "quality" ? buildQuality(stem, srcs, crop.png, tmp)
            : axis === "encoder" ? buildEncoder(stem, srcs, crop.png, tmp)
            : axis === "chroma" ? buildChroma(stem, srcs, crop.png, tmp)
            : axis === "tradeoff" ? buildTradeoff(stem, srcs, crop.png, tmp)
            : buildResample(src, tmp);
        } catch (e) { trial = null; why = `${e instanceof Error ? e.constructor.name : "Error"}: ${e instanceof Error ? e.message : String(e)}`; }
        if (trial === null) { dropped.push([axis, stem, why as string]); log(`  x ${axis.padEnd(9)} ${stem}  ${why}`); continue; }
        trial.crop_score = Number(crop.score.toFixed(1));
        built.push(trial);
        log(`  · ${axis.padEnd(9)} ${stem}  ${describe(trial)}`);
      }
    }

    // ---- rank within each axis, keep the most legible
    const trials: Trial[] = [];
    for (const [axis, [, keep]] of Object.entries(CANDIDATES) as [Axis, [Intent, number, string[]]][]) {
      const pool = built.filter((t) => t.axis === axis).sort((a, b) => rankKey(axis, b) - rankKey(axis, a));
      for (const t of pool.slice(keep)) dropped.push([axis, t.crop, `ranked ${JSON.stringify(RANK[axis](t))}, below the top ${keep} on this axis`]);
      trials.push(...pool.slice(0, keep));
    }

    // ---- report
    log("");
    const byAxis: Record<string, number> = {};
    for (const t of trials) byAxis[t.axis] = (byAxis[t.axis] ?? 0) + 1;
    log(`kept ${trials.length} of ${built.length} built: ${Object.entries(byAxis).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => `${k} ${v}`).join(", ")}`);
    log(`chroma-flavoured: ${(byAxis.chroma ?? 0) + (byAxis.tradeoff ?? 0)} of ${trials.length}`);
    const enc = trials.filter((t) => t.budget_drift !== undefined);
    if (enc.length) log(`worst equal-budget drift shipped: ${Math.max(...enc.map((t) => t.budget_drift as number))}%`);
    if (dropped.length) { log(`dropped ${dropped.length}:`); for (const [axis, stem, why] of dropped) log(`   ${axis}/${stem}: ${why}`); }

    if (sheet) writeSheet(trials, sheet);
    if (dryRun) { log("\n--dry-run: no tiles or manifest written"); return 0; }
    if (trials.length < 12) { log(`\nrefusing to write: only ${trials.length} trials survived, want >= 12`); return 1; }

    // ---- write (only now that the whole set is known good)
    const staged = new Map<string, Buffer>();
    for (const t of trials) {
      for (const o of t.options) {
        const data = fs.readFileSync(o.path);
        const h = createHash("sha256").update(data).digest("hex").slice(0, 12);
        staged.set(h, data);
        o.src = `/pixel-peeper/tiles/${h}.jpg`;
        delete (o as Partial<Option>).path;
      }
      delete t.rejected;
    }
    fs.rmSync(TILES_DIR, { recursive: true, force: true });
    fs.mkdirSync(TILES_DIR, { recursive: true });
    for (const [h, data] of staged) fs.writeFileSync(path.join(TILES_DIR, `${h}.jpg`), data);
    const manifestFile = path.join(OUT_DIR, "manifest.json");
    fs.writeFileSync(manifestFile, `${JSON.stringify({ tile: TILE, trials })}\n`);
    const total = [...staged.values()].reduce((n, d) => n + d.length, 0);
    log(`\nwrote ${staged.size} tiles (${Math.floor(total / 1024)} KB) + manifest.json (${fs.statSync(manifestFile).size} B)`);
    return 0;
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

if (import.meta.main) process.exit(main());
