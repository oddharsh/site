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
import { readFileSync } from "node:fs";

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

export interface TokenCopy {
  literal: string;
  token: string;
  index: number;
}

/** Every oklch() literal in `css` that is one token's value, with where it sits. */
export function tokenCopiesIn(css: string, map: Map<string, string>): TokenCopy[] {
  const out: TokenCopy[] = [];
  for (const m of css.matchAll(OKLCH)) {
    const token = map.get(normalizeColor(m[0]));
    if (token) out.push({ literal: m[0], token, index: m.index });
  }
  return out;
}

/** The `<style>` blocks of a document, which is the only place a page's CSS lives. */
export function styleBlocksOf(html: string): string[] {
  return [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]);
}

export function loadTokenValueMap(root: URL): Map<string, string> {
  return tokenValueMap(readFileSync(new URL("design/tokens/colors.css", root), "utf8"));
}
