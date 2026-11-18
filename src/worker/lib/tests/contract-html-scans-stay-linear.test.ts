// ── HTML from other origins is scanned in linear time ───────────────────────
// mf2.ts parses webmention sources up to 1 MB, and stripTags runs over Lens
// pages up to 2 MB. Both are written by whoever owns the other origin. Before
// 2026-11-18, mf2's tokenizer took 1.5 s on "<a" repeated 1,000 times (cubic),
// and the tag strip took 114 ms on 16,000 unclosed "<" (quadratic). The budget
// below is about 300x what the linear versions take on a 1 MB input.
import { assert, test } from "../../../../tools/tests/contract-shared.ts";
import { parseMf2 } from "../mf2.ts";
import { stripTags } from "../text.ts";

const BUDGET_MS = 250;
const elapsed = (run: () => void) => {
  const start = performance.now();
  run();
  return performance.now() - start;
};

test("parseMf2 reads an h-card ahead of 1 MB of unclosed tags, and drops the cut-off tag", () => {
  const html = `<div class="h-card"><span class="p-name">Ada</span></div>${"<a".repeat(500_000)}`;
  let doc = parseMf2("", "https://x.test/");
  const ms = elapsed(() => (doc = parseMf2(html, "https://x.test/")));
  assert.ok(ms < BUDGET_MS, `parseMf2 took ${ms.toFixed(0)} ms on 1 MB`);
  assert.deepEqual(
    doc.items.map((item) => [item.type, item.properties.name]),
    [[["h-card"], ["Ada"]]],
  );

  const [cut] = parseMf2('<div class="h-card"><span class="p-name">Ada</span><a class="u-url" href="https://ada.test/', "https://x.test/").items;
  assert.deepEqual(cut.properties, { name: ["Ada"] }, "a tag the input ends inside is dropped, as a browser drops it");
});

test("stripTags matches the tag-strip regex and leaves a tail of unclosed < alone", () => {
  const page = "<p>a <b>b</b> c</p> 1 < 2";
  assert.equal(stripTags(page, " "), page.replace(/<[^>]+>/g, " "));
  assert.equal(stripTags(page, " "), " a  b  c  1 < 2");

  const tail = `<p>kept</p>${"<".repeat(1_000_000)}`;
  let out = "";
  const ms = elapsed(() => (out = stripTags(tail, "")));
  assert.ok(ms < BUDGET_MS, `stripTags took ${ms.toFixed(0)} ms on 1 MB`);
  assert.equal(out, `kept${"<".repeat(1_000_000)}`);
});
