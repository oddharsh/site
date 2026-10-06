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

/** sRGB 0-255 to OKLab, by Björn Ottosson's published matrices. */
export function srgbToOklab(r: number, g: number, b: number): Lab {
  const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const [R, G, B] = [r, g, b].map((v) => lin(v / 255));
  const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
  const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
  const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
  return {
    L: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    a: 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    b: 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  };
}

/** `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`, `rgb()` or `rgba()` as OKLab plus alpha text. Null for anything else. */
export function parseSrgb(s: string): { lab: Lab; alpha: string | null } | null {
  const hex = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(s);
  if (hex) {
    const h = hex[1].length <= 4 ? hex[1].replace(/./g, "$&$&") : hex[1];
    const n = (i: number) => parseInt(h.slice(i, i + 2), 16);
    return { lab: srgbToOklab(n(0), n(2), n(4)), alpha: h.length === 8 ? String(Math.round((n(6) / 255) * 100) / 100) : null };
  }
  const rgb = /^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/i.exec(s);
  if (rgb) return { lab: srgbToOklab(+rgb[1], +rgb[2], +rgb[3]), alpha: rgb[4] ?? null };
  return null;
}

/**
 * True when the colour at `index` sits in a declaration value, so `#fab` in a
 * selector or a URL fragment is never read as a colour: the nearest `{`, `;`
 * or `}` behind it must be followed by a `:` before the colour.
 */
function inDeclaration(css: string, index: number): boolean {
  // Inside a /* comment */ is prose, even when the prose has a colon in it
  // (access's note on why its greys moved names two of them by hex).
  if (css.lastIndexOf("/*", index) > css.lastIndexOf("*/", index)) return false;
  const start = Math.max(css.lastIndexOf("{", index), css.lastIndexOf(";", index), css.lastIndexOf("}", index), css.lastIndexOf('"', index));
  return css.slice(start + 1, index).includes(":");
}

/** oklch(), and the sRGB spellings the site also writes: hex and rgb()/rgba(). */
const COLOR = /oklch\([^()]*\)|(?<![\w&#-])#[0-9a-fA-F]{3,8}(?![\w-])|rgba?\([^()]*\)/g;

/**
 * Every colour literal in `css` that is one token's value, with where it sits.
 * Three spellings count: the token's resolved text, the same with an alpha
 * (`--frame / .3`, written as `oklch(from var(--frame) l c h / .3)`), and a
 * literal within COPY_DE of exactly one token. A literal that close to two
 * tokens names neither, for the same reason an ambiguous value never does.
 * Hex and rgb() are compared by distance alone, since they never share text
 * with an oklch() token; that is how 87 of them hid until 2026-10-06.
 */
export interface ColorLiteral {
  literal: string;
  index: number;
  lab: Lab;
  alpha: string | null;
}

/**
 * Every colour literal in `css` that a stylesheet would paint: oklch(), hex and
 * rgb(). Skipped: SVG presentation attributes (counter.ts paints its badge with
 * fill="oklch(...)", which cannot take var() and is served alone where no
 * token resolves), and for the sRGB spellings anything outside a declaration
 * value, so an id selector or a hex in a comment is never a colour.
 */
export function colorLiteralsIn(css: string): ColorLiteral[] {
  const out: ColorLiteral[] = [];
  for (const m of css.matchAll(COLOR)) {
    if (/\b[a-z-]+=["']$/.test(css.slice(Math.max(0, m.index - 24), m.index))) continue;
    const isOklch = m[0].startsWith("oklch(");
    if (!isOklch && !inDeclaration(css, m.index)) continue;
    // A var() fallback is where a literal belongs: it paints when the token is
    // not defined yet (the homepage's client edge, before luna.css lands).
    if (/var\(\s*--[\w-]+\s*,[^()]*$/.test(css.slice(Math.max(0, m.index - 80), m.index))) continue;
    const parsed = isOklch ? parseOklch(m[0]) : parseSrgb(m[0]);
    if (parsed) out.push({ literal: m[0], index: m.index, lab: parsed.lab, alpha: parsed.alpha });
  }
  return out;
}

export function tokenCopiesIn(css: string, map: Map<string, string>): TokenCopy[] {
  const labs: [string, Lab][] = [];
  for (const [value, token] of map) {
    const p = parseOklch(value);
    if (p) labs.push([token, p.lab]);
  }
  const out: TokenCopy[] = [];
  for (const parsed of colorLiteralsIn(css)) {
    const m = { 0: parsed.literal, index: parsed.index };
    const opaque = m[0].startsWith("oklch(") ? normalizeColor(m[0].replace(/\s*\/\s*[\d.]+%?\s*\)$/, ")")) : "";
    let token = opaque ? map.get(opaque) : undefined;
    let dE = 0;
    if (!token) {
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

/**
 * Worker sources whose HTML is EMAIL, not a page. No mail client loads
 * luna.css and many ignore var() outright, so a token there paints nothing.
 * Until 2026-10-06 the walk below read these as page CSS, and #1183 swept
 * four #888s in the booking mail and four greys in the webmention moderation
 * mail into var(--ink-faint) and var(--ink-quiet). Their colours stay literal.
 */
export const EMAIL_TEMPLATES = new Set(["cal/src/email.ts", "src/worker/webmention.ts"]);

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
      // Garage specs carry their CSS as `pageCss`, lwe specs as `demoCss`. Until
      // 2026-10-06 only the first was read, so no lwe demo was ever checked.
      const spec = JSON.parse(read(`pipelines/${family}/specs/${f}`)) as { pageCss?: string; demoCss?: string };
      for (const css of [spec.pageCss, spec.demoCss]) {
        if (css) out.push({ file: `pipelines/${family}/specs/${f}`, css, kind: "spec", offset: null });
      }
    }
  }
  // Worker-rendered pages: every one goes through lunaPage, which links
  // luna.css, and cal links it by absolute URL, so the tokens resolve there
  // too. 63 copies sat in these template strings on 2026-09-15 (around.ts 19,
  // whoareyou.ts 15, reading.ts 9, bot.ts 8, ...), each read by hand before
  // the swap because a TS file holds CSS beside things that are not CSS.
  for (const dir of ["src/worker", "cal/src", "serendipity"]) {
    for (const f of ls(dir, true)) {
      if (/\.(ts|js)$/.test(f) && !/(^|\/)test\//.test(f) && !f.endsWith(".d.ts") && !EMAIL_TEMPLATES.has(`${dir}/${f}`)) out.push({ file: `${dir}/${f}`, css: read(`${dir}/${f}`), kind: "worker", offset: 0 });
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
