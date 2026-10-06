// Which literal colours in served CSS are hand-resolved COPIES of a design token.
//
// design/tokens/colors.css is built around a few knobs (`--hue-luna`,
// `--chroma-luna`) and derives the palette from them, so that turning one knob
// retunes the site. That only holds where the CSS says `var(--blue-40)`. Where
// it says `oklch(41.92% 0.0962 250.51)`, somebody resolved the token by hand
// and pasted the answer, and the knob no longer reaches that rule. Measured
// 2026-09-15: 345 such copies across 43 pages, 43 more inside luna.css itself,
// and the title-bar gradient (`--grad-title`) resolved by hand in 30 pages while
// the token had zero consumers.
//
// This module answers one question, "is this literal a token's value", by
// resolving every token in the `:root` block through the knobs and comparing
// normalised text. A value that two or more tokens share (white is four) is
// AMBIGUOUS and never reported, because `var(--window)` for a white that meant
// "selection text" would be a semantic lie. Only the sRGB `:root` block is
// read: the `@media (color-gamut: p3)` overrides are a second value for the
// same name, and a literal equal to one of those is a copy of the boosted
// value, which is a different mistake this does not try to name.
//
// "Is this literal a token's value" was first answered by text, and text missed
// two spellings of the same mistake: the token with an alpha on it, and the
// token resolved by hand at a different rounding. Both are now matched by
// distance in OKLab (see COPY_DE).
import { readFileSync, readdirSync } from "node:fs";

const OKLCH = /oklch\([^()]*\)/g;

/**
 * Spelling variants collapse so `0.150`, `0.15` and `.15` compare equal, and so
 * does `100.00%` against `100%`. The bare `.15` form is what the garage
 * generator writes and the first sweep missed for exactly that reason.
 */
export function normalizeColor(s: string): string {
  return s
    .trim()
    .replace(/\s+/g, " ")
    .replace(/(?<![\d.])\.(\d)/g, "0.$1")
    .replace(/(\d+)\.0+(?=[ %)])/g, "$1")
    .replace(/(\d+\.\d*[1-9])0+(?=[ %)])/g, "$1");
}

/** Token name by resolved literal value, for tokens whose value is one unambiguous oklch(). */
export function tokenValueMap(colorsCss: string): Map<string, string> {
  const p3 = colorsCss.indexOf("@media (color-gamut: p3)");
  const root = p3 === -1 ? colorsCss : colorsCss.slice(0, p3);
  const knobs = new Map<string, number>();
  for (const m of root.matchAll(/(--hue-[a-z]+|--chroma-[a-z]+)\s*:\s*([\d.]+)/g)) {
    if (!knobs.has(m[1])) knobs.set(m[1], Number(m[2]));
  }
  const resolve = (v: string): string | null => {
    let out = v;
    let unknown = false;
    out = out.replace(/var\((--[a-z-]+)\)/g, (_, n: string) => {
      const k = knobs.get(n);
      if (k === undefined) unknown = true;
      return k === undefined ? _ : String(k);
    });
    if (unknown) return null;
    out = out.replace(/calc\(\s*([\d.]+)\s*([-+])\s*([\d.]+)\s*\)/g, (_, a: string, op: string, b: string) =>
      String(Math.round((Number(a) + (op === "+" ? 1 : -1) * Number(b)) * 1e4) / 1e4),
    );
    return normalizeColor(out);
  };
  const byValue = new Map<string, string[]>();
  for (const m of root.matchAll(/(--[a-z0-9-]+)\s*:\s*(oklch\([^;]*?\))\s*;/g)) {
    const value = resolve(m[2]);
    if (value === null) continue;
    byValue.set(value, [...(byValue.get(value) ?? []), m[1]]);
  }
  const map = new Map<string, string>();
  for (const [value, names] of byValue) if (names.length === 1) map.set(value, names[0]);
  return map;
}

/** A colour as OKLab coordinates (L in 0..1), where straight-line distance tracks how different two colours look. */
export interface Lab {
  L: number;
  a: number;
  b: number;
}

/** `oklch(L C h)` or `oklch(L C h / α)` with plain numbers, split into OKLab and the alpha text. Anything with var(), calc() or `none` is null. */
export function parseOklch(s: string): { lab: Lab; alpha: string | null } | null {
  const m = /^oklch\(\s*([\d.]+)(%?)\s+([\d.]+)\s+([\d.]+)(?:deg)?\s*(?:\/\s*([\d.]+%?)\s*)?\)$/.exec(s.trim());
  if (!m) return null;
  const L = m[2] ? Number(m[1]) / 100 : Number(m[1]);
  const C = Number(m[3]);
  const h = (Number(m[4]) * Math.PI) / 180;
  return { lab: { L, a: C * Math.cos(h), b: C * Math.sin(h) }, alpha: m[5] ?? null };
}

/** ΔE in OKLab. CSS Color 4 puts the just-noticeable difference near 0.02. */
export const deltaEOK = (x: Lab, y: Lab): number => Math.hypot(x.L - y.L, x.a - y.a, x.b - y.b);

/**
 * Below this distance a literal is a token retyped at a different rounding.
 * Measured 2026-10-06 across src/styles + src/pages: every hit under 0.004 was
 * one, from four-decimal retypes (`--rule` as `86.67% 0.0294 259.59` where the
 * knob resolves 259, dE 0.0003) to whole-digit ones (`--danger-deep` as
 * `46% 0.19 25`, dE 0.0034). From 0.005 the hits mix rounding with intent
 * (`--blue-60` at chroma 0.22, but also `--paper` with its warmth dropped), so
 * that band is a person's call and `bun run colors:drift` lists it instead.
 * Text equality missed every one of these, which is why this compares distance.
 */
export const COPY_DE = 0.004;

export interface TokenCopy {
  literal: string;
  token: string;
  index: number;
  /** 0 for a textual copy; otherwise how far the literal sits from the token. */
  dE: number;
  /** What to write instead: `var(--t)`, or the relative-colour form when the literal carries an alpha. */
  fix: string;
}

/**
 * Every oklch() literal in `css` that is one token's value, with where it sits.
 * Three spellings count: the token's resolved text, the same with an alpha
 * (`--frame / .3`, written as `oklch(from var(--frame) l c h / .3)`), and a
 * literal within COPY_DE of exactly one token. A literal that close to two
 * tokens names neither, for the same reason an ambiguous value never does.
 */
export function tokenCopiesIn(css: string, map: Map<string, string>): TokenCopy[] {
  const labs: [string, Lab][] = [];
  for (const [value, token] of map) {
    const p = parseOklch(value);
    if (p) labs.push([token, p.lab]);
  }
  const out: TokenCopy[] = [];
  for (const m of css.matchAll(OKLCH)) {
    // An SVG presentation attribute (counter.ts paints its badge with fill="oklch(...)")
    // cannot take var(), and that badge is served alone where no token resolves.
    if (/\b[a-z-]+=["']$/.test(css.slice(Math.max(0, m.index - 24), m.index))) continue;
    const parsed = parseOklch(m[0]);
    const opaque = normalizeColor(m[0].replace(/\s*\/\s*[\d.]+%?\s*\)$/, ")"));
    let token = map.get(opaque);
    let dE = 0;
    if (!token && parsed) {
      const near = labs.map(([t, lab]) => [t, deltaEOK(parsed.lab, lab)] as const).filter(([, d]) => d < COPY_DE);
      if (near.length === 1) [token, dE] = near[0];
    }
    if (!token) continue;
    const fix = parsed?.alpha ? `oklch(from var(${token}) l c h / ${parsed.alpha})` : `var(${token})`;
    out.push({ literal: m[0], token, index: m.index, dE: Math.round(dE * 1e4) / 1e4, fix });
  }
  return out;
}

/** A document's `<style>` blocks, which is the only place a page's CSS lives. */
const STYLE_BLOCK = /<style[^>]*>([\s\S]*?)<\/style>/g;

export function loadTokenValueMap(root: URL): Map<string, string> {
  return tokenValueMap(readFileSync(new URL("design/tokens/colors.css", root), "utf8"));
}

/** The one page that does not link luna.css, so a var() there would resolve to nothing. */
export const NO_LUNA = new Set(["garage/vt-b.html"]);

export interface CssSource {
  file: string;
  css: string;
  kind: "page" | "generator" | "spec" | "worker" | "stylesheet";
  /** Where `css` starts in `file`, for line numbers. Null for a spec, whose CSS is a JSON string. */
  offset: number | null;
}

/**
 * Every place served CSS is authored where luna.css's tokens resolve. The
 * contract holds these at zero copies and `colors:drift` reports on the same
 * set, so the two can never disagree about what was looked at.
 */
export function cssSources(root: URL): CssSource[] {
  const read = (rel: string) => readFileSync(new URL(rel, root), "utf8");
  const ls = (rel: string, recursive = false) => readdirSync(new URL(rel, root), { recursive }) as string[];
  const out: CssSource[] = [];
  for (const rel of ls("src/pages", true).filter((f) => f.endsWith(".html"))) {
    if (NO_LUNA.has(rel)) continue;
    for (const m of read(`src/pages/${rel}`).matchAll(STYLE_BLOCK)) {
      out.push({ file: `src/pages/${rel}`, css: m[1], kind: "page", offset: m.index + m[0].indexOf(">") + 1 });
    }
  }
  // The generators author INTO src/pages, so a copy there is a copy on the next
  // page anyone generates. The first sweep missed the garage one because it
  // spells the stops `.15` rather than `0.15`, which normalizeColor now folds.
  for (const rel of ["pipelines/lwe/generate.mjs", "pipelines/garage/generate.mjs"]) out.push({ file: rel, css: read(rel), kind: "generator", offset: 0 });
  for (const family of ["lwe", "garage"]) {
    for (const f of ls(`pipelines/${family}/specs`).filter((f) => f.endsWith(".json"))) {
      const spec = JSON.parse(read(`pipelines/${family}/specs/${f}`)) as { pageCss?: string };
      out.push({ file: `pipelines/${family}/specs/${f}`, css: spec.pageCss ?? "", kind: "spec", offset: null });
    }
  }
  // Worker-rendered pages: every one goes through lunaPage, which links
  // luna.css, and cal links it by absolute URL, so the tokens resolve there
  // too. 63 copies sat in these template strings on 2026-09-15 (around.ts 19,
  // whoareyou.ts 15, reading.ts 9, bot.ts 8, ...), each read by hand before
  // the swap because a TS file holds CSS beside things that are not CSS.
  for (const dir of ["src/worker", "cal/src", "serendipity"]) {
    for (const f of ls(dir, true)) {
      if (/\.(ts|js)$/.test(f) && !/(^|\/)test\//.test(f) && !f.endsWith(".d.ts")) out.push({ file: `${dir}/${f}`, css: read(`${dir}/${f}`), kind: "worker", offset: 0 });
    }
  }
  // luna.css after its verbatim token blocks: the definitions themselves are literals by nature.
  const luna = read("src/styles/luna.css");
  const typo = read("design/tokens/typography.css").trim();
  const body = luna.indexOf(typo) + typo.length;
  out.push({ file: "src/styles/luna.css", css: luna.slice(body), kind: "stylesheet", offset: body });
  // The other root stylesheets. nav-run, nav-tray and infotip are injected by
  // nav.js on first interaction, and lwe-base and prose are linked beside
  // luna.css, so each one loads where the tokens already resolve. Until
  // 2026-10-06 only luna.css was walked, and five of these held 14 copies.
  for (const f of ls("src/styles").filter((f) => f.endsWith(".css") && f !== "luna.css")) {
    out.push({ file: `src/styles/${f}`, css: read(`src/styles/${f}`), kind: "stylesheet", offset: 0 });
  }
  return out;
}
