// Three tools here have to find where a <script> or <style> ends without a
// parser, and CodeQL's js/bad-tag-filter has flagged a different missed end-tag
// shape in each of them, in three separate runs. tools/lib/html-raw-text.ts is
// the one answer they now share; this is what holds it.
//
// Behaviour through a real import rather than a source-text pattern, for the
// reason the ua-survey test beside this one gives: a source assertion would have
// passed on every broken version of the thing it claims to cover.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { closeTagSource, stripRawText, stripUnrendered } from "./lib/html-raw-text.ts";
import { readDocument } from "./lib/html-to-md.ts";

// The four shapes the HTML tokenizer accepts as a close, plus the one it does
// not. `</scriptfoo>` closes an element called scriptfoo, so reading it as a
// script close swallows real content.
const CLOSES = [
  ["plain", "</script>"],
  ["space before bracket", "</script >"],
  ["whitespace then junk", "</script\t\n bar>"],
  ["solidus", "</script/>"],
];

test("closeTagSource matches every close the tokenizer accepts", () => {
  const re = new RegExp(closeTagSource("script"), "i");
  for (const [name, close] of CLOSES) assert.match(close, re, name);
  assert.doesNotMatch("</scriptfoo>", re, "a longer tag name is a different element");
  assert.match("</SCRIPT >", re, "end tags are case-insensitive");
});

test("stripRawText removes the element whatever shape its end tag takes", () => {
  for (const [name, close] of CLOSES) {
    assert.equal(stripRawText(`keep<script>LEAK${close}tail`, "script").replace(/\s+/g, " "), "keep tail", name);
  }
  assert.equal(stripRawText("keep<style>a{b:c} LEAK</style >tail", "style").replace(/\s+/g, " "), "keep tail", "style too");
});

test("stripUnrendered drops comments and raw text, whichever opens first", () => {
  const out = (html) => stripUnrendered(html).replace(/\s+/g, " ").trim();
  assert.equal(out("a<!-- <h4>x</h4> -->b"), "a b");
  assert.equal(out("a<script>'<!--'</script>b<!-- c -->d"), "a b d", "a <!-- inside a script opens no comment");
  assert.equal(out("a<!-- <script> -->b<h2>c</h2>"), "a b<h2>c</h2>", "a <script> inside a comment opens nothing");
  assert.equal(out('a<style>:root{--g:"字"}</style >b<template><h5></h5></template>c'), "a b c");
  assert.equal(out("a<!-->b<!--x--!>c"), "a b c", "the abrupt and the tolerated comment closes");
  // the splice CodeQL's js/incomplete-multi-character-sanitization warns of:
  // removing an inner comment must not leave a live <script behind
  assert.doesNotMatch(out("<scr<!-- -->ipt>x</script>"), /<script(?=[\s/>])/i, "the gap left by a comment never joins a tag back together");
  assert.equal(out("a<script>never closed"), "a", "an unterminated element runs to end of document");
});

test("document extraction keeps prose after each legal raw-text close", () => {
  for (const [, close] of CLOSES) {
    for (const format of ["markdown", "text"] as const) {
      const doc = readDocument(`<body><main><p>Before</p><script>SECRET${close}<p>After</p></main></body>`, { format });
      assert.match(doc.body, /Before/);
      assert.match(doc.body, /After/);
      assert.doesNotMatch(doc.body, /SECRET/);
    }
  }
});

// generate-search-index feeds /search and the schema.org descriptions /ask
// publishes, so a script body surviving the strip is prose an agent reads as
// fact. The naive `<\/script>` pattern it used to carry is the control: it
// leaks on three of the four shapes above.
test("the search index strip beats the pattern it replaced", () => {
  const naive = (s) => s.replace(/<script\b[\s\S]*?<\/script>/gi, " ");
  let leaked = 0;
  for (const [, close] of CLOSES) {
    const html = `keep<script>SECRET${close}tail`;
    assert.doesNotMatch(stripRawText(html, "script"), /SECRET/);
    if (naive(html).includes("SECRET")) leaked += 1;
  }
  assert.equal(leaked, 3, "the old pattern leaks on 3 of the 4 closes");
});

// The luq-data payload carries the quiz ANSWER KEY, so its extractor has the
// same requirement. check-page-contracts.ts runs its assertions at module scope
// and cannot be imported, so this covers the composition rule instead: it must
// build its close from the shared source rather than re-derive one. Narrow on
// purpose, and the same shape as the assertion that neither Worker redefines
// validateLensTarget.
//
// It deliberately does NOT ban a literal `<\/script>` from the file. Several
// assertions there check that a generator emitted the exact string
// `<script src="/quiz.js" defer></script>`, which is a presence check on bytes
// we control rather than a search for where an unknown element ends, and those
// are the ones this whole class of finding does not apply to.
test("check-page-contracts composes its close from the shared module", async () => {
  const src = await readFile(new URL("./check-page-contracts.ts", import.meta.url), "utf8");
  assert.match(src, /closeTagSource\(["']script["']\)/, "must call the shared builder");
});

test("the composed luq-data pattern reads every close", () => {
  const re = new RegExp(`<script\\b[^>]*\\btype="application/json"[^>]*\\bid="luq-data"[^>]*>([\\s\\S]*?)${closeTagSource("script")}`, "gi");
  for (const [name, close] of CLOSES) {
    const html = `<script type="application/json" id="luq-data">{"a":1}${close}`;
    const m = [...html.matchAll(re)];
    assert.equal(m.length, 1, name);
    assert.deepEqual(JSON.parse(m[0][1]), { a: 1 }, name);
  }
});
