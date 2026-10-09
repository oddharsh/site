// ── the minifier keeps what every built page means ──────────────────────────
// tools/lib/html-minify.ts replaced minify-html on 2026-10-07, and its whole-site
// proof was a one-time byte diff. Its rules were learned by probing, so a page
// built in a shape nobody probed could lose a space, an attribute or a nesting
// level and nothing would say so. This minifies the readable source of every
// built page (its .src.html twin), reads both as trees with a parser written apart
// from the minifier (tools/lib/html-to-md.ts), and requires the same tree: same
// elements, nesting, attributes and text. It minifies the twin itself rather
// than reading the served page, because other steps (asset hashing) also sit
// between the two, and this is the minifier's check.
//
// Idea and controls from the build-off's bespoke entry (buildoff/bespoke,
// test/html-parity.js), which compared against minify-html; this compares each
// page against its own source, so it outlives that dependency.
//
// Two things are normalized, because the minifier changes them on purpose (its
// header lists each): whitespace, which collapses, and which is trimmed at block
// edges and dropped between a layout element's children; and attributes it drops
// or rewrites without changing what they say (an empty class, a value equal to
// the attribute's default, a boolean's self-named value, a class's spacing, the
// spaces around a viewport's commas). Every list below is a COPY of the
// minifier's, so a change to its policy fails here until both change on purpose.
// <script> and <style> bodies are left out: the build runs Oxc and Lightning CSS
// over them first, and the parser drops them.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { minifyHtml } from "./lib/html-minify.ts";
import { decodeEntities, parseHtml } from "./lib/html-to-md.ts";
import { assert, ROOT, test } from "./contract-shared.ts";

const BUILT = fileURLToPath(new URL(".build/public/", ROOT));
const needsBuild = !existsSync(BUILT) && "needs a built tree: bun run build";

const LAYOUT = new Set(["html", "head", "body", "div", "section", "nav", "blockquote", "form", "figure", "header", "footer", "article", "fieldset",
  "aside", "dialog", "main", "ol", "ul", "dl", "menu", "hgroup", "select", "optgroup", "datalist", "table", "thead", "tbody", "tfoot", "tr",
  "colgroup", "map", "picture", "svg", "g"]);
const CONTENT = new Set(["p", "li", "td", "th", "dd", "dt", "h1", "h2", "h3", "h4", "h5", "h6", "button", "summary", "details", "caption",
  "legend", "option", "output", "figcaption", "noscript", "template", "label", "address", "object", "canvas", "iframe", "audio", "video", "slot"]);
const BLOCKISH = new Set([...LAYOUT, ...CONTENT]);
const SENSITIVE = new Set(["pre", "textarea", "code"]);
const DROP_EMPTY = new Set(["class", "id", "style", "title", "name", "value"]);
const DEFAULTS = {
  img: { loading: "eager" }, button: { type: "submit" }, script: { type: "text/javascript" }, style: { type: "text/css", media: "all" },
  form: { method: "get" }, a: { target: "_self" }, area: { "shape": "rect" },
};
const BOOLEAN = new Set(["checked", "disabled", "hidden", "selected", "readonly", "required", "multiple", "autofocus", "novalidate", "async", "defer",
  "nomodule", "ismap", "reversed", "open", "inert", "formnovalidate", "allowfullscreen", "default", "playsinline"]);

// An attribute as the minifier is allowed to leave it, or null where it may drop it.
function attribute(tag, name, value, attrs) {
  if (name === "class") value = value.trim().replace(/\s+/g, " ");
  if (tag === "meta" && name === "content" && attrs.name === "viewport") value = value.replace(/\s*,\s*/g, ",");
  if (DEFAULTS[tag]?.[name] === value.toLowerCase()) return null;
  const empty = DROP_EMPTY.has(name) || name === "action" || (name === "content" && tag === "meta") || (name === "src" && tag !== "script");
  if (value === "" && empty && !(tag === "option" && name === "value")) return null;
  if (BOOLEAN.has(name) && value.toLowerCase() === name) value = "";
  return value;
}

// A page as a list of lines: an open tag with its sorted attributes, a text run,
// a close tag. Two pages mean the same thing when their lists are equal.
export function meaning(html) {
  const out = [];
  const walk = (node, keepSpace) => {
    // merge neighbouring text (a dropped comment splits one run into two)
    const kids = [];
    for (const c of node.children) {
      if (c.name === "#text" && kids.at(-1)?.name === "#text") kids[kids.length - 1] = { name: "#text", value: kids.at(-1).value + c.value };
      else kids.push(c);
    }
    kids.forEach((c, i) => {
      if (c.name === "#text") {
        let t = c.value;
        if (!keepSpace) {
          t = t.replace(/\s+/g, " ");
          const prev = kids[i - 1], next = kids[i + 1];
          if (!prev ? BLOCKISH.has(node.name) : BLOCKISH.has(prev.name)) t = t.trimStart();
          if (!next ? BLOCKISH.has(node.name) : BLOCKISH.has(next.name)) t = t.trimEnd();
          if (LAYOUT.has(node.name) && !t.trim()) t = "";
        }
        if (t) out.push(`text ${JSON.stringify(t)}`);
        return;
      }
      const attrs = Object.entries(c.attrs)
        .map(([k, v]) => [k, attribute(c.name, k, v, c.attrs)])
        .filter(([, v]) => v !== null)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => `${k}=${JSON.stringify(v)}`);
      out.push(`<${c.name}${attrs.length ? " " + attrs.join(" ") : ""}>`);
      walk(c, keepSpace || SENSITIVE.has(c.name));
      out.push(`</${c.name}>`);
    });
  };
  walk(parseHtml(html), false);
  return out;
}

function pages() {
  const found = [];
  const visit = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) visit(p);
      else if (e.name.endsWith(".src.html")) found.push(relative(BUILT, p));
    }
  };
  visit(BUILT);
  return found.sort();
}

// The first place two pages part, with a little context on each side.
function firstDifference(a, b) {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  if (i === a.length && i === b.length) return null;
  return { at: i, source: a.slice(Math.max(0, i - 2), i + 3), served: b.slice(Math.max(0, i - 2), i + 3) };
}

test("every built page means what its readable source means", { skip: needsBuild }, () => {
  const list = pages();
  assert.ok(list.length >= 50, `only ${list.length} .src.html twins: the check would pass on almost nothing`);
  const failures = [];
  for (const src of list) {
    const html = readFileSync(join(BUILT, src), "utf8");
    const diff = firstDifference(meaning(html), meaning(minifyHtml(html)));
    if (diff) failures.push({ page: src, ...diff });
  }
  assert.deepEqual(failures, [], `${failures.length} of ${list.length} pages changed meaning when minified`);
});

// Each planted change is one the minifier could make by mistake, and the check
// must see it, or a clean pass above means nothing.
test("the check sees a glued word, a changed attribute and a lost end tag", { skip: needsBuild }, () => {
  const served = minifyHtml(readFileSync(join(BUILT, "garage/horizon.src.html"), "utf8"));
  const base = meaning(served);
  const plant = (re, to, what) => {
    assert.match(served, re, `the planted ${what} found nothing to change`);
    assert.notDeepEqual(meaning(served.replace(re, to)), base, `the check missed a ${what}`);
  };
  plant(/([a-z]) (<(?:a|b|em|code)\b)/, "$1$2", "space removed before an inline element");
  plant(/\bid=("?)([\w-]+)\1/, "id=$1$2x$1", "changed id");
  // text right after it, so the text moves inside: the reader unwinds a stray
  // open element at its parent's end, so a lost </a> before </li> reads the same
  plant(/<\/(?:b|em|code)>(?=[^<\s])/, "", "missing end tag before text");
});

// The reader above decodes a named reference only if its table has the name, and
// so do the Markdown twins, which share it. The first run of this check found six
// names missing, printed as written in the twins and llms-full.txt. So every name
// a built page uses has to decode, and a page that adds a new one fails here.
test("every named reference a built page uses decodes in the twin reader", { skip: needsBuild }, () => {
  const names = new Set();
  for (const src of pages()) for (const m of readFileSync(join(BUILT, src), "utf8").matchAll(/&([a-zA-Z][a-zA-Z0-9]*);/g)) names.add(m[1]);
  assert.ok(names.size > 10, "found almost no named references: the scan is reading the wrong files");
  const unknown = [...names].filter((n) => decodeEntities(`&${n};`) === `&${n};`).sort();
  assert.deepEqual(unknown, [], "add these to ENTITIES in tools/lib/html-to-md.ts");
});
