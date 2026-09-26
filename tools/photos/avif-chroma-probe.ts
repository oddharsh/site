#!/usr/bin/env bun
// avif-chroma-probe.ts — which chroma layout wins for the AVIF tiers the site
// actually serves, at the SAME bytes as the shipped encode?
//
// It asked "would 4:4:4 beat the shipped 4:2:0" on 2026-09-26, the answer was
// yes, and the tiers moved to 4:4:4 on the strength of it (zenc/src/avif.c has
// the numbers). It compares all three layouts against whatever SHIPS, so it
// stays a valid check after that change and can be re-run on the next one.
//
// codec-knob-probe.ts measured +0.3 ssimulacra2 for 4:4:4 on 320px crops cut at
// native resolution. The site serves nothing at native resolution: every AVIF
// tier is a 600/400/200px square reduced ~9-26x from the frame. So this re-asks
// the question on those tiers, produced by the pipeline's own `zenc square`.
//
// Per photo and tier:
//   control   the reproduced tier must be BYTE-IDENTICAL to the shipped /i/
//             file, or the run is measuring some other encode. A mismatch is
//             reported and the tier still scored, marked.
//   420/422/444  each scored at exactly the shipped tier's byte count, by
//             bracketing avifenc -q and interpolating (codec-knob-probe.ts's
//             bracketed()), so every layout is compared at identical bytes.
//   equiv     600 tier only: how many MORE bytes 4:2:0 needs to reach 4:4:4's
//             score at the shipped budget. The unit an encoder change is
//             decided in here, rather than a metric delta.
//   rt420     4:2:0 with NO compression: the tier's chroma halved both ways and
//             upsampled back, nothing else. What subsampling alone throws away
//             is the ceiling on what 4:4:4 can win back.
//   rt420@1:1 the same round trip on a native-resolution crop, for contrast.
//
// Every colour source here is 4:2:2 (chroma halved horizontally, full height),
// read off the JPEG frame headers and zenc's own note on the Fuji HIFs.
//
// Usage:
//     bun tools/photos/avif-chroma-probe.ts [--n 24] [--jobs 5] [--json out.json]
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bracketed } from "./codec-knob-probe.ts";
import { AVIF_ARGS, bestCrop, butter, decodeFmt, loadSource, ssim2 } from "./gen-pixel-peeper.ts";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SRC_DIR = "/Users/aadharsh/Downloads/to post (from ssd)";
const ZENC = path.join(REPO, "tools", "photos", "zenc", "target", "release", "zenc");
const HASHES = JSON.parse(fs.readFileSync(path.join(REPO, "public", "images", "hashes.json"), "utf8")) as Record<string, { a: string; s: string; x: string }>;
// size, the /i/ filename suffix, and the hashes.json key
const TIERS = [[600, "", "a"], [400, "-400", "s"], [200, "-200", "x"]] as const;

// ------------------------------------------------------------ chroma round trip

type Rgb = { w: number; h: number; px: Uint8Array };
const readPpm = (file: string): Rgb => {
  const buf = fs.readFileSync(file);
  const m = /^P6\s+(\d+)\s+(\d+)\s+255\s/.exec(buf.subarray(0, 40).toString("latin1")) as RegExpExecArray;
  const w = Number(m[1]), h = Number(m[2]);
  return { w, h, px: new Uint8Array(buf.buffer, buf.byteOffset + m[0].length, w * h * 3) };
};

/** Full-range BT.601 YCbCr (the matrix zenc's AVIF path signals), chroma
 *  box-averaged 2x2, upsampled back with centre-sited bilinear weights (the
 *  3/4-1/4 "fancy" kernel libjpeg and libyuv use), then RGB again. Float
 *  throughout, one rounding at the end, so the loss is subsampling's alone. */
function roundTrip420(im: Rgb, out: string): void {
  const { w, h, px } = im, cw = w >> 1, ch = h >> 1;
  const Y = new Float32Array(w * h), cb = new Float32Array(cw * ch), cr = new Float32Array(cw * ch);
  for (let i = 0; i < w * h; i += 1) {
    const r = px[i * 3], g = px[i * 3 + 1], b = px[i * 3 + 2];
    Y[i] = 0.299 * r + 0.587 * g + 0.114 * b;
    const x = i % w, y = (i / w) | 0, j = (y >> 1) * cw + (x >> 1);
    cb[j] += (-0.168736 * r - 0.331264 * g + 0.5 * b) / 4;
    cr[j] += (0.5 * r - 0.418688 * g - 0.081312 * b) / 4;
  }
  const at = (p: Float32Array, x: number, y: number) => p[Math.min(ch - 1, Math.max(0, y)) * cw + Math.min(cw - 1, Math.max(0, x))];
  const up = (p: Float32Array, x: number, y: number) => {
    // output pixel x sits between chroma samples; nearest gets 3/4, the neighbour 1/4
    const cx = x >> 1, cy = y >> 1, nx = cx + (x & 1 ? 1 : -1), ny = cy + (y & 1 ? 1 : -1);
    return (9 * at(p, cx, cy) + 3 * at(p, nx, cy) + 3 * at(p, cx, ny) + at(p, nx, ny)) / 16;
  };
  const o = Buffer.alloc(w * h * 3);
  const c = (v: number) => Math.min(255, Math.max(0, Math.round(v)));
  for (let y = 0; y < h; y += 1) for (let x = 0; x < w; x += 1) {
    const i = y * w + x, u = up(cb, x, y), v = up(cr, x, y);
    o[i * 3] = c(Y[i] + 1.402 * v);
    o[i * 3 + 1] = c(Y[i] - 0.344136 * u - 0.714136 * v);
    o[i * 3 + 2] = c(Y[i] + 1.772 * u);
  }
  fs.writeFileSync(out, Buffer.concat([Buffer.from(`P6\n${w} ${h}\n255\n`), o]));
}

// ------------------------------------------------------------------ worker

type Score = { s2: number; bu: number };
type Tier = { size: number; bytes: number; control: boolean; base: Score; y420: Score; y422: Score; y444: Score; rt420: number };
type Result = { stem: string; tiers: Tier[]; rt420native: number; equiv: number | null };
const withYuv = (yuv: string) => AVIF_ARGS.map((a, i) => (AVIF_ARGS[i - 1] === "--yuv" ? yuv : a));

/** The budget multiple at which 4:2:0 reaches `want`, to 0.3%: 1 when it
 *  already does at the budget, null when even +40% does not get there. */
function equivalent(png: string, dir: string, budget: number, want: number): number | null {
  let n = 0;
  const at = (b: number) => { const d = path.join(dir, `eq${n++}`); fs.mkdirSync(d); return bracketed(png, d, Math.round(b), withYuv("420")).s2; };
  if (at(budget) >= want) return 1;
  let lo = budget, hi = budget * 1.4;
  if (at(hi) < want) return null;
  for (let i = 0; i < 7; i += 1) { const m = (lo + hi) / 2; if (at(m) < want) lo = m; else hi = m; }
  return Number((hi / budget).toFixed(4));
}

function work(stem: string): Result {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `chroma-${stem}-`));
  try {
    const src = loadSource(stem, tmp);
    const args = [src.file, "--orient", String(src.orient), "--filter", "box"];
    for (const [size] of TIERS) args.push("--size", String(size), "--out", path.join(tmp, `t${size}.png`), "--avif-out", path.join(tmp, `t${size}.avif`));
    const r = spawnSync(ZENC, ["square", ...args], { encoding: "utf8" });
    if (r.status !== 0) throw new Error(`zenc square: ${r.stderr.trim().slice(0, 200)}`);
    const tiers = TIERS.map(([size, suffix, key]): Tier => {
      const png = path.join(tmp, `t${size}.png`), avif = path.join(tmp, `t${size}.avif`);
      const shipped = path.join(REPO, "public", "i", `${stem}${suffix}.${HASHES[stem][key]}.avif`);
      const control = fs.existsSync(shipped) && Buffer.compare(fs.readFileSync(shipped), fs.readFileSync(avif)) === 0;
      const bytes = fs.statSync(avif).size;
      const dec = decodeFmt("avif", avif, path.join(tmp, `t${size}-dec.png`));
      const at = (yuv: string): Score => {
        const d = path.join(tmp, `${size}-${yuv}`);
        fs.mkdirSync(d);
        const b = bracketed(png, d, bytes, withYuv(yuv));
        return { s2: b.s2, bu: b.bu };
      };
      const ppm = path.join(tmp, `t${size}.ppm`), rt = path.join(tmp, `t${size}-rt.ppm`);
      spawnSync(ZENC, ["frame", png, "--out", ppm]);
      roundTrip420(readPpm(ppm), rt);
      return { size, bytes, control, base: { s2: ssim2(png, dec), bu: butter(png, dec) }, y420: at("420"), y422: at("422"), y444: at("444"), rt420: ssim2(ppm, rt) };
    });
    // the contrast: the same round trip at native resolution, on the frame's most detailed window
    const crop = bestCrop(src, "detail", tmp);
    const nrt = path.join(tmp, "native-rt.ppm");
    roundTrip420(readPpm(crop.ppm), nrt);
    const t600 = tiers[0];
    const eqDir = path.join(tmp, "equiv");
    fs.mkdirSync(eqDir);
    return { stem, tiers, rt420native: ssim2(crop.ppm, nrt), equiv: equivalent(path.join(tmp, "t600.png"), eqDir, t600.bytes, t600.y444.s2) };
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

// -------------------------------------------------------------------- main

/** Colour sources with a shipped tier set, every k-th in name order so both
 *  cameras and the whole date range are represented. Monochrom frames (one
 *  JPEG component) are skipped: they ship as 4:0:0 and have no chroma. */
function sample(n: number): string[] {
  const colour = fs.readdirSync(SRC_DIR).filter((f) => /\.(hif|jpe?g)$/i.test(f)).filter((f) => {
    const stem = path.parse(f).name;
    if (!HASHES[stem]) return false;
    if (!/\.jpe?g$/i.test(f)) return true;
    const b = fs.readFileSync(path.join(SRC_DIR, f));
    for (let i = 2; i < b.length - 10;) {
      if (b[i] !== 0xff) { i += 1; continue; }
      const m = b[i + 1];
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return b[i + 9] === 3;
      i += 2 + b.readUInt16BE(i + 2);
    }
    return false;
  }).map((f) => path.parse(f).name).sort();
  const k = Math.max(1, Math.floor(colour.length / n));
  return colour.filter((_, i) => i % k === 0).slice(0, n);
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const arg = (k: string) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : null);
  if (argv.includes("--worker")) { process.stdout.write(`${JSON.stringify(work(arg("--stem") as string))}\n`); return 0; }
  const stems = sample(Number(arg("--n") ?? 24));
  const self = fileURLToPath(import.meta.url);
  const results: Result[] = [];
  let next = 0;
  const one = async () => {
    while (next < stems.length) {
      const stem = stems[next++];
      const out = await new Promise<string>((resolve) => {
        const p = spawn(process.execPath, [self, "--worker", "--stem", stem], { stdio: ["ignore", "pipe", "inherit"] });
        let buf = "";
        p.stdout.on("data", (c) => { buf += c; });
        p.on("close", (code) => resolve(code === 0 ? buf : ""));
      });
      if (out) results.push(JSON.parse(out) as Result); else console.error(`  x ${stem}`);
      console.error(`  · ${stem}`);
    }
  };
  await Promise.all(Array.from({ length: Number(arg("--jobs") ?? 5) }, one));
  if (arg("--json")) fs.writeFileSync(arg("--json") as string, `${JSON.stringify(results, null, 1)}\n`);

  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const sgn = (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(2)}`;
  console.log(`\n${results.length} photos; control (reproduced tier == shipped /i/ bytes): ${results.flatMap((r) => r.tiers).filter((t) => t.control).length}/${results.length * TIERS.length} tiers`);
  console.log("each layout at the shipped tier's exact bytes, as Δ against the shipped encode (s2 up / bu down is better)");
  console.log("tier   shipped s2   420 Δs2  420 Δbu   422 Δs2  422 Δbu   444 Δs2  444 Δbu  444>420  rt420 s2 (no compression)");
  for (const [size] of TIERS) {
    const ts = results.map((r) => r.tiers.find((t) => t.size === size) as Tier);
    const d = (k: "y420" | "y422" | "y444", m: "s2" | "bu") => sgn(mean(ts.map((t) => t[k][m] - t.base[m]))).padStart(8);
    const wins = ts.filter((t) => t.y444.s2 > t.y420.s2).length;
    console.log(`${String(size).padEnd(5)}  ${mean(ts.map((t) => t.base.s2)).toFixed(2).padStart(10)}  ${d("y420", "s2")} ${d("y420", "bu")}  ${d("y422", "s2")} ${d("y422", "bu")}  ${d("y444", "s2")} ${d("y444", "bu")}  ${`${wins}/${ts.length}`.padStart(7)}  ${mean(ts.map((t) => t.rt420)).toFixed(2).padStart(8)}`);
  }
  const eq = results.map((r) => r.equiv).filter((x): x is number => x !== null).sort((a, b) => a - b);
  if (eq.length) {
    const pct = (x: number) => `${((x - 1) * 100).toFixed(2)}%`;
    const med = eq.length % 2 ? eq[eq.length >> 1] : (eq[eq.length / 2 - 1] + eq[eq.length / 2]) / 2;
    console.log(`600 tier, extra bytes 4:2:0 needs to match 4:4:4: median ${pct(med)}, max ${pct(eq[eq.length - 1])}, none needed on ${eq.filter((x) => x <= 1).length} of ${eq.length}${results.length > eq.length ? `, beyond +40% on ${results.length - eq.length}` : ""}`);
  }
  console.log(`native 1:1 crop rt420 s2: ${mean(results.map((r) => r.rt420native)).toFixed(2)}`);
  console.log("Δbu is butteraugli, where NEGATIVE is better.");
  return 0;
}

if (import.meta.main) process.exit(await main());
