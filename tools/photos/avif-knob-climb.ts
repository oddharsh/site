#!/usr/bin/env bun
// avif-knob-climb.ts — the AVIF encoder knobs, hillclimbed on the tier that ships.
//
// codec-knob-probe.ts carries a list of AVIF flag variants and has only ever
// scored them on /pixel-peeper's 320px native crops, the dense end the site
// never serves at that size (av2-tile-probe.ts measured the gap: 1.08 bpp for
// the crops against 0.46 for the 600px tier, and a verdict that flips across
// it). This scores the same knobs where they would actually ship, through the
// shared loop in tools/lib/hillclimb.ts:
//
//   items    every colour Fuji original in --src (HIF and JPG), each cut into
//            its 600px tile exactly as add-photos.sh cuts it: HIF through a
//            full-resolution sips TIFF, then `zenc square --orient N --filter
//            box`. The two Leica frames are left out, since the Monochrom
//            tiers are 4:0:0 and half these knobs mean nothing there.
//   score    ssimulacra2 AT MATCHED BYTES: the shipped flags at -q 63 set the
//            tile's byte budget, and each config is bracketed on -q until two
//            encodes straddle it, then interpolated to the exact byte count
//            (codec-knob-probe.ts's bracketed(), async here so tiles run in
//            parallel). A knob that "improves quality" by spending bytes has
//            improved nothing. Lower is better to the harness, so the score is
//            the negated s2.
//   noise    `--jobs 1` in place of the pipeline's 4, which moves the bytes
//            (gotcha 43) and means nothing. Its total per side against the
//            shipped flags is the band, mirrored around zero. Measured once:
//            it is the encoder's jitter, which a knob barely moves, and per
//            candidate it doubled the run.
//   control  the -q 63 budget must be BYTE-IDENTICAL to the shipped /i/ file
//            for that stem, or every score is measured at some other budget.
//            The run reports how many matched, and refuses below 90%.
//   climb    one knob per round against the current best, keep only what
//            clears the band on train AND held-out test, stop after --stall
//            flat rounds and name the worst tiles.
//
// Encode time is reported beside every verdict, since the judge weighs quality
// at fixed bytes and speed 1 would be bought with the photo pipeline's clock.
// Encodes are cached per (tile, flags, q) under --work, so a re-run with more
// candidates costs only the new encodes. Workstation-only: it reads the SOOC
// originals. Writes only under --work and the --ledger path.
//
// WHAT IT FOUND, 2026-09-29 (182 Fuji tiles, 132 train / 50 test, avifenc
// 1.4.2 on aom 3.15.1; budget byte-identical to the shipped /i/ file on 162 of
// 162 published tiles; band ±3.56 s2 train, ±2.33 test, about 0.03 per tile):
//
//   knob            train Δ (132)   test Δ (50)    verdict   encode time
//   speed 1         -1.19, 63 wins  +0.06, 25      noise     +36%
//   sharpness=2     -8.38, 50       +2.76, 31      noise     +21%
//   deltaq-mode=3   -90.3, 3        -31.0, 4       REGRESS   +16%
//
// (s2 totals, positive = better; the harness logs them negated.) It stalled
// there, and the reflection pass it asks for explained the plateau. Per tile,
// mean Δs2 over all 182: speed 1 -0.006, sharpness=2 -0.031, and the
// meaningless --jobs 1 control +0.032, so the knobs sit inside the encoder's
// own jitter. sharpness=2 is the one with structure: r = -0.51 against bits per
// pixel, +0.13 s2 under 0.3 bpp (19 of 28) and -0.17 over 0.8 (7 of 58), which
// is why train and test disagreed in sign on different bpp mixes. That is a
// per-tile rule worth ~0.07 s2 on the sparse third, and not worth one.
//
// The eight later candidates were not reached, on purpose. dq0, tune=ssim and
// tune=psnr override choices tune=iq makes for stills, and tune=iq already beat
// tune=ssim by 2.7% BD-rate (2026-07-19). cdef0 and lr0 turn off filters tune=iq
// configures. 12-bit needs AV1's Professional profile, which browser decode
// cannot be assumed for, so it cannot ship whatever it scores. Run them with
// --candidates and --stall 99 if that prior is ever in doubt; the cache under
// --work makes the base encodes free. What this does not reach: -q itself, which
// is a bytes-for-quality call rather than a knob (q63 over the byte-flat q62 was
// an owner call in #962), and sharpyuv, which only matters for SUBSAMPLED chroma
// and so is moot on 4:4:4 tiers.
//
// usage: bun tools/photos/avif-knob-climb.ts [--src <originals>] [--limit n]
//          [--parallel n] [--candidates s1,sharp2,...] [--stall n] [--ledger out.jsonl]
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { climb, ZERO_BAND, type Band, type Candidate } from "../lib/hillclimb.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const arg = (name: string) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined; };
const SRC = arg("src") ?? "/Users/aadharsh/Downloads/to post (from ssd)";
const WORK = arg("work") ?? path.join(os.tmpdir(), "avif-knob-climb");
const ZENC = path.join(HERE, "zenc/target/release/zenc");
// a 600px tile keeps under two cores busy whatever --jobs says, so overlap many
const PARALLEL = Number(arg("parallel") ?? Math.max(2, os.availableParallelism() - 4));
const Q_SHIP = 63;

// ── config: avifenc flags beyond -q, as an ordered list of [flag, value] ────
// `-a key=value` codec options are keyed by their KEY, so sharpness=2 replaces
// sharpness=1 rather than stacking beside it.
type Config = Array<[string, string]>;
const BASE: Config = [["-d", "10"], ["--speed", "2"], ["--yuv", "444"], ["--jobs", "4"]];
const keyOf = ([f, v]: [string, string]) => (f === "-a" ? `-a ${v.split("=")[0]}` : f);
const set = (c: Config, flag: string, value: string): Config => {
  const k = keyOf([flag, value]);
  return [...c.filter((p) => keyOf(p) !== k), [flag, value]];
};
const flags = (c: Config) => c.flatMap(([f, v]) => [f, v]);
const label = (c: Config) => flags(c).join(" ");

// The knobs, from codec-knob-probe.ts's AVIF list minus what is already known:
// speed 0 was measured and rejected (+0.09 s2 over speed 2 for 3.6x the time,
// CLAUDE.md), and 4:2:0 / 4:2:2 were settled by avif-chroma-probe.ts in #962.
// Ordered by prior evidence, since the climb stops on a plateau.
const CANDIDATES: Record<string, Candidate<Config>> = {
  s1: { name: "speed 1", apply: (c) => set(c, "--speed", "1") },
  sharp2: { name: "sharpness=2", apply: (c) => set(c, "-a", "sharpness=2") },
  dq3: { name: "deltaq-mode=3", apply: (c) => set(c, "-a", "deltaq-mode=3") },
  cdef0: { name: "enable-cdef=0", apply: (c) => set(c, "-a", "enable-cdef=0") },
  lr0: { name: "enable-restoration=0", apply: (c) => set(c, "-a", "enable-restoration=0") },
  tunessim: { name: "tune=ssim", apply: (c) => set(c, "-a", "tune=ssim") },
  d12: { name: "12-bit", apply: (c) => set(c, "-d", "12") },
  sharp1: { name: "sharpness=1", apply: (c) => set(c, "-a", "sharpness=1") },
  sharp4: { name: "sharpness=4", apply: (c) => set(c, "-a", "sharpness=4") },
  dq0: { name: "deltaq-mode=0", apply: (c) => set(c, "-a", "deltaq-mode=0") },
  tunepsnr: { name: "tune=psnr", apply: (c) => set(c, "-a", "tune=psnr") },
};
const CONTROL = (c: Config) => set(c, "--jobs", "1");

// ── processes, with a limit on how many tiles encode at once ────────────────
async function sh(cmd: string[]): Promise<string> {
  const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const [out, err] = [await new Response(p.stdout).text(), await new Response(p.stderr).text()];
  if ((await p.exited) !== 0) throw new Error(`${path.basename(cmd[0])} failed: ${err.trim().slice(-300)}`);
  return out;
}
let running = 0;
const waiting: Array<() => void> = [];
async function slot<T>(fn: () => Promise<T>): Promise<T> {
  if (running >= PARALLEL) await new Promise<void>((r) => waiting.push(r));
  running++;
  try { return await fn(); } finally { running--; waiting.shift()?.(); }
}

// ── tiles ───────────────────────────────────────────────────────────────────
type Item = { stem: string; file: string };
async function tile(it: Item): Promise<string> {
  const png = path.join(WORK, "tiles", `${it.stem}.png`);
  if (fs.existsSync(png)) return png;
  let input = it.file, tif: string | null = null;
  if (/\.hif$/i.test(it.file)) {
    tif = path.join(WORK, "tiles", `${it.stem}.tif`);
    await sh(["sips", "-s", "format", "tiff", it.file, "--out", tif]);
    input = tif;
  }
  const o = Number(/"Orientation":\s*(\d)/.exec(await sh(["exif-sooc", "-n", "-Orientation", it.file]))?.[1] ?? 1);
  try {
    await sh([ZENC, "square", input, "--orient", String(o >= 1 && o <= 8 ? o : 1), "--filter", "box", "--size", "600", "--out", png]);
  } finally { if (tif) fs.rmSync(tif, { force: true }); }
  return png;
}

// ── encodes, cached across runs ─────────────────────────────────────────────
type Enc = { bytes: number; ms: number; s2?: number };
const CACHE_FILE = path.join(WORK, "cache.json");
const cache: Record<string, Enc> = fs.existsSync(CACHE_FILE) ? JSON.parse(fs.readFileSync(CACHE_FILE, "utf8")) : {};
let dirty = 0;
const persist = (force = false) => { if (dirty && (force || dirty > 50)) { fs.writeFileSync(CACHE_FILE, JSON.stringify(cache)); dirty = 0; } };

async function encode(stem: string, ref: string, c: Config, q: number, needScore: boolean): Promise<Enc> {
  const key = `${stem}|${label(c)}|${q}`;
  const hit = cache[key];
  if (hit && (!needScore || hit.s2 !== undefined)) return hit;
  const out = path.join(WORK, "enc", `${stem}.${Bun.hash(key).toString(36)}.avif`);
  const t0 = performance.now();
  await sh(["avifenc", "-q", String(q), ...flags(c), "--ignore-icc", "--ignore-exif", "--ignore-xmp", ref, out]);
  const e: Enc = hit ?? { bytes: fs.statSync(out).size, ms: performance.now() - t0 };
  if (needScore) {
    const png = out.replace(/\.avif$/, ".png");
    await sh(["avifdec", "-d", "8", out, png]);
    e.s2 = Number.parseFloat(await sh(["ssimulacra2", ref, png]));
    if (!Number.isFinite(e.s2)) throw new Error(`ssimulacra2 printed no score for ${stem} q${q}`);
    fs.rmSync(png, { force: true });
  }
  fs.rmSync(out, { force: true });
  cache[key] = e; dirty++; persist();
  return e;
}

// The score AT the budget: bytes rise with -q, so seed from the shipped q and
// widen until two adjacent q values straddle the budget, then interpolate.
const budgets = new Map<string, number>();
async function atBudget(it: Item, c: Config): Promise<{ s2: number; ms: number }> {
  return slot(async () => {
    const ref = await tile(it);
    let budget = budgets.get(it.stem);
    if (budget === undefined) { budget = (await encode(it.stem, ref, BASE, Q_SHIP, false)).bytes; budgets.set(it.stem, budget); }
    const size = async (q: number) => (await encode(it.stem, ref, c, q, false)).bytes;
    let lo = Q_SHIP, hi = Q_SHIP, step = 1;
    if ((await size(Q_SHIP)) <= budget) {
      while (hi < 100 && (await size(hi)) <= budget) { lo = hi; hi = Math.min(100, hi + step); step *= 2; }
    } else {
      while (lo > 0 && (await size(lo)) > budget) { hi = lo; lo = Math.max(0, lo - step); step *= 2; }
    }
    if ((await size(lo)) > budget || (await size(hi)) <= budget) throw new Error(`${it.stem} ${label(c)}: budget ${budget} B outside -q 0..100`);
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if ((await size(m)) <= budget) lo = m; else hi = m; }
    const a = await encode(it.stem, ref, c, lo, true), b = await encode(it.stem, ref, c, hi, true);
    const t = (budget - a.bytes) / (b.bytes - a.bytes);
    return { s2: a.s2! + t * (b.s2! - a.s2!), ms: (a.ms + b.ms) / 2 };
  });
}

// ── the run ─────────────────────────────────────────────────────────────────
const main = async () => {
  fs.mkdirSync(path.join(WORK, "tiles"), { recursive: true });
  fs.mkdirSync(path.join(WORK, "enc"), { recursive: true });
  const names = fs.readdirSync(SRC).filter((f) => /^XT\d+\.(HIF|JPG)$/i.test(f)).sort();
  // one item per stem; a HIF outranks a JPG of the same frame, as add-photos.sh reads it
  const byStem = new Map<string, Item>();
  for (const f of names) {
    const stem = f.replace(/\.[^.]+$/, "");
    if (!byStem.has(stem) || /\.hif$/i.test(f)) byStem.set(stem, { stem, file: path.join(SRC, f) });
  }
  let items = [...byStem.values()];
  if (arg("limit")) items = items.slice(0, Number(arg("limit")));
  const pick = (arg("candidates") ?? Object.keys(CANDIDATES).join(",")).split(",");
  for (const p of pick) if (!CANDIDATES[p]) throw new Error(`unknown candidate ${p}; have ${Object.keys(CANDIDATES).join(", ")}`);

  console.log(`avif-knob-climb: ${items.length} tiles from ${SRC}, ${PARALLEL} at a time, base ${label(BASE)} -q ${Q_SHIP}`);
  const t0 = Date.now();
  const times = new Map<string, number[]>();
  const score = async (c: Config, it: Item) => {
    const r = await atBudget(it, c);
    const k = label(c);
    if (!times.has(k)) times.set(k, []);
    times.get(k)!.push(r.ms);
    return -r.s2;
  };
  // The control band, per side: the total the meaningless --jobs 1 moves the
  // score by against the shipped flags, mirrored, measured once per side.
  const bands = new Map<string, Promise<Band>>();
  const noise = (side: string, _c: Config, set: Item[]): Promise<Band> => {
    if (!bands.has(side)) bands.set(side, (async () => {
      const base = await Promise.all(set.map((it) => atBudget(it, BASE).then((r) => -r.s2)));
      const ctrl = await Promise.all(set.map((it) => atBudget(it, CONTROL(BASE)).then((r) => -r.s2)));
      const total = Math.abs(ctrl.reduce((s, x, i) => s + x - base[i], 0));
      console.log(`  noise band, ${side}: ±${total.toFixed(2)} s2 over ${set.length} tiles (--jobs 1 against 4)`);
      return total ? { lo: -total, hi: total, n: 1, median: 0 } : ZERO_BAND;
    })());
    return bands.get(side)!;
  };
  const out = await climb<Config, Item>({
    items, nameOf: (it) => it.stem, baseline: BASE, candidates: pick.map((p) => CANDIDATES[p]),
    score, noise: (side, c, set) => noise(side, c, set), ledger: arg("ledger"),
    stallAfter: Number(arg("stall") ?? 3), minWins: 0.5,
  });
  persist(true);
  // The alignment control: is the budget the bytes that actually ship?
  const hashes = JSON.parse(fs.readFileSync(path.join(HERE, "../../public/images/hashes.json"), "utf8"));
  let same = 0, checked = 0;
  for (const it of items) {
    const h = hashes[it.stem]?.a, f = path.join(HERE, "../../public/i", `${it.stem}.${h}.avif`);
    if (!h || !fs.existsSync(f) || !budgets.has(it.stem)) continue;
    checked++;
    if (fs.statSync(f).size === budgets.get(it.stem)) same++;
  }
  console.log(`\ncontrol: the -q ${Q_SHIP} budget equals the shipped /i/ file on ${same} of ${checked} tiles`);
  if (!checked || same / checked < 0.9) throw new Error("the budget is not the shipped bytes; every score above was measured at some other budget");
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  console.log(`\nencode time per tile at the bracketing pair (mean ms):`);
  for (const [k, xs] of times) console.log(`  ${mean(xs).toFixed(0).padStart(6)}  ${k}`);
  console.log(`\nkept: ${out.kept.join(", ") || "nothing"}; best: ${label(out.best)} (${((Date.now() - t0) / 60000).toFixed(1)} min)`);
  if (out.stalled) console.log(`stalled; worst tiles on the last candidate (Δ negated s2, higher is worse): ${out.worst.map((w) => `${w.name} ${w.delta >= 0 ? "+" : ""}${w.delta.toFixed(2)}`).join(", ")}`);
};

if (import.meta.main) await main();
