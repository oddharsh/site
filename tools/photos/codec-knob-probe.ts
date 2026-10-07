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
//     bun tools/photos/codec-knob-probe.ts --codec avm --variants base,s4   # AV2; needs libavif-avm/build.sh
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
// AV2, `--codec avm`: where the next codec in the AV1 line stands on these
// photos. It is scored against the SAME shipped AVIF budgets and the same AVIF
// scores, so every row reads "AV2 at the bytes AVIF actually costs". Both files
// are AVIF containers (AV2 writes an `av02` item), so this is file against file
// with no container adjustment. It needs avifenc-avm, the AV2 build from
// tools/photos/libavif-avm/build.sh, and is bracketed on -q exactly like the
// AVIF arm. Nothing it writes can ship: no browser decodes AV2.
//
// WHAT IT FOUND FOR AV2, 2026-09-27 (AVM 1.0.0 via libavif 768b3dfe, against
// the 4:4:4 AVIF budget; Δ s2 vs the shipped AVIF at matched bytes, train /
// holdout; wins out of 32; one 320 px encode, best of 3, idle machine):
//   shipped AVIF (aom --speed 2)                        reference              0.45 s
//   speed 6, tune ssim (libavif default, the base)  -1.75 / -2.16   s2 0, bu 7   5.4 s
//   speed 6, tune psnr (tunepsnr)                   -2.04 / -2.81   s2 0, bu 14  5.4 s
//   speed 3, tune ssim (s3)                         -1.03 / -1.53   s2 4, bu 11  18.3 s
// Speed 3 beat speed 6 on all 32 calls. A scratch harness driving raw avmenc
// through its own RGB->YUV (tune psnr) scores AV2 about 0.5 better at the same
// tune (-1.46 / -2.32 at cpu-used 6, -0.81 / -1.66 at 3); that gap is untraced
// and neither instrument puts AV2 ahead on average.
// WHERE AV2 LOSES, from the decodes of all 32 calls at speed 6: error on 8x8
// block means is higher than aom's on 32 of 32 in luma (0.26 -> 0.39) and 32 of
// 32 in chroma (0.25 -> 0.41), including the 8 calls within 1% of budget, while
// fine luma texture tracks the source better on 21 of 32 (Laplacian correlation
// 0.773 -> 0.811). An earlier reading here said AV2 flattens sensor grain; that
// came from eyeballing one frame and the decodes disprove it.
// Lossless (-l, identity matrix, bit-exact on all 16 crops) is 29% LARGER than
// aom's, and speed 3 did not close it (161,336 B vs 160,357 at speed 6).
//
// THE CROPS ARE THE DENSE END. These are /pixel-peeper's detail
// crops, the hardest native-resolution window per photo, at about 1.08 bits per
// pixel. av2-tile-probe.ts's 38 whole-frame tiles average 0.46, and there AV2
// WINS: +0.77 s2 on 28 of 38 (2026-09-28). The shipped 600px tier sits denser
// than that sample (median 0.67 over 255 frames, 2026-10-07): 82 of 255 fall
// under 0.5 bpp, where AV2 won 23 of 24 pooled calls, and the other 173 fall
// where it lost. Read a number from this probe as the worst case, and the tile
// probe's as the sparse third, never either as the verdict for the tier.
//
// TUNING, 2026-09-27/28, on build.sh --tuned with sb-size=128 pinned (base vs
// AVIF -1.57 train, -2.12 holdout). Only per-segment QM held on the holdout:
// `a:enable-qm=1+qm-curve=1+qmseg=1+qmseg-level=12` +0.14 (11 of 16), where the
// QM curve alone is -0.47. Chroma AC +4 (-0.06), Variance Boost and the jpegli
// mask (train only, -0.54 and -0.25 at their best) did not.
//
// Crops are cached in --cache (default: a directory under the OS temp dir), since
// cutting one from a HIF costs a full-resolution sips decode.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  AVIF_ARGS, bestCrop, butter, decodeFmt, encode, encodeFmt, FORMAT_TIER_ANCHOR, JXL_ARGS, loadSource, searchFmt, ssim2,
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

// AV2 through libavif's experimental AVM codec. --speed maps straight onto
// AVM's cpu-used (clamped 0..9), and that axis matters far more than it does
// for aom: on one crop, raw avmenc at cpu-used 3 scored +2.4 s2 over cpu-used 6
// at the same bytes, for 5x the time, and cpu-used 1 ran past 8 minutes on a
// single 320px frame. So the base is speed 6, and the slow speeds are variants.
// Screened 2026-09-27 at q63 on one crop, like the lists above:
// enable-restoration=0 and deltaq-mode=0 came back BYTE-IDENTICAL to the base,
// and enable-tcq is refused ("Invalid codec-specific option", as is an invented
// key, which is the control that a refusal is visible). The rest moved bytes.
//
// TUNE IS THE KNOB THAT MATTERS, and libavif picks it for you. codec_avm.c sets
// AVM_TUNE_SSIM unless a tune is given, where raw avmenc defaults to PSNR, so
// tune=ssim screened byte-identical to the base because it IS the base. AVM
// accepts only psnr and ssim: tune=iq, which libaom 3.13+ uses for the shipped
// AVIF stills, is refused, so AV2 has no still-image tune yet. On XT509540 at
// qp 105, speed 3: ssim 8,308 B s2 69.70 bu 2.56; psnr 8,599 B s2 68.84 bu 1.72.
// ssimulacra2 barely moves and butteraugli swings, which is why the metrics
// read as disagreeing under one tune and agreeing under the other.
// AVM_BUILD_DIR points the AV2 arm at another build of the same libavif, which
// is how a patched encoder is measured against the pinned reference by name.
const AVIFENC_AVM = path.join(process.env.AVM_BUILD_DIR ?? path.join(path.dirname(fileURLToPath(import.meta.url)), "libavif-avm", "build"), "avifenc");
const AVIFDEC_AVM = path.join(path.dirname(AVIFENC_AVM), "avifdec");
// sb-size=128 is pinned because AVM's dynamic choice depends on frame size: at
// speed > 1 it picks 64px superblocks when the short side is 480px or less, so the
// 320px crops would otherwise encode with 64 while a real 600px tier gets 128.
// Measured on two full 600px tiles, 64 costs 1.31 and 1.38 s2 at matched bytes,
// and every per-superblock tool (delta-q, the masks) changes behaviour with it.
const AVM_ARGS = ["-c", "avm", "-d", "10", "--speed", "6", "--yuv", "444", "-a", "sb-size=128"];
const avm = (...extra: string[]) => [...AVM_ARGS, ...extra];
const withAvm = (flag: string, value: string) => AVM_ARGS.map((a, i) => (AVM_ARGS[i - 1] === flag ? value : a));
const AVM_VARIANTS: Record<string, string[]> = {
  base: AVM_ARGS,
  s4: withAvm("--speed", "4"),
  s3: withAvm("--speed", "3"),
  yuv420: withAvm("--yuv", "420"),
  qm1: avm("-a", "enable-qm=1"),
  dq2: avm("-a", "deltaq-mode=2"),
  cdef0: avm("-a", "enable-cdef=0"),
  ccso0: avm("-a", "enable-ccso=0"),
  gdf0: avm("-a", "enable-gdf=0"),
  tunepsnr: avm("-a", "tune=psnr"),
  nofilt: avm("-a", "enable-cdef=0", "-a", "enable-ccso=0", "-a", "enable-gdf=0"),
};

/** Encode and decode for one AVIF-family codec: the shipped aom build, or the
 *  AV2 build, which reads and writes files the shipped avifdec cannot open.
 *  `enc` takes a KNOB in 0..range whose bytes rise with it, which is all
 *  bracketed() needs to know about a codec's quality scale. */
type AvifCodec = { range: number; enc: (png: string, out: string, knob: number, args: string[]) => number; dec: (file: string, png: string) => string };
const AOM: AvifCodec = {
  range: 100,
  enc: (png, out, q, args) => encodeFmt("avif", png, out, q, undefined, args),
  dec: (file, png) => decodeFmt("avif", file, png),
};
// AV2's knob is its own quantizer, qp = 255 - knob. libavif's -q is far too
// coarse for AV2: on XT509540 at speed 3, -q 49 wrote 6,865 B and -q 50 wrote
// 9,608 B, a 40% step, so a -q bracket interpolated across a gap that size.
// `-a qp=` is accepted and overrides -q (qp 120 wrote 2,219 B, qp 126 1,584 B).
// Through that door qp runs 0..255: avmenc's 10-bit floor of -48 is REFUSED
// ("Invalid codec-specific option", measured down to -1), and the first run with
// a -48 ceiling errored on all 32 calls. -q stays at 50 so libavif never reads
// the request as lossless.
const AVM: AvifCodec = {
  range: 255,
  enc: (png, out, knob, args) => {
    // --jobs pinned like the AVIF arm, since a thread count can move bytes (gotcha 43)
    const r = spawnSync(AVIFENC_AVM, ["-q", "50", "-a", `qp=${255 - knob}`, ...args, "--jobs", "4", "--ignore-icc", "--ignore-exif", "--ignore-xmp", png, out], { encoding: "utf8" });
    if (r.status !== 0 || !fs.existsSync(out)) throw new Error(`avifenc-avm qp=${255 - knob} failed: ${(r.stderr || r.stdout || "").trim().slice(-200)}`);
    return fs.statSync(out).size;
  },
  dec: (file, png) => {
    const r = spawnSync(AVIFDEC_AVM, ["-d", "8", file, png], { encoding: "utf8" });
    if (r.status !== 0 || !fs.existsSync(png)) throw new Error(`avifdec (AV2 build) failed: ${(r.stderr || r.stdout || "").trim().slice(-200)}`);
    return png;
  },
};

/** A named AV2 variant, or an inline one: "a:key=val+key2=val2" appends each
 *  pair as `-a key=val` to the base args. Returns null for an unknown name. */
function avmVariant(name: string): string[] | null {
  if (AVM_VARIANTS[name]) return AVM_VARIANTS[name];
  if (!name.startsWith("a:")) return null;
  const pairs = name.slice(2).split("+").filter(Boolean);
  if (!pairs.length || pairs.some((p) => !/^[a-z0-9-]+=-?[0-9A-Za-z.]+$/.test(p))) return null;
  return [...AVM_ARGS, ...pairs.flatMap((p) => ["-a", p])];
}

// Pinned by name, 2026-10-07: the format axis grew three stems that day, and
// every table above was measured on these eight. A TRAIN that followed the
// candidate list would quietly change what "train" means under old results.
export const TRAIN = ["XT507494", "XT509794", "XT508890", "XT509986", "XT509721", "XT507517", "XT509509", "XT508756"];
export const HOLDOUT = ["XT509278", "XT507955", "XT508055", "XT509535", "XT509965", "XT509848", "XT509388", "XT509540"];
const TIERS = Object.keys(FORMAT_TIER_ANCHOR) as (keyof typeof FORMAT_TIER_ANCHOR)[];

type Codec = "jxl" | "avif" | "avm";
type Row = { set: string; stem: string; tier: string; budget: number; avif: { s2: number; bu: number; bu3?: number }; v: Record<string, { bytes: number; d: number; s2: number; bu: number; bu3?: number } | { error: string }> };

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

function butterBoth(ref: string, dec: string): [number, number] {
  const r = spawnSync("butteraugli_main", [ref, dec], { encoding: "utf8" });
  const out = `${r.stdout ?? ""}`;
  const max = Number.parseFloat(out.split("\n")[0] ?? "");
  const p3 = Number.parseFloat(/3-norm:\s*([0-9.]+)/.exec(out)?.[1] ?? "");
  if (!Number.isFinite(max) || !Number.isFinite(p3)) throw new Error(`butteraugli printed no scores: ${out.slice(0, 120)}`);
  return [Number(max.toFixed(3)), Number(p3.toFixed(4))];
}

/** Score an AVIF variant AT the budget: find the adjacent -q pair whose sizes
 *  straddle it, score both, interpolate linearly in bytes. `d` carries the
 *  lower -q plus the fraction of the way to the next one. */
export function bracketed(ref: string, dir: string, target: number, args: string[], codec: AvifCodec = AOM, hint?: number): { bytes: number; d: number; s2: number; bu: number; bu3: number } {
  const size = new Map<number, number>();
  const at = (q: number) => { if (!size.has(q)) size.set(q, codec.enc(ref, path.join(dir, `q${q}.avif`), q, args)); return size.get(q) as number; };
  let lo = 0, hi = codec.range;                // invariant: at(lo) <= target < at(hi), checked below
  // SEEDED: start from a nearby answer (the base variant's) and expand in
  // doubling steps until the sizes straddle the budget, then bisect inside.
  // Bytes are monotone in the knob, so this finds the same adjacent pair the
  // full-range bisection does in about half the encodes; --no-seed is the
  // control that checks that equivalence rather than assuming it.
  if (hint !== undefined && Number.isFinite(hint)) {
    const h = Math.max(0, Math.min(codec.range, Math.round(hint)));
    let step = 2;
    if (at(h) <= target) {
      lo = h; hi = Math.min(codec.range, h + step);
      while (hi < codec.range && at(hi) <= target) { lo = hi; step *= 2; hi = Math.min(codec.range, hi + step); }
    } else {
      hi = h; lo = Math.max(0, h - step);
      while (lo > 0 && at(lo) > target) { hi = lo; step *= 2; lo = Math.max(0, lo - step); }
    }
  }
  if (at(lo) > target || at(hi) <= target) throw new Error(`budget ${target}B outside knob 0..${codec.range} (${at(0)}..${at(codec.range)}B)`);
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (at(m) <= target) lo = m; else hi = m; }
  const score = (q: number) => { const d = codec.dec(path.join(dir, `q${q}.avif`), path.join(dir, `q${q}.png`)); return [ssim2(ref, d), ...butterBoth(ref, d)]; };
  const [s2a, bua, b3a] = score(lo), [s2b, bub, b3b] = score(hi);
  const t = (target - at(lo)) / (at(hi) - at(lo));
  const r = (x: number) => Number(x.toFixed(3));
  return { bytes: target, d: r(lo + t), s2: r(s2a + t * (s2b - s2a)), bu: r(bua + t * (bub - bua)), bu3: Number((b3a + t * (b3b - b3a)).toFixed(4)) };
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
      const [abu, abu3] = butterBoth(ref, ad);
      const row: Row = { set, stem, tier, budget: avif.bytes, avif: { s2: ssim2(ref, ad), bu: abu, bu3: abu3 }, v: {} };
      // the base variant runs first; its landing point seeds everyone else
      let hint: number | undefined;
      const seed = !process.argv.includes("--no-seed");
      for (const name of variants) {
        const vd = path.join(sub, name.replace(/[^a-zA-Z0-9_.-]/g, "_"));
        fs.mkdirSync(vd);
        if (codec === "avif" || codec === "avm") {
          try {
            row.v[name] = codec === "avif" ? bracketed(ref, vd, avif.bytes, AVIF_VARIANTS[name], AOM, seed ? hint : undefined) : bracketed(ref, vd, avif.bytes, avmVariant(name) as string[], AVM, seed ? hint : undefined);
            const got = row.v[name];
            if (name === "base" && !("error" in got)) hint = got.d;
          }
          catch (e) { row.v[name] = { error: e instanceof Error ? e.message.slice(0, 120) : String(e) }; }
          continue;
        }
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
    // jxl and avm are rival codecs, so their question is the gap to the shipped AVIF
    const vsAvif = codec !== "avif";
    // inline variants ("a:key=val+...") run long, so the name column fits the longest
    const W = Math.max(10, ...variants.map((v) => v.length + 1));
    // An all-error run leaves `base` empty and the mean NaN; say so rather than print it
    if (vsAvif) console.log(base.length ? `  base vs AVIF at matched bytes: mean ${avifGap >= 0 ? "+" : ""}${avifGap.toFixed(2)} s2` : "  base vs AVIF: no call landed on budget, so there is no gap to report (see the errors in --json)");
    console.log(`  ${"variant".padEnd(W)} n  mean Δs2  mean Δbu  s2 wins  ${vsAvif ? "vs AVIF s2" : "bu wins"}   Δbu3  ${vsAvif ? "vs AVIF bu3" : ""}`);
    for (const name of variants) {
      const pairs = rs.filter((r) => ok(r.v.base, r.budget) && ok(r.v[name], r.budget));
      if (!pairs.length) { console.log(`  ${name.padEnd(W)}  0  (never landed on budget)`); continue; }
      const d2 = pairs.map((r) => (r.v[name] as { s2: number }).s2 - (r.v.base as { s2: number }).s2);
      const db = pairs.map((r) => (r.v[name] as { bu: number }).bu - (r.v.base as { bu: number }).bu);
      const b3 = pairs.filter((r) => (r.v[name] as { bu3?: number }).bu3 !== undefined && (r.v.base as { bu3?: number }).bu3 !== undefined)
        .map((r) => ((r.v[name] as { bu3: number }).bu3 - (r.v.base as { bu3: number }).bu3));
      const b3a = pairs.filter((r) => (r.v[name] as { bu3?: number }).bu3 !== undefined && r.avif.bu3 !== undefined)
        .map((r) => ((r.v[name] as { bu3: number }).bu3 - (r.avif.bu3 as number)));
      const va = pairs.map((r) => (r.v[name] as { s2: number }).s2 - r.avif.s2);
      const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
      const sign = (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(2)}`;
      console.log(`  ${name.padEnd(W)}${String(pairs.length).padStart(2)}  ${sign(mean(d2)).padStart(8)}  ${sign(mean(db)).padStart(8)}  ${`${d2.filter((x) => x > 0).length}/${pairs.length}`.padStart(7)}  ${vsAvif ? sign(mean(va)).padStart(10) : `${db.filter((x) => x < 0).length}/${pairs.length}`.padStart(7)}  ${b3.length ? `${mean(b3) >= 0 ? "+" : ""}${mean(b3).toFixed(3)}`.padStart(7) : "      -"}  ${vsAvif && b3a.length ? `${mean(b3a) >= 0 ? "+" : ""}${mean(b3a).toFixed(3)}`.padStart(8) : ""}`);
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
  if (codec !== "jxl" && codec !== "avif" && codec !== "avm") { console.error("--codec wants jxl, avif or avm"); return 2; }
  if (codec === "avm" && !(fs.existsSync(AVIFENC_AVM) && fs.existsSync(AVIFDEC_AVM))) {
    console.error(`--codec avm needs avifenc-avm, the AV2 build; run tools/photos/libavif-avm/build.sh (expected ${AVIFENC_AVM})`);
    return 2;
  }
  const VARIANTS = codec === "avif" ? AVIF_VARIANTS : codec === "avm" ? AVM_VARIANTS : JXL_VARIANTS;
  const variants = (arg("--variants") ?? Object.keys(VARIANTS).join(",")).split(",");
  for (const v of variants) if (!(codec === "avm" ? avmVariant(v) : VARIANTS[v])) { console.error(`unknown ${codec} variant ${v}; have ${Object.keys(VARIANTS).join(", ")}`); return 2; }
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
  // cjxl and avifenc are multithreaded themselves, so a few workers saturate the
  // machine. AVM barely threads on a 320px still (raw avmenc sat at ~98% of one
  // core), so the AV2 arm takes a worker per core instead.
  const conc = Number(arg("--jobs") ?? (codec === "avm" ? os.availableParallelism() : 4));
  const runOne = async (): Promise<void> => {
    while (next < jobs.length) {
      const [set, stem] = jobs[next++];
      const t0 = Date.now();
      const out = await new Promise<string>((resolve, reject) => {
        const p = spawn(process.execPath, [self, "--worker", "--codec", codec, "--set", set, "--stem", stem, "--variants", variants.join(","), "--cache", cache, ...(argv.includes("--no-seed") ? ["--no-seed"] : [])], { stdio: ["ignore", "pipe", "inherit"] });
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
