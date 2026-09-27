#!/usr/bin/env bun
// codec-knob-probe.ts — which encoder flags buy JPEG XL or AVIF quality per
// byte, at the /pixel-peeper format axis's own budgets? --codec picks which.
//
// Every JXL variant is searched onto the SAME byte budget the format axis uses (the
// AVIF encode's real output size, per tier), decoded by djxl, and scored against
// the native crop. So a variant is only ever compared at matched bytes, which is
// the rule matched-bytes-probe.ts states for the resampling work: a flag that
// "improves quality" by spending more bytes has improved nothing.
//
// AVIF CANNOT BE SEARCHED ONTO A BUDGET, which is why its half works
// differently. avifenc's -q walks ~64 quantizer steps, 3-6% of a tile apiece,
// so a variant lands wherever its nearest step does and a 2% gate throws most
// of them away. Instead each AVIF variant is BRACKETED: the two adjacent -q
// values whose sizes straddle the budget are both scored, and the score at the
// exact budget is interpolated linearly in bytes. That is a one-point
// rate-distortion curve, and it compares every variant, base included, at the
// same byte count to the byte.
//
// Nothing here adds content the camera did not record. aom's film grain
// (denoise, then resynthesize at decode) and cjxl's photon noise are OUT on
// that rule, whatever a metric says about them. (Photon noise was measured
// once before the rule was written down: -0.10 / -0.06 s2, so it lost anyway.) Turning a codec's own loop
// filter OFF is in scope: that removes a filter rather than adding one.
//
// Two crop sets, and the split is the point. TRAIN is the format axis's own
// candidate list, which is what any setting chosen here will ship on. HOLDOUT is
// detail crops the axis never uses. A decoder-filter strength tuned on 8 tiles
// can fit those tiles; a gain that holds on 8 unseen ones is a property of the
// encoder. Promote nothing that fails the holdout.
//
// Usage:
//     bun tools/photos/codec-knob-probe.ts                    # JXL, every variant, both sets
//     bun tools/photos/codec-knob-probe.ts --codec avif
//     bun tools/photos/codec-knob-probe.ts --set train --variants base,epf0
//     bun tools/photos/codec-knob-probe.ts --json out.json
//
// WHAT IT FOUND FOR JXL, 2026-09-27, against the 4:4:4 AVIF budget (train /
// holdout, Δ s2 over plain effort 9 at matched bytes; base trails AVIF by
// 2.09 / 2.50, and no arm closes that):
//   zenc JPEG repacked (cjxl -j 1), no reconstruction box   +1.34 / +1.50   bu +0.18 / +0.21
//   zenc JPEG repacked, box kept                            +0.97 / +0.99   bu +0.20 / +0.27
//   --gaborish=0 --epf=0                                    +0.40 / +0.64   bu +0.04 / +0.06
//   lossy modular (-I 100, -E 3, -g 0, e10 all alike)       ~0    / +1.0    bu +0.31 to +0.47
//   --intensity_target=400                                  +0.04 / +0.51   does not replicate
//   --faster_decoding=4                                     -0.02 / +0.24   about free
//   effort 10, --codestream_level=10, 16-bit                ~0
//   -p (progressive)                                        -1.13 / -1.37
//   --intensity_target=150                                  -0.23 / -0.76
//   --disable_perceptual_optimizations                      -15.9 / -14.3
// The repack of a 4:4:4 zenc JPEG is worse than of a 4:2:0 one (+0.20 / +0.60).
// Repacking the SHIPPED 600px JPEG tier saves 9.24% (12.64 to 11.48 MB) with
// identical pixels, and is still 42.7% larger than the 4:4:4 AVIF tier, so it
// never wins for a browser that decodes both.
//
// WHAT IT FOUND FOR WEBP, 2026-09-27, against the 4:4:4 AVIF budget (train /
// holdout, Δ s2 over -m 6 -sharp_yuv at the default sns 50; that baseline
// trails AVIF by 5.24 / 5.68, and no arm closes it):
//   -sns 25                                  +0.45 / +0.66   bu -0.15 / -0.19   shipped on the axis
//   -sns 10 / 15 / 35 / 40                   lower than 25 on both sets
//   -sns 25 with -sharpness 7 and -pass 10   +0.56 / +0.70   within noise of 25 alone
//   -sns 80 / 100                            -2.18 / -2.81, -5.53 / -7.26
//   -preset photo / picture                  -2.3 to -2.7 (both raise sns)
//   -m 4                                     -1.46 / -1.24
//   -nostrong                                -1.26 / -1.49
//   -f 0, -af, -segments 1 or 2              -0.2 to -1.1
//   zenwebp 0.4.4 (imazen's pure-Rust VP8)   -0.54 / -0.30, and its Auto preset -1.06 / -0.41
// zenwebp follows libwebp's algorithms closely (its README claims sizes within
// 0.02% at method 5), so no better WebP encoder exists to swap in; the gains
// are in libwebp's own knobs, and they are worth under a point.
//
// Crops are cached in --cache (default: a directory under the OS temp dir), since
// cutting one from a HIF costs a full-resolution sips decode.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  AVIF_ARGS, bestCrop, butter, CANDIDATES, decodeFmt, encode, encodeFmt, FORMAT_TIER_ANCHOR, JXL_ARGS, loadSource, searchFmt, ssim2, WEBP_ARGS,
} from "./gen-pixel-peeper.ts";

// The baseline is whatever the format axis ships, so a variant's delta is the
// delta the page would see if it were promoted.
// Variants are built on PLAIN effort 9, so they stay comparable across runs
// whatever the format axis currently ships (JXL_ARGS, the `base` row).
const E9 = ["-e", "9"];
const JXL_VARIANTS: Record<string, string[]> = {
  base: JXL_ARGS,
  e9: E9,
  e7: ["-e", "7"],
  e10: ["-e", "10"],
  e11: ["-e", "11", "--allow_expert_options"],
  epf0: [...E9, "--epf=0"],
  epf1: [...E9, "--epf=1"],
  epf2: [...E9, "--epf=2"],
  epf3: [...E9, "--epf=3"],
  gab0: [...E9, "--gaborish=0"],
  resamp2: [...E9, "--resampling=2"],
  modular: [...E9, "-m", "1"],
  gab0epf0: [...E9, "--gaborish=0", "--epf=0"],
  gab0epf3: [...E9, "--gaborish=0", "--epf=3"],
  modgab0: [...E9, "-m", "1", "--gaborish=0"],
  // Not a cjxl flag set: zenc's JPEG, repacked into JXL LOSSLESSLY (cjxl -j 1).
  // The knob searched is zenc's quality, and the size is the repacked file's.
  // This is the lever only JXL has: the tuned JPEG encoder's pixels, ~20% smaller.
  zencjxl: ["<zenc-recompress>"],
  // Second batch, 2026-09-27. Screened first for "accepted, and moves the
  // bytes" at d1.8 e9 on one crop; these came back BYTE-IDENTICAL to the base
  // and are left out: --dots, --patches, --noise=0, --gaborish=1, --epf=-1,
  // --buffering=0, --container=0 (cjxl already writes a bare codestream), and
  // in modular mode -C, -P 15, -Y 0, -X 0, -R 1. An unknown flag exits 1.
  it150: [...E9, "--intensity_target=150"],
  it400: [...E9, "--intensity_target=400"],
  noperc: [...E9, "--disable_perceptual_optimizations"],
  fastdec4: [...E9, "--faster_decoding=4"],
  prog: [...E9, "-p"],
  progdc: [...E9, "--progressive_dc=1"],
  level10: [...E9, "--codestream_level=10"],
  bd16: [...E9, "--override_bitdepth=16"],
  gab0epf0it150: [...E9, "--gaborish=0", "--epf=0", "--intensity_target=150"],
  modI100: [...E9, "-m", "1", "-I", "100"],
  modE3: [...E9, "-m", "1", "-E", "3"],
  modg0: [...E9, "-m", "1", "-g", "0"],
  mode10: ["-e", "10", "-m", "1"],
  // The repack arm without the JPEG-reconstruction box (the site never needs
  // the original JPEG back, so those bytes are overhead), and from a 4:4:4
  // zenc JPEG, since a repack keeps whatever subsampling the JPEG had.
  zencjxlnr: ["<zenc-recompress>", "420", "--allow_jpeg_reconstruction=0"],
  zenc444jxlnr: ["<zenc-recompress>", "444", "--allow_jpeg_reconstruction=0"],
};

// Keys already at libavif 1.4.2's defaults for a still image are left out,
// because they produced BYTE-IDENTICAL files at q63 (2026-09-26): tune=iq,
// enable-qm=1, enable-chroma-deltaq=1, aq-mode=1, enable-restoration=1. A key
// avifenc does not know exits 1 ("Invalid codec-specific option"), so every
// key below was accepted, and each moved the bytes.
const AV = (...extra: string[]) => [...AVIF_ARGS, ...extra];
/** The shipping flags with one of them replaced. */
const with_ = (flag: string, value: string) => AVIF_ARGS.map((a, i) => (AVIF_ARGS[i - 1] === flag ? value : a));
const AVIF_VARIANTS: Record<string, string[]> = {
  base: AVIF_ARGS,
  s1: with_("--speed", "1"),
  yuv420: with_("--yuv", "420"),
  yuv422: with_("--yuv", "422"),
  yuv444: with_("--yuv", "444"),
  d8: with_("-d", "8"),
  d12: with_("-d", "12"),
  tunessim: AV("-a", "tune=ssim"),
  tunepsnr: AV("-a", "tune=psnr"),
  dq0: AV("-a", "deltaq-mode=0"),
  dq3: AV("-a", "deltaq-mode=3"),
  sharp1: AV("-a", "sharpness=1"),
  sharp2: AV("-a", "sharpness=2"),
  sharp4: AV("-a", "sharpness=4"),
  cdef0: AV("-a", "enable-cdef=0"),
  lr0: AV("-a", "enable-restoration=0"),
  nofilt: AV("-a", "enable-cdef=0", "-a", "enable-restoration=0"),
};

// WebP, 2026-09-27. Screened at -q 80 -m 6 -sharp_yuv on one crop first: an
// unknown flag exits 1, and -strong (the default), -pre 2, -hint and -mt came
// back BYTE-IDENTICAL, so they are left out. -mt changing nothing is worth a
// line beside gotcha 43, where avifenc's --jobs did change the bytes. The loop
// filter flags (-f, -sharpness, -nostrong, -af) keep the size and change the
// decode, so matched bytes is exactly the right test for them. -preset has to
// come first on cwebp's command line, which is why WEBP_ARGS precede -q.
// Variants are built on the PLAIN flags (default sns), so they stay comparable
// across runs whatever the format axis ships (WEBP_ARGS, the `base` row).
const WEBP_PLAIN = ["-m", "6", "-sharp_yuv"];
const W = (...extra: string[]) => [...WEBP_PLAIN, ...extra];
const WEBP_VARIANTS: Record<string, string[]> = {
  base: WEBP_ARGS,
  plain: WEBP_PLAIN,
  m4: ["-m", "4", "-sharp_yuv"],
  nosharp: ["-m", "6"],
  sns0: W("-sns", "0"),
  sns25: W("-sns", "25"),
  sns80: W("-sns", "80"),
  sns100: W("-sns", "100"),
  f0: W("-f", "0"),
  f30: W("-f", "30"),
  f90: W("-f", "90"),
  sharp7: W("-sharpness", "7"),
  nostrong: W("-nostrong"),
  af: W("-af"),
  seg1: W("-segments", "1"),
  seg2: W("-segments", "2"),
  pass10: W("-pass", "10"),
  sns10: W("-sns", "10"),
  sns15: W("-sns", "15"),
  sns35: W("-sns", "35"),
  sns40: W("-sns", "40"),
  sns25s7: W("-sns", "25", "-sharpness", "7"),
  sns25p10: W("-sns", "25", "-pass", "10"),
  sns25s7p10: W("-sns", "25", "-sharpness", "7", "-pass", "10"),
  photo: ["-preset", "photo", ...WEBP_PLAIN],
  picture: ["-preset", "picture", ...WEBP_PLAIN],
  // Not cwebp: zenwebp, imazen's pure-Rust VP8 encoder (the zenjpeg authors),
  // through a small CLI named by ZENWEBP_BIN, since the crate ships no usable
  // one. Method 6 with sharp YUV to match the base; the second arm adds its
  // content-detecting Auto preset, the one idea it has that libwebp lacks.
  zenwebp: ["<zenwebp>", "none"],
  zenwebpauto: ["<zenwebp>", "auto"],
};

const TRAIN = CANDIDATES.format[2];
const HOLDOUT = ["XT509278", "XT507955", "XT508055", "XT509535", "XT509965", "XT509848", "XT509388", "XT509540"];
const TIERS = Object.keys(FORMAT_TIER_ANCHOR) as (keyof typeof FORMAT_TIER_ANCHOR)[];

type Codec = "jxl" | "avif" | "webp";
type Row = { set: string; stem: string; tier: string; budget: number; avif: { s2: number; bu: number }; v: Record<string, { bytes: number; d: number; s2: number; bu: number } | { error: string }> };

// ------------------------------------------------------------------ worker

function cropFor(stem: string, cache: string): string {
  const png = path.join(cache, `${stem}.png`);
  if (fs.existsSync(png)) return png;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `knobprobe-${stem}-`));
  try {
    const crop = bestCrop(loadSource(stem, tmp), "detail", tmp);
    fs.copyFileSync(crop.png, png);
    fs.copyFileSync(crop.ppm, path.join(cache, `${stem}.ppm`));
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  return png;
}

/** zenc at quality q, then cjxl --lossless_jpeg=1. Bisect q onto the budget. */
function recompressed(srcs: { png: string; ppm: string }, dir: string, target: number, ref: string, chroma = "420", extra: string[] = []): { bytes: number; d: number; s2: number; bu: number } {
  let lo = 5, hi = 100, best: { q: number; bytes: number; path: string } | null = null;
  while (lo <= hi) {
    const q = Math.floor((lo + hi) / 2);
    const jpg = path.join(dir, `z${q}.jpg`), jxl = path.join(dir, `z${q}.jxl`);
    encode("zenc", srcs, jpg, q, chroma);
    const r = Bun.spawnSync(["cjxl", jpg, jxl, "--lossless_jpeg=1", "-e", "9", ...extra, "--quiet"]);
    if (r.exitCode !== 0) throw new Error(`cjxl -j 1 failed on zenc q${q}`);
    const bytes = fs.statSync(jxl).size;
    if (!best || Math.abs(bytes - target) < Math.abs(best.bytes - target)) best = { q, bytes, path: jxl };
    if (bytes > target) hi = q - 1; else if (bytes < target) lo = q + 1; else break;
  }
  const b = best as { q: number; bytes: number; path: string };
  const dec = decodeFmt("jxl", b.path, path.join(dir, "dec.png"));
  return { bytes: b.bytes, d: b.q, s2: ssim2(ref, dec), bu: butter(ref, dec) };
}

/** Score an AVIF variant AT the budget: find the adjacent -q pair whose sizes
 *  straddle it, score both, interpolate linearly in bytes. `d` carries the
 *  lower -q plus the fraction of the way to the next one. */
/** zenwebp's quality is continuous like cwebp's, so bisect it onto the budget. */
function searchZenwebp(png: string, dir: string, target: number, preset: string): { knob: number; bytes: number; path: string } {
  const bin = process.env.ZENWEBP_BIN;
  if (!bin || !fs.existsSync(bin)) throw new Error("set ZENWEBP_BIN to a zenwebp CLI: <in.png> <out.webp> <q> <method> <sharp 0|1> <preset>");
  let lo = 0, hi = 100, best: { knob: number; bytes: number; path: string } | null = null;
  for (let step = 0; step < 18; step += 1) {
    const q = (lo + hi) / 2, out = path.join(dir, `zw-${step}.webp`);
    const r = Bun.spawnSync([bin, png, out, q.toFixed(3), "6", "1", preset]);
    if (r.exitCode !== 0 || !fs.existsSync(out)) throw new Error(`zenwebp q=${q} failed: ${r.stderr.toString().slice(0, 120)}`);
    const bytes = fs.statSync(out).size;
    if (!best || Math.abs(bytes - target) < Math.abs(best.bytes - target)) best = { knob: q, bytes, path: out };
    if (Math.abs(bytes - target) / target < 0.002) break;
    if (bytes > target) hi = q; else lo = q;
  }
  return best as { knob: number; bytes: number; path: string };
}

export function bracketed(ref: string, dir: string, target: number, args: string[]): { bytes: number; d: number; s2: number; bu: number } {
  const size = new Map<number, number>();
  const at = (q: number) => { if (!size.has(q)) size.set(q, encodeFmt("avif", ref, path.join(dir, `q${q}.avif`), q, undefined, args)); return size.get(q) as number; };
  let lo = 0, hi = 100;                        // invariant: at(lo) <= target < at(hi), checked below
  if (at(lo) > target || at(hi) <= target) throw new Error(`budget ${target}B outside -q 0..100 (${at(0)}..${at(100)}B)`);
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (at(m) <= target) lo = m; else hi = m; }
  const score = (q: number) => { const d = decodeFmt("avif", path.join(dir, `q${q}.avif`), path.join(dir, `q${q}.png`)); return [ssim2(ref, d), butter(ref, d)]; };
  const [s2a, bua] = score(lo), [s2b, bub] = score(hi);
  const t = (target - at(lo)) / (at(hi) - at(lo));
  const r = (x: number) => Number(x.toFixed(3));
  return { bytes: target, d: r(lo + t), s2: r(s2a + t * (s2b - s2a)), bu: r(bua + t * (bub - bua)) };
}

function work(codec: Codec, set: string, stem: string, variants: string[], cache: string): Row[] {
  const ref = cropFor(stem, cache);
  const srcs = { png: ref, ppm: ref.replace(/\.png$/, ".ppm") };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `knobprobe-${stem}-`));
  try {
    return TIERS.map((tier) => {
      const a = FORMAT_TIER_ANCHOR[tier];
      const sub = path.join(tmp, tier);
      fs.mkdirSync(sub);
      // the budget, exactly as buildFormatTier derives it
      const avif = a.enc === "avif"
        ? (() => { const p = path.join(sub, "ship.avif"); return { bytes: encodeFmt("avif", ref, p, a.q), path: p }; })()
        : searchFmt("avif", ref, sub, encode("zenc", srcs, path.join(sub, "anchor.jpg"), a.q, a.chroma));
      const ad = decodeFmt("avif", avif.path, path.join(sub, "avif.png"));
      const row: Row = { set, stem, tier, budget: avif.bytes, avif: { s2: ssim2(ref, ad), bu: butter(ref, ad) }, v: {} };
      for (const name of variants) {
        const vd = path.join(sub, name);
        fs.mkdirSync(vd);
        if (codec === "webp") {
          try {
            const v = WEBP_VARIANTS[name];
            const got = v[0] === "<zenwebp>" ? searchZenwebp(ref, vd, avif.bytes, v[1]) : searchFmt("webp", ref, vd, avif.bytes, undefined, undefined, v);
            const dec = decodeFmt("webp", got.path, path.join(vd, "dec.png"));
            row.v[name] = { bytes: got.bytes, d: Number(got.knob.toFixed(3)), s2: ssim2(ref, dec), bu: butter(ref, dec) };
          } catch (e) { row.v[name] = { error: e instanceof Error ? e.message.slice(0, 120) : String(e) }; }
          continue;
        }
        if (codec === "avif") { try { row.v[name] = bracketed(ref, vd, avif.bytes, AVIF_VARIANTS[name]); } catch (e) { row.v[name] = { error: e instanceof Error ? e.message.slice(0, 120) : String(e) }; } continue; }
        try {
          const v = JXL_VARIANTS[name];
          if (v[0] === "<zenc-recompress>") { row.v[name] = recompressed(srcs, vd, avif.bytes, ref, v[1] ?? "420", v.slice(2)); continue; }
          const got = searchFmt("jxl", ref, vd, avif.bytes, JXL_VARIANTS[name]);
          const dec = decodeFmt("jxl", got.path, path.join(vd, "dec.png"));
          row.v[name] = { bytes: got.bytes, d: Number(got.knob.toFixed(3)), s2: ssim2(ref, dec), bu: butter(ref, dec) };
        } catch (e) { row.v[name] = { error: e instanceof Error ? e.message.slice(0, 120) : String(e) }; }
      }
      return row;
    });
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

// -------------------------------------------------------------------- main

const BUDGET_TOL = 0.02;
const ok = (x: Row["v"][string] | undefined, budget: number): x is { bytes: number; d: number; s2: number; bu: number } =>
  !!x && !("error" in x) && Math.abs(x.bytes - budget) / budget <= BUDGET_TOL;

function report(rows: Row[], variants: string[], codec: Codec): void {
  for (const set of ["train", "holdout"]) {
    const rs = rows.filter((r) => r.set === set);
    if (!rs.length) continue;
    const base = rs.filter((r) => ok(r.v.base, r.budget));
    console.log(`\n${set}: ${rs.length} calls (${new Set(rs.map((r) => r.stem)).size} crops x ${TIERS.length} tiers)`);
    const avifGap = base.reduce((n, r) => n + ((r.v.base as { s2: number }).s2 - r.avif.s2), 0) / base.length;
    if (codec !== "avif") console.log(`  base vs AVIF at matched bytes: mean ${avifGap >= 0 ? "+" : ""}${avifGap.toFixed(2)} s2`);
    console.log(`  variant     n  mean Δs2  mean Δbu  s2 wins  ${codec !== "avif" ? "vs AVIF s2" : "bu wins"}`);
    for (const name of variants) {
      const pairs = rs.filter((r) => ok(r.v.base, r.budget) && ok(r.v[name], r.budget));
      if (!pairs.length) { console.log(`  ${name.padEnd(10)}  0  (never landed on budget)`); continue; }
      const d2 = pairs.map((r) => (r.v[name] as { s2: number }).s2 - (r.v.base as { s2: number }).s2);
      const db = pairs.map((r) => (r.v[name] as { bu: number }).bu - (r.v.base as { bu: number }).bu);
      const va = pairs.map((r) => (r.v[name] as { s2: number }).s2 - r.avif.s2);
      const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
      const sign = (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(2)}`;
      console.log(`  ${name.padEnd(10)}${String(pairs.length).padStart(2)}  ${sign(mean(d2)).padStart(8)}  ${sign(mean(db)).padStart(8)}  ${`${d2.filter((x) => x > 0).length}/${pairs.length}`.padStart(7)}  ${codec !== "avif" ? sign(mean(va)).padStart(10) : `${db.filter((x) => x < 0).length}/${pairs.length}`.padStart(7)}`);
    }
  }
  console.log("\nΔbu is butteraugli, where NEGATIVE is better. Only calls landing within 2% of budget count.");
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const arg = (k: string) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : null);
  const cache = arg("--cache") ?? path.join(os.tmpdir(), "jxl-knob-probe-crops");
  fs.mkdirSync(cache, { recursive: true });
  const codec = (arg("--codec") ?? "jxl") as Codec;
  if (codec !== "jxl" && codec !== "avif" && codec !== "webp") { console.error("--codec wants jxl, avif or webp"); return 2; }
  const VARIANTS = codec === "avif" ? AVIF_VARIANTS : codec === "webp" ? WEBP_VARIANTS : JXL_VARIANTS;
  const variants = (arg("--variants") ?? Object.keys(VARIANTS).join(",")).split(",");
  for (const v of variants) if (!VARIANTS[v]) { console.error(`unknown ${codec} variant ${v}; have ${Object.keys(VARIANTS).join(", ")}`); return 2; }
  if (!variants.includes("base")) variants.unshift("base");

  if (argv.includes("--worker")) {
    process.stdout.write(`${JSON.stringify(work(codec, arg("--set") as string, arg("--stem") as string, variants, cache))}\n`);
    return 0;
  }

  const which = arg("--set");
  const jobs = [...(which !== "holdout" ? TRAIN.map((s) => ["train", s]) : []), ...(which !== "train" ? HOLDOUT.map((s) => ["holdout", s]) : [])];
  const self = fileURLToPath(import.meta.url);
  const rows: Row[] = [];
  let next = 0;
  // cjxl and avifenc are multithreaded themselves, so a few workers saturate the machine
  const conc = Number(arg("--jobs") ?? 4);
  const runOne = async (): Promise<void> => {
    while (next < jobs.length) {
      const [set, stem] = jobs[next++];
      const t0 = Date.now();
      const out = await new Promise<string>((resolve, reject) => {
        const p = spawn(process.execPath, [self, "--worker", "--codec", codec, "--set", set, "--stem", stem, "--variants", variants.join(","), "--cache", cache], { stdio: ["ignore", "pipe", "inherit"] });
        let buf = "";
        p.stdout.on("data", (c) => { buf += c; });
        p.on("close", (code) => (code === 0 ? resolve(buf) : reject(new Error(`${stem} exited ${code}`))));
      }).catch((e) => { console.error(`  x ${stem}: ${e.message}`); return ""; });
      if (out) rows.push(...(JSON.parse(out) as Row[]));
      console.error(`  · ${set} ${stem} ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    }
  };
  await Promise.all(Array.from({ length: conc }, runOne));
  const json = arg("--json");
  if (json) fs.writeFileSync(json, `${JSON.stringify(rows, null, 1)}\n`);
  report(rows, variants, codec);
  return 0;
}

if (import.meta.main) process.exit(await main());
