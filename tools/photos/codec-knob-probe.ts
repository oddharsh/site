#!/usr/bin/env bun
// codec-knob-probe.ts — which encoder flags buy JPEG XL or AVIF quality per
// byte, at the /pixel-peeper format axis's own budgets? --codec picks which.
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
// Usage:
//     bun tools/photos/codec-knob-probe.ts                    # JXL, every variant, both sets
//     bun tools/photos/codec-knob-probe.ts --codec avif
//     bun tools/photos/codec-knob-probe.ts --codec avm --variants base,s4   # AV2; needs `bun run av2:build`
//     bun tools/photos/codec-knob-probe.ts --set train --variants base,epf0
//     bun tools/photos/codec-knob-probe.ts --json out.json
//
// AV2, `--codec avm`: where the next codec in the AV1 line stands on these
// photos. It is scored against the SAME shipped AVIF budgets and the same AVIF
// scores, so every row reads "AV2 at the bytes AVIF actually costs". Both files
// are AVIF containers (AV2 writes an `av02` item), so this is file against file
// with no container adjustment. It needs avifenc-avm, the AV2 build that
// `bun run av2:build` makes from the pinned av2-tone, and is bracketed on -q
// exactly like the AVIF arm. Nothing it writes can ship: no browser decodes AV2.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AV2_BUILD, AV2_BUILD_COMMAND } from "./av2-tone.ts";
import {
  AVIF_ARGS, bestCrop, butter, decodeFmt, encode, encodeFmt, FORMAT_TIER_ANCHOR, JXL_ARGS, loadSource, searchFmt, ssim2,
} from "./gen-pixel-peeper.ts";

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
  zencjxl: ["<zenc-recompress>"],
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
  zencjxlnr: ["<zenc-recompress>", "420", "--allow_jpeg_reconstruction=0"],
  zenc444jxlnr: ["<zenc-recompress>", "444", "--allow_jpeg_reconstruction=0"],
};

const AV = (...extra: string[]) => [...AVIF_ARGS, ...extra];
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

const AVIFENC_AVM = path.join(process.env.AVM_BUILD_DIR ?? AV2_BUILD, "avifenc");
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

function avmVariant(name: string): string[] | null {
  if (AVM_VARIANTS[name]) return AVM_VARIANTS[name];
  if (!name.startsWith("a:")) return null;
  const pairs = name.slice(2).split("+").filter(Boolean);
  if (!pairs.length || pairs.some((p) => !/^[a-z0-9-]+=-?[0-9A-Za-z.]+$/.test(p))) return null;
  return [...AVM_ARGS, ...pairs.flatMap((p) => ["-a", p])];
}

export const TRAIN = ["XT507494", "XT509794", "XT508890", "XT509986", "XT509721", "XT507517", "XT509509", "XT508756"];
export const HOLDOUT = ["XT509278", "XT507955", "XT508055", "XT509535", "XT509965", "XT509848", "XT509388", "XT509540"];
const TIERS = Object.keys(FORMAT_TIER_ANCHOR) as (keyof typeof FORMAT_TIER_ANCHOR)[];

type Codec = "jxl" | "avif" | "avm";
type Row = { set: string; stem: string; tier: string; budget: number; avif: { s2: number; bu: number; bu3?: number }; v: Record<string, { bytes: number; d: number; s2: number; bu: number; bu3?: number } | { error: string }> };

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

export function bracketed(ref: string, dir: string, target: number, args: string[], codec: AvifCodec = AOM, hint?: number): { bytes: number; d: number; s2: number; bu: number; bu3: number } {
  const size = new Map<number, number>();
  const at = (q: number) => { if (!size.has(q)) size.set(q, codec.enc(ref, path.join(dir, `q${q}.avif`), q, args)); return size.get(q) as number; };
  let lo = 0, hi = codec.range;
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
      const avif = a.enc === "avif"
        ? (() => { const p = path.join(sub, "ship.avif"); return { bytes: encodeFmt("avif", ref, p, a.q), path: p }; })()
        : searchFmt("avif", ref, sub, encode("zenc", srcs, path.join(sub, "anchor.jpg"), a.q, a.chroma));
      const ad = decodeFmt("avif", avif.path, path.join(sub, "avif.png"));
      const [abu, abu3] = butterBoth(ref, ad);
      const row: Row = { set, stem, tier, budget: avif.bytes, avif: { s2: ssim2(ref, ad), bu: abu, bu3: abu3 }, v: {} };
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
    const vsAvif = codec !== "avif";
    const W = Math.max(10, ...variants.map((v) => v.length + 1));
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
    console.error(`--codec avm needs avifenc-avm, the AV2 build; run ${AV2_BUILD_COMMAND} (expected ${AVIFENC_AVM})`);
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
