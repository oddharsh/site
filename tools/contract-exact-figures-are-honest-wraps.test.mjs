// ── exact figures: a <data value> on an essay says something new ──────────────
//
// Holding Alt shows every <data value> on a page in place of its rounded text
// (nav.js initExact, docs/TERMS.md). Whether a value is the RIGHT exact number
// is a judgment about which measurement a sentence describes, so no test can
// hold it. What a test can hold is the shape: a wrap with nothing in it, or one
// that would show the same text back, is a hold that reveals nothing, and a
// wrap inside a heading or inside a page's JSON data never reaches a reader.
import { assert, readFileSync, test } from "./contract-shared.ts";
import { readdirSync } from "node:fs";

const ROOT_DIR = new URL("../", import.meta.url);
const pages = readdirSync(new URL("src/pages/", ROOT_DIR), { recursive: true })
  .map(String).filter((p) => /^(garage|lwe)\/.+\.html$/.test(p));

test("every exact-figure wrap shows a different, non-empty value", () => {
  let seen = 0;
  for (const page of pages) {
    const html = readFileSync(new URL(`src/pages/${page}`, ROOT_DIR), "utf8");
    for (const [, value, text] of html.matchAll(/<data value="([^"]*)">([\s\S]*?)<\/data>/g)) {
      seen++;
      assert.ok(value.trim(), `${page}: <data> around "${text}" has an empty value`);
      assert.notEqual(value.trim(), text.replace(/&nbsp;/g, " ").trim(), `${page}: "${text}" shows itself on Alt`);
    }
    for (const [, , inner] of html.matchAll(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/g)) {
      assert.doesNotMatch(inner, /<data value=/, `${page}: a wrap sits inside a heading`);
    }
    assert.doesNotMatch(html, /\\u003cdata value=|<data value=\\"/, `${page}: a wrap sits inside JSON data`);
  }
  assert.ok(seen > 0, "found no wraps at all, so this test is reading the wrong place");
});
