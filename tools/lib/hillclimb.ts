// hillclimb.ts — the loop every optimization here runs by hand, written once.
//
// The repo is strict about its GRADERS (every check carries a control, and "a
// check that can only agree with itself" is a named failure), and until
// 2026-09-29 it was loose about the LOOP around them. Knobs were tuned and then
// scored on the same set. Two decisions show what that costs. The AVIF q63 call
// was projected from 320px crops at about +1% bytes and shipped at +5.6% on the
// real tiers. And the family dictionary's representative tails were kept for 47
// days on in-sample numbers, and lost in all 90 held-out windows once
// tools/family-holdout.ts measured them (#1005).
//
// The shape is Anthropic's eval-hillclimbing recipe, cut to what bytes and
// encoder knobs need:
//
//   split    a deterministic train/test split by a hash of each item's NAME, so
//            the same item lands on the same side on every run and machine, and
//            adding an item never reshuffles the others. A temporal split
//            (tune at commit N, score at N+k) is the caller's to build, as
//            family-holdout.ts does; judge() takes either.
//   noise    a band of control deltas, in the scorer's units. For brotli the
//            controls are random same-size deletions, since q11 swings 50-160 B
//            on a big page from any small edit. For a deterministic scorer on a
//            fixed set the band is zero and the paired win count carries the
//            weight instead. byteNoiseBand answers one of two questions, and
//            they are not interchangeable; see the note above it.
//   judge    keep a change only if it clears the noise on train AND on test.
//            Train clearing with test flat is the overfit signal; revert it.
//   climb    one change per round against the current best, a JSONL ledger of
//            every round, and a stop after `stallAfter` rounds without a keep,
//            listing the items losing the most. A plateau is the cue to sort
//            the remaining losses by root cause (a bad item, a bad metric, a
//            ceiling), never to try a sixth variation of the fifth idea.
//
// Every delta is candidate minus baseline, and LOWER IS BETTER, because bytes
// are what this repo mostly climbs. A higher-is-better score passes its
// negation. Nothing here reads the network or the tree; the ledger is the one
// write, to a path the caller names.

import { createHash } from "node:crypto";
import { appendFileSync } from "node:fs";

// ── split ───────────────────────────────────────────────────────────────────
export type Side = "train" | "test";
export type SplitOptions = { testShare?: number; seed?: string };

export function sideOf(name: string, { testShare = 0.3, seed = "hillclimb" }: SplitOptions = {}): Side {
  const h = createHash("sha256").update(`${seed}\0${name}`).digest().readUInt32BE(0);
  return h / 2 ** 32 < testShare ? "test" : "train";
}

// Refuses a split with an empty side, which is what a small corpus or a stray
// testShare produces, and which would otherwise judge everything on one side.
export function split<T>(items: T[], nameOf: (item: T) => string, opts: SplitOptions = {}): { train: T[]; test: T[] } {
  const out = { train: [] as T[], test: [] as T[] };
  for (const item of items) out[sideOf(nameOf(item), opts)].push(item);
  if (!out.train.length || !out.test.length) {
    throw new Error(`hillclimb split: ${out.train.length} train / ${out.test.length} test over ${items.length} items; widen the corpus or change testShare`);
  }
  return out;
}

// ── noise ───────────────────────────────────────────────────────────────────
export type Band = { lo: number; hi: number; n: number; median: number };
export const ZERO_BAND: Band = { lo: 0, hi: 0, n: 0, median: 0 };

export function band(controlDeltas: number[]): Band {
  if (!controlDeltas.length) throw new Error("hillclimb band: no control deltas; pass ZERO_BAND for a deterministic scorer");
  const sorted = [...controlDeltas].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  return { lo: sorted[0], hi: sorted.at(-1)!, n: sorted.length, median };
}

// The same spread, moved to sit around zero: what is left of the controls once
// their typical effect is taken out, which is the jitter.
export const centered = (b: Band): Band => ({ lo: b.lo - b.median, hi: b.hi - b.median, n: b.n, median: 0 });

// A seeded PRNG, so a control run is reproducible from its seed alone.
export function rng(seed: string): () => number {
  let a = createHash("sha256").update(seed).digest().readUInt32LE(0);
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
  };
}

// `size` bytes deleted from `bytes` in `pieces` runs at random offsets. The
// control for a byte-level change of the same raw size: it moves the same
// number of bytes and means nothing, so what it does to the compressed size is
// what the compressor does on its own.
export function deleteAtRandom(bytes: Uint8Array, size: number, pieces: number, next: () => number): Uint8Array {
  if (size <= 0) return bytes;
  const n = Math.max(1, Math.min(pieces, size));
  const lengths = Array.from({ length: n }, (_, i) => Math.floor(size / n) + (i < size % n ? 1 : 0));
  let out = bytes;
  for (const len of lengths) {
    if (len >= out.length) return new Uint8Array(0);
    const at = Math.floor(next() * (out.length - len));
    const cut = new Uint8Array(out.length - len);
    cut.set(out.subarray(0, at));
    cut.set(out.subarray(at + len), at);
    out = cut;
  }
  return out;
}

// The brotli (or any byte-scorer) noise band over a set: `runs` times, delete
// from every item as many bytes as the candidate moved in it, and record how
// far the set's compressed total moved. Measure it per SIDE, since the band
// grows with the set.
//
// TWO QUESTIONS, and the first version of this file asked the wrong one. A
// random deletion removes information, so on its own it SAVES compressed bytes,
// and the raw band sits below zero: over 12 KB slices of seven garage pages it
// read -165..-62 B. Stripping leading indentation saved 137 B there, a real
// win, and the raw band called it a regression, because whitespace compresses
// almost for free and removing it saves less than removing arbitrary bytes.
//
//   "jitter"     (default) the band recentred on zero. Is the change's effect
//                larger than q11's own wobble? This is the keep-or-revert
//                question.
//   "arbitrary"  the raw band. Does the change beat deleting the same number
//                of arbitrary bytes? This is the question the 2026-09-26 sprite
//                fold was held to (-27 B against -41..+10), and it is the right
//                one only when the candidate claims to remove information.
export function byteNoiseBand(
  items: Array<{ name: string; bytes: Uint8Array; changed: number }>,
  compress: (bytes: Uint8Array) => number,
  { runs = 30, pieces = 4, seed = "hillclimb-noise", against = "jitter" }:
  { runs?: number; pieces?: number; seed?: string; against?: "jitter" | "arbitrary" } = {},
): Band {
  const base = items.map((it) => compress(it.bytes));
  const deltas: number[] = [];
  for (let r = 0; r < runs; r++) {
    let d = 0;
    items.forEach((it, i) => {
      const next = rng(`${seed}\0${r}\0${it.name}`);
      d += compress(deleteAtRandom(it.bytes, Math.abs(it.changed), pieces, next)) - base[i];
    });
    deltas.push(d);
  }
  return against === "jitter" ? centered(band(deltas)) : band(deltas);
}

// ── judge ───────────────────────────────────────────────────────────────────
export type Verdict = "keep" | "overfit" | "noise" | "regress";
export type SideReading = { total: number; wins: number; units: number; clears: boolean; worse: boolean };
export type Judgement = { verdict: Verdict; reason: string; train: SideReading; test: SideReading };

// `deltas` are paired per unit (an item, or a window of a temporal split),
// candidate minus baseline, lower is better. A side CLEARS when its total beats
// the noise band's best control AND it wins in at least `minWins` of its units,
// so a total carried by one outlier item does not count as a change that
// generalizes. A side is WORSE when its total loses by more than the band's
// worst control.
export function judge(
  { train, test, noise = { train: ZERO_BAND, test: ZERO_BAND }, minWins = 0.5 }:
  { train: number[]; test: number[]; noise?: { train: Band; test: Band }; minWins?: number },
): Judgement {
  const read = (deltas: number[], b: Band): SideReading => {
    if (!deltas.length) throw new Error("hillclimb judge: a side has no units");
    const total = deltas.reduce((s, d) => s + d, 0);
    const wins = deltas.filter((d) => d < 0).length;
    return { total, wins, units: deltas.length, clears: total < b.lo && wins / deltas.length >= minWins, worse: total > b.hi };
  };
  const tr = read(train, noise.train), te = read(test, noise.test);
  const fmt = (s: SideReading, b: Band) => `${s.total >= 0 ? "+" : ""}${round(s.total)} (band ${round(b.lo)}..${round(b.hi)}, wins ${s.wins}/${s.units})`;
  const both = `train ${fmt(tr, noise.train)}, test ${fmt(te, noise.test)}`;
  if (te.worse || (tr.worse && !te.clears)) return { verdict: "regress", reason: `worse past the noise: ${both}`, train: tr, test: te };
  if (tr.clears && te.clears) return { verdict: "keep", reason: `clears the noise on both sides: ${both}`, train: tr, test: te };
  if (tr.clears) return { verdict: "overfit", reason: `train clears and test does not: ${both}`, train: tr, test: te };
  return { verdict: "noise", reason: `inside the noise: ${both}`, train: tr, test: te };
}
const round = (x: number) => Math.round(x * 100) / 100;

// ── climb ───────────────────────────────────────────────────────────────────
export type Candidate<C> = { name: string; apply: (best: C) => C };
export type LedgerRow = {
  round: number; candidate: string; verdict: Verdict; reason: string;
  train: SideReading; test: SideReading; noise: { train: Band; test: Band }; at: string;
};

// One change per round against the current best. `score` is per item and
// lower is better; `noise` returns the band for a side given the candidate's
// config and that side's items (omit it for a deterministic scorer). Stops
// after `stallAfter` rounds without a keep and returns the items the last
// candidate lost most on, which is where a root-cause pass starts.
export async function climb<C, I>(
  { items, nameOf, baseline, candidates, score, noise, ledger, testShare, seed, minWins, stallAfter = 3, log = console.log }:
  {
    items: I[]; nameOf: (item: I) => string; baseline: C; candidates: Array<Candidate<C>>;
    score: (config: C, item: I) => number | Promise<number>;
    noise?: (side: Side, config: C, items: I[]) => Band | Promise<Band>;
    ledger?: string; testShare?: number; seed?: string; minWins?: number; stallAfter?: number;
    log?: (line: string) => void;
  },
): Promise<{ best: C; kept: string[]; rows: LedgerRow[]; stalled: boolean; worst: Array<{ name: string; delta: number }> }> {
  const sides = split(items, nameOf, { testShare, seed });
  const scores = async (config: C, set: I[]) => Promise.all(set.map(async (item) => score(config, item)));
  let best = baseline;
  let bestScores = { train: await scores(best, sides.train), test: await scores(best, sides.test) };
  const rows: LedgerRow[] = [], kept: string[] = [];
  let flat = 0, worst: Array<{ name: string; delta: number }> = [];
  log(`hillclimb: ${sides.train.length} train / ${sides.test.length} test`);
  for (const [n, cand] of candidates.entries()) {
    const config = cand.apply(best);
    const s = { train: await scores(config, sides.train), test: await scores(config, sides.test) };
    const deltas = {
      train: s.train.map((x, i) => x - bestScores.train[i]),
      test: s.test.map((x, i) => x - bestScores.test[i]),
    };
    const bands = noise
      ? { train: await noise("train", config, sides.train), test: await noise("test", config, sides.test) }
      : { train: ZERO_BAND, test: ZERO_BAND };
    const j = judge({ ...deltas, noise: bands, minWins });
    const row: LedgerRow = { round: n + 1, candidate: cand.name, verdict: j.verdict, reason: j.reason, train: j.train, test: j.test, noise: bands, at: new Date().toISOString() };
    rows.push(row);
    if (ledger) appendFileSync(ledger, JSON.stringify(row) + "\n");
    log(`  round ${n + 1} ${cand.name}: ${j.verdict.toUpperCase()}, ${j.reason}`);
    if (j.verdict === "keep") {
      best = config; bestScores = s; kept.push(cand.name); flat = 0;
      continue;
    }
    worst = [...sides.train, ...sides.test]
      .map((item, i) => ({ name: nameOf(item), delta: [...deltas.train, ...deltas.test][i] }))
      .sort((a, b) => b.delta - a.delta).slice(0, 5);
    if (++flat >= stallAfter) {
      log(`hillclimb: stalled, ${flat} rounds without a keep. Sort the losses by cause before another variation; worst items: ${worst.map((w) => `${w.name} ${w.delta >= 0 ? "+" : ""}${round(w.delta)}`).join(", ")}`);
      return { best, kept, rows, stalled: true, worst };
    }
  }
  return { best, kept, rows, stalled: false, worst };
}
