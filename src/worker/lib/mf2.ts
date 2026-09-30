// mf2.ts: a small, bounded microformats2 parser for pages a stranger names.
//
// The webmention receiver needs three facts from a source page: who wrote it,
// what it is called, and when. Those live in microformats2 markup, and the
// values rarely sit in visible text. A site that marks its author up with
// <data class="p-name" value="..."> draws nothing on screen and still names a
// person, and every real mf2 parser (XRay, mf2py, microformats-parser) reads it.
// A text-only reader reads nothing there and falls back to the hostname.
//
// So this follows the parsing spec (https://microformats.org/wiki/microformats2-parsing)
// for the parts a mention uses:
//
//   p-*   value-class pattern, abbr/link@title, data/input@value,
//         img/area@alt, then text (img replaced by its alt)
//   u-*   a/area/link@href, img/audio/video/source/iframe@src, video@poster,
//         object@data, value-class, abbr@title, data/input@value, then text;
//         resolved against the document's base URL
//   dt-*  value-class (date and time parts joined), time/ins/del@datetime,
//         abbr@title, data/input@value, then text
//   e-*   { html, value }, with html sliced from the source bytes
//   nested h-* under a property: the item, with `value` set per the prefix
//   implied name, photo and url, when the item has nothing explicit
//   rels, for rel=author
//
// Left out on purpose: backcompat classes (hentry, vcard), dt-* date
// inheritance between siblings, srcset, and the `lang` and `id` fields. None
// of them decides an author or a date for a mention.
//
// No dependency and no HTMLRewriter: the contract suite runs this under node,
// which has neither, and the Worker bundle should not pay for a DOM. The tree is
// built by one regex tokenizer with a node cap and a depth cap, so a hostile page
// can make the parse shorter and never longer. Values are capped too.

import { asList, asRecord, asText } from "./parse.ts";

export type Mf2Item = {
  type: string[];
  properties: Record<string, Mf2Value[]>;
  children?: Mf2Item[];
  value?: string;
  html?: string;
  // Which properties the implied rules supplied. Outside the mf2 JSON shape: a
  // consumer that wants what the page SAID (a post title, say) needs to tell an
  // explicit p-name from a name implied out of the whole entry's text.
  implied?: string[];
};
export type Mf2Value = string | { html: string; value: string } | Mf2Item;
export type Mf2Doc = { items: Mf2Item[]; rels: Record<string, string[]> };

type El = {
  tag: string;
  attrs: Record<string, string>;
  classes: string[];
  children: El[];
  text?: string;   // set on "#text" nodes alone
  innerStart: number;
  innerEnd: number;
};

const MAX_INPUT = 1024 * 1024;
const MAX_NODES = 20000;
const MAX_DEPTH = 256;
const MAX_VALUE = 4000;
const MAX_HTML = 20000;

const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
// Text inside these is one raw run. script/style/template content is dropped
// outright: the spec removes script and style from text, and a template's
// content is inert until cloned, the same rule linksTo applies.
const RAW_DROP = new Set(["script", "style", "template", "noscript"]);
const RAW_TEXT = new Set(["textarea", "title", "xmp"]);
// An open tag of one of these closes an open sibling of the same group, which is
// how <li>a<li>b nests in a real parser.
const AUTO_CLOSE: Record<string, Set<string>> = {
  li: new Set(["li"]),
  dt: new Set(["dt", "dd"]),
  dd: new Set(["dt", "dd"]),
  option: new Set(["option"]),
  tr: new Set(["tr", "td", "th"]),
  td: new Set(["td", "th"]),
  th: new Set(["td", "th"]),
  p: new Set(["p"]),
};

const ROOT = /^h-(?:[a-z0-9]+-)?[a-z]+(?:-[a-z]+)*$/;
const PROP = /^(p|u|dt|e)-((?:[a-z0-9]+-)?[a-z]+(?:-[a-z]+)*)$/;

// ── entities ───────────────────────────────────────────────────────────────
const NAMED: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: "\u00a0",
  mdash: "\u2014", ndash: "\u2013", hellip: "\u2026", lsquo: "\u2018", rsquo: "\u2019",
  ldquo: "\u201c", rdquo: "\u201d", copy: "\u00a9", reg: "\u00ae", middot: "\u00b7", bull: "\u2022",
};

export function decodeEntities(s: string): string {
  if (!s.includes("&")) return s;
  return s.replace(/&(?:#[xX]([0-9a-fA-F]{1,6});?|#([0-9]{1,7});?|([a-zA-Z][a-zA-Z0-9]{1,31});)/g, (m, hex, dec, name) => {
    if (name) return NAMED[name] ?? m;
    const cp = hex ? parseInt(hex, 16) : parseInt(dec, 10);
    if (!cp || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return "\ufffd";
    return String.fromCodePoint(cp);
  });
}

// ── tokenizer ──────────────────────────────────────────────────────────────
const TOKEN = /<!--[\s\S]*?(?:-->|$)|<![^>]*>?|<\?[^>]*>?|<\/([a-zA-Z][^\s/>]*)[^>]*>|<([a-zA-Z][^\s/>]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
const ATTR = /([^\s"'>/=]+)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s"'=<>`]+))?/g;

function parseAttrs(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const m of raw.matchAll(ATTR)) {
    const name = m[1].toLowerCase();
    if (name in attrs) continue;   // the first occurrence wins, as in a browser
    const v = m[2] ?? "";
    attrs[name] = decodeEntities(v.startsWith("\"") || v.startsWith("'") ? v.slice(1, -1) : v);
  }
  return attrs;
}

function buildTree(input: string): El {
  const src = input.length > MAX_INPUT ? input.slice(0, MAX_INPUT) : input;
  const root: El = { tag: "#root", attrs: {}, classes: [], children: [], innerStart: 0, innerEnd: src.length };
  const stack: El[] = [root];
  let nodes = 0;
  let last = 0;
  const top = () => stack[stack.length - 1];
  const pushText = (t: string) => { if (t) top().children.push(textNode(decodeEntities(t))); };
  const close = (i: number, at: number) => {
    for (let k = stack.length - 1; k >= i; k--) stack[k].innerEnd = at;
    stack.length = i;
  };

  TOKEN.lastIndex = 0;
  for (let m = TOKEN.exec(src); m; m = TOKEN.exec(src)) {
    pushText(src.slice(last, m.index));
    last = TOKEN.lastIndex;
    if (m[1]) {
      const tag = m[1].toLowerCase();
      for (let i = stack.length - 1; i > 0; i--) {
        if (stack[i].tag === tag) { close(i, m.index); break; }
      }
      continue;
    }
    if (!m[2]) continue;   // comment, doctype, processing instruction
    if (++nodes > MAX_NODES) { last = src.length; break; }

    const tag = m[2].toLowerCase();
    const closers = AUTO_CLOSE[tag];
    if (closers && stack.length > 1 && closers.has(top().tag)) close(stack.length - 1, m.index);

    const rawAttrs = m[3] || "";
    const attrs = parseAttrs(rawAttrs);
    const classes = [...new Set((attrs.class || "").split(/\s+/).filter(Boolean))];
    const el: El = { tag, attrs, classes, children: [], innerStart: TOKEN.lastIndex, innerEnd: TOKEN.lastIndex };
    top().children.push(el);

    if (RAW_DROP.has(tag) || RAW_TEXT.has(tag)) {
      const end = src.slice(TOKEN.lastIndex).search(new RegExp(`</${tag}\\s*>`, "i"));
      const stop = end === -1 ? src.length : TOKEN.lastIndex + end;
      if (RAW_TEXT.has(tag)) el.children.push(textNode(decodeEntities(src.slice(TOKEN.lastIndex, stop))));
      el.innerEnd = stop;
      const after = end === -1 ? src.length : src.indexOf(">", stop) + 1;
      TOKEN.lastIndex = after;
      last = after;
      continue;
    }
    if (VOID.has(tag) || /\/\s*$/.test(rawAttrs)) continue;
    // Past the depth cap an element keeps its place in its parent and its
    // children become its siblings. The structure flattens; nothing is lost.
    if (stack.length < MAX_DEPTH) stack.push(el);
  }
  pushText(src.slice(last));
  close(1, src.length);
  return root;
}

// ── text helpers ───────────────────────────────────────────────────────────
const textNode = (text: string): El => ({ tag: "#text", attrs: {}, classes: [], children: [], innerStart: 0, innerEnd: 0, text });
function elementChildren(el: El): El[] { return el.children.filter((n) => n.tag !== "#text"); }
const cap = (s: string, n = MAX_VALUE) => (s.length > n ? s.slice(0, n) : s);

/** textContent with script and style dropped (the tokenizer never kept them)
 *  and each img replaced by its alt, or its src when it has no alt. */
function textOf(el: El, base: string, imgs = true, trim = true): string {
  let out = "";
  const walk = (n: El) => {
    if (out.length > MAX_VALUE) return;
    if (n.tag === "#text") { out += n.text; return; }
    if (imgs && n.tag === "img") {
      const alt = n.attrs.alt;
      out += alt != null ? ` ${alt} ` : n.attrs.src ? ` ${resolve(n.attrs.src, base)} ` : "";
      return;
    }
    for (const c of n.children) walk(c);
  };
  for (const c of el.children) walk(c);
  return cap(trim ? out.trim() : out);
}

function resolve(url: string, base: string): string {
  try { return new URL(url.trim(), base).href; } catch { return url.trim(); }
}

// ── value-class pattern ────────────────────────────────────────────────────
function valueElements(el: El): El[] {
  const found: El[] = [];
  const walk = (n: El) => {
    for (const c of elementChildren(n)) {
      if (c.classes.some((k) => ROOT.test(k))) continue;   // a nested item keeps its own values
      if (c.classes.includes("value") || c.classes.includes("value-title")) { found.push(c); continue; }
      walk(c);
    }
  };
  walk(el);
  return found;
}

function valueOf(v: El, dt: boolean, base: string): string {
  if (v.classes.includes("value-title")) return v.attrs.title ?? "";
  if ((v.tag === "img" || v.tag === "area") && v.attrs.alt != null) return v.attrs.alt;
  if (v.tag === "data") return v.attrs.value ?? textOf(v, base, false, false);
  if (v.tag === "abbr") return v.attrs.title ?? textOf(v, base, false, false);
  if (dt && (v.tag === "del" || v.tag === "ins" || v.tag === "time") && v.attrs.datetime != null) return v.attrs.datetime;
  return textOf(v, base, false, false);
}

const DATE = /^\d{4}-(?:\d{2}-\d{2}|\d{3})$/;
const TIME = /^\d{1,2}(?::\d{2}(?::\d{2}(?:\.\d+)?)?)?\s*(?:[ap]\.?m\.?)?$/i;
const TZ = /^(?:Z|[+-]\d{2}:?(?:\d{2})?)$/i;

/** The dt-* half of the pattern: parts are sorted into a date, a time and a
 *  timezone and joined as "date time", which is what mf2py and XRay emit. A
 *  part that already carries both halves stands in for the date. */
function joinDateTime(parts: string[]): string {
  let date = "", time = "", tz = "";
  for (const raw of parts.map((p) => p.trim()).filter(Boolean)) {
    if (!date && /^\d{4}-\d{2}-\d{2}[T ]/.test(raw)) date = raw;
    else if (!date && DATE.test(raw)) date = raw;
    else if (!time && TIME.test(raw)) time = raw;
    else if (!tz && TZ.test(raw)) tz = raw;
  }
  if (!date) return parts.join("").trim();
  return time ? `${date} ${time}${tz}` : date;
}

// ── property parsers ───────────────────────────────────────────────────────
function parseP(el: El, base: string): string {
  const vals = valueElements(el);
  if (vals.length) return cap(vals.map((v) => valueOf(v, false, base)).join("").trim());
  if ((el.tag === "abbr" || el.tag === "link") && el.attrs.title != null) return cap(el.attrs.title);
  if ((el.tag === "data" || el.tag === "input") && el.attrs.value != null) return cap(el.attrs.value);
  if ((el.tag === "img" || el.tag === "area") && el.attrs.alt != null) return cap(el.attrs.alt);
  return textOf(el, base);
}

function parseU(el: El, base: string): string {
  const a = el.attrs;
  let v: string | undefined;
  if ((el.tag === "a" || el.tag === "area" || el.tag === "link") && a.href != null) v = a.href;
  else if (["img", "audio", "video", "source", "iframe"].includes(el.tag) && a.src != null) v = a.src;
  else if (el.tag === "video" && a.poster != null) v = a.poster;
  else if (el.tag === "object" && a.data != null) v = a.data;
  if (v != null) return cap(resolve(v, base));
  const vals = valueElements(el);
  if (vals.length) return cap(resolve(vals.map((x) => valueOf(x, false, base)).join(""), base));
  if (el.tag === "abbr" && a.title != null) return cap(resolve(a.title, base));
  if ((el.tag === "data" || el.tag === "input") && a.value != null) return cap(resolve(a.value, base));
  return cap(resolve(textOf(el, base), base));
}

function parseDt(el: El, base: string): string {
  const vals = valueElements(el);
  if (vals.length) return cap(joinDateTime(vals.map((v) => valueOf(v, true, base))));
  const a = el.attrs;
  if ((el.tag === "time" || el.tag === "ins" || el.tag === "del") && a.datetime != null) return cap(a.datetime.trim());
  if (el.tag === "abbr" && a.title != null) return cap(a.title.trim());
  if ((el.tag === "data" || el.tag === "input") && a.value != null) return cap(a.value.trim());
  return textOf(el, base, false);
}

function parseE(el: El, src: string, base: string): { html: string; value: string } {
  return { html: cap(src.slice(el.innerStart, el.innerEnd).trim(), MAX_HTML), value: textOf(el, base) };
}

// ── items ──────────────────────────────────────────────────────────────────
function rootsOf(el: El): string[] { return el.classes.filter((k) => ROOT.test(k)).sort(); }
function propsOf(el: El): [string, string][] {
  const out: [string, string][] = [];
  for (const k of el.classes) {
    const m = k.match(PROP);
    if (m && !out.some(([p, n]) => p === m[1] && n === m[2])) out.push([m[1], m[2]]);
  }
  return out;
}

type Ctx = { src: string; base: string };

function parseItem(el: El, ctx: Ctx): Mf2Item {
  const item: Mf2Item = { type: rootsOf(el), properties: {} };
  const children: Mf2Item[] = [];
  const seen = { p: false, u: false, e: false, nested: false };
  const add = (name: string, v: Mf2Value) => { (item.properties[name] ||= []).push(v); };

  const walk = (node: El) => {
    for (const child of elementChildren(node)) {
      const roots = rootsOf(child);
      const props = propsOf(child);
      if (roots.length) {
        const nested = parseItem(child, ctx);
        seen.nested = true;
        if (!props.length) { children.push(nested); continue; }
        for (const [prefix, name] of props) {
          const v: Mf2Item = { ...nested };
          if (prefix === "p") v.value = firstString(nested.properties.name) ?? parseP(child, ctx.base);
          else if (prefix === "u") v.value = firstString(nested.properties.url) ?? parseU(child, ctx.base);
          else if (prefix === "dt") v.value = parseDt(child, ctx.base);
          else { const e = parseE(child, ctx.src, ctx.base); v.value = e.value; v.html = e.html; }
          add(name, v);
        }
        continue;
      }
      for (const [prefix, name] of props) {
        if (prefix === "p") { seen.p = true; add(name, parseP(child, ctx.base)); }
        else if (prefix === "u") { seen.u = true; add(name, parseU(child, ctx.base)); }
        else if (prefix === "dt") add(name, parseDt(child, ctx.base));
        else { seen.e = true; add(name, parseE(child, ctx.src, ctx.base)); }
      }
      walk(child);
    }
  };
  walk(el);

  const implied: string[] = [];
  if (!item.properties.name && !seen.p && !seen.e && !seen.nested) {
    item.properties.name = [impliedName(el, ctx.base)];
    implied.push("name");
  }
  if (!item.properties.photo && !seen.u && !seen.nested) {
    const photo = impliedPhoto(el, ctx.base);
    if (photo) { item.properties.photo = [photo]; implied.push("photo"); }
  }
  if (!item.properties.url && !seen.u && !seen.nested) {
    const url = impliedUrl(el, ctx.base);
    if (url) { item.properties.url = [url]; implied.push("url"); }
  }
  if (implied.length) item.implied = implied;
  if (children.length) item.children = children;
  return item;
}

/** The only element child, when it is not itself an item. */
function soleChild(el: El): El | null {
  const kids = elementChildren(el);
  return kids.length === 1 && !rootsOf(kids[0]).length ? kids[0] : null;
}

function impliedName(el: El, base: string): string {
  const own = (e: El): string | null => {
    if ((e.tag === "img" || e.tag === "area") && e.attrs.alt != null) return e.attrs.alt;
    if (e.tag === "abbr" && e.attrs.title != null) return e.attrs.title;
    return null;
  };
  const child = soleChild(el);
  const grand = child && soleChild(child);
  return cap((own(el) ?? (child && own(child)) ?? (grand && own(grand)) ?? textOf(el, base)).trim());
}

function impliedPhoto(el: El, base: string): string {
  const own = (e: El): string | null =>
    e.tag === "img" && e.attrs.src != null ? e.attrs.src : e.tag === "object" && e.attrs.data != null ? e.attrs.data : null;
  const child = soleChild(el);
  const grand = child && soleChild(child);
  const v = own(el) ?? (child && own(child)) ?? (grand && own(grand));
  return v == null ? "" : resolve(v, base);
}

function impliedUrl(el: El, base: string): string {
  const own = (e: El): string | null => ((e.tag === "a" || e.tag === "area") && e.attrs.href != null ? e.attrs.href : null);
  const child = soleChild(el);
  const grand = child && soleChild(child);
  const v = own(el) ?? (child && own(child)) ?? (grand && own(grand));
  return v == null ? "" : resolve(v, base);
}

/** A property value as an item, when it is one. Values are built here, so the
 *  parse.ts primitives are the whole check: an item is the record with a type. */
function asItem(v: Mf2Value): Mf2Item | null {
  const r = asRecord(v);
  return r && asList(r.type).length ? (r as Mf2Item) : null;
}

/** The text a value stands for: a plain value, or the `value` an embedded
 *  e-* or a nested item carries for its parent. */
function textValue(v: Mf2Value): string | null {
  return asText(v) ?? asText(asRecord(v)?.value);
}

function firstString(vals: Mf2Value[] | undefined): string | undefined {
  for (const v of vals || []) {
    const s = textValue(v);
    if (s !== null) return s;
  }
  return undefined;
}

// ── document ───────────────────────────────────────────────────────────────
export function parseMf2(html: string, pageUrl: string): Mf2Doc {
  const src = String(html ?? "");
  const tree = buildTree(src);
  let base = pageUrl;
  const items: Mf2Item[] = [];
  const rels: Record<string, string[]> = {};

  const findBase = (n: El): boolean => {
    for (const c of elementChildren(n)) {
      if (c.tag === "base" && c.attrs.href) { base = resolve(c.attrs.href, pageUrl); return true; }
      if (findBase(c)) return true;
    }
    return false;
  };
  findBase(tree);

  const ctx = { src, base };
  // Items stop the item walk at their root; rels are document-wide, so every
  // element is visited for those whether or not it sits inside an item.
  const walk = (n: El, inItem: boolean) => {
    for (const c of elementChildren(n)) {
      if ((c.tag === "a" || c.tag === "link" || c.tag === "area") && c.attrs.rel && c.attrs.href != null) {
        const href = resolve(c.attrs.href, base);
        for (const r of c.attrs.rel.toLowerCase().split(/\s+/).filter(Boolean)) {
          const list = (rels[r] ||= []);
          if (!list.includes(href)) list.push(href);
        }
      }
      const root = !inItem && rootsOf(c).length > 0;
      if (root) items.push(parseItem(c, ctx));
      walk(c, inItem || root);
    }
  };
  walk(tree, false);
  return { items, rels };
}

/** The first string value of a property: a plain value, or the `value` a nested
 *  item carries for its parent. */
export function mf2First(item: Mf2Item | undefined, name: string): string {
  return firstString(item?.properties[name]) ?? "";
}

/** Every item in the document, depth first: top-level items, their children,
 *  and items that sit under a property. */
export function mf2All(doc: Mf2Doc): Mf2Item[] {
  const out: Mf2Item[] = [];
  const visit = (it: Mf2Item) => {
    if (out.length >= 2000) return;
    out.push(it);
    for (const vals of Object.values(it.properties)) {
      for (const v of vals) { const nested = asItem(v); if (nested) visit(nested); }
    }
    for (const c of it.children || []) visit(c);
  };
  for (const it of doc.items) visit(it);
  return out;
}

/** The plain string values of a property, which for a u-* is its URLs. Nested
 *  items and embedded e-* values are left out. */
export function mf2Strings(item: Mf2Item | undefined, name: string): string[] {
  return (item?.properties[name] || []).map((v) => asText(v)).filter((s): s is string => s !== null);
}

/** The nested items under a property, and the plain strings beside them, in
 *  document order: an author can be either. */
export function mf2Values(item: Mf2Item | undefined, name: string): ({ item: Mf2Item } | { text: string })[] {
  const out: ({ item: Mf2Item } | { text: string })[] = [];
  for (const v of item?.properties[name] || []) {
    const nested = asItem(v);
    if (nested) out.push({ item: nested });
    else { const s = textValue(v); if (s !== null) out.push({ text: s }); }
  }
  return out;
}
