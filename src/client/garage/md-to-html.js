// md-to-html.js: the inverse of tools/lib/html-to-md.ts, for /garage/round-trip.
//
// Hand-rolled for the same reason the forward half is. The input is a CLOSED
// language: the Markdown that html-to-md.ts writes, plus the thirteen hand twins
// in src/content/md/. That is ATX headings, paragraphs with hard breaks, `-` and
// `1.` lists (nested by indentation), `>` quotes, ``` fences, `---`, GFM tables,
// and inline code, **strong**, *em*, ~~del~~, [links](…) and ![images](…). A
// CommonMark parser would cover cases nobody here writes and cost a dependency.
//
// The test this file has to pass is a FIXED POINT: for a twin md, running
// html-to-md over mdToHtml(md) must hand back md. Anything that fails it is a
// bug in one direction or the other, which is the point of building it.
//
// Two rules from the forward half carry over unchanged:
//   1. Every character of input is text until a rule says otherwise, and text
//      leaves through esc(). The page renders Markdown it fetched, so this is
//      the only thing between a twin and the DOM.
//   2. A link whose scheme executes (javascript:, data:, vbscript:, read the
//      way a browser reads it) renders as its text and nothing else. An image
//      may load data:image/, since an <img> never runs what it loads.
//
// Two forward marks do NOT invert, and the page says so rather than guessing:
// `^x` (from <sup>) and `_x` (from <sub>) have no closing delimiter, so a caret
// or underscore in prose reads the same. They stay literal text.

const UNSAFE_SCHEME = /^(?:javascript|data|vbscript):/i;
function executes(href) {
  let i = 0;
  while (i < href.length && href.charCodeAt(i) <= 0x20) i++;
  return UNSAFE_SCHEME.test(href.slice(i));
}

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// the punctuation escapeMd() backslashes, plus the table pipe
const ESCAPABLE = new Set("\\`*_[]<>#+-.|!~^".split(""));

// ── inline ──────────────────────────────────────────────────────────────────

/** The run of backticks that starts at s[i]. */
function backtickRun(s, i) {
  let j = i;
  while (s[j] === "`") j++;
  return s.slice(i, j);
}

/** Index of the next unescaped `delim` at or after `from`, skipping code spans. */
function findClose(s, delim, from) {
  for (let i = from; i < s.length; i++) {
    if (s[i] === "\\") { i++; continue; }
    if (s[i] === "`") {
      const run = backtickRun(s, i);
      const end = s.indexOf(run, i + run.length);
      if (end !== -1) { i = end + run.length - 1; continue; }
    }
    if (s.startsWith(delim, i)) {
      // a single `*` must not match half of a `**`
      if (delim === "*" && (s[i + 1] === "*" || s[i - 1] === "*")) continue;
      return i;
    }
  }
  return -1;
}

/** `[text](href)` starting at s[i] === "[": returns { text, href, end } or null. */
function readLink(s, i) {
  let depth = 0, j = i;
  for (; j < s.length; j++) {
    if (s[j] === "\\") { j++; continue; }
    if (s[j] === "[") depth++;
    else if (s[j] === "]" && --depth === 0) break;
  }
  if (j >= s.length || s[j + 1] !== "(") return null;
  let k = j + 2, parens = 1;
  for (; k < s.length; k++) {
    if (s[k] === "(") parens++;
    else if (s[k] === ")" && --parens === 0) break;
  }
  if (k >= s.length) return null;
  return { text: s.slice(i + 1, j), href: s.slice(j + 2, k).trim(), end: k + 1 };
}

export function inline(s) {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "\\" && i + 1 < s.length && ESCAPABLE.has(s[i + 1])) { out += esc(s[++i]); continue; }
    if (c === " " && s.startsWith("  \n", i)) { out += "<br>"; i += 2; continue; }
    if (c === "`") {
      const run = backtickRun(s, i);
      const end = s.indexOf(run, i + run.length);
      if (end !== -1) {
        let code = s.slice(i + run.length, end);
        if (code.length > 1 && code.startsWith(" ") && code.endsWith(" ")) code = code.slice(1, -1);
        out += `<code>${esc(code)}</code>`;
        i = end + run.length - 1;
        continue;
      }
    }
    // `<br>` is the one tag html-to-md writes, for a line break inside a table
    // cell, where Markdown has no other way to say it. Every other `<` it
    // writes is escaped.
    if (s.startsWith("<br>", i)) { out += "<br>"; i += 3; continue; }
    // <https://…>: the hand twins write autolinks; html-to-md never does, since
    // it escapes every `<` in prose
    if (c === "<") {
      const m = /^<([a-z][a-z0-9+.-]*:[^\s<>]*)>/i.exec(s.slice(i));
      if (m) {
        out += executes(m[1]) ? esc(m[1]) : `<a href="${esc(m[1])}">${esc(m[1])}</a>`;
        i += m[0].length - 1;
        continue;
      }
    }
    if (c === "!" && s[i + 1] === "[") {
      const l = readLink(s, i + 1);
      if (l) {
        // An <img> never runs what it loads, so a data: image is a picture here
        // (/garage/horizon draws its quadrant diagram as one). Only data:image/
        // passes; a link keeps the full refusal.
        if (!executes(l.href) || /^data:image\//i.test(l.href.trim())) out += `<img src="${esc(l.href)}" alt="${esc(unescape(l.text))}">`;
        i = l.end - 1;
        continue;
      }
    }
    if (c === "[") {
      const l = readLink(s, i);
      if (l) {
        const text = inline(l.text);
        out += executes(l.href) ? text : `<a href="${esc(l.href)}">${text}</a>`;
        i = l.end - 1;
        continue;
      }
    }
    const span = emphasis(s, i);
    if (span) { out += span.html; i = span.end - 1; continue; }
    out += esc(c);
  }
  return out;
}

// **strong**, ~~del~~ and *em*, longest delimiter first so `**` never reads as
// two empty <em>s. An opener with no closer is literal text.
const EMPHASIS = [["**", "strong"], ["~~", "del"], ["*", "em"]];
function emphasis(s, i) {
  for (const [delim, tag] of EMPHASIS) {
    if (!s.startsWith(delim, i)) continue;
    const end = findClose(s, delim, i + delim.length);
    if (end > i + delim.length) {
      return { html: `<${tag}>${inline(s.slice(i + delim.length, end))}</${tag}>`, end: end + delim.length };
    }
  }
  return null;
}

const unescape = (s) => s.replace(/\\(.)/g, (m, ch) => (ESCAPABLE.has(ch) ? ch : m));

// ── blocks ──────────────────────────────────────────────────────────────────

const LIST_ITEM = /^(\s*)(-|\d+\.) (.*)$/;
const FENCE = /^```/;
const HEADING = /^(#{1,6}) (.*)$/;
const TABLE_SEP = /^\|(?:\s*:?-{3,}:?\s*\|)+\s*$/;

/** Split a GFM row on pipes that are not backslash-escaped. */
function cells(row) {
  const inner = row.trim().replace(/^\|/, "").replace(/\|$/, "");
  const out = [];
  let cur = "";
  for (let i = 0; i < inner.length; i++) {
    if (inner[i] === "\\" && inner[i + 1] === "|") { cur += "|"; i++; continue; }
    if (inner[i] === "|") { out.push(cur.trim()); cur = ""; continue; }
    cur += inner[i];
  }
  out.push(cur.trim());
  return out;
}

function startsBlock(line, next) {
  return FENCE.test(line) || HEADING.test(line) || line === "---" || line.startsWith(">")
    || LIST_ITEM.test(line) || (line.startsWith("|") && next !== undefined && TABLE_SEP.test(next));
}

export function blocks(md) {
  const lines = md.replace(/\r\n?/g, "\n").split("\n");
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }

    if (FENCE.test(line)) {
      const body = [];
      for (i++; i < lines.length && !FENCE.test(lines[i]); i++) body.push(lines[i]);
      i++;
      out.push(`<pre><code>${esc(body.join("\n"))}</code></pre>`);
      continue;
    }
    const h = HEADING.exec(line);
    if (h) { out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`); i++; continue; }
    if (line === "---") { out.push("<hr>"); i++; continue; }

    if (line.startsWith(">")) {
      const body = [];
      for (; i < lines.length && lines[i].startsWith(">"); i++) body.push(lines[i].replace(/^> ?/, ""));
      out.push(`<blockquote>${blocks(body.join("\n"))}</blockquote>`);
      continue;
    }

    if (line.startsWith("|") && TABLE_SEP.test(lines[i + 1] || "")) {
      const head = cells(line);
      const rows = [];
      for (i += 2; i < lines.length && lines[i].startsWith("|"); i++) rows.push(cells(lines[i]));
      // html-to-md writes an all-empty header row for a table that had none
      const thead = head.some(Boolean) ? `<thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join("")}</tr></thead>` : "";
      out.push(`<table>${thead}<tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`).join("")}</tbody></table>`);
      continue;
    }

    const li = LIST_ITEM.exec(line);
    if (li) {
      const indent = li[1].length;
      const ordered = li[2] !== "-";
      const items = [];
      const termRows = [];
      /** @type {{ dt: string, dds: string[] }[]} */
      const dlItems = [];
      while (i < lines.length) {
        const m = LIST_ITEM.exec(lines[i]);
        if (!m || m[1].length !== indent || (m[2] !== "-") === !ordered) break;
        const pad = indent + m[2].length + 1;
        const body = [m[3]];
        // continuation: anything indented past the marker, blank lines included
        // while the item goes on after them
        for (i++; i < lines.length; i++) {
          const l = lines[i];
          if (l.trim() && l.length - l.trimStart().length >= pad) body.push(l.slice(pad));
          else if (!l.trim() && (lines[i + 1] || "").length - (lines[i + 1] || "").trimStart().length >= pad && (lines[i + 1] || "").trim()) body.push("");
          else break;
        }
        const dt = /^\*\*(.*)\*\*$/.exec(body[0]);
        termRows.push(Boolean(dt) && body.slice(1).every((l) => l.trim()));
        dlItems.push({ dt: dt ? dt[1] : "", dds: body.slice(1) });
        const html = blocks(body.join("\n"));
        // a one-paragraph item is a tight item: no <p> around it
        items.push(/^<p>(?:(?!<p>)[\s\S])*<\/p>$/.test(html) ? html.slice(3, -4) : html);
      }
      // html-to-md writes a <dl> as `- **term**` with each <dd> indented under
      // it. Read that exact shape back as a <dl>: as a list it would fuse the
      // term and its definition into one line, and the trip would not close.
      if (!ordered && termRows.length && termRows.every(Boolean)) {
        out.push(`<dl>${dlItems.map(({ dt, dds }) => `<dt>${inline(dt)}</dt>${dds.map((d) => `<dd>${inline(d)}</dd>`).join("")}`).join("")}</dl>`);
        continue;
      }
      const tag = ordered ? "ol" : "ul";
      out.push(`<${tag}>${items.map((x) => `<li>${x}</li>`).join("")}</${tag}>`);
      continue;
    }

    const para = [line];
    for (i++; i < lines.length && lines[i].trim() && !startsBlock(lines[i], lines[i + 1]); i++) para.push(lines[i]);
    out.push(`<p>${inline(para.join("\n"))}</p>`);
  }
  return out.join("\n");
}

/** Markdown (the twin language) to an HTML fragment. A served twin opens with
 *  YAML front matter (title, path, source); that is metadata about the page,
 *  so it stays out of the body the way <head> stays out of a page's text. */
export function mdToHtml(md) {
  return blocks(md.replace(/^---\n[\s\S]*?\n---\n/, ""));
}
