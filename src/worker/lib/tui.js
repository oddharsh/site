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

// ── palette (retired) ─────────────────────────────────────────────────────
// There is no palette here any more, and the constraint that governed it is
// worth keeping because it governs any future one. MID-TONES ONLY: a terminal
// theme belongs to the visitor, so a near-white foreground vanishes on a light
// profile and a near-black one vanishes on a dark profile, and a TUI unreadable
// on half of all terminals is a TUI that does not work.
//
// The one painted region was the title bar, since a blue bar with white text is
// the Luna signature and sets its own background. emit() stopped turning styles
// into escapes on 2026-08-06, when the window chrome came off for being a
// Windows window drawn in ASCII inside a real one. That left the SGR table and
// titleBarLine unreferenced for eight days; oxlint reported both and they were
// deleted 2026-08-14.
//
// Spans still carry a style NAME, which is exactly what let the 2026-08-06 strip
// land without touching a single caller. So colour comes back by teaching emit()
// to map those names, never by reviving a constant next to a renderer that
// ignores it.

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
export function emit(lines) {
  // Plain text, always. This used to paint xterm-256 escapes and the frames
  // drew a window border and [_][#][X] controls around them — an emulated
  // Windows window, rendered in ASCII, inside a real one that already had those
  // buttons. Stripped 2026-08-06: a tool's output should read like a tool's
  // output, and the audience for a .txt route is curl and a model, neither of
  // which wanted the chrome.
  //
  // Spans still CARRY their style name so no caller had to change; emit just
  // stops turning it into an escape. Trailing whitespace goes too — it carries
  // no information and is what makes a diff of two frames noisy.
  return lines.map((spans) => spans.map(([t]) => t).join("").replace(/[ \t]+$/, "")).join("\n");
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
 * The window. An outer double-line frame with a painted Luna title bar, a body,
 * and a status bar — the four regions every frame in this system has.
 *
 * `body` is an array of span-lines, already sized to the INNER width
 * (w - 4: two border columns plus one space of padding on each side).
 */
export function plainFrame({ title, body, status }) {
  // A title, a blank line, and indented content. No border, because the border
  // was drawing a window inside a window.
  const out = [];
  if (title) { out.push([s(title, "strong")]); out.push([s("")]); }
  for (const spans of rows(...body)) out.push([s("  "), ...spans]);
  if (status !== undefined) {
    out.push([s("")]);
    for (const spans of rows(status)) out.push([s("  "), ...spans]);
  }
  return out;
}

/** A nested single-line pane inside the window body. `body` sized to w - 4. */
export function pane({ title, body, width: w = COLS }) {
  const out = [];
  if (title) out.push(rule(w - 4, title));
  for (const spans of rows(...body)) out.push(spans);
  return out;
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
