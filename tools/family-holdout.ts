#!/usr/bin/env bun
// family-holdout.ts — score the page-family dictionary OUT OF SAMPLE.
//
// build.ts cuts the family dictionary from the staged pages and then scores it
// on those same pages, so every number the build prints about it is in-sample.
// So is chooseFamilyDictionary's drift check (tools/lib/page-family.ts), which
// scores the committed dictionary and the fresh derivation on the fresh one's
// own training pages. Production never asks either question: a returning
// visitor holds a dictionary cut from pages that have since CHANGED, and
// fetches the new ones.
//
// Its first run (2026-09-28) retired build.ts's REPRESENTATIVE tails, four
// outlier pages' tails laid over the corpus. Tuned in sample they looked like a
// margin; held out they lost 1.6-1.8 points in every one of 90 windows, since
// their benefit was those pages finding their own tails in the dictionary. The
// shipped set stays here as the `tails` rows, so the question stays askable.
//
// So this asks the production question instead. src/dict/p-dict is a git series
// of the bytes production actually SERVED, one snapshot per page per roll (read
// off the wire, so it includes what edge features injected at the time). At
// every roll commit C_i it rebuilds the dictionary from the pages served then,
// with build.ts's own construction, and scores it on the pages served at C_i
// (train, what the build sees) and at C_{i+k} (test, what a visitor sees).
//
// Two questions, both reported with their spread across windows rather than as
// one number, since page content is the noise here and zstd is deterministic:
//
//   configs   does build.ts's corpus beat the alternatives on pages it was not
//             cut from? A config is only better if it wins on test in most
//             windows, read with the corpus pages excluded.
//   drift     the build re-mints when committed/fresh - 1 > FAMILY_DRIFT, with
//             both scored on the fresh corpus's own pages. What is that ratio
//             when both are scored on pages NEITHER was cut from?
//
// It reads git and writes nothing. Usage:
//     bun tools/family-holdout.ts [--k 1,3,8] [--json out.json]
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { brotliCompressSync, brotliDecompressSync, zstdCompressSync, constants as zc } from "node:zlib";
import { createHash, randomBytes } from "node:crypto";
import { zstdCompressDictionaryBatch } from "./lib/zstd-batch.ts";
import { FAMILY_DRIFT } from "./lib/page-family.ts";

const args = process.argv.slice(2);
const flag = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const K = (flag("--k") ?? "1,3,8").split(",").map(Number);
const JSON_OUT = flag("--json");

const git = (a: string[]) => execFileSync("git", a, { encoding: "utf8", maxBuffer: 1 << 28 });
const gitBytes = (a: string[]) => execFileSync("git", a, { maxBuffer: 1 << 28 });
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex").slice(0, 12);

// ── build.ts's construction, read from build.ts ─────────────────────────────
// Parsed rather than copied, so a change to the tail budgets there is what this
// scores as `current` without anyone remembering to edit two files.
const buildSrc = readFileSync(new URL("./build.ts", import.meta.url), "utf8");
const listBlock = (name: string) => {
  const m = buildSrc.match(new RegExp(`const ${name}[^=]*=\\s*\\[([\\s\\S]*?)\\n\\s*\\];`));
  if (!m) throw new Error(`build.ts: could not find ${name}; did the family corpus block move?`);
  return m[1];
};
const slugOf = (rel: string) => rel.replace(/\.html$/, "").replaceAll("/", "__");
const BASE = [...listBlock("BASE_CORPUS").matchAll(/"([^"]+\.html)"/g)].map((m) => slugOf(m[1]));
if (BASE.length < 2) throw new Error("build.ts: BASE_CORPUS parsed empty");
// Tails, if build.ts ever carries them again: the same [page, bytes] shape the
// REPRESENTATIVES list had. Absent means none, which is the shipped state.
const CURRENT: Array<[string, number]> = /const REPRESENTATIVES\b/.test(buildSrc)
  ? [...listBlock("REPRESENTATIVES").matchAll(/\["([^"]+\.html)",\s*([\d_]+)\]/g)].map((m) => [slugOf(m[1]), Number(m[2].replaceAll("_", ""))])
  : [];
const SIZE = 65_536;

// The alternatives are the tail sets build.ts shipped or compared, 2026-08-11 to
// 2026-09-28: horizon and access at the budget named, the two fixtures whole.
const tails = (h: number, a: number): Array<[string, number]> => [
  ["garage__horizon", h], ["garage__vt-b", 4_096], ["garage__vt-check", 4_096], ["access__index", a],
];
const CONFIGS: Array<{ name: string; reps: Array<[string, number]> }> = [
  { name: "current", reps: CURRENT },
  { name: "tails", reps: tails(11_264, 12_288) },
  { name: "tails 12", reps: tails(12_288, 12_288) },
  { name: "tails 16", reps: tails(16_384, 16_384) },
];

// ── the served-page series ──────────────────────────────────────────────────
const PDICT = /(?:^|\/)p-dict\/([^/]+)\.([0-9a-f]{16})\.html\.br$/;
type Snap = { slug: string; tag: string; order: number; path: string; commit: string };
const firstSeen = new Map<string, Snap>();
const checkpoints: Array<{ commit: string; date: string }> = [];
{
  let cur: { commit: string; date: string } | null = null;
  for (const line of git(["log", "--reverse", "--no-renames", "--diff-filter=A", "--format=C %H %cs",
    "--name-only", "--", ":(glob)**/p-dict/*.html.br"]).split("\n")) {
    if (line.startsWith("C ")) { const [, c, d] = line.split(" "); cur = { commit: c, date: d }; checkpoints.push(cur); continue; }
    const m = line.match(PDICT);
    if (!m || !cur) continue;
    const key = `${m[1]}.${m[2]}`;
    if (!firstSeen.has(key)) firstSeen.set(key, { slug: m[1], tag: m[2], order: firstSeen.size, path: line, commit: cur.commit });
  }
}

// The page set served at a checkpoint: per slug, the newest snapshot present in
// the tree then. p-dict keeps up to three per page, so "present" alone is not it.
type State = Map<string, Snap>;
const states: State[] = checkpoints.map(({ commit }) => {
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

const pageCache = new Map<string, Buffer>();
const page = (s: Snap) => {
  const key = `${s.slug}.${s.tag}`;
  let b = pageCache.get(key);
  if (!b) { b = brotliDecompressSync(gitBytes(["show", `${s.commit}:${s.path}`])); pageCache.set(key, b); }
  return b;
};
const q11Cache = new Map<string, number>();
const q11 = (s: Snap) => {
  const key = `${s.slug}.${s.tag}`;
  let n = q11Cache.get(key);
  if (n === undefined) {
    n = brotliCompressSync(page(s), { params: { [zc.BROTLI_PARAM_QUALITY]: 11, [zc.BROTLI_PARAM_SIZE_HINT]: page(s).length } }).length;
    q11Cache.set(key, n);
  }
  return n;
};

function derive(state: State, reps: Array<[string, number]>): Buffer | null {
  const parts: Buffer[] = [];
  let total = 0;
  for (const slug of BASE) {
    const s = state.get(slug);
    if (!s) return null;
    parts.push(page(s));
    total += page(s).length;
    if (total >= SIZE) break;
  }
  if (total < SIZE) return null;
  const base = Buffer.concat(parts).subarray(0, SIZE);
  const tails: Buffer[] = [];
  for (const [slug, n] of reps) {
    const s = state.get(slug);
    if (!s) return null;
    tails.push(page(s).subarray(Math.max(0, page(s).length - n)));
  }
  const prefix = Buffer.concat(tails);
  return Buffer.concat([prefix, base.subarray(prefix.length)]);
}

// ── the grader's own control, before any score is believed ──────────────────
// A zstd that silently ignores `dictionary` prints the same size three times
// (CLAUDE.md gotcha 14), and every number below would then be a no-dictionary
// number. The right dictionary must beat both no dictionary and a wrong one.
{
  const last = states.at(-1)!;
  const dict = derive(last, CURRENT);
  const target = last.get("garage__index") ?? [...last.values()][0];
  if (!dict) throw new Error("control: no dictionary derivable at the newest checkpoint");
  const lvl = { params: { [zc.ZSTD_c_compressionLevel]: 19 } };
  const none = zstdCompressSync(page(target), lvl).length;
  const right = zstdCompressSync(page(target), { ...lvl, dictionary: dict }).length;
  const wrong = zstdCompressSync(page(target), { ...lvl, dictionary: randomBytes(SIZE) }).length;
  console.log(`control ${target.slug}: none ${none} B, wrong dictionary ${wrong} B, right dictionary ${right} B`);
  if (!(right < none * 0.8 && right < wrong)) throw new Error("control failed: this runtime is not honouring the zstd dictionary");
}

// --detail: per page, the newest checkpoint's pages served against a dictionary
// cut K[0] rolls earlier, current against every other config. The aggregate
// above cannot say WHICH pages a config moves, and traffic is not uniform.
if (args.includes("--detail")) {
  const newest = states.length - 1, from = newest - K[0];
  const pages = [...states[newest].values()].sort((a, b) => a.slug.localeCompare(b.slug));
  const lvl = { [zc.ZSTD_c_compressionLevel]: 19 };
  const served = (dict: Buffer, s: Snap) => Math.min(zstdCompressSync(page(s), { dictionary: dict, params: lvl }).length + 40, q11(s));
  const dicts = CONFIGS.map((c) => derive(states[from], c.reps)!);
  console.log(`\nserved bytes at ${checkpoints[newest].date}, dictionaries cut at ${checkpoints[from].date}; columns are each config minus current`);
  console.log(`  ${"page".padEnd(40)} ${"q11".padStart(7)} ${"current".padStart(8)} ${CONFIGS.slice(1).map((c) => c.name.padStart(8)).join(" ")}`);
  const totals = CONFIGS.map(() => 0);
  for (const s of pages) {
    const row = dicts.map((d) => served(d, s));
    row.forEach((n, ci) => { totals[ci] += n; });
    console.log(`  ${s.slug.padEnd(40)} ${String(q11(s)).padStart(7)} ${String(row[0]).padStart(8)} ${row.slice(1).map((n) => String(n - row[0]).padStart(8)).join(" ")}`);
  }
  console.log(`  ${"TOTAL".padEnd(40)} ${String(pages.reduce((n, s) => n + q11(s), 0)).padStart(7)} ${String(totals[0]).padStart(8)} ${totals.slice(1).map((n) => String(n - totals[0]).padStart(8)).join(" ")}`);
  process.exit(0);
}

// ── plan every (dictionary, page) frame, then compress once ─────────────────
const valid = states.map((s, i) => ({ i, dicts: CONFIGS.map((c) => derive(s, c.reps)) }))
  .filter((v) => v.dicts.every(Boolean));
const dictById = new Map<string, Buffer>();
const dictId = (b: Buffer) => { const id = sha(b); dictById.set(id, b); return id; };
const ids = new Map<number, string[]>(valid.map((v) => [v.i, v.dicts.map((d) => dictId(d!))]));

const wanted = new Map<string, { dict: string; snap: Snap }>();
const want = (dict: string, state: State) => {
  for (const s of state.values()) wanted.set(`${dict}|${s.slug}.${s.tag}`, { dict, snap: s });
};
for (const { i } of valid) {
  for (const d of ids.get(i)!) {
    want(d, states[i]);
    for (const k of K) if (states[i + k]) want(d, states[i + k]);
  }
  // drift: D_i and D_j both on S_{j+k}
  for (const k of K) {
    const j = i + k;
    if (!ids.has(j)) continue;
    for (const k2 of K) if (states[j + k2]) { want(ids.get(i)![0], states[j + k2]); want(ids.get(j)![0], states[j + k2]); }
  }
}
const frameSize = new Map<string, number>();
{
  const jobs = [...wanted.entries()];
  const CHUNK = 1200;
  const t0 = Date.now();
  for (let o = 0; o < jobs.length; o += CHUNK) {
    const slice = jobs.slice(o, o + CHUNK);
    const frames = await zstdCompressDictionaryBatch(slice.map(([, { dict, snap }]) => ({ bytes: page(snap), dictionary: dictById.get(dict)! })));
    slice.forEach(([key], n) => frameSize.set(key, frames[n].length));
    process.stderr.write(`\r  compressed ${Math.min(o + CHUNK, jobs.length)}/${jobs.length} frames`);
  }
  process.stderr.write(` in ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);
}

// What the family tier SERVES over a page set, as a share saved under plain q11.
// A delta that fails to beat the page's q11 twin is never emitted (build.ts step
// 8 skips it), so that page costs q11 and not the frame: served bytes are
// min(frame + the 40-byte dcz header, q11). `frames` keeps the raw sum, which is
// what chooseFamilyDictionary compares.
type Score = { frames: number; served: number; q11: number; pages: number; losses: number };
function score(dict: string, pages: Snap[]): Score {
  let frames = 0, served = 0, base = 0, losses = 0;
  for (const s of pages) {
    const f = frameSize.get(`${dict}|${s.slug}.${s.tag}`)!;
    const b = q11(s);
    frames += f; base += b;
    served += Math.min(f + 40, b);
    if (f + 40 >= b) losses++;
  }
  return { frames, served, q11: base, pages: pages.length, losses };
}
const saved = (s: Score) => 1 - s.served / s.q11;
const changedSince = (from: State, to: State) => [...to.values()].filter((s) => from.get(s.slug)?.tag !== s.tag);
// The corpus pages are the dictionary's own answers: a page whose bytes (or tail)
// sit in the window compresses to almost nothing, and still does k rolls later if
// it has not changed. Every config's test set drops the SAME union, so the
// comparison stays paired; what is left is pages no config was cut from.
const CORPUS = new Set([...BASE, ...CONFIGS.flatMap((c) => c.reps.map(([slug]) => slug))]);
const heldOut = (st: State) => [...st.values()].filter((s) => !CORPUS.has(s.slug));

const days = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);
const stats = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * (s.length - 1) + 0.5))];
  return { n: s.length, min: s[0], median: q(0.5), max: s.at(-1)! };
};
const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const pts = (x: number) => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(2)}`;

console.log(`\n${checkpoints.length} roll commits, ${firstSeen.size} served page versions, ${valid.length} checkpoints with every corpus page`);
console.log(`corpus (from build.ts): base ${BASE.join(", ")}; tails ${CURRENT.length ? CURRENT.map(([s, n]) => `${s} ${n}`).join(", ") : "none"}\n`);

const report: Record<string, unknown> = { checkpoints: checkpoints.length, valid: valid.length, configs: {}, drift: {} };

// ── question 1: does the in-sample ranking hold out of sample? ──────────────
console.log("family tier, share saved under plain q11 (median over windows, [min, max])");
console.log("  config      train (in sample)        test k=" + K.join(" / test k="));
const perConfig: Record<string, { train: number[]; test: Record<number, number[]>; testChanged: Record<number, number[]>; testClean: Record<number, number[]> }> = {};
CONFIGS.forEach((c, ci) => {
  const train: number[] = [];
  const test: Record<number, number[]> = {}, testChanged: Record<number, number[]> = {}, testClean: Record<number, number[]> = {};
  for (const k of K) { test[k] = []; testChanged[k] = []; testClean[k] = []; }
  for (const { i } of valid) {
    const d = ids.get(i)![ci];
    train.push(saved(score(d, [...states[i].values()])));
    for (const k of K) {
      if (!states[i + k]) continue;
      test[k].push(saved(score(d, [...states[i + k].values()])));
      testClean[k].push(saved(score(d, heldOut(states[i + k]))));
      const ch = changedSince(states[i], states[i + k]);
      if (ch.length) testChanged[k].push(saved(score(d, ch)));
    }
  }
  perConfig[c.name] = { train, test, testChanged, testClean };
  const fmt = (xs: number[]) => { const s = stats(xs); return `${pct(s.median)} [${pct(s.min)}, ${pct(s.max)}]`; };
  console.log(`  ${c.name.padEnd(10)}  ${fmt(train).padEnd(24)} ${K.map((k) => fmt(test[k])).join("  ")}`);
});
// Pages whose delta loses to q11 (served as brotli), and the dictionary's own
// q11 fetch, which every returning visitor pays once per re-mint.
console.log("\npages falling back to q11 (median per window, test k=" + K[0] + "), and the dictionary's own q11 fetch (median)");
CONFIGS.forEach((c, ci) => {
  const losses: number[] = [], dictBr: number[] = [];
  for (const { i } of valid) {
    const d = ids.get(i)![ci];
    if (states[i + K[0]]) losses.push(score(d, [...states[i + K[0]].values()]).losses);
    dictBr.push(brotliCompressSync(dictById.get(d)!, { params: { [zc.BROTLI_PARAM_QUALITY]: 11 } }).length);
  }
  console.log(`  ${c.name.padEnd(10)}  losses ${stats(losses).median} [${stats(losses).min}, ${stats(losses).max}] of ~${states.at(-1)!.size} pages   dictionary ${stats(dictBr).median} B`);
});
console.log("\nsame, CHANGED pages only (what a returning visitor re-fetches)");
for (const c of CONFIGS) {
  console.log(`  ${c.name.padEnd(10)}  ${K.map((k) => { const s = stats(perConfig[c.name].testChanged[k]); return `k=${k}: ${pct(s.median)} [${pct(s.min)}, ${pct(s.max)}] n=${s.n}`; }).join("  ")}`);
}
console.log("\neach config against current, per window: median points, and windows it WINS out of all");
for (const c of CONFIGS.slice(1)) {
  const cmp = (a: number[], b: number[]) => {
    const d = a.map((x, n) => x - b[n]);
    return `${pts(stats(d).median)} pts, wins ${d.filter((x) => x > 0).length}/${d.length}`;
  };
  const cur = perConfig.current;
  console.log(`  ${c.name.padEnd(10)}  train ${cmp(perConfig[c.name].train, cur.train).padEnd(26)} ${K.map((k) => `test k=${k} ${cmp(perConfig[c.name].test[k], cur.test[k])}`).join("  ")}`);
  console.log(`  ${"".padEnd(10)}  corpus pages excluded:     ${K.map((k) => `test k=${k} ${cmp(perConfig[c.name].testClean[k], cur.testClean[k])}`).join("  ")}`);
}
report.configs = perConfig;

// ── question 2: is the build's drift reading an in-sample artifact? ─────────
// D_i is the stale committed dictionary, D_j the fresh derivation k rolls later.
// The build reads drift on S_j (D_j's own pages). The held-out reading scores
// both on S_{j+k2}, which neither was cut from.
console.log(`\ndrift of a dictionary k rolls stale (committed/fresh - 1; the build re-mints above ${pct(FAMILY_DRIFT)})`);
const driftReport: Record<string, unknown> = {};
for (const k of K) {
  const asBuild: number[] = [], heldOut: Record<number, number[]> = {}, gaps: number[] = [];
  for (const k2 of K) heldOut[k2] = [];
  for (const { i } of valid) {
    const j = i + k;
    if (!ids.has(j)) continue;
    const Di = ids.get(i)![0], Dj = ids.get(j)![0];
    const inS = [...states[j].values()];
    asBuild.push(score(Di, inS).frames / score(Dj, inS).frames - 1);
    gaps.push(days(checkpoints[i].date, checkpoints[j].date));
    for (const k2 of K) {
      if (!states[j + k2]) continue;
      const out = [...states[j + k2].values()];
      heldOut[k2].push(score(Di, out).frames / score(Dj, out).frames - 1);
    }
  }
  const s = stats(asBuild);
  console.log(`  stale by k=${k} (median ${stats(gaps).median} days): as the build reads it ${pts(s.median)}% [${pts(s.min)}, ${pts(s.max)}], over ${pct(FAMILY_DRIFT)} in ${asBuild.filter((x) => x > FAMILY_DRIFT).length}/${s.n}`);
  for (const k2 of K) {
    const h = stats(heldOut[k2]);
    if (!h.n) continue;
    console.log(`      held out, pages k=${k2} later: ${pts(h.median)}% [${pts(h.min)}, ${pts(h.max)}], over ${pct(FAMILY_DRIFT)} in ${heldOut[k2].filter((x) => x > FAMILY_DRIFT).length}/${h.n}`);
  }
  driftReport[k] = { asBuild, heldOut, gaps };
}
report.drift = driftReport;

if (JSON_OUT) writeFileSync(JSON_OUT, JSON.stringify(report, null, 2));
