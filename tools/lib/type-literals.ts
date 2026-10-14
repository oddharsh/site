// Which font sizes and families in served CSS are written by hand instead of
// naming a typography token (design/tokens/typography.css).

const DECL = /(?<![\w-])(font-size|font-family|font)\s*:\s*([^;{}<>`\n]+)/g;
const SIZE = /(?<![\w.#-])(\d*\.?\d+)(pt|px|em|rem|%)(?:\s*\/\s*[\d.]+[a-z%]*)?(?![\w-])/;
export const DISPLAY_PT = 14;

export interface TypeFinding {
  index: number;
  prop: string;
  value: string;
  kind: "size" | "family";
  literal: string;
}

function cleanValue(v: string): string {
  let out = v.trim();
  const quotes = (out.match(/"/g) ?? []).length;
  if (quotes % 2 === 1 && out.endsWith('"')) out = out.slice(0, -1).trim();
  return out.replace(/\s*!important$/, "");
}

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
