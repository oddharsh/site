// ── The IndieWeb doors: webmention discovery on `/`, h-entry on every note ──
// Two gaps, closed together on 2026-09-30.
//
// 1. `/` sent no rel="webmention" Link, while /garage/*, /lwe/* and /writing
//    all did. A sender that linked the homepage had nowhere to send. The rel
//    lives in the Link header alone, because the homepage body ships as a q11
//    twin and a dcz delta and one <link> tag would re-mint both.
// 2. The Notepad notes carried no h-entry, so a webmention receiver or reader
//    parsing one of them found no post, no author and no date.
//
// The h-entry half is checked by PARSING the render with the small mf2 reader
// below. A class in the wrong place (a p-name that also catches the caption's
// ".txt" and Notepad suffix, an author whose name leaks into the entry's
// scope) passes a grep for class names and fails every real parser. It was
// cross-checked against microformats-parser on the built pages, which produced
// the same properties.
import { readFileSync } from "node:fs";
import { assert, test } from "./contract-shared.ts";
import { HOMEPAGE_DISCOVERY_LINK } from "../src/worker/lib/security.ts";
import { OWNER_NAME, OWNER_URL, notepadWindow, renderWritingIndex, renderWritingPost } from "../src/worker/writing.ts";

const ROOT = new URL("../", import.meta.url);
const read = (p) => readFileSync(new URL(p, ROOT), "utf8");
const WEBMENTION = '</webmention>; rel="webmention"';

test("the homepage Link set advertises the webmention endpoint", () => {
  assert.ok(HOMEPAGE_DISCOVERY_LINK.split(", ").includes(WEBMENTION),
    "HOMEPAGE_DISCOVERY_LINK must carry the webmention rel");
  // the route composes that set into its header (contract-the-speculation-ledger
  // pins HOMEPAGE_HEADERS to it), and _headers states the same set for `/`
  const block = read("public/_headers").match(/^\/\n((?: {2}.+\n)+)/m);
  assert.ok(block, "_headers lost its `/` rule");
  assert.ok(block[1].includes(`Link: ${WEBMENTION}`), "_headers' `/` rule must carry the webmention Link too");
  // and the endpoint it names is a real route, so the rel always leads somewhere
  assert.match(read("src/worker/index.ts"), /\["\/webmention", handleWebmention\]/);
});

test("the homepage body carries no webmention <link>, so the rel costs no body bytes", () => {
  assert.doesNotMatch(read("src/pages/index.html"), /rel="?webmention/);
});

// ── a minimal microformats2 reader ─────────────────────────────────────────
// Enough of https://microformats.org/wiki/microformats2-parsing for what these
// pages use: h-* roots, nested h-* as property values, p-/u-/dt-/e- parsing
// including <data value>, <time datetime> and <a href>. Textarea content is
// raw text, which is how an HTML parser reads it.
const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);
const RAW = new Set(["script", "style", "textarea", "title"]);
const decode = (s) => s.replace(/&(amp|lt|gt|quot|#39);/g, (_, e) => ({ amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'" })[e]);

function parseHtml(html) {
  const root = { tag: "#root", attrs: {}, children: /** @type {any[]} */ ([]) };
  const stack = [root];
  const tagRe = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>|<!--[\s\S]*?-->|<![^>]*>/g;
  let at = 0;
  for (let m; (m = tagRe.exec(html));) {
    const top = stack[stack.length - 1];
    if (m.index > at) top.children.push({ text: decode(html.slice(at, m.index)) });
    at = tagRe.lastIndex;
    if (!m[2]) continue;
    const tag = m[2].toLowerCase();
    if (m[1]) {
      const i = stack.map((n) => n.tag).lastIndexOf(tag);
      if (i > 0) stack.length = i;
      continue;
    }
    const attrs = {};
    for (const a of m[3].matchAll(/([^\s=/]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) attrs[a[1].toLowerCase()] = decode(a[2] ?? a[3] ?? a[4] ?? "");
    const node = { tag, attrs, children: /** @type {any[]} */ ([]) };
    top.children.push(node);
    if (RAW.has(tag)) {
      const end = html.indexOf(`</${tag}`, at);
      node.children.push({ text: decode(html.slice(at, end)) });
      at = tagRe.lastIndex = html.indexOf(">", end) + 1;
    } else if (!VOID.has(tag)) stack.push(node);
  }
  return root;
}

const classes = (n) => (n.attrs?.class ?? "").split(/\s+/).filter(Boolean);
const text = (n) => (n.text ?? n.children.map(text).join(""));
const roots = (n) => classes(n).filter((c) => c.startsWith("h-"));

function propValue(n, kind) {
  if (kind === "p") return n.tag === "data" ? n.attrs.value : text(n).trim();
  if (kind === "u") return n.attrs.href ?? n.attrs.value ?? text(n).trim();
  if (kind === "dt") return n.attrs.datetime ?? n.attrs.value ?? text(n).trim();
  return { value: text(n).trim() };
}

function item(n) {
  const out = { type: roots(n), properties: {}, children: /** @type {any[]} */ ([]) };
  const walk = (node) => {
    for (const c of node.children ?? []) {
      if (c.text !== undefined) continue;
      const props = classes(c).map((k) => k.match(/^(p|u|dt|e)-(.+)$/)).filter(Boolean);
      const nested = roots(c).length ? item(c) : null;
      for (const [, kind, name] of props) (out.properties[name] ??= []).push(nested ?? propValue(c, kind));
      if (nested && !props.length) out.children.push(nested);
      if (!nested) walk(c);
    }
  };
  walk(n);
  return out;
}

function mf2(html) {
  const items = [];
  const find = (n) => { for (const c of n.children ?? []) if (c.tag) roots(c).length ? items.push(item(c)) : find(c); };
  find(parseHtml(html));
  return items;
}

// ── the notes ───────────────────────────────────────────────────────────────
const env = {
  ASSETS: {
    fetch: async (url) => {
      const path = new URL(url).pathname;
      try { return new Response(read(`src/content${path}`)); } catch { return new Response("", { status: 404 }); }
    },
  },
};
const posts = JSON.parse(read("src/content/writing/posts.json"));

test("every note parses to one h-entry with name, published, url, content and author", async () => {
  assert.ok(posts.length >= 1, "posts.json lists no notes");
  for (const post of posts) {
    const response = await renderWritingPost(post.slug, env);
    assert.equal(response.status, 200, post.slug);
    const items = mf2(await response.text());
    assert.equal(items.length, 1, `${post.slug}: expected one top-level microformat, got ${items.map((i) => i.type).join(" ")}`);
    const [entry] = items;
    assert.deepEqual(entry.type, ["h-entry"]);
    const p = entry.properties;
    // the title alone, without the caption's file extension and Notepad suffix
    assert.deepEqual(p.name, [post.title], `${post.slug}: p-name`);
    assert.deepEqual(p.published, [post.date], `${post.slug}: dt-published`);
    assert.deepEqual(p.url, [`https://aadhar.sh/writing/${post.slug}`], `${post.slug}: u-url`);
    // the canonical text, verbatim, which the textarea carries
    assert.deepEqual(p.content, [{ value: read(`src/content/writing/${post.slug}.txt`).trim() }], `${post.slug}: e-content`);
    assert.equal(p.author?.length, 1, `${post.slug}: p-author`);
    assert.deepEqual(p.author[0].type, ["h-card"]);
    assert.deepEqual(p.author[0].properties, { name: [OWNER_NAME], url: [OWNER_URL] }, `${post.slug}: author card`);
  }
});

test("the author card names the identity the homepage's representative h-card declares", () => {
  const [card] = mf2(read("src/pages/index.html")).filter((i) => i.type.includes("h-card"));
  assert.ok(card, "the homepage lost its h-card");
  assert.deepEqual(card.properties.name, [OWNER_NAME]);
  assert.ok(card.properties.url.includes(OWNER_URL) && card.properties.uid.includes(OWNER_URL),
    "the homepage h-card must be representative (u-url and u-uid) for the notes' author to resolve to it");
});

test("/writing is an h-feed whose rows are the notes, and its popovers add no second copy", async () => {
  const response = await renderWritingIndex(env);
  const items = mf2(await response.text());
  assert.equal(items.length, 1, `expected the h-feed alone, got ${items.map((i) => i.type).join(" ")}`);
  const [feed] = items;
  assert.deepEqual(feed.type, ["h-feed"]);
  assert.equal(feed.properties.author?.[0]?.properties.name?.[0], OWNER_NAME);
  assert.deepEqual(feed.children.map((c) => c.properties.url[0]), posts.map((p) => `/writing/${p.slug}`));
  assert.deepEqual(feed.children.map((c) => c.properties.name[0]), posts.map((p) => p.title));
  assert.deepEqual(feed.children.map((c) => c.properties.published[0]), posts.map((p) => p.date));
});

test("the control: a window rendered without an entry carries no microformat at all", () => {
  // the reader has to be able to say "nothing here", or every assertion above
  // could be passing on a parser that invents entries
  assert.deepEqual(mf2(notepadWindow("a.txt", "text", "/writing", "2026-01-01")), []);
  assert.deepEqual(mf2(notepadWindow("a.txt", "text", "/writing", "2026-01-01", "note-a")), []);
  assert.equal(mf2(notepadWindow("a.txt", "text", "/writing", "2026-01-01", undefined, { name: "a", url: "https://aadhar.sh/writing/a" })).length, 1);
});
