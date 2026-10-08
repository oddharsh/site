// html-minify.ts: the build's HTML minifier, one pass over tokens with a stack
// of open elements.
//
// It replaced @minify-html/node on 2026-10-07 and makes exactly the choices the
// build's old HTML_MINIFY_CFG made, so the two agree byte for byte on every
// staged page but one: /garage/horizon, where minify-html rewrote
// `hidden="until-found"` to a bare `hidden`. That broke the page's
// find-in-page demo in production, because bare `hidden` cannot be revealed by
// a search. Here `hidden` loses its value only when the value is empty or
// "hidden". The rest it reproduces:
//   - comments go, except SSI comments (<!--#...-->), which carry markers
//   - whitespace collapses, except inside <pre>, <textarea> and <code>; it is
//     trimmed at the edges of block-ish elements, and a run of only whitespace
//     between the children of a layout element (div, ul, table, nav ...) goes
//     entirely. That rule is lossy in normal flow (<div><b>a</b> <b>b</b></div>
//     loses its space); the site's layouts are flex and grid, where that space
//     never rendered, and minify-html made the same call
//   - attributes sort (quoted values first, then by name), lose quotes they do
//     not need, and empty class, id, style, title, name and value attributes go
//   - end tags the HTML spec lets a parser infer are omitted (</p> before a
//     block, </li> before <li>, </td>, </tr>, </option>, </body>, </html> ...)
//   - named and numeric references decode to the characters they name, except
//     "<", and "&" where a bare one would start another reference
// <script> and <style> keep their bytes, less outer whitespace: the build runs
// Oxc and Lightning CSS over them first (transformInlineHtmlBlocks).
//
// Written for the build-off's bespoke entry (branch buildoff/bespoke), which
// measured it against minify-html with its parity test and a planted-mutation
// control. It is slower warm (about 1.8x) and loads in under 1 ms against the
// native addon's 4 to 6, and it removes 6 lockfile packages and a 16 MB binary.

const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);
// no tags inside: copied through to their end tag
const RAW = new Set(["script", "style", "textarea", "title", "xmp", "plaintext"]);
// whitespace inside is content
const SENSITIVE = new Set(["pre", "textarea", "code"]);
const LAYOUT = new Set(["html", "head", "body", "div", "section", "nav", "blockquote", "form", "figure", "header", "footer", "article", "fieldset",
  "aside", "dialog", "main", "ol", "ul", "dl", "menu", "hgroup", "select", "optgroup", "datalist", "table", "thead", "tbody", "tfoot", "tr",
  "colgroup", "map", "picture", "svg", "g"]);
const CONTENT = new Set(["p", "li", "td", "th", "dd", "dt", "h1", "h2", "h3", "h4", "h5", "h6", "button", "summary", "details", "caption",
  "legend", "option", "output", "figcaption", "noscript", "template", "label", "address", "object", "canvas", "iframe", "audio", "video", "slot"]);
const DROP_EMPTY = new Set(["class", "id", "style", "title", "name", "value"]);

// End tags a parser infers (HTML spec 13.1.2.4): before which start tag, and
// whether at the parent's end.
const P_CLOSERS = new Set(["address", "article", "aside", "blockquote", "details", "dialog", "div", "dl", "fieldset", "figcaption", "figure", "footer", "form",
  "h1", "h2", "h3", "h4", "h5", "h6", "header", "hgroup", "hr", "main", "menu", "nav", "ol", "p", "pre", "search", "section", "table", "ul"]);
const OMIT_BEFORE: Record<string, (next: string) => boolean> = {
  li: (n) => n === "li",
  dt: (n) => n === "dt" || n === "dd",
  dd: (n) => n === "dt" || n === "dd",
  p: (n) => P_CLOSERS.has(n),
  option: (n) => n === "option" || n === "optgroup",
  optgroup: (n) => n === "optgroup",
  tr: (n) => n === "tr",
  td: (n) => n === "td" || n === "th",
  th: (n) => n === "td" || n === "th",
  thead: (n) => n === "tbody" || n === "tfoot",
  tbody: (n) => n === "tbody" || n === "tfoot",
  head: (n) => n === "body",
};
const OMIT_AT_END = new Set(["li", "dt", "dd", "option", "optgroup", "tr", "td", "th", "tbody", "body", "html"]);
const P_KEEPS_END_IN = new Set(["a", "audio", "del", "ins", "map", "noscript", "video"]);

// Every named reference the site's pages use, so each decodes to its character
// as minify-html did. An unknown name stays as written.
const ENTITIES: Record<string, string> = {
  quot: '"', apos: "'", amp: "&", lt: "<", gt: ">", nbsp: " ", middot: "·", times: "×", rarr: "→", larr: "←", uarr: "↑", darr: "↓",
  hellip: "…", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", mdash: "—", ndash: "–", egrave: "è", minus: "−", copy: "©", deg: "°",
  ge: "≥", le: "≤", divide: "÷", sup2: "²", rsaquo: "›", lsaquo: "‹", plusmn: "±", nacute: "ń", micro: "µ", chi: "χ", boxbox: "⧉",
  blacktriangle: "▴", approx: "≈",
};

const TOKEN = /<!--[\s\S]*?-->|<![^>]*>|<\/([A-Za-z][\w-]*)\s*>|<([A-Za-z][\w-]*)((?:\s+[^\s"'>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*(\/?)>|[^<]+|</g;
const ATTR = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

type Kind = "open" | "close" | "text" | "raw" | "other";
type Tok = { s: string; kind: Kind; tag?: string; parent?: string };

export function minifyHtml(src: string): string {
  const lower = src.toLowerCase();
  const out: Tok[] = [];
  const stack: string[] = [];
  // the last end tag, already in `out`, whose bytes wait on what follows it
  let held: Tok | null = null;

  const close = (tag: string) => { held = { s: `</${tag}>`, kind: "close", tag }; out.push(held); };
  // Settle the held end tag: empty it if the next start tag (or, with null,
  // the parent's end) lets the parser infer it.
  const settle = (next: string | null) => {
    if (!held || !held.tag) return;
    const omit = next === null
      ? held.tag === "p" ? !P_KEEPS_END_IN.has(stack.at(-1) ?? "") : OMIT_AT_END.has(held.tag)
      : OMIT_BEFORE[held.tag]?.(next) ?? false;
    if (omit) held.s = "";
    held = null;
  };

  // lastIndex is ours: raw text jumps it forward
  const re = new RegExp(TOKEN);
  for (let m = re.exec(src); m; m = re.exec(src)) {
    const [t, endName, startName, attrs = "", selfClose] = m;
    if (t.startsWith("<!--")) {
      if (t.startsWith("<!--#")) out.push({ s: t, kind: "other" });
      continue;
    }
    if (t.startsWith("<!")) { out.push({ s: t.replace(/^<!doctype/i, "<!doctype"), kind: "other" }); continue; }
    if (startName) {
      const tag = startName.toLowerCase();
      settle(tag);
      // A start tag the parser lets close the open element closes it here too,
      // with its end tag omitted: `<p>a<p>b` is two paragraphs, so the first
      // one's trailing whitespace goes as it would before a written </p>. The
      // authored pages leave <p> open in places; without this, /garage/horizon
      // kept a space and a stray </p> that minify-html never emitted.
      while (stack.length && OMIT_BEFORE[stack.at(-1) as string]?.(tag)) {
        out.push({ s: "", kind: "close", tag: stack.pop() });
      }
      // in SVG and MathML a "/>" closes the element, so it stays; in HTML it means nothing
      const foreign = !!selfClose && stack.some((s) => s === "svg" || s === "math");
      const html = attributes(attrs, tag);
      out.push({
        s: foreign ? `<${tag}${html}${/=[^"'\s]*$/.test(html) ? " " : ""}/>` : `<${tag}${html}>`,
        kind: VOID.has(tag) || foreign ? "other" : "open",
        tag,
        parent: stack.at(-1),
      });
      if (VOID.has(tag) || foreign) continue;
      if (RAW.has(tag)) {
        const end = lower.indexOf(`</${tag}`, m.index + t.length);
        const stop = end < 0 ? src.length : end;
        let body = src.slice(m.index + t.length, stop);
        if (tag === "style" || (tag === "script" && isJs(attrs))) body = body.trim();
        // RCDATA: references apply and tags don't, so "<" needs no escape unless it would close the element
        if (tag === "title" || tag === "textarea") body = references(body).replace(new RegExp(`&lt;(?!/${tag})`, "gi"), "<");
        out.push({ s: body, kind: "raw" }, { s: `</${tag}>`, kind: "close", tag });
        held = null;
        re.lastIndex = end < 0 ? src.length : src.indexOf(">", end) + 1;
        continue;
      }
      stack.push(tag);
      continue;
    }
    if (endName) {
      const tag = endName.toLowerCase();
      // a stray end tag means nothing
      if (VOID.has(tag) || !stack.includes(tag)) continue;
      settle(null);
      while (stack.at(-1) !== tag) { close(stack.pop() as string); settle(null); }
      stack.pop();
      close(tag);
      continue;
    }
    // Text: the whitespace decision waits until both neighbours are known.
    // Text keeps a held end tag; so does whitespace that will survive (any parent but a layout one).
    if (!/^\s*$/.test(t) || (stack.length && !LAYOUT.has(stack.at(-1) as string))) settle("#text");
    const sensitive = stack.some((s) => SENSITIVE.has(s));
    out.push({ s: references(sensitive ? t : t.replace(/[ \t\n\r\f]+/g, " ")), kind: sensitive ? "raw" : "text", parent: stack.at(-1) });
  }
  settle(null);
  while (stack.length) { close(stack.pop() as string); settle(null); }

  // Whitespace: trim at the edges of layout and content elements, drop
  // whitespace-only runs between a layout element's children.
  let html = "";
  for (let i = 0; i < out.length; i++) {
    const tok = out[i];
    if (tok.kind !== "text") { html += tok.s; continue; }
    const block = !tok.parent || LAYOUT.has(tok.parent) || CONTENT.has(tok.parent);
    let s = tok.s;
    if (s === " " && (!tok.parent || LAYOUT.has(tok.parent))) continue;
    const prev = out[i - 1], next = out[i + 1];
    if (block && (!prev || (prev.kind === "open" && prev.tag === tok.parent))) s = s.replace(/^ /, "");
    if (block && (!next || next.kind === "close")) s = s.replace(/ $/, "");
    html += s;
  }
  return html;
}

const isJs = (attrs: string) => {
  const type = attrs.match(/\btype\s*=\s*["']?([^"'\s>]+)/i)?.[1].toLowerCase();
  return !type || type === "module" || /javascript|ecmascript/.test(type);
};

// References decode to their characters. "<" stays escaped, and "&" stays
// escaped only where a bare "&" would start another reference: "&x;", "&#",
// or one of the legacy names browsers read without a semicolon.
const LEGACY = /^(?:#|\w+;|(?:amp|lt|gt|quot|nbsp|copy|reg|not|shy|deg|micro|para|middot|times|divide|sect|uml|cent|pound|yen|laquo|raquo|plusmn|sup[123]|frac\d\d|[A-Za-z](?:grave|acute|circ|tilde|uml|ring|cedil)|szlig|eth|thorn|aelig)(?!\w))/i;
function references(s: string): string {
  return s.replace(/&(?:#(\d+)|#[xX]([\da-fA-F]+)|(\w+));/g, (m: string, dec: string | undefined, hex: string | undefined, name: string | undefined, at: number) => {
    const ch = dec ? String.fromCodePoint(+dec) : hex ? String.fromCodePoint(parseInt(hex, 16)) : ENTITIES[name ?? ""];
    if (ch === undefined) return m;
    if (ch === "<") return "&lt;";
    if (ch === "&") return LEGACY.test(s.slice(at + m.length)) ? "&amp;" : "&";
    return ch;
  });
}

// Attributes: sorted, unquoted where the value allows, and empty or default
// values dropped the way minify-html dropped them.
const DEFAULTS: Record<string, Record<string, string>> = {
  img: { loading: "eager" }, button: { type: "submit" }, script: { type: "text/javascript" }, style: { type: "text/css", media: "all" },
  form: { method: "get" }, a: { target: "_self" }, area: { "shape": "rect" },
};
const BOOLEAN = new Set(["checked", "disabled", "hidden", "selected", "readonly", "required", "multiple", "autofocus", "novalidate", "async", "defer",
  "nomodule", "ismap", "reversed", "open", "inert", "formnovalidate", "allowfullscreen", "default", "playsinline"]);
function attributes(raw: string, tag: string): string {
  const list: string[] = [];
  const viewport = tag === "meta" && /name\s*=\s*["']?viewport/i.test(raw);
  for (const [, rawName, dq, sq, bare] of raw.matchAll(ATTR)) {
    const name = rawName.toLowerCase();
    let value: string | undefined = dq ?? sq ?? bare;
    if (value !== undefined) value = references(value).replace(/&lt;/g, "<");
    if (name === "class" && value !== undefined) value = value.trim().replace(/\s+/g, " ");
    if (viewport && name === "content" && value !== undefined) value = value.replace(/\s*,\s*/g, ",");
    if (value !== undefined && DEFAULTS[tag]?.[name] === value.toLowerCase()) continue;
    if (value === "" && (DROP_EMPTY.has(name) || name === "action" || (name === "content" && tag === "meta") || (name === "src" && tag !== "script")) && !(tag === "option" && name === "value")) continue;
    // A boolean attribute loses only an empty or self-named value: hidden="until-found" is a different state from hidden.
    if (BOOLEAN.has(name) && (value === "" || value?.toLowerCase() === name)) value = undefined;
    if (value === undefined || value === "") list.push(name);
    else if (/^[^\s"'=<>`]+$/.test(value)) list.push(`${name}=${value}`);
    else if (!value.includes('"')) list.push(`${name}="${value}"`);
    else list.push(`${name}='${value.replace(/'/g, "&#39;")}'`);
  }
  // quoted values first, then the rest, each group by name (minify-html's order)
  const quoted = (a: string) => (/["']$/.test(a) ? 0 : 1);
  const nameOf = (a: string) => a.split("=")[0];
  return list.sort((a, b) => quoted(a) - quoted(b) || (nameOf(a) < nameOf(b) ? -1 : nameOf(a) > nameOf(b) ? 1 : 0)).map((a) => " " + a).join("");
}
