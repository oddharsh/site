// html-minify.ts: the build's HTML minifier, one pass over tokens with a stack
// of open elements.

const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);
const RAW = new Set(["script", "style", "textarea", "title", "xmp", "plaintext"]);
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

const ENTITIES: Record<string, string> = {
  quot: '"', apos: "'", amp: "&", lt: "<", gt: ">", nbsp: " ", middot: "·", times: "×", rarr: "→", larr: "←", uarr: "↑", darr: "↓",
  hellip: "…", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", mdash: "—", ndash: "–", egrave: "è", minus: "−", copy: "©", deg: "°",
  ge: "≥", le: "≤", divide: "÷", sup2: "²", rsaquo: "›", lsaquo: "‹", plusmn: "±", nacute: "ń", micro: "µ", chi: "χ", boxbox: "⧉",
  blacktriangle: "▴", approx: "≈",
};

const isWs = (c: number) =>
  c === 32 || (c >= 9 && c <= 13) || c === 0xa0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) ||
  c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff;
const isAlpha = (c: number) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
const isNameRest = (c: number) => isAlpha(c) || (c >= 48 && c <= 57) || c === 95 || c === 45;
const isAttrName = (c: number) => c >= 0 && !isWs(c) && c !== 34 && c !== 39 && c !== 62 && c !== 47 && c !== 61;
const isBare = (c: number) => c >= 0 && !isWs(c) && c !== 34 && c !== 39 && c !== 61 && c !== 60 && c !== 62 && c !== 96;

const attrNames: string[] = [];
const attrValues: (string | undefined)[] = [];
let attrCount = 0;
let rawAttrs = "";
let selfClose = false;

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
  let sensitive = 0;
  const push = (tag: string) => { stack.push(tag); if (SENSITIVE.has(tag)) sensitive++; };
  const pop = () => { const tag = stack.pop() as string; if (SENSITIVE.has(tag)) sensitive--; return tag; };
  let held: Tok | null = null;

  const close = (tag: string) => { held = tok(`</${tag}>`, "close", tag); out.push(held); };
  const settle = (next: string | null) => {
    if (!held || !held.tag) return;
    const omit = next === null
      ? held.tag === "p" ? !P_KEEPS_END_IN.has(stack.at(-1) ?? "") : OMIT_AT_END.has(held.tag)
      : OMIT_BEFORE[held.tag]?.(next) ?? false;
    if (omit) held.s = "";
    held = null;
  };

  const text = (t: string) => {
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
    text("<");
    i++;
  }
  settle(null);
  while (stack.length) { close(pop()); settle(null); }

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
  if (kept.length > 1) kept.sort(byGroupThenName);
  let s = "";
  for (let k = 0; k < kept.length; k++) s += " " + kept[k].text;
  return s;
}
