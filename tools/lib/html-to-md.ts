// html-to-md.mjs — the downleveled-render half of the Markdown twin.

import { closeTagSource } from "./html-raw-text.ts";

// schemes that execute rather than address. Read the way a BROWSER reads one
// rather than the way a source file writes one: it strips leading C0 controls
// and space before the scheme and then matches case-insensitively, so
// `JavaScript:` and a tab-prefixed `\tdata:` both run and both must be refused.
// The strip is a loop rather than a `[\u0000-\u0020]*` prefix because oxlint's
// no-control-regex refuses that class, and a suppression buys nothing here.
const UNSAFE_SCHEME = /^(?:javascript|data|vbscript):/i;
function executesRatherThanAddresses(href) {
  let i = 0;
  while (i < href.length && href.charCodeAt(i) <= 0x20) i++;
  return UNSAFE_SCHEME.test(href.slice(i));
}

const VOID = new Set("area base br col embed hr img input link meta param source track wbr".split(" "));

const RAW_TEXT = new Set(["script", "style", "textarea", "title"]);

const RAW_TEXT_DISCARD = new Set(["script", "style"]);

const DROP = new Set([
  "script", "style", "noscript", "template", "svg", "canvas", "iframe", "object",
  "head", "meta", "link", "form",
  "button", "input", "select", "option", "textarea", "label", "output",
]);

const DROP_ID = new Set(["axp-desktop", "luq"]);
const DROP_CLASS = new Set(["title-bar", "controls", "status", "modebar", "readouts", "meter"]);

const TRANSPARENT = new Set([
  "html", "body", "div", "section", "article", "aside", "main", "nav", "header",
  "footer", "colgroup", "tbody", "thead", "tfoot", "hgroup", "address", "fieldset",
]);

const BLOCK = new Set([
  ...TRANSPARENT,
  "h1", "h2", "h3", "h4", "h5", "h6", "p", "hr", "pre", "blockquote",
  "ul", "ol", "li", "dl", "dt", "dd", "table", "tr", "td", "th",
  "details", "summary", "figure", "figcaption", "caption",
]);

const DROP_CLASS_INLINE = new Set(["bay-no"]);

const OUT_OF_FLOW = /(?:display\s*:\s*(?:block|flex|grid|list-item|table)|float\s*:\s*(?:left|right)|(?:^|[;{\s])flex\s*:|flex-basis\s*:|grid-(?:area|column|row)\s*:)/i;

const SELF_TOKEN = new Set(["img"]);

const CONTAINER = /display\s*:\s*(?:flex|grid)\b/i;

export function collectBlockClasses(html) { return new Set(rulesWhere(html, OUT_OF_FLOW).keys()); }

export function collectContainerClasses(html): Map<string, number> {
  const found = new Map<string, number>();
  const columns = rulesWhere(html, /grid-template-columns/i);
  for (const [cls, own] of rulesWhere(html, CONTAINER)) {
    const decls = own + ";" + (columns.get(cls) ?? "");
    const flex = /display\s*:\s*flex\b/i.test(decls);
    const across = flex ? (/flex-(?:direction|flow)\s*:\s*column|flex-(?:wrap|flow)\s*:[^;]*\bwrap\b/i.test(decls) ? 1 : Infinity) : gridColumns(decls);
    found.set(cls, Math.max(found.get(cls) ?? 1, across));
  }
  return found;
}

function gridColumns(decls: string): number {
  let widest = 1;
  for (const m of decls.matchAll(/grid-template-columns\s*:\s*([^;}]+)/gi)) widest = Math.max(widest, tracks(m[1]));
  return widest;
}

function tracks(value: string): number {
  if (/auto-(?:fill|fit)|\[|subgrid|masonry/i.test(value)) return 1;
  const count = (v: string): number => {
    let n = 0, depth = 0, token = "";
    const end = () => { if (token.trim()) n += 1; token = ""; };
    for (let i = 0; i < v.length; i++) {
      const ch = v[i];
      if (depth === 0 && v.startsWith("repeat(", i)) {
        let j = i + 7, d = 1;
        while (j < v.length && d) { if (v[j] === "(") d++; else if (v[j] === ")") d--; j++; }
        const inner = v.slice(i + 7, j - 1), comma = inner.indexOf(",");
        n += Number(inner.slice(0, comma)) * count(inner.slice(comma + 1));
        token = ""; i = j - 1; continue;
      }
      if (ch === "(") depth++; else if (ch === ")") depth--;
      if (depth === 0 && /\s/.test(ch)) end(); else token += ch;
    }
    end();
    return n;
  };
  const n = count(value.trim());
  return Number.isFinite(n) && n > 0 ? n : 1;
}

function rulesWhere(html, test: RegExp): Map<string, string> {
  const found = new Map<string, string>();
  for (const style of html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)) {
    const css = style[1].replace(/\/\*[\s\S]*?\*\//g, "");
    for (const rule of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      if (!test.test(rule[2])) continue;
      for (const sel of rule[1].split(",")) {
        const m = /\.([A-Za-z_][\w-]*)\s*$/.exec(sel.trim());
        if (m) found.set(m[1], (found.get(m[1]) ?? "") + ";" + rule[2]);
      }
    }
  }
  return found;
}

// an open <p> is closed by any of these starting (HTML spec 13.1.2.4, the end
// tags a minifier may leave out; the minifier check reads whole documents, so
// <head>, the table sections and <optgroup> are here as well as <p> and <li>)
const IMPLIED_CLOSE = {
  head: new Set(["body"]),
  thead: new Set(["tbody", "tfoot"]),
  tbody: new Set(["tbody", "tfoot"]),
  optgroup: new Set(["optgroup"]),
  p: new Set("address article aside blockquote details dialog div dl fieldset figcaption figure footer form h1 h2 h3 h4 h5 h6 header hgroup hr main menu nav ol p pre search section table ul".split(" ")),
  li: new Set(["li"]),
  dt: new Set(["dt", "dd"]),
  dd: new Set(["dt", "dd"]),
  td: new Set(["td", "th", "tr", "thead", "tbody", "tfoot"]),
  th: new Set(["td", "th", "tr", "thead", "tbody", "tfoot"]),
  tr: new Set(["tr", "thead", "tbody", "tfoot"]),
  option: new Set(["option", "optgroup"]),
};

const ENTITIES = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00a0", hellip: "\u2026",
  mdash: "\u2014", ndash: "\u2013", times: "\u00d7", middot: "\u00b7", deg: "\u00b0",
  laquo: "\u00ab", raquo: "\u00bb", ldquo: "\u201c", rdquo: "\u201d", lsquo: "\u2018",
  rsquo: "\u2019", larr: "\u2190", rarr: "\u2192", uarr: "\u2191", darr: "\u2193",
  check: "\u2713", copy: "\u00a9", reg: "\u00ae", trade: "\u2122", eacute: "\u00e9",
  egrave: "\u00e8", agrave: "\u00e0", ccedil: "\u00e7", uuml: "\u00fc", ouml: "\u00f6",
  auml: "\u00e4", szlig: "\u00df", ntilde: "\u00f1", minus: "\u2212", plusmn: "\u00b1",
  frac12: "\u00bd", sup2: "\u00b2", sup3: "\u00b3", micro: "\u00b5", infin: "\u221e",
  ne: "\u2260", le: "\u2264", ge: "\u2265", asymp: "\u2248", bull: "\u2022",
  divide: "\u00f7", rsaquo: "\u203a", lsaquo: "\u2039", nacute: "\u0144", chi: "\u03c7",
  dagger: "\u2020", Dagger: "\u2021", approx: "\u2248", boxbox: "\u29c9", blacktriangle: "\u25b4",
};

export function decodeEntities(s) {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (m, body) => {
    if (body[0] === "#") {
      const cp = body[1] === "x" || body[1] === "X"
        ? parseInt(body.slice(2), 16)
        : parseInt(body.slice(1), 10);
      return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
    }
    const hit = ENTITIES[body];
    return hit === undefined ? m : hit;
  });
}

type Attrs = Record<string, string>;

type Token =
  | { t: "text", v: string, raw?: false, owner?: undefined }
  | { t: "text", v: string, raw: true, owner: string }
  | { t: "open", name: string, attrs: Attrs, self: boolean }
  | { t: "close", name: string };

type TextNode = { name: "#text", value: string };
type ElementNode = { name: string, attrs: Attrs, children: Node[] };
type Node = TextNode | ElementNode;

function tokenize(html) {
  const tokens: Token[] = [];
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt === -1) {
      if (i < html.length) tokens.push({ t: "text", v: html.slice(i) });
      break;
    }
    if (lt > i) tokens.push({ t: "text", v: html.slice(i, lt) });

    if (html.startsWith("<!--", lt)) {
      const end = html.indexOf("-->", lt + 4);
      i = end === -1 ? html.length : end + 3;
      continue;
    }
    if (html.startsWith("<!", lt)) {
      const end = html.indexOf(">", lt);
      i = end === -1 ? html.length : end + 1;
      continue;
    }
    if (html.startsWith("</", lt)) {
      const end = html.indexOf(">", lt);
      if (end === -1) { i = html.length; break; }
      tokens.push({ t: "close", name: html.slice(lt + 2, end).trim().toLowerCase() });
      i = end + 1;
      continue;
    }

    const tag = readTag(html, lt);
    if (!tag) { tokens.push({ t: "text", v: "<" }); i = lt + 1; continue; }
    tokens.push({ t: "open", name: tag.name, attrs: tag.attrs, self: tag.self });
    i = tag.end;

    if (RAW_TEXT.has(tag.name) && !tag.self) {
      const closeRe = new RegExp(closeTagSource(tag.name), "i");
      const rest = html.slice(i);
      const m = closeRe.exec(rest);
      const body = m ? rest.slice(0, m.index) : rest;
      tokens.push({ t: "text", v: body, raw: true, owner: tag.name });
      tokens.push({ t: "close", name: tag.name });
      i += m ? m.index + m[0].length : rest.length;
    }
  }
  return tokens;
}

function readTag(html, start) {
  const nameMatch = /^<([a-zA-Z][a-zA-Z0-9:-]*)/.exec(html.slice(start));
  if (!nameMatch) return null;
  const name = nameMatch[1].toLowerCase();
  let i = start + nameMatch[0].length;
  const attrs = {};
  let self = false;

  while (i < html.length) {
    while (i < html.length && /\s/.test(html[i])) i++;
    if (html[i] === ">") { i++; break; }
    if (html[i] === "/" && html[i + 1] === ">") { self = true; i += 2; break; }
    const an = /^[^\s=/>]+/.exec(html.slice(i));
    if (!an) { i++; continue; }
    const attr = an[0].toLowerCase();
    i += an[0].length;
    while (i < html.length && /\s/.test(html[i])) i++;
    if (html[i] !== "=") { attrs[attr] = ""; continue; }
    i++;
    while (i < html.length && /\s/.test(html[i])) i++;
    const q = html[i];
    if (q === '"' || q === "'") {
      const end = html.indexOf(q, i + 1);
      attrs[attr] = decodeEntities(html.slice(i + 1, end === -1 ? html.length : end));
      i = end === -1 ? html.length : end + 1;
    } else {
      const uv = /^[^\s>]*/.exec(html.slice(i))?.[0] ?? "";
      attrs[attr] = decodeEntities(uv);
      i += uv.length;
    }
  }
  return { name, attrs, self, end: i };
}

export { parse as parseHtml };

function parse(html) {
  const root: ElementNode = { name: "#root", attrs: {}, children: [] };
  const stack: ElementNode[] = [root];
  const top = () => stack[stack.length - 1];

  for (const tk of tokenize(html)) {
    if (tk.t === "text") {
      if (tk.raw && RAW_TEXT_DISCARD.has(tk.owner)) continue;
      top().children.push({ name: "#text", value: decodeEntities(tk.v) });
      continue;
    }
    if (tk.t === "open") {
      for (;;) {
        const cur = top();
        const implied = IMPLIED_CLOSE[cur.name];
        if (implied && implied.has(tk.name)) stack.pop();
        else break;
      }
      const node = { name: tk.name, attrs: tk.attrs, children: [] };
      top().children.push(node);
      if (!tk.self && !VOID.has(tk.name)) stack.push(node);
      continue;
    }
    const idx = stack.map((n) => n.name).lastIndexOf(tk.name);
    if (idx > 0) stack.length = idx;
  }
  return root;
}

const dropped = (node) => {
  if (DROP.has(node.name)) return true;
  const id = node.attrs?.id;
  if (id && DROP_ID.has(id)) return true;
  const cls = (node.attrs?.class || "").split(/\s+/).filter(Boolean);
  if (cls.some((c) => DROP_CLASS.has(c) || DROP_CLASS_INLINE.has(c))) return true;
  if (node.attrs?.["aria-hidden"] === "true") return true;
  return false;
};

const hasClass = (node, name) => (node.attrs?.class || "").split(/\s+/).includes(name);
const across = (node, ctx): number => {
  let n = 0;
  for (const c of (node.attrs?.class || "").split(/\s+/)) n = Math.max(n, ctx.containerClasses?.get(c) ?? 0);
  return n;
};
const isContainer = (node, ctx) => across(node, ctx) > 0;

const INLINE_TOKEN = new Set(["a", "b", "strong", "em", "i", "cite", "var", "code", "kbd", "samp", "sup", "sub", "del", "s", "img"]);

const STRUCTURED = /\n|^(?:#{1,6} |```|\||[-*+] |> |\d+\. )/;
function renderChildren(node, ctx, depth) {
  const width = across(node, ctx);
  if (!width) return renderBlocks(node.children || [], ctx, depth);
  const boxes = (node.children || []).filter((c) => !dropped(c) && (!isText(c) || squeeze(c.value).trim()));
  const cells = boxes.map((c) => (isText(c) || INLINE_TOKEN.has(c.name) || BLOCK.has(c.name)
    ? renderBlocks([c], ctx, depth) : renderChildren(c, ctx, depth)).trim());
  const rows: string[] = [];
  const step = Number.isFinite(width) ? width : cells.length;
  for (let i = 0; i < cells.length; i += step) {
    const row = cells.slice(i, i + step).filter(Boolean);
    if (row.some((c) => STRUCTURED.test(c))) rows.push(...row);
    else if (row.length) rows.push(row.join(" · "));
  }
  return rows.join("\n\n");
}

const isText = (n) => n.name === "#text";
const EMPTY = new Set();

const squeeze = (s) => s.replace(/\s+/g, " ");

const escapeMd = (s) => s.replace(/([\\`*_[\]<>])/g, "\\$1");

// Markers that start a block only at the start of a LINE, so they are escaped
// once a block's text is assembled, never per text node. Per node, the rule
// fired mid-sentence: /garage/octane's `<a>Next.js</a> 16. That…` became
// `Next.js \16.`, and a backslash before a digit is no escape in CommonMark, so
// every reader saw it. An ordered marker escapes its period (`16\.`), the one
// character CommonMark will unescape there.
const escapeLineStarts = (s) => s
  .replace(/^(\s*)([#>+-])(?=\s)/gm, "$1\\$2")
  .replace(/^(\s*)(\d+)\.(?=\s)/gm, "$1$2\\.");

function renderInline(nodes, ctx) {
  let out = "";
  for (const n of nodes) {
    if (isText(n)) {
      if (ctx.raw) { out += n.value; continue; }
      const t = escapeMd(squeeze(n.value));
      out += t.startsWith(" ") && /\s$/.test(out) ? t.slice(1) : t;
      continue;
    }
    if (dropped(n)) continue;
    switch (n.name) {
      // Inside a table cell a hard break would end the row, so the cell keeps
      // <br>, which GFM reads there. Elsewhere it is the Markdown hard break.
      case "br": out += ctx.inCell ? "<br>" : "  \n"; break;
      case "code": case "kbd": case "samp": {
        const t = textOf(n);
        const ticks = "`".repeat(Math.max(1, longestRun(t, "`") + 1));
        out += t ? `${ticks}${t.includes("`") ? " " : ""}${t}${t.includes("`") ? " " : ""}${ticks}` : "";
        break;
      }
      case "strong": case "b": {
        const inner = renderInline(n.children, ctx).trim();
        out += inner ? `**${inner}**` : "";
        break;
      }
      case "em": case "i": case "cite": case "var": {
        const inner = renderInline(n.children, ctx).trim();
        out += inner ? `*${inner}*` : "";
        break;
      }
      case "a": {
        const inner = renderInline(n.children, ctx).trim();
        const href = n.attrs.href || "";
        if (!inner) break;
        if (!href || href.startsWith("#") || executesRatherThanAddresses(href)) { out += inner; break; }
        const key = hasClass(n, "term") ? (n.attrs["data-t"] || "") : "";
        const title = (n.attrs.title || "").trim();
        if (ctx.terms && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(key) && title) {
          if (!ctx.terms.has(key)) ctx.terms.set(key, { href: absolute(href, ctx.origin), title });
          out += `[${inner}][${key}]`;
          break;
        }
        out += `[${inner}](${absolute(href, ctx.origin)})`;
        break;
      }
      case "img": {
        const alt = (n.attrs.alt || "").trim();
        const src = n.attrs.src || "";
        if (!src || !alt) break;
        out += `![${escapeMd(alt)}](${absolute(src, ctx.origin)})`;
        break;
      }
      case "sup": out += `^${renderInline(n.children, ctx).trim()}`; break;
      case "sub": out += `_${renderInline(n.children, ctx).trim()}`; break;
      case "del": case "s": out += `~~${renderInline(n.children, ctx).trim()}~~`; break;
      default: out += renderInline(n.children, ctx);
    }
  }
  return out;
}

const longestRun = (s, ch) => {
  let best = 0, cur = 0;
  for (const c of s) { cur = c === ch ? cur + 1 : 0; if (cur > best) best = cur; }
  return best;
};

function textOf(node) {
  if (isText(node)) return node.value;
  if (dropped(node)) return "";
  return (node.children || []).map(textOf).join("");
}

export function absolute(href, origin) {
  if (!origin) return href;
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("//")) return href;
  if (href.startsWith("/")) return origin + href;
  return href;
}

function renderBlocks(nodes, ctx, depth = 0) {
  const out: string[] = [];
  let run: string[] = [];
  const flush = () => {
    if (!run.length) return;
    const s = escapeLineStarts(renderInline(run, ctx).replace(/[ \t]+\n/g, "  \n").trim());
    run = [];
    if (s) out.push(s);
  };

  for (const n of nodes) {
    if (isText(n)) {
      if (squeeze(n.value).trim() || run.length) run.push(n);
      continue;
    }
    if (dropped(n)) continue;
    const cls = (n.attrs?.class || "").split(/\s+/).filter(Boolean);
    const promoted = ctx.blockClasses || EMPTY;
    const isBlock = BLOCK.has(n.name)
      || (!SELF_TOKEN.has(n.name) && cls.some((c) => promoted.has(c)));
    if (!isBlock) { run.push(n); continue; }
    flush();

    switch (n.name) {
      case "h1": case "h2": case "h3": case "h4": case "h5": case "h6": {
        const level = Number(n.name[1]);
        const promotedChild = (n.children || []).some((c) => !isText(c)
          && (c.attrs?.class || "").split(/\s+/).some((k) => (ctx.blockClasses || EMPTY).has(k)));
        const s = (promotedChild
          ? renderBlocks(n.children, ctx, depth).split(/\n{2,}/).map((b) => b.replace(/\n/g, " ").trim()).filter(Boolean).join(" · ")
          : renderInline(n.children, ctx)).trim();
        if (s) out.push(`${"#".repeat(level)} ${s}`);
        break;
      }
      case "p": case "figcaption": case "summary": case "caption": {
        const s = renderChildren(n, ctx, depth).trim();
        if (!s) break;
        const caption = n.name === "figcaption" || n.name === "caption";
        out.push(caption ? s.replace(/\n{2,}/g, " · ") : s);
        break;
      }
      case "a": {
        const inner = renderChildren(n, ctx, depth).trim()
          .split(/\n{2,}/).map((b) => b.replace(/^#{1,6} /, "").replace(/\n/g, " ").trim()).filter(Boolean).join(" · ");
        if (!inner) break;
        const href = n.attrs.href || "";
        out.push(!href || href.startsWith("#") || executesRatherThanAddresses(href) ? inner : `[${inner}](${absolute(href, ctx.origin)})`);
        break;
      }
      case "hr": out.push("---"); break;
      case "pre": {
        const t = textOf(n).replace(/^\n/, "").replace(/\s+$/, "");
        if (t) out.push("```\n" + t + "\n```");
        break;
      }
      case "blockquote": {
        const inner = renderBlocks(n.children, ctx, depth);
        if (inner.trim()) out.push(inner.split("\n").map((l) => (l ? `> ${l}` : ">")).join("\n"));
        break;
      }
      case "ul": case "ol": {
        const items = n.children.filter((c) => c.name === "li" && !dropped(c));
        const lines = items.map((li, k) => {
          const marker = n.name === "ol" ? `${k + 1}.` : "-";
          const body = renderChildren(li, ctx, depth + 1).trim();
          const pad = " ".repeat(marker.length + 1);
          return `${marker} ${body.split("\n").join("\n" + pad)}`;
        });
        if (lines.length) out.push(lines.join("\n"));
        break;
      }
      case "dl": {
        const lines: string[] = [];
        for (const c of n.children) {
          if (dropped(c)) continue;
          if (c.name === "dt") lines.push(`- **${renderInline(c.children, ctx).trim()}**`);
          else if (c.name === "dd") lines.push(`  ${escapeLineStarts(renderInline(c.children, ctx).trim())}`);
        }
        if (lines.length) out.push(lines.join("\n"));
        break;
      }
      case "table": {
        for (const c of n.children || []) {
          if (c.name === "caption" && !dropped(c)) {
            const cap = renderBlocks([c], ctx, depth);
            if (cap) out.push(cap);
          }
        }
        const t = renderTable(n, ctx);
        if (t) out.push(t);
        break;
      }
      case "details": {
        const inner = renderBlocks(n.children, ctx, depth).trim();
        if (inner) out.push(inner);
        break;
      }
      case "figure": {
        const inner = renderBlocks(n.children, ctx, depth).trim();
        if (inner) out.push(inner);
        break;
      }
      default: {
        if (hasClass(n, "cap-strip")) {
          const chips: string[] = [];
          const collect = (x) => {
            if (isText(x)) return;
            if (hasClass(x, "chip")) chips.push(textOf(x).trim());
            else (x.children || []).forEach(collect);
          };
          collect(n);
          if (chips.length) out.push(`Tags: ${chips.filter(Boolean).join(", ")}`);
          break;
        }
        const inner = renderChildren(n, ctx, depth);
        if (inner.trim()) out.push(inner);
      }
    }
  }
  flush();
  while (out.length && out[out.length - 1] === "---") out.pop();
  return out.join("\n\n");
}

function renderTable(table, outer) {
  const ctx = { ...outer, inCell: true };
  const rows: { cells: string[], head: boolean }[] = [];
  const walk = (node) => {
    for (const c of node.children || []) {
      if (dropped(c)) continue;
      if (c.name === "tr") {
        // The pipe escape looks like it forgot to escape backslashes, and CodeQL's
        // js/incomplete-sanitization reads it that way. It is correct here, and the
        // reason is that a GFM table cell is unescaped TWICE: the table stage turns
        // `\|` into `|` and copies every other backslash through untouched, and only
        // then does inline parsing run, where `\\` becomes one backslash. Text nodes
        // arrive with their backslashes already doubled by escapeMd, so one literal
        // backslash before a pipe reaches the wire as three, which is exactly what
        // survives both stages. Code spans arrive undoubled and are correct undoubled,
        // since a backslash inside a code span is literal.
        //
        // Doubling here would therefore CREATE the bug, not fix it. Measured against
        // GitHub's own GFM renderer on 2026-08-24 over pipes, backslash-then-pipe,
        // double-backslash-then-pipe, lone and trailing backslashes, in both a text
        // and a code-span cell: 10 of 10 round-tripped to the source content, no cell
        // split and no backslash lost. contract-md-table-escapes.test.mjs pins the
        // bytes that measurement blessed. `ctx.raw` is never set, so there is no
        // third path that skips escapeMd.
        const cells = (c.children || [])
          .filter((d) => (d.name === "td" || d.name === "th") && !dropped(d))
          .map((d) => renderInline(d.children, ctx).replace(/\|/g, "\\|").replace(/ {2}\n/g, "<br>").replace(/\n/g, " ").trim());
        if (cells.length) rows.push({ cells, head: (c.children || []).some((d) => d.name === "th") });
      } else walk(c);
    }
  };
  walk(table);
  if (!rows.length) return "";

  const width = Math.max(...rows.map((r) => r.cells.length));
  const pad = (r) => { const c = r.cells.slice(); while (c.length < width) c.push(""); return c; };
  const head = rows[0].head ? pad(rows[0]) : Array(width).fill("");
  const body = rows.slice(rows[0].head ? 1 : 0);

  const lines = [
    `| ${head.join(" | ")} |`,
    `| ${Array(width).fill("---").join(" | ")} |`,
    ...body.map((r) => `| ${pad(r).join(" | ")} |`),
  ];
  return lines.join("\n");
}

function renderText(nodes, ctx, items = false) {
  let out = "";
  for (const n of nodes) {
    if (isText(n)) { out += n.value; continue; }
    if (dropped(n)) continue;
    if (n.name === "img") { out += ` ${n.attrs.alt || ""} `; continue; }
    if (n.name === "br" || n.name === "hr") { out += " "; continue; }
    const inner = renderText(n.children, ctx, isContainer(n, ctx));
    const block = items || BLOCK.has(n.name) || (n.attrs.class || "").split(/\s+/).some((c) => ctx.blockClasses.has(c));
    out += block ? ` ${inner} ` : inner;
  }
  return out;
}

function glossary(terms: Map<string, { href: string; title: string }>): string {
  const quote = (t: string) => t.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\s+/g, " ");
  return [...terms].map(([key, { href, title }]) => `[${key}]: ${href} "${quote(title)}"`).join("\n");
}

export function readDocument(html, { origin = "https://aadhar.sh", format = "markdown" }: { origin?: string; format?: "markdown" | "text" } = {}) {
  const root = parse(html);
  const meta = collectMeta(root);
  const content = findContent(root);
  const terms = new Map<string, { href: string; title: string }>();
  const ctx = { origin, blockClasses: collectBlockClasses(html), containerClasses: collectContainerClasses(html), terms };
  if (format === "text") return { ...meta, body: squeeze(renderText(content.children, ctx, isContainer(content, ctx))).trim() };
  const body = renderChildren(content, ctx, 0).replace(/\n{3,}/g, "\n\n").trim();
  return { ...meta, body: terms.size ? `${body}\n\n${glossary(terms)}` : body };
}

function collectMeta(root) {
  const out: { title: string, description: string, canonical: string, status: string[] } =
    { title: "", description: "", canonical: "", status: [] };
  const visit = (n) => {
    if (isText(n)) return;
    if (n.name === "title" && !out.title) out.title = textOf(n).trim();
    if (n.name === "meta") {
      const key = (n.attrs.name || n.attrs.property || "").toLowerCase();
      if (key === "description" && !out.description) out.description = (n.attrs.content || "").trim();
      if (key === "og:description" && !out.description) out.description = (n.attrs.content || "").trim();
    }
    if (n.name === "link" && (n.attrs.rel || "").toLowerCase() === "canonical") {
      out.canonical = n.attrs.href || "";
    }
    if (n.name === "div" && (n.attrs.class || "").split(/\s+/).includes("status")) {
      for (const c of n.children || []) {
        const t = textOf(c).trim();
        if (t) out.status.push(t);
      }
    }
    for (const c of n.children || []) visit(c);
  };
  visit(root);
  out.title = decodeEntities(out.title);
  return out;
}

function findContent(root) {
  let main = null, body = null, contentDiv = null;
  const visit = (n) => {
    if (isText(n)) return;
    const cls = (n.attrs?.class || "").split(/\s+/);
    if (!contentDiv && cls.includes("content")) contentDiv = n;
    if (!main && n.name === "main") main = n;
    if (!body && n.name === "body") body = n;
    for (const c of n.children || []) visit(c);
  };
  visit(root);
  return contentDiv || main || body || root;
}
