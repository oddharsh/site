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
// THE WINDOW SIZE, 2026-09-29 (--candidates w96,w128,w48,w32, same windows).
// Per page the harness says bigger: 96 KiB and then 128 KiB were KEPT, 128 KiB
// winning 43 of 47 train pages and 20 of 20 test, and 48 and 32 KiB regress.
// That verdict is correct and is not the answer, for two reasons the tool now
// prints below the climb:
//
//   1. 64% of 128 KiB's gain in the newest window is lwe/vigenere matching its
//      own bytes (-16,514 of -26,166 B). A bigger window pulls more of a corpus
//      page in, and a visitor collects that only on that page. The other 63
//      pages save about 150 B each.
//   2. The dictionary is a download. Its q11 twin is 8,367 / 12,495 / 15,024 /
//      22,094 / 30,931 B at 32 / 48 / 64 / 96 / 128 KiB, paid once per visitor
//      per re-mint, and the harness weighs only per-page bytes.
//
//   window    B/view (all / outside corpus)   break-even outside the corpus
//   32 KiB    8,343 / 8,332                   better for visitors under 16 pages
//   48 KiB    7,937 / 7,986                   better for visitors under 50 pages
//   64 KiB    7,850 / 7,936                   shipped
//   96 KiB    7,676 / 7,868                   pays back after 105 page views
//   128 KiB   7,460 / 7,786                   pays back after 107 page views
//
// So the size is a bet on visit depth, which this site does not measure (no
// RUM, by design): 48 KiB for visitors who read under ~50 pages per dictionary
// lifetime, 64 for 50-105, 128 past that. Nothing changed. A size change ships
// only at a re-mint, and a re-mint re-downloads the dictionary for every
// returning visitor anyway, so the choice belongs to that moment and to
// whatever is known about visit depth then. What is settled is the direction
// of the error: a per-page verdict alone would have grown the window, and the
// acquisition says that is wrong for any visitor reading fewer than 100 pages.
//
// usage: bun tools/family-corpus-climb.ts [--k 16] [--candidates a,b] [--stall 3] [--min-wins 0.6] [--ledger out.jsonl]
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { brotliCompressSync, constants as zc } from "node:zlib";
import { climb, type Candidate } from "./lib/hillclimb.ts";
import { deriveFamily, FAMILY_WINDOW, loadServedSeries, q11, page, type Snap } from "./lib/served-pages.ts";
import { zstdCompressDictionaryBatch } from "./lib/zstd-batch.ts";

const argv = process.argv.slice(2);
const arg = (name: string) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined; };
const K = Number(arg("k") ?? 16);

// the shipped corpus, read from build.ts rather than copied
const buildSrc = readFileSync(new URL("./build.ts", import.meta.url), "utf8");
const block = buildSrc.match(/const BASE_CORPUS[^=]*=\s*\[([\s\S]*?)\n\s*\];/);
if (!block) throw new Error("build.ts: BASE_CORPUS not found");
const SHIPPED = [...block[1].matchAll(/"([^"]+)\.html"/g)].map((m) => m[1].replaceAll("/", "__"));

// A corpus is the page list build.ts reads in order AND the window it fills.
type Corpus = { pages: string[]; size: number };
const SHIPPED_CORPUS: Corpus = { pages: SHIPPED, size: FAMILY_WINDOW };
const replace = (c: Corpus, from: string, to: string): Corpus => ({ ...c, pages: c.pages.map((s) => (s === from ? to : s)) });
const toFront = (c: Corpus, slug: string): Corpus => ({ ...c, pages: [slug, ...c.pages.filter((s) => s !== slug)] });
const window_ = (size: number) => (c: Corpus): Corpus => ({ ...c, size });
const labelOf = (c: Corpus) => `${c.pages.join(",")}@${c.size}`;
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
  // The window itself. Bigger means more shell for every page to match and a
  // bigger one-time download, which the harness does not see; see the end.
  w96: { name: "96 KiB window", apply: window_(98_304) },
  w128: { name: "128 KiB window", apply: window_(131_072) },
  w48: { name: "48 KiB window", apply: window_(49_152) },
  w32: { name: "32 KiB window", apply: window_(32_768) },
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
  const key = labelOf(c);
  if (!frameMemo.has(key)) frameMemo.set(key, (async () => {
    const jobs: Array<{ key: string; bytes: Buffer; dictionary: Buffer }> = [];
    for (const i of windows) {
      const dict = deriveFamily(states[i], c.pages, [], c.size);
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
console.log(`shipped corpus: ${SHIPPED.join(", ")} in ${FAMILY_WINDOW} B`);
const out = await climb<Corpus, string>({
  items, nameOf: (s) => s, baseline: SHIPPED_CORPUS, candidates: pick.map((p) => CANDIDATES[p]), score,
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
const [a, b] = [await byFamily(SHIPPED_CORPUS), await byFamily(out.best)];
console.log(`\nkept: ${out.kept.join(", ") || "nothing"}; best corpus: ${out.best.pages.join(", ")} in ${out.best.size} B`);
console.log(`newest window, served family tier by page family (shipped -> best):`);
for (const f of Object.keys(a).sort()) console.log(`  ${f.padEnd(8)} ${String(a[f]).padStart(7)} -> ${String(b[f]).padStart(7)}  (${b[f] - a[f] >= 0 ? "+" : ""}${b[f] - a[f]} B)`);
const dictAt = (c: Corpus) => deriveFamily(states[windows.at(-1)!], c.pages, [], c.size)!;
const dictHash = (c: Corpus) => createHash("sha256").update(dictAt(c)).digest("hex").slice(0, 8);
console.log(`dictionary: shipped corpus ${dictHash(SHIPPED_CORPUS)}, best ${dictHash(out.best)}`);

// THE ACQUISITION, which the harness does not weigh. A returning visitor
// downloads the dictionary's q11 twin once per re-mint, and every page they
// then read saves the per-page difference. So a window change is only worth
// it past a break-even page count, and that count is a statement about
// visitors this site does not measure (it collects no RUM). Printed for every
// window the run scored, against the shipped one.
const sizes = [...new Set([FAMILY_WINDOW, ...pick.map((p) => CANDIDATES[p].apply(SHIPPED_CORPUS)).filter((c) => c.pages.join() === SHIPPED.join()).map((c) => c.size)])].sort((x, y) => x - y);
const q11Of = (b: Buffer) => brotliCompressSync(b, { params: { [zc.BROTLI_PARAM_QUALITY]: 11 } }).length;
// Two per-view means: over every page, and over the pages OUTSIDE the corpus.
// A bigger window pulls more of a corpus page into the dictionary, where it
// matches itself; on 2026-09-29 that was 64% of the 128 KiB window's gain, all
// of it lwe/vigenere, and a visitor collects it only on that one page.
const perView = async (c: Corpus, excludeCorpus: boolean) => {
  const i = windows.at(-1)!, fr = await frames(c);
  const pages = [...states[i + K].values()].filter((s) => !excludeCorpus || !SHIPPED.includes(s.slug));
  return pages.reduce((n, s) => n + served(fr.get(`${i}|${s.slug}`)!, s), 0) / pages.length;
};
const shippedAll = await perView(SHIPPED_CORPUS, false), shippedRest = await perView(SHIPPED_CORPUS, true), shippedAcq = q11Of(dictAt(SHIPPED_CORPUS));
const verdict = (saved: number, extra: number) => saved > 0 && extra > 0 ? `pays back after ${Math.ceil(extra / saved)} views`
  : saved > 0 ? "smaller download AND pages" : extra < 0 ? `pays back for visitors reading under ${Math.floor(-extra / -saved)} pages` : "worse both ways";
console.log(`\nwindow size against acquisition (newest window; per-view means over all pages / pages outside the corpus; dictionary as its q11 download):`);
for (const size of sizes) {
  const c = { pages: SHIPPED, size };
  const all = await perView(c, false), rest = await perView(c, true), acq = q11Of(dictAt(c)), extra = acq - shippedAcq;
  const tail = size === FAMILY_WINDOW ? "  <- shipped" : `  | all pages: ${verdict(shippedAll - all, extra)}; outside the corpus: ${verdict(shippedRest - rest, extra)}`;
  console.log(`  ${String(size).padStart(6)} B  ${all.toFixed(0).padStart(5)} / ${rest.toFixed(0).padStart(5)} B/view  dictionary ${String(acq).padStart(6)} B${tail}`);
}
