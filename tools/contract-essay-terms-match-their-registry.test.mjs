// ── essay terms: every marked term is a copy of its registry entry ────────────
//
// A term in an essay (docs/TERMS.md) carries its definition in `title` and its
// source in `href`, so the page works with no script and the infotip never has
// to fetch anything. The cost of that is one copy per page, and copies drift:
// a definition corrected in src/content/terms.json and left stale on twelve
// pages would show a reader two answers to the same hover. So the registry is
// the record and this holds every page to it, byte for byte.
import { assert, readFileSync, test } from "./contract-shared.ts";
import { readdirSync } from "node:fs";

const ROOT_DIR = new URL("../", import.meta.url);
const TERMS = JSON.parse(readFileSync(new URL("src/content/terms.json", ROOT_DIR), "utf8"));

const unescape = (s) => s
  .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<")
  .replace(/&gt;/g, ">").replace(/&amp;/g, "&");
const attr = (tag, name) => {
  const m = tag.match(new RegExp(`\\s${name}="([^"]*)"`));
  return m ? unescape(m[1]) : null;
};

const pages = readdirSync(new URL("src/pages/", ROOT_DIR), { recursive: true })
  .map(String).filter((p) => p.endsWith(".html"));
const marked = pages.flatMap((page) => {
  const html = readFileSync(new URL(`src/pages/${page}`, ROOT_DIR), "utf8");
  return [...html.matchAll(/<a\b[^>]*\sclass="term"[^>]*>/g)].map((m) => ({ page, tag: m[0] }));
});

test("the registry's entries are well formed and in the house voice", () => {
  for (const [key, t] of Object.entries(TERMS)) {
    assert.match(key, /^[a-z0-9]+(-[a-z0-9]+)*$/, `${key}: keys are lowercase-kebab`);
    assert.ok(t.label && t.plain && t.src, `${key}: needs label, plain and src`);
    assert.match(t.src, /^https:\/\//, `${key}: src is an https URL`);
    assert.doesNotMatch(t.plain, /[—‘’“”]/, `${key}: no em dashes or curly quotes`);
    const words = t.plain.split(/\s+/).length;
    assert.ok(words <= 30, `${key}: ${words} words, the rule is under 30`);
  }
});

test("every marked term matches its registry entry", () => {
  assert.ok(marked.length > 0, "found no marked terms at all, so this test is reading the wrong place");
  for (const { page, tag } of marked) {
    const key = attr(tag, "data-t");
    const t = TERMS[key];
    assert.ok(t, `${page}: data-t="${key}" is not in src/content/terms.json`);
    assert.equal(attr(tag, "href"), t.src, `${page}: ${key} href drifted from the registry`);
    assert.equal(attr(tag, "title"), t.plain, `${page}: ${key} title drifted from the registry`);
  }
});

test("a term is marked once per page, and every entry is used somewhere", () => {
  const seen = new Set();
  for (const { page, tag } of marked) {
    const id = `${page} ${attr(tag, "data-t")}`;
    assert.ok(!seen.has(id), `${id}: mark the first occurrence only`);
    seen.add(id);
  }
  const used = new Set(marked.map(({ tag }) => attr(tag, "data-t")));
  for (const key of Object.keys(TERMS)) assert.ok(used.has(key), `${key} is in the registry but on no page`);
});

test("no term is marked inside a page's JSON data", () => {
  // A spec's quiz and editorial strings ride into the page as JSON, where a
  // term's markup arrives escaped and renders as nothing a reader can hover.
  // The first pass put one there by string match (lwe/drivers, a quiz `why`),
  // and the anchor check above cannot see it, because the tag is escaped.
  for (const page of pages) {
    const html = readFileSync(new URL(`src/pages/${page}`, ROOT_DIR), "utf8");
    assert.doesNotMatch(html, /class=\\"term\\"/, `${page}: a term is marked inside JSON (quiz or editorial data)`);
  }
});
