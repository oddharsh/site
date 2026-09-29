#!/usr/bin/env bun
// family-corpus-climb.ts — which pages should fill the family dictionary's window?
//
// build.ts reads BASE_CORPUS in order until 64 KiB is full. Today that is
// lwe/drivers (25.6 KB) and garage/compression (34.6 KB) plus 4 KB of
// lwe/vigenere, so the window holds an LWE shell and a Garage shell and nothing
// from the homepage, the writing pages, or the eighteen utility pages. Every
// page added evicts part of what is there, so each candidate is a TRADE between
// page families, and this climbs those trades through tools/lib/hillclimb.ts.
//
// Two held-out layers at once:
//
//   by page   the harness splits the served pages by a hash of their slug,
//             70/30. A corpus is tuned against the train pages' bytes and
//             kept only if the test pages agree, so a corpus that suits
//             whichever family dominates train cannot win on that alone.
//   by time   every page is scored at the version served --k rolls AFTER the
//             dictionary was cut (tools/lib/served-pages.ts), because the
//             committed dictionary ships for months (tools/lib/page-family.ts)
//             while the pages it was cut from keep changing.
//
// Corpus pages are NOT excluded here, which is the one departure from
// family-holdout.ts, and it is deliberate. There the question was whether a
// tuning generalizes, and a page scored against its own bytes answers nothing.
// Here the question is what visitors get, and a returning visitor to a corpus
// page really does get a near-free delta until the page drifts. The long --k
// is what keeps that honest: at 16 rolls most corpus pages have changed.
//
// The score per page is the served family tier, min(frame + 40, q11), summed
// over every window the page is present in; lower is better. zstd is
// deterministic, so the band is zero and a change must win on at least
// --min-wins of pages on both sides.
//
// WHAT IT FOUND, 2026-09-29 (67 pages, 47 train / 20 test, 18 windows at k=16,
// dictionaries cut 2026-08-06 to 2026-08-28; served-byte deltas summed over
// every window, negative is smaller):
//
//   trade                                  train (47)       test (20)       verdict
//   garage/compression first               -288, 20 wins    -3,038, 14      noise
//   homepage first                         +181,971, 8      +50,182, 4      REGRESS
//   writing/index first                    -68,058, 19      +26,342, 7      REGRESS
//   garage/index for garage/compression    +18,396, 24      +1,969, 8       REGRESS
//   lwe/index for lwe/drivers              +13,781, 12      +95,938, 4      REGRESS
//   updates first                          -63,468, 29      -1,718, 10      overfit
//
// Nothing kept: the shipped corpus is a local optimum for one-page trades. The
// first stall's worst item was garage/compression itself, and that is the root
// cause. The window is full, the Garage explainer is the shell 30 garage pages
// match against, and any other family's shell evicts it, so the largest family
// pays for every newcomer. writing/index shows why the win share gates a side:
// its train total fell 68 KB on 19 of 47 pages, the writing pages gaining a lot
// and most others losing a little, and test went the other way.
//
// updates is the near-miss, and it is early rather than wrong. It carries the
// page shell eight utility pages adopted when they became built documents on
// 2026-09-25, and those pages have 3-4 rolls of history, so only the latest
// windows at k=16 contain them. Re-run once they have 16 rolls behind them
// (early October 2026 at the recent two rolls a day, late October at the
// long-run 0.6); the served series grows by itself, so the same command then
// measures a family that is half missing today.
// Nothing here ships until a re-mint anyway (tools/lib/page-family.ts).
//
// usage: bun tools/family-corpus-climb.ts [--k 16] [--candidates a,b] [--stall 3] [--min-wins 0.6] [--ledger out.jsonl]
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { climb, type Candidate } from "./lib/hillclimb.ts";
import { deriveFamily, loadServedSeries, q11, page, type Snap } from "./lib/served-pages.ts";
import { zstdCompressDictionaryBatch } from "./lib/zstd-batch.ts";

const argv = process.argv.slice(2);
const arg = (name: string) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined; };
const K = Number(arg("k") ?? 16);

// the shipped corpus, read from build.ts rather than copied
const buildSrc = readFileSync(new URL("./build.ts", import.meta.url), "utf8");
const block = buildSrc.match(/const BASE_CORPUS[^=]*=\s*\[([\s\S]*?)\n\s*\];/);
if (!block) throw new Error("build.ts: BASE_CORPUS not found");
const SHIPPED = [...block[1].matchAll(/"([^"]+)\.html"/g)].map((m) => m[1].replaceAll("/", "__"));

type Corpus = string[];
const replace = (c: Corpus, from: string, to: string): Corpus => c.map((s) => (s === from ? to : s));
const toFront = (c: Corpus, slug: string): Corpus => [slug, ...c.filter((s) => s !== slug)];
// One trade per round, ordered by prior: the cheapest structural change first,
// then a shell for each family the window holds nothing of, then swaps of the
// two pages it does hold for their section indexes.
const CANDIDATES: Record<string, Candidate<Corpus>> = {
  compfirst: { name: "garage/compression first", apply: (c) => toFront(c, "garage__compression") },
  home: { name: "homepage first", apply: (c) => toFront(c, "index") },
  writing: { name: "writing/index first", apply: (c) => toFront(c, "writing__index") },
  utility: { name: "updates first", apply: (c) => toFront(c, "updates") },
  garageidx: { name: "garage/index for garage/compression", apply: (c) => replace(c, "garage__compression", "garage__index") },
  lweidx: { name: "lwe/index for lwe/drivers", apply: (c) => replace(c, "lwe__drivers", "lwe__index") },
};
const pick = (arg("candidates") ?? Object.keys(CANDIDATES).join(",")).split(",");
for (const p of pick) if (!CANDIDATES[p]) throw new Error(`unknown candidate ${p}; have ${Object.keys(CANDIDATES).join(", ")}`);

const { checkpoints, states, versions } = loadServedSeries();
// Windows every candidate can be scored in: each page any of them names must be
// served at the roll the dictionary is cut from, or the comparison is unpaired.
const named = new Set([...SHIPPED, "index", "writing__index", "updates", "garage__index", "lwe__index"]);
const windows = states.map((_, i) => i).filter((i) => states[i + K] && [...named].every((s) => states[i].has(s)));
if (windows.length < 5) throw new Error(`only ${windows.length} windows at k=${K}; lower --k`);
const items = [...states.at(-1)!.keys()].sort();

// Frames for one corpus over every (window, page), batched once per corpus.
const frameMemo = new Map<string, Promise<Map<string, number>>>();
function frames(c: Corpus): Promise<Map<string, number>> {
  const key = c.join(",");
  if (!frameMemo.has(key)) frameMemo.set(key, (async () => {
    const jobs: Array<{ key: string; bytes: Buffer; dictionary: Buffer }> = [];
    for (const i of windows) {
      const dict = deriveFamily(states[i], c);
      if (!dict) throw new Error(`corpus ${key} cannot fill the window at ${checkpoints[i].date}`);
      for (const s of states[i + K].values()) jobs.push({ key: `${i}|${s.slug}`, bytes: page(s), dictionary: dict });
    }
    const out = await zstdCompressDictionaryBatch(jobs.map(({ bytes, dictionary }) => ({ bytes, dictionary })));
    return new Map(jobs.map((j, n) => [j.key, out[n].length]));
  })());
  return frameMemo.get(key)!;
}
const served = (f: number, s: Snap) => Math.min(f + 40, q11(s));
async function score(c: Corpus, slug: string): Promise<number> {
  const fr = await frames(c);
  let total = 0;
  for (const i of windows) {
    const s = states[i + K].get(slug);
    if (s) total += served(fr.get(`${i}|${slug}`)!, s);
  }
  return total;
}

console.log(`family-corpus-climb: ${items.length} pages, ${windows.length} windows at k=${K} (${checkpoints[windows[0]].date} to ${checkpoints[windows.at(-1)!].date}), ${versions} served versions`);
console.log(`shipped corpus: ${SHIPPED.join(", ")}`);
const out = await climb<Corpus, string>({
  items, nameOf: (s) => s, baseline: SHIPPED, candidates: pick.map((p) => CANDIDATES[p]), score,
  minWins: Number(arg("min-wins") ?? 0.6), stallAfter: Number(arg("stall") ?? 3), ledger: arg("ledger"),
});

// What a kept corpus is worth, in the reader's units: bytes per page view on the
// newest roll's pages, served against the corpus cut at the roll K before it.
const fam = (s: string) => s === "index" ? "home" : s.split("__")[0] in { garage: 1, lwe: 1, writing: 1 } ? s.split("__")[0] : "utility";
const byFamily = async (c: Corpus) => {
  const i = windows.at(-1)!, fr = await frames(c), acc: Record<string, number> = {};
  for (const s of states[i + K].values()) acc[fam(s.slug)] = (acc[fam(s.slug)] ?? 0) + served(fr.get(`${i}|${s.slug}`)!, s);
  return acc;
};
const [a, b] = [await byFamily(SHIPPED), await byFamily(out.best)];
console.log(`\nkept: ${out.kept.join(", ") || "nothing"}; best corpus: ${out.best.join(", ")}`);
console.log(`newest window, served family tier by page family (shipped -> best):`);
for (const f of Object.keys(a).sort()) console.log(`  ${f.padEnd(8)} ${String(a[f]).padStart(7)} -> ${String(b[f]).padStart(7)}  (${b[f] - a[f] >= 0 ? "+" : ""}${b[f] - a[f]} B)`);
const dictHash = (c: Corpus) => createHash("sha256").update(deriveFamily(states[windows.at(-1)!], c)!).digest("hex").slice(0, 8);
console.log(`dictionary: shipped corpus ${dictHash(SHIPPED)}, best ${dictHash(out.best)}`);
