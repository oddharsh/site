// tui.js — the frame renderer behind /terminal/*. Box-drawing, ANSI SGR, and the
// width math that keeps an 80-column frame actually 80 columns wide.
//
// The whole module is pure: frames in, string out. No env, no fetch, no state.
// That is what lets the same renderer answer an HTTP GET, an MCP tools/call, and
// a contract test without three code paths.
//
// ── why spans instead of pre-escaped strings ──────────────────────────────
// A line is an array of [text, style] SPANS rather than a string with escapes
// already baked in. Once you concatenate "\x1b[1m" into a string you can no
// longer measure it: `"\x1b[1mhi\x1b[0m".length` is 12 for two visible columns,
// so every pad and truncate downstream is wrong. Keeping text and style apart
// means width() counts what a terminal draws, and plain mode is a flag at emit
// time rather than a second renderer.
//
// Width is counted in CODE POINTS, not UTF-16 units, so an emoji or an accented
// stem doesn't over-count. It is still wrong for CJK (double-width) and for
// combining marks; both are absent from the data these frames render (photo
// stems, film simulations, URLs, English prose), and the cost of being wrong is
// a border one column off rather than anything structural. Said plainly here so
// the next person doesn't discover it as a bug.

export const COLS = 80;

// ── palette ───────────────────────────────────────────────────────────────
// MID-TONES ONLY, and that is a hard constraint rather than taste. A terminal
// theme is the user's, not ours: near-white foregrounds vanish on a light
// profile and near-black ones vanish on a dark one, and a TUI that is unreadable
// on half of all terminals is a TUI that doesn't work. Every color here is
// legible against both. Body text carries NO color at all and inherits the
// terminal's own foreground, which is the most theme-safe choice available.
//
// The one painted region is the title bar, because a blue bar with white text IS
// the Luna signature and it sets its own background, so it doesn't depend on the
// terminal's. 256-color codes throughout (\x1b[38;5;Nm); xterm-256 is effectively
// universal, and the 16-color fallback would cost the Luna blue.
const SGR = {
  bar:     "\x1b[1;38;5;255;48;5;25m",   // white bold on Luna blue — the title bar
  barDim:  "\x1b[38;5;153;48;5;25m",     // the bar's secondary text (window controls)
  border:  "\x1b[38;5;66m",              // box drawing
  label:   "\x1b[38;5;66m",              // field names
  key:     "\x1b[1;38;5;136m",           // a hotkey letter in the status bar
  accent:  "\x1b[38;5;25m",              // links, paths, the selected row
  sel:     "\x1b[1;38;5;255;48;5;25m",   // the cursor row, painted like the bar
  ok:      "\x1b[38;5;29m",
  warn:    "\x1b[38;5;136m",
  bad:     "\x1b[38;5;124m",
  dim:     "\x1b[2m",
  strong:  "\x1b[1m",
};
const RESET = "\x1b[0m";

// ── spans ─────────────────────────────────────────────────────────────────
/** One styled run of text. `style` is a key of SGR, or null for terminal default. */
export const s = (text, style = null) => [text === null || text === undefined ? "" : String(text), style];

/** Visible width of a line, in code points. */
export const width = (spans) => spans.reduce((n, [t]) => n + [...t].length, 0);

/** Truncate a line to `w` columns, marking the cut with a single-column ellipsis. */
export function truncTo(spans, w) {
  if (w <= 0) return [];
  if (width(spans) <= w) return spans;
  const out = [];
  let left = w - 1;                       // reserve the ellipsis column
  for (const [text, style] of spans) {
    const chars = [...text];
    if (chars.length <= left) { out.push([text, style]); left -= chars.length; continue; }
    if (left > 0) out.push([chars.slice(0, left).join(""), style]);
    break;
  }
  out.push(["…", "dim"]);
  return out;
}

/** Pad a line out to `w` columns with spaces. */
export const padTo = (spans, w) => {
  const gap = w - width(spans);
  return gap > 0 ? [...spans, [" ".repeat(gap), null]] : spans;
};

/** Truncate then pad: a line that is EXACTLY `w` columns, whatever went in. */
export const fit = (spans, w) => padTo(truncTo(spans, w), w);

/** Right-align a line within `w` columns. */
export const rightTo = (spans, w) => {
  const gap = w - width(spans);
  return gap > 0 ? [[" ".repeat(gap), null], ...spans] : truncTo(spans, w);
};

/** Lay spans out left and right against one `w`-column line. */
export function ends(left, right, w) {
  const l = truncTo(left, Math.max(0, w - width(right) - 1));
  return [...l, [" ".repeat(Math.max(1, w - width(l) - width(right))), null], ...right];
}

// ── emit ──────────────────────────────────────────────────────────────────
// The only place escapes are ever produced. `color: false` drops them entirely,
// which is what MCP and the markdown twin ask for: an escape sequence in a model
// context window is pure noise that the model then has to be robust to.
export function emit(lines, { color = true } = {}) {
  return lines.map((spans) => {
    if (!color) return spans.map(([t]) => t).join("").replace(/[ \t]+$/, "");
    let out = "";
    for (const [text, style] of spans) {
      if (!text) continue;
      const code = style && SGR[style];
      out += code ? code + text + RESET : text;
    }
    // Trailing whitespace is stripped in BOTH modes. It carries no information,
    // it is what makes a diff of two frames noisy, and in color mode a padded
    // run inside a painted region would otherwise leave a colored tail.
    return out.replace(/[ \t]+$/, "");
  }).join("\n");
}

// ── shapes ────────────────────────────────────────────────────────────────
// Two shapes travel through this module and they nest one inside the other, so
// they are easy to confuse: a LINE is an array of spans, a BLOCK is an array of
// lines. kv/meter/rule/keys return a line; table/pane/windowFrame return a
// block. Getting it backwards used to fail deep inside width() with "null is not
// iterable", which names neither the caller nor the mistake.
//
// rows() normalizes a mixed list of both, so a body can be assembled without the
// caller tracking which helper returns which. A line's first element is a span
// ([string, style]); a block's first element is a line, whose first element is
// an array. That one test tells them apart unambiguously.
export const rows = (...items) =>
  items.flatMap((item) => (Array.isArray(item?.[0]?.[0]) ? item : [item]));

// ── glyphs ────────────────────────────────────────────────────────────────
// CP437 box drawing, which is what cmd.exe drew with in the OEM codepage. Single
// line for panes, double for the outer frame, so a nested pane reads as nested.
const G = {
  tl: "┌", tr: "┐", bl: "└", br: "┘", h: "─", v: "│",
  lt: "├", rt: "┤", tt: "┬", bt: "┴", x: "┼",
  dtl: "╔", dtr: "╗", dbl: "╚", dbr: "╝", dh: "═", dv: "║",
  // The single-line separator INSIDE a double-line frame. ╟ and ╢ are the
  // dedicated CP437 joins for exactly this (double vertical meeting single
  // horizontal); ├ and ┤ are single-on-single and leave a visible notch where
  // the rule meets the frame wall.
  slt: "╟", srt: "╢",
};

// ── layout ────────────────────────────────────────────────────────────────

/** Wrap plain text to `w` columns on word boundaries. Returns plain strings. */
export function wrap(text, w) {
  const words = String(text ?? "").replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  if (!words.length) return [];
  const out = [];
  let cur = "";
  for (const word of words) {
    if (!cur) { cur = word; continue; }
    if ([...cur].length + 1 + [...word].length <= w) { cur += " " + word; continue; }
    out.push(cur);
    cur = word;
  }
  if (cur) out.push(cur);
  // A single word longer than the column (a URL, usually) still has to fit.
  return out.flatMap((row) => {
    const chars = [...row];
    if (chars.length <= w) return [row];
    const parts = [];
    for (let i = 0; i < chars.length; i += w) parts.push(chars.slice(i, i + w).join(""));
    return parts;
  });
}

/** A horizontal rule inside a pane, optionally captioned. */
export function rule(w, label = "") {
  if (!label) return [s(G.h.repeat(w), "border")];
  const text = ` ${label} `;
  const lead = 2;
  const tail = Math.max(0, w - lead - [...text].length);
  return [s(G.h.repeat(lead), "border"), s(text, "label"), s(G.h.repeat(tail), "border")];
}

/** `label ....... value`, the field row every pane is mostly made of. */
export function kv(label, value, w, opts = {}) {
  const lab = String(label);
  const gutter = opts.gutter ?? 18;
  const valSpans = Array.isArray(value) ? value : [s(value ?? "—", value == null ? "dim" : opts.style || null)];
  const head = fit([s(lab, "label")], Math.min(gutter, w));
  return [...head, ...truncTo(valSpans, Math.max(0, w - gutter))];
}

/**
 * A meter: `Classic Chrome  ▇▇▇▇▇▇▁▁▁▁  42`. Used for facet counts, where the
 * shape of the distribution is the answer and the exact number is a footnote.
 */
export function meter(label, value, max, w, opts = {}) {
  const labW = opts.labelWidth ?? 20;
  const numW = String(max).length;
  // labW + barW + one space + numW must total exactly w, or the bars in a stack
  // end at a ragged right edge and stop reading as a shared axis.
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

/**
 * A column table. `cols` is [{ title, width, align }]; a null width takes the
 * remaining space (at most one such column). Rows are arrays of span-arrays or
 * plain strings.
 */
export function table({ cols, rows, width: w = COLS, header = true }) {
  const fixed = cols.reduce((n, c) => n + (c.width || 0), 0);
  const flexCount = cols.filter((c) => !c.width).length;
  const gaps = cols.length - 1;
  const flexW = flexCount ? Math.max(6, Math.floor((w - fixed - gaps) / flexCount)) : 0;
  const widths = cols.map((c) => c.width || flexW);

  const layRow = (cells, style) => {
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

  const lines = [];
  if (header) {
    lines.push(layRow(cols.map((c) => c.title || ""), "label"));
    lines.push([s(widths.map((n) => G.h.repeat(n)).join(" "), "border")]);
  }
  for (const row of rows) lines.push(layRow(row));
  return lines;
}

/**
 * The title bar's one line, sized to `w` (the frame's inner width).
 *
 * The gap between the title and the window controls is padded with the BAR
 * style rather than left unstyled. A generic ends() would insert an unpainted
 * run there, and an unpainted run inside a painted region reads on screen as a
 * blue bar with a hole punched through the middle of it.
 */
function titleBarLine(title, right, w) {
  const tail = [s(right + " ", "barDim")];
  const head = truncTo([s(" " + title, "bar")], Math.max(0, w - width(tail) - 1));
  const gap = Math.max(0, w - width(head) - width(tail));
  return [...head, s(" ".repeat(gap), "bar"), ...tail];
}

/**
 * The window. An outer double-line frame with a painted Luna title bar, a body,
 * and a status bar — the four regions every frame in this system has.
 *
 * `body` is an array of span-lines, already sized to the INNER width
 * (w - 4: two border columns plus one space of padding on each side).
 */
export function windowFrame({ title, right = "[_][#][X]", body, status, width: w = COLS }) {
  const inner = w - 4;
  const out = [];
  out.push([s(G.dtl + G.dh.repeat(w - 2) + G.dtr, "border")]);
  out.push([s(G.dv, "border"), ...titleBarLine(title, right, w - 2), s(G.dv, "border")]);
  out.push([s(G.slt + G.h.repeat(w - 2) + G.srt, "border")]);
  for (const spans of rows(...body)) {
    out.push([s(G.dv, "border"), s(" "), ...fit(spans, inner), s(" "), s(G.dv, "border")]);
  }
  if (status !== undefined) {
    out.push([s(G.slt + G.h.repeat(w - 2) + G.srt, "border")]);
    for (const spans of rows(status)) {
      out.push([s(G.dv, "border"), s(" "), ...fit(spans, inner), s(" "), s(G.dv, "border")]);
    }
  }
  out.push([s(G.dbl + G.dh.repeat(w - 2) + G.dbr, "border")]);
  return out;
}

/** A nested single-line pane inside the window body. `body` sized to w - 4. */
export function pane({ title, body, width: w }) {
  const inner = w - 4;
  const head = title
    ? [s(G.tl + G.h + " ", "border"), s(title, "label"), s(" " + G.h.repeat(Math.max(0, w - 5 - [...title].length)) + G.tr, "border")]
    : [s(G.tl + G.h.repeat(w - 2) + G.tr, "border")];
  return [
    head,
    ...rows(...body).map((spans) => [s(G.v, "border"), s(" "), ...fit(spans, inner), s(" "), s(G.v, "border")]),
    [s(G.bl + G.h.repeat(w - 2) + G.br, "border")],
  ];
}

/** The status bar's `KEY label` pairs, laid out as one line. */
export function keys(pairs) {
  const out = [];
  pairs.forEach(([key, label], i) => {
    if (i) out.push(s("  "));
    out.push(s(key, "key"), s(" " + label));
  });
  return out;
}

/** Blank line, sized by the caller's fit(). */
export const blank = () => [s("")];
