#!/usr/bin/env bun
// jpeg-knob-climb.ts — the JPEG tier's zenc settings, on the tiles that ship.
//
// The 600px JPEG tier is `zenc -q 84`, 4:2:0 with sharp_yuv. zenc exposes two
// knobs, and they are different kinds of question:
//
//   --yuv   a CODING choice, judged at matched bytes like every knob here.
//           src/worker/encode.ts calls 4:4:4 "a byte tax for detail the eye
//           does not resolve", and CLAUDE.md records that verdict as never
//           re-measured. The AVIF form of the same verdict was measured at a
//           fixed knob and overturned at equal bytes (#962), so this asks the
//           JPEG form the equal-bytes way.
//   -q      a RATE choice: more bytes, more quality, and no bytes are held
//           equal, so the harness cannot judge it without a target nobody has
//           set. The run reports the curve around q84 (bytes and s2 per q, and
//           the AVIF tier's s2 for reference) and leaves the pick to the owner.
//
// Through tools/lib/hillclimb.ts: every colour Fuji tile (tools/lib/photo-tiles.ts),
// split 70/30 by stem, each config scored as ssimulacra2 at the byte budget the
// shipped settings spend on that tile, bracketed on -q and interpolated.
// Decoding is mozjpeg's djpeg, which is libjpeg-turbo's decoder, the one most
// browsers run; `zenc frame` scored within 0.04 s2 of it on a spot check, so the
// decoder does not move the verdict. zenc is deterministic, so the band is zero
// and the win share carries the weight.
//
// Controls: the q84 budget must equal the shipped /i/ JPEG for that stem (the
// run refuses below 90%), and the shipped config must score identically when
// re-scored, which it does by construction.
//
// Who this reaches: the JPEG is the <img src> fallback, fetched only by a
// browser that does not take AVIF (gotcha 7), and it is the file the histogram
// bake reads. Changing it re-mints every /i/*.jpg and owes a histogram re-bake
// (gotcha 46).
//
// WHAT IT FOUND, 2026-09-29 (182 Fuji tiles, 132 train / 50 test; the q84
// budget byte-identical to the shipped /i/ JPEG on 162 of 162 published tiles):
//
//   layout   train Δs2 (132)   test Δs2 (50)   verdict
//   4:4:4    -15.48, 48 wins   -9.88, 16       REGRESS
//   4:2:2    -99.2, 16         -32.57, 8       REGRESS
//
// So the JPEG half of "4:4:4 is a byte tax" HOLDS at equal bytes, where the
// AVIF half fell (#962). The difference is the codec: AV1 predicts chroma from
// luma, so full chroma is cheap to code, and baseline JPEG codes each channel
// on its own, so full chroma costs full price and 4:2:0 with sharp_yuv spends
// those bytes better. 4:2:2 is worse than either: it keeps two chroma blocks
// per MCU and sharpens in one direction only.
//
// The -q curve at 4:2:0, mean over all 182 tiles:
//
//   q78 38,615 B 75.51 | q80 40,415 76.18 | q82 42,989 77.02 | q84 46,253 78.03
//   q86 50,853 79.62   | q88 56,899 81.28 | q90 63,681 82.62
//
// About 3 KB per s2 point from q80 to q88, with no knee near q84, so nothing in
// the curve itself picks q84 over a neighbour. The reference that could: the
// AVIF tier most visitors get, at 29,822 B on the same tiles, averages s2 78.96
// decoded to 8 bits by Homebrew's avifdec and 79.13 at full depth (re-measured
// 2026-09-29 over all 182 tiles). The 8-bit figure is closer to what an 8-bit
// display shows after the browser's own conversion; the full-depth one is the
// encode itself. So the q84 fallback sits 0.93 to 1.10 s2 below the primary,
// and parity lands between about q85 and q85.5, roughly +5% to +7% JPEG bytes.
// This line said "0.93" and "q85, +5%" alone until the AV2 climb found two
// avifdec builds disagreeing at -d 8 (tools/photos/av2-knob-climb.ts, THE
// DECODER TRAP): Homebrew's 8-bit path was not wrong, but it was one reading
// of a range. Whether the fallback should match the primary is a policy the
// owner has not set; this records the price of either answer.
//
// usage: bun tools/photos/jpeg-knob-climb.ts [--tiles dir] [--work dir] [--limit n] [--parallel n] [--ledger out.jsonl]
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { climb, type Candidate } from "../lib/hillclimb.ts";
import { cutTile, defaultParallel, fujiSources, limiter, sh, shippedTier, ZENC, type TileSource } from "../lib/photo-tiles.ts";

const argv = process.argv.slice(2);
const arg = (name: string) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined; };
const WORK = arg("work") ?? path.join(os.tmpdir(), "jpeg-knob-climb");
const TILES = arg("tiles") ?? path.join(os.tmpdir(), "photo-tiles");
const DJPEG = "/opt/homebrew/opt/mozjpeg/bin/djpeg";
const Q_SHIP = 84;
const slot = limiter(Number(arg("parallel") ?? defaultParallel()));

type Config = { yuv: "420" | "422" | "444" };
const BASE: Config = { yuv: "420" };
const CANDIDATES: Array<Candidate<Config>> = [
  { name: "4:4:4", apply: () => ({ yuv: "444" }) },
  { name: "4:2:2", apply: () => ({ yuv: "422" }) },
];

type Enc = { bytes: number; s2?: number };
const CACHE_FILE = path.join(WORK, "cache.json");
fs.mkdirSync(path.join(WORK, "enc"), { recursive: true });
const cache: Record<string, Enc> = fs.existsSync(CACHE_FILE) ? JSON.parse(fs.readFileSync(CACHE_FILE, "utf8")) : {};
let dirty = 0;
const persist = (force = false) => { if (dirty && (force || dirty > 100)) { fs.writeFileSync(CACHE_FILE, JSON.stringify(cache)); dirty = 0; } };

async function encode(stem: string, ref: string, c: Config, q: number, needScore: boolean): Promise<Enc> {
  const key = `${stem}|${c.yuv}|${q}`;
  const hit = cache[key];
  if (hit && (!needScore || hit.s2 !== undefined)) return hit;
  const out = path.join(WORK, "enc", `${stem}.${c.yuv}.${q}.jpg`);
  await sh([ZENC, ref, out, "-q", String(q), "--yuv", c.yuv]);
  const e: Enc = hit ?? { bytes: fs.statSync(out).size };
  if (needScore) {
    const ppm = out.replace(/\.jpg$/, ".ppm");
    await sh([DJPEG, "-outfile", ppm, out]);
    e.s2 = Number.parseFloat(await sh(["ssimulacra2", ref, ppm]));
    if (!Number.isFinite(e.s2)) throw new Error(`ssimulacra2 printed no score for ${stem} ${c.yuv} q${q}`);
    fs.rmSync(ppm, { force: true });
  }
  fs.rmSync(out, { force: true });
  cache[key] = e; dirty++; persist();
  return e;
}

const budgets = new Map<string, number>();
async function atBudget(it: TileSource, c: Config): Promise<number> {
  return slot(async () => {
    const ref = await cutTile(it, TILES);
    let budget = budgets.get(it.stem);
    if (budget === undefined) { budget = (await encode(it.stem, ref, BASE, Q_SHIP, false)).bytes; budgets.set(it.stem, budget); }
    const size = async (q: number) => (await encode(it.stem, ref, c, q, false)).bytes;
    let lo = Q_SHIP, hi = Q_SHIP, step = 1;
    if ((await size(Q_SHIP)) <= budget) {
      while (hi < 100 && (await size(hi)) <= budget) { lo = hi; hi = Math.min(100, hi + step); step *= 2; }
    } else {
      while (lo > 1 && (await size(lo)) > budget) { hi = lo; lo = Math.max(1, lo - step); step *= 2; }
    }
    if ((await size(lo)) > budget || (await size(hi)) <= budget) {
      // the shipped config itself lands exactly on its own budget
      if ((await size(lo)) === budget) return (await encode(it.stem, ref, c, lo, true)).s2!;
      throw new Error(`${it.stem} ${c.yuv}: budget ${budget} B outside -q 1..100`);
    }
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if ((await size(m)) <= budget) lo = m; else hi = m; }
    const a = await encode(it.stem, ref, c, lo, true), b = await encode(it.stem, ref, c, hi, true);
    return a.s2! + ((budget - a.bytes) / (b.bytes - a.bytes)) * (b.s2! - a.s2!);
  });
}

if (import.meta.main) {
  let items = fujiSources();
  if (arg("limit")) items = items.slice(0, Number(arg("limit")));
  console.log(`jpeg-knob-climb: ${items.length} tiles, base zenc -q ${Q_SHIP} --yuv ${BASE.yuv}, scored at matched bytes through djpeg`);
  const out = await climb<Config, TileSource>({
    items, nameOf: (it) => it.stem, baseline: BASE, candidates: CANDIDATES,
    score: async (c, it) => -(await atBudget(it, c)), minWins: 0.6, ledger: arg("ledger"),
  });

  // The alignment control.
  let same = 0, checked = 0;
  for (const it of items) {
    const f = shippedTier(it.stem, "j");
    if (!f || !budgets.has(it.stem)) continue;
    checked++;
    if (fs.statSync(f).size === budgets.get(it.stem)) same++;
  }
  console.log(`\ncontrol: the q${Q_SHIP} budget equals the shipped /i/ JPEG on ${same} of ${checked} tiles`);
  if (!checked || same / checked < 0.9) throw new Error("the budget is not the shipped bytes; every score above was measured at some other budget");

  // The rate curve around q84, for the owner's -q call: it is not judged.
  console.log(`\n-q curve at 4:2:0 over all ${items.length} tiles (mean bytes, mean s2 through djpeg):`);
  for (const q of [78, 80, 82, 84, 86, 88, 90]) {
    const rows = await Promise.all(items.map((it) => slot(async () => encode(it.stem, await cutTile(it, TILES), BASE, q, true))));
    const mb = rows.reduce((s, r) => s + r.bytes, 0) / rows.length, ms = rows.reduce((s, r) => s + r.s2!, 0) / rows.length;
    console.log(`  q${q}  ${mb.toFixed(0).padStart(6)} B  s2 ${ms.toFixed(2)}${q === Q_SHIP ? "   <- shipped" : ""}`);
  }
  persist(true);
  console.log(`\nkept: ${out.kept.join(", ") || "nothing"}; best: --yuv ${out.best.yuv}`);
}
