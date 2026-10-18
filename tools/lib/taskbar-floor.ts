// taskbar-floor.ts: the body floor a document sets above the taskbar, reduced
// to one canonical sum so differently spelled copies can be compared.
//
// luna.css owns the floor, and two documents keep their own copy because they
// paint before luna lands: the homepage and cal's templates (build.ts step 5).
// The copies are spelled differently on purpose. luna.css and the homepage
// write `calc(100dvh - var(--taskbar-h))` with the token defined beside it,
// while cal writes the arithmetic out, `calc(100dvh - 30px -
// env(safe-area-inset-bottom, 0px))`. A regex for one spelling went blind when
// #1369 (2026-10-16) introduced the token, and the check compared nothing
// (gotcha 80). So this resolves `var()` through the document's own custom
// properties and flattens the result to signed terms, where every correct
// spelling reads `100dvh - 30px - env(safe-area-inset-bottom,0px)`.

/** Every distinct body floor in `src`, canonicalized. Empty when there is none. */
export function taskbarFloors(src: string): string[] {
  const text = src.replace(/\/\*[\s\S]*?\*\//g, "");
  const defs = customProperties(text);
  const found = new Set<string>();
  // `height:` alone: a `min-height`/`max-height` calc is a window cap, not the floor.
  for (const m of text.matchAll(/(?<![\w-])height\s*:\s*calc\(\s*100dvh\b/g)) {
    const start = m.index + m[0].lastIndexOf("calc(");
    found.add(canonical(expandVars(balanced(text, start), defs)));
  }
  return [...found];
}

// `--name: value` declarations. A property set to two different values can't
// be resolved without knowing the cascade, so it resolves to nothing and the
// floor keeps its var(), which then disagrees with every other copy by name.
function customProperties(text: string): Map<string, string> {
  const seen = new Map<string, Set<string>>();
  for (const m of text.matchAll(/(?<![\w-])(--[\w-]+)\s*:\s*([^;{}]+)/g)) {
    const values = seen.get(m[1]) ?? new Set();
    values.add(m[2].trim());
    seen.set(m[1], values);
  }
  const defs = new Map<string, string>();
  for (const [name, values] of seen) if (values.size === 1) defs.set(name, [...values][0]);
  return defs;
}

// The substring from `open` (the start of a function name) through its matching `)`.
function balanced(text: string, open: number): string {
  let depth = 0;
  for (let i = text.indexOf("(", open); i < text.length; i++) {
    if (text[i] === "(") depth++;
    else if (text[i] === ")" && --depth === 0) return text.slice(open, i + 1);
  }
  throw new Error(`taskbar-floor: unbalanced parentheses after offset ${open}`);
}

function expandVars(expr: string, defs: Map<string, string>, depth = 0): string {
  if (depth > 8) throw new Error(`taskbar-floor: var() nests past 8 levels in ${expr}`);
  let out = "";
  let i = 0;
  for (let at = expr.indexOf("var(", i); at !== -1; at = expr.indexOf("var(", i)) {
    const call = balanced(expr, at);
    const name = call.slice(4, -1).split(",")[0].trim();
    const value = defs.get(name);
    out += expr.slice(i, at) + (value === undefined ? call : `(${expandVars(value, defs, depth + 1)})`);
    i = at + call.length;
  }
  return out + expr.slice(i);
}

// Flatten a calc() sum: nested calc() and parentheses distribute their sign,
// px terms add up, and the remaining terms are compacted and sorted, so
// `calc(100dvh - (30px + env(x, 0px)))` and `calc(100dvh - 30px - env(x,0px))`
// both read `100dvh - 30px - env(x,0px)`.
function canonical(expr: string): string {
  const terms: Array<[1 | -1, string]> = [];
  collect(expr, 1, terms);
  let px = 0;
  const rest: string[] = [];
  for (const [sign, term] of terms) {
    const n = term.match(/^(-?\d*\.?\d+)px$/);
    if (n) px += sign * Number(n[1]);
    else rest.push(`${sign < 0 ? "-" : "+"} ${term}`);
  }
  if (px) rest.push(`${px < 0 ? "-" : "+"} ${Math.abs(px)}px`);
  rest.sort((a, b) => (a.startsWith("+") === b.startsWith("+") ? a.slice(2).localeCompare(b.slice(2)) : a.startsWith("+") ? -1 : 1));
  return rest.join(" ").replace(/^\+ /, "");
}

function collect(expr: string, sign: 1 | -1, out: Array<[1 | -1, string]>): void {
  let s = expr.trim();
  const inner = s.match(/^calc\(([\s\S]*)\)$/) ?? (s.startsWith("(") && balanced(s, 0) === s ? [s, s.slice(1, -1)] : null);
  if (inner) s = inner[1].trim();
  // Split on a top-level `+` or `-` that has whitespace on both sides, which is
  // the only way calc() can spell an operator (a bare `-` is part of a name).
  const parts: Array<[1 | -1, string]> = [];
  let depth = 0, from = 0, next: 1 | -1 = 1;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (depth === 0 && (c === "+" || c === "-") && /\s/.test(s[i - 1] ?? "") && /\s/.test(s[i + 1] ?? "")) {
      parts.push([next, s.slice(from, i)]);
      next = c === "+" ? 1 : -1;
      from = i + 1;
    }
  }
  parts.push([next, s.slice(from)]);
  if (parts.length === 1 && !inner) {
    out.push([sign, s.replace(/\s+/g, "").toLowerCase()]);
    return;
  }
  for (const [partSign, part] of parts) collect(part, (sign * partSign) as 1 | -1, out);
}
