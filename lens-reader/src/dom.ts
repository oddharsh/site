// lens-reader/src/dom.ts — a DOM fitted to ONE workload, over htmlparser2.
//
// WHY THIS EXISTS. linkedom is 65.27 KiB gzip of the Reader Worker's 80.57
// (measured 2026-08-23 by bundling each package alone under this project's
// wrangler config). Of that, htmlparser2 is 26.62 and does the hard part:
// tolerant parsing of whatever the open web serves. The remaining ~38.6 KiB is
// a general DOM plus a CSS selector engine plus a CSSOM, and this Worker uses
// 39 members of it.
//
// WHAT WAS TRIED FIRST AND FAILED, so nobody spends the afternoon again.
// @mozilla/readability ships JSDOMParser.js, 1278 lines, described in its own
// header as "the minimal set of functionality necessary for Readability.js".
// Readability guards for it: _getAllNodesWithTag falls back to
// getElementsByTagName when querySelectorAll is absent. Bundled, it took a
// probe from 105.68 to 27.07 KiB gzip. It also fails on 36 of this repository's
// 38 documents, with `expected '</meta>' and got </head>`, because it is an
// XHTML parser and HTML5 void elements are not XHTML. Tolerant parsing is not
// the separable part. Keep the parser, replace the layer above it.
//
// THE SURFACE, counted rather than guessed. Readability.js touches 39 distinct
// DOM members (tagName 49 times, parentNode 32, getAttribute 26,
// getElementsByTagName 25); reader.ts touches 11. Every selector Readability
// ever passes to querySelectorAll is a comma-separated list of TAG NAMES, built
// by _getAllNodesWithTag. The one richer selector on this path is
// collectControlLabels', which adds [attr=value]. That is the whole grammar
// below, and it is the reason a selector engine is not needed.
//
// THE ORACLE IS LINKEDOM, not the browser. `img.src` in a browser is a resolved
// absolute URL; here it is the raw attribute, because that is what linkedom
// returns and what test/dom-differential.test.mjs holds this file to. Matching
// the spec where linkedom does not would fail the parity gate, correctly.
import { Parser } from "htmlparser2";

export const ELEMENT_NODE = 1;
export const TEXT_NODE = 3;
export const COMMENT_NODE = 8;
export const DOCUMENT_NODE = 9;

// Serialized without a closing tag. Parsing already knows these through
// htmlparser2; this copy is for the serializer alone.
const VOID = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input",
  "link", "meta", "param", "source", "track", "wbr",
]);

// Children serialize verbatim. Exactly the four tags linkedom backs with
// TextElement (script-element, style-element, text-area-element, title-element),
// which overrides toString to splice textContent in unescaped. <noscript> is
// deliberately absent even though Readability reads noscript.innerHTML to
// recover lazy images, because linkedom escapes it like any other element.
const RAW_TEXT = new Set(["script", "style", "textarea", "title"]);

/** The `class` attribute is a token set on both sides, so its serialized value
 *  is trimmed, whitespace-collapsed and DEDUPLICATED. linkedom gets this for
 *  free by routing every class write through a DOMTokenList; here it is
 *  explicit. Measured: `class="  a  b a  "` serializes as `class="a b"`, and
 *  nytimes.com's double-spaced <html class> is 1206 bytes of pure diff without
 *  it. */
const normalizeClass = (value) => [...new Set(String(value).split(/\s+/).filter(Boolean))].join(" ");

// The escape tables are MEASURED from linkedom, not taken from the HTML spec,
// because the parity gate compares serialized bytes and linkedom is the oracle.
// Text escapes four characters and leaves every other non-ASCII byte raw (e, em
// dash and emoji all pass through). An attribute value escapes the double quote
// and NOTHING else, so `&` and `<` ship raw inside attributes. Both were probed
// character by character on 2026-08-23; a spec-correct table fails the gate.
const escapeText = (s) => s
  .replace(/&/g, "&amp;")
  .replace(/</g, "&lt;")
  .replace(/>/g, "&gt;")
  .replace(/\u00a0/g, "&#160;");
const escapeAttr = (s) => s.replace(/"/g, "&quot;");

// An attribute in this set whose value is falsy serializes BARE, so `selected`
// rather than `selected=""`. Copied verbatim from
// linkedom/esm/shared/attributes.js. Note `class`, `id` and `style` are members,
// which is why an element Readability blanks with setAttribute("class", "")
// still has to come out as a bare `class`.
const EMPTY_ATTRIBUTES = new Set([
  "allowfullscreen", "allowpaymentrequest", "async", "autofocus", "autoplay",
  "checked", "class", "contenteditable", "controls", "default", "defer",
  "disabled", "draggable", "formnovalidate", "hidden", "id", "ismap",
  "itemscope", "loop", "multiple", "muted", "nomodule", "novalidate", "open",
  "playsinline", "readonly", "required", "reversed", "selected", "style",
  "truespeed",
]);

/** linkedom's Attr#toString, which is the byte the parity gate compares.
 *
 *  This carried a KNOWN GAP note claiming upstream escapes SVG and XML
 *  attribute values more fully than HTML ones. Measured 2026-08-23, that branch
 *  is UNREACHABLE from parseHTML: linkedom picks it with `ignoreCase(this)`,
 *  which resolves to `ownerDocument[MIME].ignoreCase`, and an HTML document
 *  answers true for every attribute on it, SVG children included. A real page's
 *  `<path d="M0&0" data-q="a&b<c">` round-trips raw on both sides. The fuller
 *  escape only applies to a document parsed as XML, which this Worker never
 *  builds. test/dom-differential.test.mjs pins the measurement. */
const serializeAttr = (attr) => {
  if (EMPTY_ATTRIBUTES.has(attr.name) && !attr.value) {
    // id, class and style are DROPPED when empty rather than written bare.
    // linkedom does this by switching on the serialized attribute string and
    // discarding exactly those three (interface/element.js, the ATTRIBUTE_NODE
    // case), so `<div class="">` round-trips as `<div>`.
    return DROPPED_WHEN_EMPTY.has(attr.name) ? null : attr.name;
  }
  return `${attr.name}="${escapeAttr(attr.value)}"`;
};

const DROPPED_WHEN_EMPTY = new Set(["id", "class", "style"]);

/** One entry in an element's attribute list. Readability clones these. */
class Attr {
  name: string;
  value: string;

  constructor(name: string, value: string) { this.name = name; this.value = value; }
  cloneNode() { return new Attr(this.name, this.value); }
}

class Node {
  // Declared rather than inferred: a .ts class does not pick its fields up from
  // constructor assignment the way checkJs does for a .js one.
  nodeType: number;
  ownerDocument: Document | null;
  parentNode: Node | null;
  childNodes: Node[];

  constructor(nodeType: number, ownerDocument: Document | null) {
    this.nodeType = nodeType;
    this.ownerDocument = ownerDocument;
    this.parentNode = null;
    this.childNodes = [];
  }

  get parentElement() {
    const p = this.parentNode;
    return p && p.nodeType === ELEMENT_NODE ? p : null;
  }

  get firstChild() { return this.childNodes[0] || null; }
  get lastChild() { return this.childNodes[this.childNodes.length - 1] || null; }

  /** Element-only view. Recomputed per access because Readability reparents
   *  constantly and a cached array would go stale between two of its own lines. */
  get children(): Element[] {
    return this.childNodes.filter((n) => n.nodeType === ELEMENT_NODE) as Element[];
  }
  get firstElementChild(): Element | null { return this.children[0] || null; }
  get lastElementChild(): Element | null { const c = this.children; return c[c.length - 1] || null; }

  #siblingAt(offset: number, elementsOnly: boolean): Node | null {
    const p = this.parentNode;
    if (!p) return null;
    const list = elementsOnly ? p.children : p.childNodes;
    const i = list.indexOf(this);
    return i < 0 ? null : list[i + offset] || null;
  }
  get nextSibling() { return this.#siblingAt(1, false); }
  get previousSibling() { return this.#siblingAt(-1, false); }
  get nextElementSibling(): Element | null { return this.#siblingAt(1, true) as Element | null; }
  get previousElementSibling(): Element | null { return this.#siblingAt(-1, true) as Element | null; }

  appendChild(child) {
    if (child.parentNode) child.parentNode.removeChild(child);
    child.parentNode = this;
    this.childNodes.push(child);
    return child;
  }

  insertBefore(child, ref) {
    if (!ref) return this.appendChild(child);
    if (child.parentNode) child.parentNode.removeChild(child);
    const i = this.childNodes.indexOf(ref);
    child.parentNode = this;
    this.childNodes.splice(i < 0 ? this.childNodes.length : i, 0, child);
    return child;
  }

  removeChild(child) {
    const i = this.childNodes.indexOf(child);
    if (i >= 0) this.childNodes.splice(i, 1);
    child.parentNode = null;
    return child;
  }

  replaceChild(newChild, oldChild) {
    const i = this.childNodes.indexOf(oldChild);
    if (i < 0) return oldChild;
    if (newChild.parentNode) newChild.parentNode.removeChild(newChild);
    newChild.parentNode = this;
    this.childNodes[i] = newChild;
    oldChild.parentNode = null;
    return oldChild;
  }

  remove() { if (this.parentNode) this.parentNode.removeChild(this); }

  /** Overridden by every concrete node. Declared here so a deep clone can walk
   *  childNodes without casting at each step. */
  cloneNode(_deep?: boolean): Node {
    throw new Error("lens dom: cloneNode is implemented by the concrete node types");
  }

  get textContent() {
    let out = "";
    for (const n of this.childNodes) {
      if (n.nodeType === TEXT_NODE) out += (n as Text).data;
      else if (n.nodeType === ELEMENT_NODE) out += n.textContent;
    }
    return out;
  }
  set textContent(value) {
    this.childNodes = [];
    if (value) this.appendChild(new Text(String(value), this.ownerDocument));
  }
}

class Text extends Node {
  data: string;

  constructor(data: string, ownerDocument: Document | null) { super(TEXT_NODE, ownerDocument); this.data = data; }
  get nodeName() { return "#text"; }
  get nodeValue() { return this.data; }
  set nodeValue(v) { this.data = String(v); }
  get textContent() { return this.data; }
  set textContent(v) { this.data = String(v); }
  cloneNode() { return new Text(this.data, this.ownerDocument); }
}

class Comment extends Node {
  data: string;

  constructor(data: string, ownerDocument: Document | null) { super(COMMENT_NODE, ownerDocument); this.data = data; }
  get nodeName() { return "#comment"; }
  get nodeValue() { return this.data; }
  get textContent() { return this.data; }
  cloneNode() { return new Comment(this.data, this.ownerDocument); }
}

/** Readability reads style.display and style.visibility and null-checks the
 *  whole object for SVG and MathML. Two properties is the entire CSSOM this
 *  workload needs, so `cssom` (6.00 KiB gzip) buys nothing here. */
function styleOf(text) {
  const style = { display: "", visibility: "" };
  for (const decl of String(text).split(";")) {
    const i = decl.indexOf(":");
    if (i < 0) continue;
    const prop = decl.slice(0, i).trim().toLowerCase();
    if (prop === "display" || prop === "visibility") style[prop] = decl.slice(i + 1).trim().toLowerCase();
  }
  return style;
}

class Element extends Node {
  localName: string;
  tagName: string;
  /** Serialization-only; see the constructor. */
  svg: boolean;
  attributes: Attr[];

  constructor(localName: string, ownerDocument: Document | null, svg = false) {
    super(ELEMENT_NODE, ownerDocument);
    this.localName = localName;
    // ALWAYS uppercased, SVG included. linkedom derives tagName through
    // localCase(), which reads `ownerDocument[MIME].ignoreCase` — a property of
    // the DOCUMENT, not of the element's namespace. So inside an HTML document
    // an SVG <path> reports tagName "PATH", measured 2026-08-23. This was
    // `svg ? localName : ...` on the reasonable-sounding guess that SVG is
    // case-sensitive, and no page in the corpus could tell the difference
    // because Readability only ever compares tagName against HTML names.
    this.tagName = localName.toUpperCase();
    // Tracked for SERIALIZATION alone: an SVG element with no children
    // self-closes. Nothing else branches on it.
    this.svg = svg;
    /** @type {Attr[]} Real array: Readability indexes it, reads .length, and
     *  passes it to Array.from, all of which an array already satisfies. */
    this.attributes = [];
  }

  get nodeName() { return this.tagName; }

  // EXACT match, deliberately. linkedom parses with lowerCaseAttributeNames
  // false and looks attributes up by identity, so `<IMG SRC=x>` answers null to
  // getAttribute("src") and "" to .src. Folding case here would be more correct
  // and would fail the gate.
  getAttributeNode(name) {
    return this.attributes.find((a) => a.name === name) || null;
  }
  getAttribute(name) { const a = this.getAttributeNode(name); return a ? a.value : null; }
  hasAttribute(name) { return this.getAttributeNode(name) !== null; }
  // A NEW attribute goes to the FRONT. linkedom keeps attributes in a linked
  // list that parsing appends to and setAttribute inserts at the head of, so an
  // element built by API serializes its attributes in reverse order of setting.
  // That is visible in every `content` payload Readability produces, because it
  // creates the readability-page-1 wrapper by hand. Pushing instead of
  // unshifting reorders bytes on the wire for no reason.
  setAttribute(name, value) {
    const key = String(name);
    const next = key === "class" ? normalizeClass(value) : String(value);
    const a = this.getAttributeNode(key);
    if (a) a.value = next;
    else this.attributes.unshift(new Attr(key, next));
  }
  // Note the asymmetry with setAttribute above, which is linkedom's and not a
  // slip: setAttribute UPDATES an existing attribute where it sits, while
  // setAttributeNode REMOVES it and inserts the new node at the head. Both were
  // measured. Readability's _hasSingleTagInsideElement copies a parent's
  // attributes onto its only child with this method, so the difference decides
  // attribute order on any page that hits that path. It cost three of the four
  // real-world diffs in the corpus.
  setAttributeNode(attr) {
    const i = this.attributes.findIndex((a) => a.name === attr.name);
    if (i >= 0) this.attributes.splice(i, 1);
    if (attr.name === "class") attr.value = normalizeClass(attr.value);
    this.attributes.unshift(attr);
    return attr;
  }
  removeAttribute(name) {
    const i = this.attributes.findIndex((a) => a.name === String(name));
    if (i >= 0) this.attributes.splice(i, 1);
  }

  get id() { return this.getAttribute("id") || ""; }
  set id(v) { this.setAttribute("id", v); }
  get className() { return this.getAttribute("class") || ""; }
  set className(v) { this.setAttribute("class", v); }

  // RAW attribute values, deliberately unresolved. See the oracle note at the top.
  get src() { return this.getAttribute("src") || ""; }
  get srcset() { return this.getAttribute("srcset") || ""; }
  get href() { return this.getAttribute("href") || ""; }

  /** null when the element carries no style attribute, which is the branch
   *  Readability's SVG and MathML null-check is written for. */
  get style() {
    const raw = this.getAttribute("style");
    return raw === null ? null : styleOf(raw);
  }

  cloneNode(deep) {
    const copy = new Element(this.localName, this.ownerDocument, this.svg);
    copy.tagName = this.tagName;
    copy.attributes = this.attributes.map((a) => a.cloneNode());
    if (deep) for (const child of this.childNodes) copy.appendChild(child.cloneNode(true));
    return copy;
  }

  get innerHTML() { return serializeChildren(this); }
  set innerHTML(html) {
    this.childNodes = [];
    parseInto(String(html), this, this.ownerDocument);
  }
  get outerHTML() { return serializeNode(this); }

  getElementsByTagName(name: string): Element[] { return collectByTag(this, name); }
  querySelectorAll(selector: string): Element[] { return querySelectorAll(this, selector); }
  querySelector(selector: string): Element | null { return querySelectorAll(this, selector)[0] || null; }
  matches(selector: string): boolean { return matchesSelector(this, parseSelector(selector)); }
  getElementById(id: string): Element | null {
    let found: Element | null = null;
    walk(this, (el) => { if (!found && el.getAttribute("id") === id) found = el; });
    return found;
  }
}

class Document extends Node {
  documentURI: string | undefined;
  baseURI: string | null;
  doctype: string | undefined;

  constructor(url?: string) {
    super(DOCUMENT_NODE, null);
    this.ownerDocument = this;
    // linkedom answers null / undefined when parseHTML gets no URL, and
    // Readability's toAbsoluteURI then throws inside `new URL(uri, baseURI)`
    // and returns the relative href untouched. reader.ts calls parseHTML with
    // one argument, so that IS the production path: links in the payload stay
    // relative. Defaulting these to a real URL here would silently start
    // rewriting every link, which is a payload change wearing a refactor's
    // clothes. Change it deliberately or not at all.
    this.documentURI = url === undefined ? undefined : url;
    this.baseURI = url === undefined ? null : url;
    this.doctype = undefined;
  }
  get nodeName() { return "#document"; }

  // The case passed in SURVIVES on localName, so Readability's
  // createElement("DIV") serializes as <DIV>. linkedom behaves the same way,
  // and its own getElementsByTagName("p") then misses that element while
  // querySelectorAll("p") finds it. Both quirks are reproduced below.
  createElement(tag) { return new Element(String(tag), this); }
  createTextNode(data) { return new Text(String(data), this); }

  // Transcribed from linkedom/esm/html/document.js. Two things about it are
  // surprising enough to be worth stating rather than tidying away.
  //
  // documentElement is simply the FIRST element child, with no preference for
  // <html>. htmlparser2 synthesizes no scaffolding, so parsing the fragment
  // `<div id="lens-root">` makes that div the documentElement, which is exactly
  // what toMarkdown's string fallback relies on.
  //
  // And reading `head` or `body` MUTATES the document: a missing head is
  // created and prepended, a missing body is created and inserted after it.
  // That is destructive on a headless fragment and it is the behaviour every
  // caller here has always had, so reproducing it is the conservative choice.
  // With no documentElement at all, both throw, on both sides.
  get documentElement(): Element | null { return this.children[0] || null; }

  get head(): Element {
    const root = this.documentElement;
    // linkedom throws here too, by destructuring a null documentElement, so an
    // empty document fails on both sides. The message differs and nothing reads
    // it; what matters is that neither one invents a <head> out of nothing.
    if (!root) throw new TypeError("lens dom: document has no documentElement");
    let first = root.firstElementChild;
    if (!first || first.tagName !== "HEAD") {
      first = this.createElement("head");
      root.insertBefore(first, root.firstChild);
    }
    return first;
  }

  get body(): Element {
    // `head` is documentElement's child in both branches above, either found
    // there or inserted there, and it throws when there is no documentElement.
    // So by the time this line runs the parent exists.
    const head = this.head;
    const root = head.parentNode as Element;
    let next = head.nextElementSibling;
    if (!next || next.tagName !== "BODY") {
      next = this.createElement("body");
      root.insertBefore(next, head.nextSibling);
    }
    return next;
  }

  /** Read from HEAD alone, not from the whole tree. A <title> that the parser
   *  left in the body is invisible to linkedom too. */
  get title(): string {
    const t = this.head.getElementsByTagName("title")[0];
    return t ? t.textContent : "";
  }

  getElementsByTagName(name: string): Element[] {
    const root = this.documentElement;
    return root ? collectByTag(root, name, true) : [];
  }
  querySelectorAll(selector: string): Element[] {
    const root = this.documentElement;
    return root ? querySelectorAll(root, selector, true) : [];
  }
  querySelector(selector: string): Element | null { return this.querySelectorAll(selector)[0] || null; }
  /** INCLUSIVE of documentElement, which the element-level walk is not. The
   *  fragment fallback asks for the id on the root element itself. */
  getElementById(id: string): Element | null {
    const root = this.documentElement;
    if (!root) return null;
    return root.getAttribute("id") === id ? root : root.getElementById(id);
  }
}

// ── traversal ───────────────────────────────────────────────────────────────

/**
 * Depth-first, document order, elements only.
 *
 * `skipTemplates` reproduces a real linkedom asymmetry rather than a preference:
 * its CSS selector engine does NOT descend into <template>, while its
 * getElementsByTagName does, and the children serialize inline either way.
 * Measured on the declarative shadow DOM in /garage/horizon, where a <style>
 * inside a <template> is invisible to querySelectorAll("style") and therefore
 * survives Readability's style-stripping pass. Walk into it and the payload
 * loses 226 bytes of that page.
 */
function walk(node: Node, visit: (el: Element) => void, skipTemplates = false): void {
  for (const child of node.childNodes) {
    // instanceof rather than a nodeType compare, so the narrowing survives into
    // visit() and the template check below.
    if (!(child instanceof Element)) continue;
    visit(child);
    if (skipTemplates && child.localName.toLowerCase() === "template") continue;
    walk(child, visit, skipTemplates);
  }
}

/** Case-SENSITIVE on localName, matching linkedom. See createElement above. */
function collectByTag(root: Node, name: string, includeRoot = false): Element[] {
  const want = String(name);
  const all = want === "*";
  const out: Element[] = [];
  if (includeRoot && root instanceof Element && (all || root.localName === want)) out.push(root);
  walk(root, (el) => { if (all || el.localName === want) out.push(el); });
  return out;
}

// ── the selector grammar, which is as small as the workload ─────────────────
//
/** One arm of the comma list: a tag, an attribute test, or both. */
type Compound = { tag: string | null; attr: string | null; value: string | null };

// Supported: a comma list of `tag`, `[attr]`, `[attr=value]`, and `tag[attr=value]`.
// That covers every selector Readability builds (tag lists, via
// _getAllNodesWithTag) and collectControlLabels' one richer query. An
// unsupported selector THROWS rather than silently matching nothing, because a
// selector that quietly returns [] reads as a page with no controls.

function parseSelector(selector: string): Compound[] {
  return String(selector).split(",").map((part) => {
    const raw = part.trim();
    const m = /^([a-zA-Z][\w-]*)?(?:\[([\w-]+)(?:=["']?([^\]"']*)["']?)?\])?$/.exec(raw);
    if (!m || (!m[1] && !m[2])) {
      throw new Error(`lens dom: unsupported selector ${JSON.stringify(raw)}`);
    }
    return { tag: m[1] ? m[1].toLowerCase() : null, attr: m[2] || null, value: m[3] === undefined ? null : m[3] };
  });
}

function matchesSelector(el: Element, compounds: Compound[]): boolean {
  return compounds.some((c) => {
    // Case-INSENSITIVE here, where getElementsByTagName is not. This is the
    // asymmetry linkedom has and Readability relies on: _getAllNodesWithTag
    // prefers querySelectorAll, which is how a createElement("DIV") wrapper
    // keeps being found by later passes looking for "div".
    if (c.tag && el.localName.toLowerCase() !== c.tag) return false;
    if (!c.attr) return true;
    const v = el.getAttribute(c.attr);
    if (v === null) return false;
    return c.value === null || v === c.value;
  });
}

function querySelectorAll(root: Node, selector: string, includeRoot = false): Element[] {
  const compounds = parseSelector(selector);
  const out: Element[] = [];
  if (includeRoot && root instanceof Element && matchesSelector(root, compounds)) out.push(root);
  walk(root, (el) => { if (matchesSelector(el, compounds)) out.push(el); }, true);
  return out;
}

// ── serialization ───────────────────────────────────────────────────────────

function serializeChildren(node) {
  let out = "";
  for (const child of node.childNodes) out += serializeNode(child);
  return out;
}

function serializeNode(node) {
  switch (node.nodeType) {
    case TEXT_NODE:
      return node.parentNode && RAW_TEXT.has(node.parentNode.localName)
        ? node.data
        : escapeText(node.data);
    case COMMENT_NODE: return `<!--${node.data}-->`;
    case ELEMENT_NODE: {
      let attrs = "";
      for (const a of node.attributes) {
        const text = serializeAttr(a);
        if (text !== null) attrs += ` ${text}`;
      }
      const tag = node.localName;
      const inner = serializeChildren(node);
      // An SVG element with no children self-closes, which is XML serialization
      // and is checked BEFORE the HTML void list. An HTML void element never
      // self-closes. Both branches are linkedom's, in that order.
      if (node.svg) return inner === "" ? `<${tag}${attrs} />` : `<${tag}${attrs}>${inner}</${tag}>`;
      if (VOID.has(tag)) return `<${tag}${attrs}>`;
      return `<${tag}${attrs}>${inner}</${tag}>`;
    }
    default: return serializeChildren(node);
  }
}

// ── parsing ─────────────────────────────────────────────────────────────────

/** Streams htmlparser2's events straight into this DOM. domhandler is skipped
 *  on purpose: it would build a second tree we immediately throw away. */
// Copied from linkedom/esm/shared/parse-from-string.js rather than chosen.
// lowerCaseTags is left at its HTML-mode default of true; recognizeSelfClosing
// is left OFF, so `<div />` does NOT self-close, exactly as linkedom sees it.
const PARSER_OPTIONS = { lowerCaseAttributeNames: false, decodeEntities: true, xmlMode: false };

function parseInto(html, root, ownerDocument) {
  let current = root;
  let svgRoot: Element | null = null;
  const parser = new Parser({
    onopentag(name, attribs) {
      const svg = svgRoot !== null || name === "svg" || name === "SVG";
      const el = new Element(name, ownerDocument, svg);
        // Parsing APPENDS in source order; only setAttribute prepends. `class`
      // is normalized here too, because linkedom's parser assigns it through
      // element.className rather than storing the raw attribute.
      for (const [k, v] of Object.entries(attribs)) {
        el.attributes.push(new Attr(k, k === "class" ? normalizeClass(v) : v));
      }
      if (svgRoot === null && svg) svgRoot = el;
      current.appendChild(el);
      current = el;
    },
    onclosetag() {
      if (current === svgRoot) svgRoot = null;
      if (current !== root && current.parentNode) current = current.parentNode;
    },
    ontext(text) { current.appendChild(new Text(text, ownerDocument)); },
    oncomment(data) { current.appendChild(new Comment(data, ownerDocument)); },
    // <!DOCTYPE html> is recorded on the document rather than appended as a
    // child, which is what linkedom does. It matters: Readability's constructor
    // reads `doc.firstChild.__JSDOMParser__` with no null guard, so firstChild
    // has to be the <html> element on both sides or the two disagree about what
    // the first child even is.
    onprocessinginstruction(name, data) {
      if (String(name).toLowerCase() === "!doctype" && ownerDocument.doctype === undefined) {
        ownerDocument.doctype = data.slice(String(name).length).trim();
      }
    },
  }, PARSER_OPTIONS);
  parser.write(html);
  parser.end();
  return root;
}

/**
 * Drop-in for linkedom's parseHTML, narrowed to what this Worker calls.
 * @param html
 * @param url becomes documentURI and baseURI, which Readability reads when it
 *   rewrites relative links. reader.ts passes NONE, which is why links in the
 *   payload stay relative; see the Document constructor.
 */
export function parseHTML(html: string, url?: string) {
  const document = new Document(url);
  parseInto(String(html), document, document);

  // No scaffolding is synthesized here, deliberately. htmlparser2 keeps only
  // what the source contained and linkedom does the same, deferring every
  // repair to the head/body getters above. Building an <html>/<body> shell at
  // parse time would move documentElement and change what Readability sees.
  return { document, window: undefined };
}
