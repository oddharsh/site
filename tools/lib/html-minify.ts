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
//     not need, and empty class, id, style, title, name and value attributes go,
//     as do empty action, src (off <script>) and meta content, and any value
//     that equals the attribute's default (DEFAULTS). A boolean loses an empty or
//     self-named value; a class's spacing and the spaces around a viewport's
//     commas collapse. contract-the-minifier-keeps-every-page-meaning copies
//     these rules, so change both together
//   - end tags the HTML spec lets a parser infer are omitted (</p> before a
//     block, </li> before <li>, </td>, </tr>, </option>, </body>, </html> ...)
//   - named and numeric references decode to the characters they name, except
//     "<", and "&" where a bare one would start another reference
// <script> and <style> keep their bytes, less outer whitespace: the build runs
// Oxc and Lightning CSS over them first (transformInlineHtmlBlocks).
//
//
// Written for the build-off's bespoke entry (branch buildoff/bespoke), which
// measured it against minify-html with its parity test and a planted-mutation
// control. It removes 6 lockfile packages and a 16 MB binary.
//
// SPEED. The first version tokenized with one regex per alternative and
// re-matched every tag's attributes with a second one, and ran 1.85x slower
// than minify-html. This one scans char codes, parses attributes once, sorts
// them on keys it already holds, and decodes references only where a run has
// an "&". Over the 69 staged pages (2.6 MB) on 2026-10-08: about 26 ms warm
// against minify-html's 27.5 and the regex version's 51, and 35 ms cold with
// load against minify-html's 32. A differential fuzz over 200,000 generated
// fragments found no output that differs from the regex version, and caught
// each of three planted mistakes. The regex version also hung on a raw element
// whose end tag never closed (`<script>x</script` at end of input); this one
// runs to the end of the document, as the parser does.

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
// ── the scanner: replaces the TOKEN and ATTR regexes ─────────────────────────
// One pass over char codes. Each branch is one alternative of the old TOKEN
// regex, in its order: comment, other `<!...>`, end tag, start tag, text, and a
// lone "<" as text when no tag shape fits. Attributes are parsed here, once,
// instead of being re-matched from the raw attribute string.

// JavaScript's \s, which the old regexes used
const isWs = (c: number) =>
  c === 32 || (c >= 9 && c <= 13) || c === 0xa0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) ||
  c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff;
const isAlpha = (c: number) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
// [\w-]
const isNameRest = (c: number) => isAlpha(c) || (c >= 48 && c <= 57) || c === 95 || c === 45;
// [^\s"'>/=]
const isAttrName = (c: number) => c >= 0 && !isWs(c) && c !== 34 && c !== 39 && c !== 62 && c !== 47 && c !== 61;
// [^\s"'=<>`]
const isBare = (c: number) => c >= 0 && !isWs(c) && c !== 34 && c !== 39 && c !== 61 && c !== 60 && c !== 62 && c !== 96;

// Filled by scanStart and read by attributes() before the next tag is scanned:
// parallel arrays reused across tags, so the hot path allocates no objects.
const attrNames: string[] = [];
const attrValues: (string | undefined)[] = [];
let attrCount = 0;
let rawAttrs = "";
let selfClose = false;

/** Parse a start tag at `i` (src[i] is "<", src[i+1] a letter). Returns the index after ">" or -1. */
function scanStart(src: string, i: number, nameEnd: number): number {
  attrCount = 0;
  selfClose = false;
  const n = src.length;
  let p = nameEnd;
  for (;;) {
    let w = p;
    while (w < n && isWs(src.charCodeAt(w))) w++;
    if (w === p || !isAttrName(src.charCodeAt(w))) break;
    let e = w;
    while (e < n && isAttrName(src.charCodeAt(e))) e++;
    const name = src.slice(w, e);
    let v = e;
    while (v < n && isWs(src.charCodeAt(v))) v++;
    if (src.charCodeAt(v) !== 61) { attrNames[attrCount] = name; attrValues[attrCount++] = undefined; p = e; continue; }
    v++;
    while (v < n && isWs(src.charCodeAt(v))) v++;
    const q = src.charCodeAt(v);
    if (q === 34 || q === 39) {
      const close = src.indexOf(q === 34 ? '"' : "'", v + 1);
      if (close < 0) return -1;
      attrNames[attrCount] = name; attrValues[attrCount++] = src.slice(v + 1, close);
      p = close + 1;
    } else {
      let b = v;
      while (b < n && isBare(src.charCodeAt(b))) b++;
      if (b === v) return -1;
      attrNames[attrCount] = name; attrValues[attrCount++] = src.slice(v, b);
      p = b;
    }
  }
  rawAttrs = src.slice(nameEnd, p);
  let e = p;
  while (e < n && isWs(src.charCodeAt(e))) e++;
  if (src.charCodeAt(e) === 47) { selfClose = true; e++; }
  return src.charCodeAt(e) === 62 ? e + 1 : -1;
}

/** The old `src.toLowerCase().indexOf("</" + tag, from)`, without lowering the whole document. `tag` is lower case. */
function findEndTag(src: string, tag: string, from: number): number {
  for (let at = src.indexOf("</", from); at >= 0; at = src.indexOf("</", at + 1)) {
    let k = 0;
    while (k < tag.length) { const c = src.charCodeAt(at + 2 + k); if ((c >= 65 && c <= 90 ? c + 32 : c) !== tag.charCodeAt(k)) break; k++; }
    if (k === tag.length) return at;
  }
  return -1;
}

type Kind = "open" | "close" | "text" | "raw" | "other";
type Tok = { s: string; kind: Kind; tag: string | undefined; parent: string | undefined };
// every token has all four fields, so the engine sees one object shape
const tok = (s: string, kind: Kind, tag?: string, parent?: string): Tok => ({ s, kind, tag, parent });

const COLLAPSE = /[ \t\n\r\f]+/g;
const BLANK = /^\s*$/;

export function minifyHtml(src: string): string {
  const out: Tok[] = [];
  const stack: string[] = [];
  // open <pre>, <textarea> and <code> elements, so a text run asks a counter
  // rather than walking the stack
  let sensitive = 0;
  const push = (tag: string) => { stack.push(tag); if (SENSITIVE.has(tag)) sensitive++; };
  const pop = () => { const tag = stack.pop() as string; if (SENSITIVE.has(tag)) sensitive--; return tag; };
  // the last end tag, already in `out`, whose bytes wait on what follows it
  let held: Tok | null = null;

  const close = (tag: string) => { held = tok(`</${tag}>`, "close", tag); out.push(held); };
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

  const text = (t: string) => {
    // Text: the whitespace decision waits until both neighbours are known.
    // Text keeps a held end tag; so does whitespace that will survive (any parent but a layout one).
    const top = stack.at(-1);
    if (!BLANK.test(t) || (stack.length && !LAYOUT.has(top as string))) settle("#text");
    out.push(tok(references(sensitive ? t : t.replace(COLLAPSE, " ")), sensitive ? "raw" : "text", undefined, top));
  };

  const n = src.length;
  let i = 0;
  while (i < n) {
    if (src.charCodeAt(i) !== 60) {
      const lt = src.indexOf("<", i);
      const end = lt < 0 ? n : lt;
      text(src.slice(i, end));
      i = end;
      continue;
    }
    const c1 = src.charCodeAt(i + 1);
    // <!-- ... -->, and the other <!...> forms (an unterminated comment falls through to them)
    if (c1 === 33) {
      let end = src.startsWith("<!--", i) ? src.indexOf("-->", i + 4) : -1;
      if (end >= 0) end += 3;
      else { end = src.indexOf(">", i + 2); if (end >= 0) end += 1; }
      if (end >= 0) {
        const t = src.slice(i, end);
        i = end;
        if (t.startsWith("<!--")) { if (t.startsWith("<!--#")) out.push(tok(t, "other")); continue; }
        out.push(tok(t.replace(/^<!doctype/i, "<!doctype"), "other"));
        continue;
      }
    } else if (c1 === 47 && isAlpha(src.charCodeAt(i + 2))) {
      let e = i + 3;
      while (e < n && isNameRest(src.charCodeAt(e))) e++;
      let g = e;
      while (g < n && isWs(src.charCodeAt(g))) g++;
      if (src.charCodeAt(g) === 62) {
        const tag = src.slice(i + 2, e).toLowerCase();
        i = g + 1;
        // a stray end tag means nothing
        if (VOID.has(tag) || !stack.includes(tag)) continue;
        settle(null);
        while (stack.at(-1) !== tag) { close(pop()); settle(null); }
        pop();
        close(tag);
        continue;
      }
    } else if (isAlpha(c1)) {
      let e = i + 2;
      while (e < n && isNameRest(src.charCodeAt(e))) e++;
      const after = scanStart(src, i, e);
      if (after >= 0) {
        const tag = src.slice(i + 1, e).toLowerCase();
        const raw = rawAttrs, self = selfClose;
        i = after;
        settle(tag);
        // A start tag the parser lets close the open element closes it here too,
        // with its end tag omitted: `<p>a<p>b` is two paragraphs, so the first
        // one's trailing whitespace goes as it would before a written </p>.
        while (stack.length && OMIT_BEFORE[stack.at(-1) as string]?.(tag)) {
          out.push(tok("", "close", pop()));
        }
        // in SVG and MathML a "/>" closes the element, so it stays; in HTML it means nothing
        const foreign = self && stack.some((s) => s === "svg" || s === "math");
        const html = attributes(raw, tag);
        const isVoid = VOID.has(tag);
        out.push(tok(foreign ? `<${tag}${html}${/=[^"'\s]*$/.test(html) ? " " : ""}/>` : `<${tag}${html}>`, isVoid || foreign ? "other" : "open", tag, stack.at(-1)));
        if (isVoid || foreign) continue;
        if (RAW.has(tag)) {
          const end = findEndTag(src, tag, i);
          let body = src.slice(i, end < 0 ? n : end);
          if (tag === "style" || (tag === "script" && isJs(raw))) body = body.trim();
          // RCDATA: references apply and tags don't, so "<" needs no escape unless it would close the element
          if (tag === "title" || tag === "textarea") body = references(body).replace(new RegExp(`&lt;(?!/${tag})`, "gi"), "<");
          out.push(tok(body, "raw"), tok(`</${tag}>`, "close", tag));
          held = null;
          const gt = end < 0 ? -1 : src.indexOf(">", end);
          i = gt < 0 ? n : gt + 1;
          continue;
        }
        push(tag);
        continue;
      }
    }
    // no tag shape fits: the "<" is text on its own
    text("<");
    i++;
  }
  settle(null);
  while (stack.length) { close(pop()); settle(null); }

  // Whitespace: trim at the edges of layout and content elements, drop
  // whitespace-only runs between a layout element's children.
  let html = "";
  for (let k = 0; k < out.length; k++) {
    const tok = out[k];
    if (tok.kind !== "text") { html += tok.s; continue; }
    const block = !tok.parent || LAYOUT.has(tok.parent) || CONTENT.has(tok.parent);
    let s = tok.s;
    if (s === " " && (!tok.parent || LAYOUT.has(tok.parent))) continue;
    const prev = out[k - 1], next = out[k + 1];
    if (block && (!prev || (prev.kind === "open" && prev.tag === tok.parent)) && s.charCodeAt(0) === 32) s = s.slice(1);
    if (block && (!next || next.kind === "close") && s.charCodeAt(s.length - 1) === 32) s = s.slice(0, -1);
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

const UNQUOTABLE = /^[^\s"'=<>`]+$/;
type Out = { name: string; text: string; quoted: boolean };
const byGroupThenName = (a: Out, b: Out) =>
  (a.quoted === b.quoted ? 0 : a.quoted ? -1 : 1) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

function attributes(raw: string, tag: string): string {
  if (attrCount === 0) return "";
  const kept: Out[] = [];
  const viewport = tag === "meta" && /name\s*=\s*["']?viewport/i.test(raw);
  const defaults = DEFAULTS[tag];
  for (let k = 0; k < attrCount; k++) {
    const name = attrNames[k].toLowerCase();
    let value = attrValues[k];
    if (value !== undefined && value.indexOf("&") >= 0) value = references(value).replace(/&lt;/g, "<");
    if (name === "class" && value !== undefined) value = value.trim().replace(/\s+/g, " ");
    if (viewport && name === "content" && value !== undefined) value = value.replace(/\s*,\s*/g, ",");
    if (value !== undefined && defaults !== undefined && defaults[name] !== undefined && defaults[name] === value.toLowerCase()) continue;
    if (value === "" && (DROP_EMPTY.has(name) || name === "action" || (name === "content" && tag === "meta") || (name === "src" && tag !== "script")) && !(tag === "option" && name === "value")) continue;
    // A boolean attribute loses only an empty or self-named value: hidden="until-found" is a different state from hidden.
    if (BOOLEAN.has(name) && (value === "" || value?.toLowerCase() === name)) value = undefined;
    if (value === undefined || value === "") kept.push({ name, text: name, quoted: false });
    else if (UNQUOTABLE.test(value)) kept.push({ name, text: `${name}=${value}`, quoted: false });
    else if (!value.includes('"')) kept.push({ name, text: `${name}="${value}"`, quoted: true });
    else kept.push({ name, text: `${name}='${value.replace(/'/g, "&#39;")}'`, quoted: true });
  }
  // quoted values first, then the rest, each group by name (minify-html's order)
  if (kept.length > 1) kept.sort(byGroupThenName);
  let s = "";
  for (let k = 0; k < kept.length; k++) s += " " + kept[k].text;
  return s;
}
