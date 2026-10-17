// Which font sizes and families in served CSS are written by hand instead of
// naming a typography token (design/tokens/typography.css).
//
// Measured 2026-10-06: 1,072 font sizes in 70 distinct values, 534 of them a
// token's exact value and not one read through var() except 23; a fractional
// tail (8.6pt, 8.4pt, 8.8pt, 8.2pt, 7.8pt) that was drift, not design; and 55
// family stacks spelled out by hand, 31 of them `"Courier New",monospace`, the
// mono token with its fallbacks dropped.
//
// The rule this module answers: a pt size up to 14pt names a token, and a
// family names a token (a var() with a fallback list is fine, since the lazy
// stylesheets load before luna.css can). px is for pixel-exact chrome and SVG
// text, em/rem/% are relative, anything over 14pt is display type. A rule whose
// type IS the exhibit says `@type demo` inside it.

/** font-size and the font shorthand. Custom properties are not declarations. Stops at `;`, a brace, or a tag. */
const DECL = /(?<![\w-])(font-size|font-family|font)\s*:\s*([^;{}<>`\n]+)/g;
/** A size token in a value: `9pt`, `8.5pt/1.3`. Group 1 is the number, group 2 the unit. */
const SIZE = /(?<![\w.#-])(\d*\.?\d+)(pt|px|em|rem|%)(?:\s*\/\s*[\d.]+[a-z%]*)?(?![\w-])/;
/** Display type starts above the largest heading token. */
export const DISPLAY_PT = 14;

export interface TypeFinding {
  /** Where the declaration starts in the scanned text. */
  index: number;
  prop: string;
  value: string;
  kind: "size" | "family";
  literal: string;
}

/** The declaration value, minus the attribute quote an inline `style="..."` leaves on the end. */
function cleanValue(v: string): string {
  let out = v.trim();
  const quotes = (out.match(/"/g) ?? []).length;
  if (quotes % 2 === 1 && out.endsWith('"')) out = out.slice(0, -1).trim();
  return out.replace(/\s*!important$/, "");
}

/** The family part of a value once every var(--font-*) (fallbacks included) is gone. Empty means tokenised. */
function literalFamily(family: string): string {
  return family.replace(/var\(--[a-z-]+(?:\s*,(?:[^()]|\([^()]*\))*)?\)/g, "").replace(/^[\s,]+|[\s,]+$/g, "");
}

export function typeFindings(css: string): TypeFinding[] {
  const out: TypeFinding[] = [];
  for (const m of css.matchAll(DECL)) {
    const prop = m[1];
    const value = cleanValue(m[2]);
    if (!value || /^(inherit|initial|unset|revert)$/.test(value)) continue;
    const open = css.lastIndexOf("{", m.index);
    const close = css.indexOf("}", m.index);
    if (css.slice(open + 1, close === -1 ? undefined : close).includes("@type demo")) continue;
    if (prop === "font-family") {
      const lit = literalFamily(value);
      if (lit && !/^(inherit|initial|unset)$/.test(lit)) out.push({ index: m.index, prop, value, kind: "family", literal: lit });
      continue;
    }
    const size = SIZE.exec(value);
    if (size && size[2] === "pt" && Number(size[1]) <= DISPLAY_PT) out.push({ index: m.index, prop, value, kind: "size", literal: `${size[1]}pt` });
    if (prop === "font" && size) {
      const lit = literalFamily(value.slice(size.index + size[0].length));
      if (lit) out.push({ index: m.index, prop, value, kind: "family", literal: lit });
    }
  }
  return out;
}
