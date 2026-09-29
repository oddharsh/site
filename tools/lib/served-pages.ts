// served-pages.ts — the pages production actually served, as a time series.
//
// src/dict/p-dict holds one snapshot per page per dictionary roll, read off the
// WIRE (so it carries whatever an edge feature injected at the time), and git
// holds every roll. Together they are a record of the bytes browsers received,
// which is the corpus a dictionary is judged against: a returning visitor holds
// a dictionary cut at one roll and fetches the pages served at a later one.
//
// tools/family-holdout.ts and tools/family-corpus-climb.ts both read it through
// here, so the series cannot mean two things. Reads git and nothing else.

import { execFileSync } from "node:child_process";
import { brotliCompressSync, brotliDecompressSync, constants as zc } from "node:zlib";

export const FAMILY_WINDOW = 65_536;
const PDICT = /(?:^|\/)p-dict\/([^/]+)\.([0-9a-f]{16})\.html\.br$/;

export type Snap = { slug: string; tag: string; order: number; path: string; commit: string };
export type State = Map<string, Snap>;
export type Series = { checkpoints: Array<{ commit: string; date: string }>; states: State[]; versions: number };

const git = (a: string[]) => execFileSync("git", a, { encoding: "utf8", maxBuffer: 1 << 28 });
const gitBytes = (a: string[]) => execFileSync("git", a, { maxBuffer: 1 << 28 });

// Every roll commit, oldest first, and the page set served at each: per slug
// the newest snapshot present in the tree then. p-dict keeps up to three per
// page, so "present" alone is not it. The paths moved twice (holding/, www/,
// src/dict/), so snapshots are keyed by file NAME and dated by first appearance.
export function loadServedSeries(): Series {
  const firstSeen = new Map<string, Snap>();
  const checkpoints: Array<{ commit: string; date: string }> = [];
  let cur: { commit: string; date: string } | null = null;
  for (const line of git(["log", "--reverse", "--no-renames", "--diff-filter=A", "--format=C %H %cs",
    "--name-only", "--", ":(glob)**/p-dict/*.html.br"]).split("\n")) {
    if (line.startsWith("C ")) { const [, c, d] = line.split(" "); cur = { commit: c, date: d }; checkpoints.push(cur); continue; }
    const m = line.match(PDICT);
    if (!m || !cur) continue;
    const key = `${m[1]}.${m[2]}`;
    if (!firstSeen.has(key)) firstSeen.set(key, { slug: m[1], tag: m[2], order: firstSeen.size, path: line, commit: cur.commit });
  }
  const states = checkpoints.map(({ commit }) => {
    const s: State = new Map();
    for (const path of git(["ls-tree", "-r", "--name-only", commit]).split("\n")) {
      const m = path.match(PDICT);
      if (!m) continue;
      const snap = firstSeen.get(`${m[1]}.${m[2]}`);
      if (!snap) continue;
      const held = s.get(snap.slug);
      if (!held || snap.order > held.order) s.set(snap.slug, snap);
    }
    return s;
  });
  return { checkpoints, states, versions: firstSeen.size };
}

const pageCache = new Map<string, Buffer>();
export function page(s: Snap): Buffer {
  const key = `${s.slug}.${s.tag}`;
  let b = pageCache.get(key);
  if (!b) { b = brotliDecompressSync(gitBytes(["show", `${s.commit}:${s.path}`])); pageCache.set(key, b); }
  return b;
}

const q11Cache = new Map<string, number>();
export function q11(s: Snap): number {
  const key = `${s.slug}.${s.tag}`;
  let n = q11Cache.get(key);
  if (n === undefined) {
    n = brotliCompressSync(page(s), { params: { [zc.BROTLI_PARAM_QUALITY]: 11, [zc.BROTLI_PARAM_SIZE_HINT]: page(s).length } }).length;
    q11Cache.set(key, n);
  }
  return n;
}

// build.ts's family construction over a served state: the base pages read in
// order until the window fills, optionally with page tails laid over the start
// (the REPRESENTATIVES shape build.ts carried until #1005). Null when a named
// page was not served at that roll, or the pages fall short of the window.
export function deriveFamily(state: State, base: string[], reps: Array<[string, number]> = [], size = FAMILY_WINDOW): Buffer | null {
  const parts: Buffer[] = [];
  let total = 0;
  for (const slug of base) {
    const s = state.get(slug);
    if (!s) return null;
    parts.push(page(s));
    total += page(s).length;
    if (total >= size) break;
  }
  if (total < size) return null;
  const window = Buffer.concat(parts).subarray(0, size);
  const tails: Buffer[] = [];
  for (const [slug, n] of reps) {
    const s = state.get(slug);
    if (!s) return null;
    tails.push(page(s).subarray(Math.max(0, page(s).length - n)));
  }
  const prefix = Buffer.concat(tails);
  return Buffer.concat([prefix, window.subarray(prefix.length)]);
}
