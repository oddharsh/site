// Three tools here have to find where a <script> or <style> ends without a
// parser, and CodeQL's js/bad-tag-filter has flagged a different missed end-tag
// shape in each of them, in three separate runs. tools/lib/html-raw-text.ts is
// the one answer they now share; this is what holds it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { closeTagSource, stripRawText } from "./lib/html-raw-text.ts";
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
    assert.equal(stripRawText(`keep<script>LEAK${close}tail`, "script").replace(/\s+/g, " "),
      "keep tail", name);
  }
  assert.equal(stripRawText("keep<style>a{b:c} LEAK</style >tail", "style").replace(/\s+/g, " "),
    "keep tail", "style too");
});

test("document extraction keeps prose after each legal raw-text close", () => {
  for (const [, close] of CLOSES) {
    for (const format of /** @type {const} */ (["markdown", "text"])) {
      const doc = readDocument(`<body><main><p>Before</p><script>SECRET${close}<p>After</p></main></body>`, { format });
      assert.match(doc.body, /Before/);
      assert.match(doc.body, /After/);
      assert.doesNotMatch(doc.body, /SECRET/);
    }
  }
});

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

test("check-page-contracts composes its close from the shared module", async () => {
  const src = await readFile(new URL("./check-page-contracts.ts", import.meta.url), "utf8");
  assert.match(src, /closeTagSource\(["']script["']\)/, "must call the shared builder");
});

test("the composed luq-data pattern reads every close", () => {
  const re = new RegExp(
    `<script\\b[^>]*\\btype="application/json"[^>]*\\bid="luq-data"[^>]*>([\\s\\S]*?)${closeTagSource("script")}`,
    "gi",
  );
  for (const [name, close] of CLOSES) {
    const html = `<script type="application/json" id="luq-data">{"a":1}${close}`;
    const m = [...html.matchAll(re)];
    assert.equal(m.length, 1, name);
    assert.deepEqual(JSON.parse(m[0][1]), { a: 1 }, name);
  }
});
