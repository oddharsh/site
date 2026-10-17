// Literal colours that sit NEAR a design token, and literals that repeat across
// files with no token at all. Report only: nothing here fails a build.
//
// The token contract (contract-design-tokens-reach-every-page) holds copies at
// zero: a literal within COPY_DE of a token is that token retyped. Past COPY_DE
// the answer stops being mechanical. `oklch(99% 0 0)` beside `--paper` might be
// the paper with its warmth dropped by accident, or a neutral white on purpose,
// and only the person who wrote the rule knows. This lists that band, from
// COPY_DE up to the just-noticeable difference, so each one gets a decision:
// write the token, or leave the literal because it means something else.
//
// The two tooltip yellows that started this land in that first list: the
// infotip's and the tray balloon's both sit near `--row-hover` (dE 0.012 and
// 0.008) and 0.0065 from each other, where XP drew both from one InfoBackground.
//
// The second list is the other kind of drift: one colour written by hand in
// three or more files, which is a token nobody has named yet. The first one
// this list named was `oklch(44.95% 0 0)` (#555555), a note grey between
// `--ink-soft` and `--ink-dim` written 52 times across 19 files; it is
// `--ink-quiet` now.
//
//   bun run colors:drift            near-token band + unnamed shared colours
//   bun run colors:drift --json     the same, as JSON
import { readFileSync } from "node:fs";
import { COPY_DE, colorLiteralsIn, cssSources, deltaEOK, loadTokenValueMap, parseOklch, tokenCopiesIn, type Lab } from "./lib/token-literals.ts";

/** CSS Color 4's just-noticeable difference in OKLab. Past this, a literal is a different colour. */
const JND = 0.02;
/** A colour hand-written in this many files is a token waiting for a name. */
const SHARED_FILES = 3;

const ROOT = new URL("../", import.meta.url);
const map = loadTokenValueMap(ROOT);
const tokens: [string, Lab][] = [];
for (const [value, name] of map) {
  const p = parseOklch(value);
  if (p) tokens.push([name, p.lab]);
}

interface Hit {
  file: string;
  /** Null inside a pipeline spec, whose CSS is a JSON string. */
  line: number | null;
  literal: string;
  lab: Lab;
}
const hits: Hit[] = [];
const texts = new Map<string, string>();
const lineOf = (file: string, offset: number | null, index: number) => {
  if (offset === null) return null;
  if (!texts.has(file)) texts.set(file, readFileSync(new URL(file, ROOT), "utf8"));
  return texts.get(file)!.slice(0, offset + index).split("\n").length;
};
for (const s of cssSources(ROOT)) {
  // The desktop shell is stamped into every page from src/worker/lib/desktop.ts,
  // which is walked as a Worker source, so its icon colours count there once.
  // Blanked rather than cut, so line numbers past it still point at the file.
  const css = s.css.replace(/<!-- axp:shell -->[\s\S]*?<!-- \/axp:shell -->/g, (m) => m.replace(/[^\n]/g, " "));
  const copies = new Set(tokenCopiesIn(css, map).map((c) => c.index));
  // oklch(), hex and rgb() alike; until 2026-10-06 this read oklch() only and
  // missed the 2,248 hex literals that make up most of the site's colour.
  for (const c of colorLiteralsIn(css)) {
    if (copies.has(c.index)) continue;
    hits.push({ file: s.file, line: lineOf(s.file, s.offset, c.index), literal: c.literal, lab: c.lab });
  }
}

const near: (Hit & { token: string; dE: number })[] = [];
const rest: Hit[] = [];
for (const h of hits) {
  let best: [string, number] = ["", Infinity];
  for (const [name, lab] of tokens) {
    const d = deltaEOK(h.lab, lab);
    if (d < best[1]) best = [name, d];
  }
  if (best[1] >= COPY_DE && best[1] < JND) near.push({ ...h, token: best[0], dE: Math.round(best[1] * 1e4) / 1e4 });
  else rest.push(h);
}

// Single-link clusters at COPY_DE: literals that close are the same colour written twice.
const clusters: Hit[][] = [];
for (const h of rest) {
  const c = clusters.find((c) => c.some((x) => deltaEOK(x.lab, h.lab) < COPY_DE));
  if (c) c.push(h);
  else clusters.push([h]);
}
const shared = clusters
  .filter((c) => new Set(c.map((h) => h.file)).size >= SHARED_FILES)
  .sort((a, b) => new Set(b.map((h) => h.file)).size - new Set(a.map((h) => h.file)).size);

if (process.argv.includes("--json")) {
  const strip = ({ lab: _, ...h }: Hit) => h;
  console.log(JSON.stringify({ near: near.map(strip), shared: shared.map((c) => c.map(strip)) }, null, 1));
} else {
  const byToken = Map.groupBy(near.sort((a, b) => a.dE - b.dE), (h) => h.token);
  console.log(`${hits.length} literals outside the tokens; ${near.length} within ${COPY_DE}–${JND} of one (write the token, or keep it on purpose):\n`);
  for (const [token, hs] of [...byToken].sort((a, b) => b[1].length - a[1].length)) {
    console.log(`  ${token}  ${hs.length}`);
    for (const h of hs.slice(0, 4)) console.log(`    ${h.dE.toFixed(4)}  ${h.literal}  ${h.file}${h.line === null ? "" : `:${h.line}`}`);
    if (hs.length > 4) console.log(`    … ${hs.length - 4} more`);
  }
  console.log(`\n${shared.length} colours hand-written in ${SHARED_FILES}+ files with no token (name one, or leave it):\n`);
  for (const c of shared.slice(0, 20)) {
    const files = [...new Set(c.map((h) => h.file))];
    console.log(`  ${c[0].literal}  ${c.length} uses, ${files.length} files: ${files.slice(0, 3).join(", ")}${files.length > 3 ? ", …" : ""}`);
  }
}
