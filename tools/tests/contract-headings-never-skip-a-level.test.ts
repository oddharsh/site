// ── headings step down one level at a time ──────────────────────────────────
// A screen reader user moves by heading, and the level is the outline: an h4
// straight after the h1 reads as a sub-sub-section of something that isn't
// there. /lwe/lean went h1 to h4 (the compiler demo's two pipes) and
// /garage/gpt56 h1 to h3 (its three bays), both picked for their default size.
// Found by the second specification.website audit, 2026-10-17. The fix keeps
// each look by scoping the old rule to its parent class; the level says where
// the heading sits.
//
// Going back up (h3 to h2) is fine. Going down skips nothing.
import { readFileSync } from "node:fs";
import { assert, test } from "./contract-shared.ts";
import { stripUnrendered } from "../lib/html-raw-text.ts";
import { staticShellPages } from "../photos/gen-desktop-partial.ts";

// Markup a browser never renders as headings: comments, and the raw text of
// script, style and template (lean's theorems name hypotheses h1 and h2).
const strip = (html) => stripUnrendered(html);

function skips(html) {
  const out: any[] = [];
  let prev = 0;
  for (const [, n] of strip(html).matchAll(/<h([1-6])\b/g)) {
    const level = Number(n);
    if (prev && level > prev + 1) out.push(`h${prev} to h${level}`);
    prev = level;
  }
  return out;
}

test("the walk catches a skip and allows a step back up (control)", () => {
  assert.deepEqual(skips("<h1>a</h1><h4>b</h4>"), ["h1 to h4"]);
  assert.deepEqual(skips("<h1>a</h1><h2>b</h2><h3>c</h3><h2>d</h2><h3>e</h3>"), []);
  assert.deepEqual(skips("<h1>a</h1><script>'<h4>'</script><!-- <h5> --><h2>b</h2>"), []);
});

test("no static page skips a heading level", () => {
  const pages = staticShellPages();
  assert.ok(pages.length >= 40, `only ${pages.length} static pages found`);
  const found = pages.flatMap((file) => skips(readFileSync(file, "utf8")).map((s) => `${file}: ${s}`));
  assert.deepEqual(found, []);
});
