// html-to-md.mjs — the downleveled-render half of the Markdown twin.
//
// Hand-rolled on purpose. The input is a CLOSED set: the 31 static pages this
// repo authors itself, all of them well-formed and all of them checked by
// `pnpm run pages:check`. A general-purpose parser would buy robustness against
// markup we never write, at the cost of a dependency the DEPENDENCIES.md policy
// would have to justify forever. zenc, gen-manifest, and check-photo-pipeline
// were all built the same way for the same reason.
//
// Two rules matter more than the rest:
//   1. RAW-TEXT elements (script, style) are tokenized as opaque blobs and
//      dropped. This is not an optimization. Every garage/lwe page carries a
//      <script type="application/json" id="luq-data"> holding the understanding
//      check's questions AND its answer key, so a converter that walked into
//      script bodies would publish the answers as prose.
//   2. Interactive controls render nothing. A <button> in a live demo is not
//      content; its label without its behavior is a lie an agent would read as
//      fact. The prose AROUND the demo still converts, which is the honest part.

// void elements never have children and never close
const VOID = new Set("area base br col embed hr img input link meta param source track wbr".split(" "));

// tokenized as opaque text runs: the spec says their content is not markup, and
// for #luq-data specifically it is an answer key we must never emit
const RAW_TEXT = new Set(["script", "style", "textarea", "title"]);

// of those, the two whose text must never reach the tree at all. <title> and
// <textarea> are raw-text for TOKENIZING reasons only; their content is real
// page text. <script>/<style> content is not, and #luq-data's is an answer key.
const RAW_TEXT_DISCARD = new Set(["script", "style"]);

// dropped whole, children and all
const DROP = new Set([
  "script", "style", "noscript", "template", "svg", "canvas", "iframe", "object",
  "head", "meta", "link", "form",
  // interactive controls: label without behavior reads as a claim
  "button", "input", "select", "option", "textarea", "label", "output",
]);

// dropped by id/class, because they are the XP desktop chrome rather than the page
const DROP_ID = new Set(["axp-desktop", "luq"]);
const DROP_CLASS = new Set(["title-bar", "controls", "status", "modebar", "readouts", "meter"]);

// block containers whose own box we ignore while keeping their children. Being
// block-level is what matters here: it is the signal to flush any inline run
// buffered before it, so a <div><strong>Rule:</strong> text</div> stays ONE
// paragraph instead of splitting bold and prose into two.
const TRANSPARENT = new Set([
  "html", "body", "div", "section", "article", "aside", "main", "nav", "header",
  "footer", "colgroup", "tbody", "thead", "tfoot", "hgroup", "address", "fieldset",
]);

// every element that starts a new block. Anything absent is inline and gets
// buffered into the surrounding paragraph.
const BLOCK = new Set([
  ...TRANSPARENT,
  "h1", "h2", "h3", "h4", "h5", "h6", "p", "hr", "pre", "blockquote",
  "ul", "ol", "li", "dl", "dt", "dd", "table", "tr", "td", "th",
  "details", "summary", "figure", "figcaption", "caption",
]);

// pure ornament in the XP window vocabulary: the bay counter is a decorative
// "01/02/03" beside a heading that already says the same thing in words
const DROP_CLASS_INLINE = new Set(["bay-no"]);

// Inline elements the page's own CSS promotes to a box of their own. Without
// this, an encoder card's caption renders as "**PNG** lossless178.7 KB1.72 b/px"
// because the separation lives entirely in `float:right` and `display:block`.
//
// Rather than name the classes (they differ per page and would rot), read the
// page's OWN inline <style> and collect every class whose rule takes it out of
// the inline flow. Each page carries its whole stylesheet inline, so this needs
// no CSS engine and no second file — just the rule blocks already in hand.
// A flex or grid ITEM is its own box while declaring no `display` of its own —
// the layout comes from its parent, so a rule like `.wu-tag{flex:0 0 92px}` looks
// inline to a check that only reads the element's own display. /updates found it:
// `<span class=wu-tag>hit-route</span><span class=wu-desc>counter tick endpoint
// renamed …</span>` converted to "hit-routecounter tick endpoint renamed …", a
// slug welded to a title into a string that appears nowhere on the page. Same
// failure this whole heuristic exists for, one layout mode further on.
//
// Matched on the item shorthand and the grid placement properties rather than on
// a parent lookup, which would need a tree walk this deliberately does without.
// `flex` needs the leading boundary so it cannot swallow `flex-direction` and
// `flex-flow`, which are CONTAINER properties and say nothing about this element.
const OUT_OF_FLOW = /(?:display\s*:\s*(?:block|flex|grid|list-item|table)|float\s*:\s*(?:left|right)|(?:^|[;{\s])flex\s*:|flex-basis\s*:|grid-(?:area|column|row)\s*:)/i;

// Elements renderInline turns into a standalone Markdown token. They are already
// self-separating in the output, so promoting them to blocks can only lose them.
const SELF_TOKEN = new Set(["img"]);

export function collectBlockClasses(html) {
  const found = new Set();
  for (const style of html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)) {
    // strip comments, then walk `selector { decls }` pairs
    const css = style[1].replace(/\/\*[\s\S]*?\*\//g, "");
    for (const rule of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      if (!OUT_OF_FLOW.test(rule[2])) continue;
      for (const sel of rule[1].split(",")) {
        // take the last simple class in the selector, so both `.enc-bpp` and
        // `.lcd .label` contribute the class that actually gets the box
        const m = /\.([A-Za-z_][\w-]*)\s*$/.exec(sel.trim());
        if (m) found.add(m[1]);
      }
    }
  }
  return found;
}

// an open <p> is closed by any of these starting
const IMPLIED_CLOSE = {
  p: new Set("address article aside blockquote details div dl fieldset figcaption figure footer form h1 h2 h3 h4 h5 h6 header hr main nav ol p pre section table ul".split(" ")),
  li: new Set(["li"]),
  dt: new Set(["dt", "dd"]),
  dd: new Set(["dt", "dd"]),
  td: new Set(["td", "th", "tr"]),
  th: new Set(["td", "th", "tr"]),
  tr: new Set(["tr"]),
  option: new Set(["option"]),
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

// ── tokenizer ───────────────────────────────────────────────────────────────
// Attribute values are read with quote awareness so a ">" inside an attribute
// (common in our inline SVG data: URIs and CSP-ish strings) cannot end the tag
// early. That single case is why the naive /<[^>]*>/ used by the search index
// is fine for flattening text and wrong for building a tree.

function tokenize(html) {
  const tokens = [];
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

    // raw-text elements swallow everything up to their matching close tag
    if (RAW_TEXT.has(tag.name) && !tag.self) {
      const closeRe = new RegExp(`</${tag.name}\\s*>`, "i");
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
      const uv = /^[^\s>]*/.exec(html.slice(i));
      attrs[attr] = decodeEntities(uv[0]);
      i += uv[0].length;
    }
  }
  return { name, attrs, self, end: i };
}

// ── tree ────────────────────────────────────────────────────────────────────

function parse(html) {
  const root = { name: "#root", attrs: {}, children: [] };
  const stack = [root];
  const top = () => stack[stack.length - 1];

  for (const tk of tokenize(html)) {
    if (tk.t === "text") {
      if (tk.raw && RAW_TEXT_DISCARD.has(tk.owner)) continue; // answer keys stop here
      top().children.push({ name: "#text", value: decodeEntities(tk.v) });
      continue;
    }
    if (tk.t === "open") {
      // close whatever this tag implicitly ends (unclosed <p>, <li>, <td>…)
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
    // close: unwind to the nearest matching open, tolerating stray closers
    const idx = stack.map((n) => n.name).lastIndexOf(tk.name);
    if (idx > 0) stack.length = idx;
  }
  return root;
}

// ── rendering ───────────────────────────────────────────────────────────────

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

const isText = (n) => n.name === "#text";
const EMPTY = new Set();

// collapse runs of whitespace the way HTML rendering does, so markdown output
// does not inherit the source file's indentation
const squeeze = (s) => s.replace(/\s+/g, " ");

// characters that would start a markdown construct at the beginning of a line
const escapeMd = (s) => s.replace(/([\\`*_[\]<>])/g, "\\$1").replace(/^(\s*)([#>+-]|\d+\.)\s/gm, "$1\\$2 ");

function renderInline(nodes, ctx) {
  let out = "";
  for (const n of nodes) {
    if (isText(n)) { out += ctx.raw ? n.value : escapeMd(squeeze(n.value)); continue; }
    if (dropped(n)) continue;
    switch (n.name) {
      case "br": out += "  \n"; break;
      case "code": case "kbd": case "samp": {
        const t = textOf(n);
        // pick a fence that cannot collide with backticks inside the span
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
        // in-page anchors and javascript: hrefs carry nothing for a reader
        if (!href || href.startsWith("#") || href.startsWith("javascript:")) { out += inner; break; }
        out += `[${inner}](${absolute(href, ctx.origin)})`;
        break;
      }
      case "img": {
        const alt = (n.attrs.alt || "").trim();
        const src = n.attrs.src || "";
        // a decorative image with no alt text is decoration; say nothing
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
  const out = [];
  // consecutive inline-level siblings belong to one paragraph. Buffer them and
  // flush at the next block boundary, so a bold lead-in and the sentence that
  // follows it do not become two blocks.
  let run = [];
  const flush = () => {
    if (!run.length) return;
    const s = renderInline(run, ctx).replace(/[ \t]+\n/g, "  \n").trim();
    run = [];
    if (s) out.push(s);
  };

  for (const n of nodes) {
    if (isText(n)) {
      if (squeeze(n.value).trim()) run.push(n);
      continue;
    }
    if (dropped(n)) continue;
    const cls = (n.attrs?.class || "").split(/\s+/).filter(Boolean);
    const promoted = ctx.blockClasses || EMPTY;
    // Class-based promotion exists to break up TEXT that would otherwise run
    // together, so it must not reach an element that renderInline already emits
    // as a token of its own. An <img> has no text, so the block switch below has
    // no case for it and it renders as nothing: /lwe/encoding's sample photo
    // vanished from its twin the moment `.bpp-img{flex:0 0 auto}` started
    // counting as out-of-flow. A named tag in BLOCK still wins, as before.
    const isBlock = BLOCK.has(n.name)
      || (!SELF_TOKEN.has(n.name) && cls.some((c) => promoted.has(c)));
    if (!isBlock) { run.push(n); continue; }
    flush();

    switch (n.name) {
      case "h1": case "h2": case "h3": case "h4": case "h5": case "h6": {
        const level = Number(n.name[1]);
        const s = renderInline(n.children, ctx).trim();
        if (s) out.push(`${"#".repeat(level)} ${s}`);
        break;
      }
      // These are leaf blocks, but their children still go through renderBlocks
      // so a child the page's CSS promoted out of the inline flow (a floated
      // byte count in a figcaption, say) becomes its own line instead of being
      // concatenated onto the text before it. Children that are all inline
      // buffer into a single run and come back out as one paragraph, which is
      // the ordinary case and is unchanged.
      case "p": case "figcaption": case "summary": case "caption": {
        const s = renderBlocks(n.children, ctx, depth).trim();
        if (!s) break;
        // A caption is one thought even when its CSS lays the parts out as
        // separate boxes ("PNG lossless", "178.7 KB", "1.72 b/px"). Rejoin them
        // on one line; a <p> keeps the blank-line split, because there the
        // promotion really did mean a new line.
        const caption = n.name === "figcaption" || n.name === "caption";
        out.push(caption ? s.replace(/\n{2,}/g, " · ") : s);
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
          const body = renderBlocks(li.children, ctx, depth + 1).trim();
          const pad = " ".repeat(marker.length + 1);
          return `${marker} ${body.split("\n").join("\n" + pad)}`;
        });
        if (lines.length) out.push(lines.join("\n"));
        break;
      }
      case "dl": {
        const lines = [];
        for (const c of n.children) {
          if (dropped(c)) continue;
          if (c.name === "dt") lines.push(`- **${renderInline(c.children, ctx).trim()}**`);
          else if (c.name === "dd") lines.push(`  ${renderInline(c.children, ctx).trim()}`);
        }
        if (lines.length) out.push(lines.join("\n"));
        break;
      }
      case "table": {
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
        // the tag-chip strip is a row of one-word <span class="chip"> badges.
        // As blocks they read as a column of orphan words; as one line they
        // read as what they are.
        if (hasClass(n, "cap-strip")) {
          const chips = [];
          const collect = (x) => {
            if (isText(x)) return;
            if (hasClass(x, "chip")) chips.push(textOf(x).trim());
            else (x.children || []).forEach(collect);
          };
          collect(n);
          if (chips.length) out.push(`Tags: ${chips.filter(Boolean).join(", ")}`);
          break;
        }
        const inner = renderBlocks(n.children || [], ctx, depth);
        if (inner.trim()) out.push(inner);
      }
    }
  }
  flush();
  // a rule with nothing after it was separating content from the understanding
  // check we dropped; it now separates content from nothing
  while (out.length && out[out.length - 1] === "---") out.pop();
  return out.join("\n\n");
}

function renderTable(table, ctx) {
  const rows = [];
  const walk = (node) => {
    for (const c of node.children || []) {
      if (dropped(c)) continue;
      if (c.name === "tr") {
        const cells = (c.children || [])
          .filter((d) => (d.name === "td" || d.name === "th") && !dropped(d))
          .map((d) => renderInline(d.children, ctx).replace(/\|/g, "\\|").replace(/\n/g, " ").trim());
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

// ── public API ──────────────────────────────────────────────────────────────

/** Parse a full HTML document into { title, description, canonical, status, body }. */
export function readDocument(html, { origin = "https://aadhar.sh" } = {}) {
  const root = parse(html);
  const meta = collectMeta(root);
  const content = findContent(root);
  const ctx = { origin, blockClasses: collectBlockClasses(html) };
  return {
    ...meta,
    body: content ? renderBlocks(content.children, ctx).replace(/\n{3,}/g, "\n\n").trim() : "",
  };
}

function collectMeta(root) {
  const out = { title: "", description: "", canonical: "", status: [] };
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
    // the XP status strip at the bottom of every garage/lwe window carries the
    // page's own provenance line ("added 2026-07-10"), which is worth keeping
    // even though the strip itself is chrome we drop from the body
    if (n.name === "div" && (n.attrs.class || "").split(/\s+/).includes("status")) {
      for (const c of n.children || []) {
        const t = textOf(c).trim();
        if (t) out.status.push(t);
      }
    }
    for (const c of n.children || []) visit(c);
  };
  visit(root);
  // <title> is raw-text tokenized, so decode it here rather than in the tree
  out.title = decodeEntities(out.title);
  return out;
}

// the payload is `.content` when the page has one (every garage/lwe window
// does), otherwise <main>, otherwise <body>
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
