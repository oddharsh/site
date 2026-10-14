export const COLS = 80;

export const SPARK = "▁▂▃▄▅▆▇█";

export type SpanStyle = "accent" | "bad" | "dim" | "key" | "label" | "ok" | "strong" | "warn";

export type Span = [string, SpanStyle | null];

export type Line = Span[];

export const s = (text, style: SpanStyle | null = null): Span =>
  [text === null || text === undefined ? "" : String(text), style];

const NEVER_COMBINES = /^[ -\u02ff\u2013\u2014\u2018-\u201f\u2022\u2026\u2190-\u2bff]*$/;
let segmenter: Intl.Segmenter | undefined;
const graphemes = (text: string) =>
  NEVER_COMBINES.test(text)
    ? text.split("")
    : Array.from((segmenter ??= new Intl.Segmenter()).segment(text), (g) => g.segment);

export const width = (spans) => spans.reduce((n, [t]) => n + graphemes(t).length, 0);

export function truncTo(spans, w) {
  if (w <= 0) return [];
  if (width(spans) <= w) return spans;
  const out: Line = [];
  let left = w - 1;
  for (const [text, style] of spans) {
    const chars = graphemes(text);
    if (chars.length <= left) { out.push([text, style]); left -= chars.length; continue; }
    if (left > 0) out.push([chars.slice(0, left).join(""), style]);
    break;
  }
  out.push(["…", "dim"]);
  return out;
}

export const padTo = (spans, w) => {
  const gap = w - width(spans);
  return gap > 0 ? [...spans, [" ".repeat(gap), null]] : spans;
};

export const fit = (spans, w) => padTo(truncTo(spans, w), w);

export const rightTo = (spans, w) => {
  const gap = w - width(spans);
  return gap > 0 ? [[" ".repeat(gap), null], ...spans] : truncTo(spans, w);
};

export function ends(left, right, w) {
  const l = truncTo(left, Math.max(0, w - width(right) - 1));
  return [...l, [" ".repeat(Math.max(1, w - width(l) - width(right))), null], ...right];
}

export function emit(lines) {
  return lines.map((spans) => spans.map(([t]) => t).join("").replace(/[ \t]+$/, "")).join("\n");
}

export const rows = (...items) =>
  items.flatMap((item) => (Array.isArray(item?.[0]?.[0]) ? item : [item]));

const G = {
  tl: "┌", tr: "┐", bl: "└", br: "┘", h: "─", v: "│",
  lt: "├", rt: "┤", tt: "┬", bt: "┴", x: "┼",
  dtl: "╔", dtr: "╗", dbl: "╚", dbr: "╝", dh: "═", dv: "║",
  slt: "╟", srt: "╢",
};

export function wrap(text, w) {
  const words = String(text ?? "").replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  if (!words.length) return [];
  const out: string[] = [];
  let cur = "";
  for (const word of words) {
    if (!cur) { cur = word; continue; }
    if (graphemes(cur).length + 1 + graphemes(word).length <= w) { cur += " " + word; continue; }
    out.push(cur);
    cur = word;
  }
  if (cur) out.push(cur);
  return out.flatMap((row) => {
    const chars = graphemes(row);
    if (chars.length <= w) return [row];
    const parts: string[] = [];
    for (let i = 0; i < chars.length; i += w) parts.push(chars.slice(i, i + w).join(""));
    return parts;
  });
}

export function rule(w, label = "") {
  if (!label) return [s(G.h.repeat(w), "border")];
  const text = ` ${label} `;
  const lead = 2;
  const tail = Math.max(0, w - lead - graphemes(text).length);
  return [s(G.h.repeat(lead), "border"), s(text, "label"), s(G.h.repeat(tail), "border")];
}

export function kv(label, value, w, opts: { gutter?: number; style?: string | null } = {}) {
  const lab = String(label);
  const gutter = opts.gutter ?? 18;
  const valSpans = Array.isArray(value) ? value : [s(value ?? "—", value == null ? "dim" : opts.style || null)];
  const head = fit([s(lab, "label")], Math.min(gutter, w));
  return [...head, ...truncTo(valSpans, Math.max(0, w - gutter))];
}

export function meter(label, value, max, w, opts: { labelWidth?: number; labelStyle?: string | null } = {}) {
  const labW = opts.labelWidth ?? 20;
  const numW = String(max).length;
  const barW = Math.max(4, w - labW - numW - 1);
  const filled = max > 0 ? Math.round((value / max) * barW) : 0;
  return [
    ...fit([s(label, opts.labelStyle || null)], labW),
    s("▇".repeat(filled), "accent"),
    s("▁".repeat(Math.max(0, barW - filled)), "dim"),
    s(" ", null),
    ...rightTo([s(String(value))], numW),
  ];
}

export function table({ cols, rows, width: w = COLS, header = true }) {
  const fixed = cols.reduce((n, c) => n + (c.width || 0), 0);
  const flexCount = cols.filter((c) => !c.width).length;
  const gaps = cols.length - 1;
  const flexW = flexCount ? Math.max(6, Math.floor((w - fixed - gaps) / flexCount)) : 0;
  const widths = cols.map((c) => c.width || flexW);

  const layRow = (cells, style?) => {
    const out = [];
    cells.forEach((cell, i) => {
      const spans = Array.isArray(cell) && Array.isArray(cell[0]) ? cell
        : Array.isArray(cell) ? [cell]
        : [s(cell ?? "", style)];
      const cw = widths[i];
      out.push(...(cols[i].align === "right" ? rightTo(truncTo(spans, cw), cw) : fit(spans, cw)));
      if (i < cols.length - 1) out.push(s(" "));
    });
    return out;
  };

  const lines: Line[] = [];
  if (header) {
    lines.push(layRow(cols.map((c) => c.title || ""), "label"));
    lines.push([s(widths.map((n) => G.h.repeat(n)).join(" "), "border")]);
  }
  for (const row of rows) lines.push(layRow(row));
  return lines;
}

export function plainFrame({ title, body, status }) {
  const out = [];
  if (title) { out.push([s(title, "strong")]); out.push([s("")]); }
  for (const spans of rows(...body)) out.push([s("  "), ...spans]);
  if (status !== undefined) {
    out.push([s("")]);
    for (const spans of rows(status)) out.push([s("  "), ...spans]);
  }
  return out;
}

export function pane({ title, body, width: w = COLS }) {
  const out = [];
  if (title) out.push(rule(w - 4, title));
  for (const spans of rows(...body)) out.push(spans);
  return out;
}

export function keys(pairs) {
  const out = [];
  pairs.forEach(([key, label], i) => {
    if (i) out.push(s("  "));
    out.push(s(key, "key"), s(" " + label));
  });
  return out;
}

export const blank = () => [s("")];
