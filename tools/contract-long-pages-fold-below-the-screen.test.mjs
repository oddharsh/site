// ── long essays fold below the first screen ─────────────────────────────────
// build.ts step 1g2 runs tools/lib/prose-fold.ts on every page it dresses, which
// wraps a long essay's later blocks in <section class="fold"> so the browser can
// skip laying them out on first paint (/garage/horizon: -48 ms of first paint on
// a phone, measured 2026-10-07). What would quietly break it:
//   - a fold opening on the first screen, where skipping costs a frame;
//   - text changing, which turns a layout change into a content change;
//   - a fold opening on anything but an h2 or a .demo card, where prose.css's
//     margin fix no longer holds and the page grows a few pixels per boundary;
//   - an LWE chat page folding, which measured no gain and a scroll-height jump.
// A browser check, not this file, proves the folded pages keep their height to
// the pixel; this pins the shape that check relies on.
//
// HTMLRewriter is a bun global, so under node the suite skips, matching
// contract-csp-scan.test.mjs.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";
import { FOLD_AFTER_CHARS, SHELF_RUN_CHARS, foldLongProse } from "./lib/prose-fold.ts";

const needsParser = { skip: typeof HTMLRewriter === "undefined" && "needs bun's HTMLRewriter" };
const ROOT = new URL("../", import.meta.url);
const pages = (dir) => readdirSync(new URL(dir, ROOT)).filter((f) => f.endsWith(".html")).map((f) => [`${dir}${f}`, readFileSync(new URL(`${dir}${f}`, ROOT), "utf8")]);
const OPEN = /<section class="fold" style="contain-intrinsic-block-size:auto (\d+)px">/g;
// The page's visible text, read by the same parser the fold uses rather than
// stripped with regexes: script, style and template elements go first, then
// every remaining text node is collected (comments are not text nodes).
const visible = (html) => {
  const bare = new HTMLRewriter().on("script, style, template", { element(e) { e.remove(); } }).transform(html);
  let text = "";
  new HTMLRewriter().onDocument({ text(t) { text += t.text; } }).transform(bare);
  return text;
};

test("folding a garage essay only adds section tags, never moves or changes a word", needsParser, () => {
  let folded = 0;
  for (const [rel, html] of pages("src/pages/garage/")) {
    const out = foldLongProse(html);
    if (out === html) continue;
    folded++;
    assert.equal(visible(out), visible(html), `${rel}: the fold changed the page's text`);
    assert.equal(foldLongProse(out), out, `${rel}: folding twice must change nothing (the twin writer re-dresses pages)`);
  }
  // 21 essays fold today; a count far below that means the selectors stopped matching.
  assert.ok(folded >= 15, `only ${folded} garage essays folded; did .content.prose or its h2s change shape?`);
});

test("every fold opens past the first screen, on an h2, a .demo card or a continuing shelf run, with an intrinsic height", needsParser, () => {
  for (const [rel, html] of pages("src/pages/garage/")) {
    const out = foldLongProse(html);
    const opens = [...out.matchAll(OPEN)];
    if (!opens.length) continue;
    const before = visible(out.slice(out.indexOf('<div class="content prose"'), opens[0].index)).length;
    assert.ok(before >= FOLD_AFTER_CHARS, `${rel}: the first fold opens after ${before} characters, inside the first screen`);
    for (const m of opens) {
      const next = out.slice(m.index + m[0].length).trimStart();
      assert.match(next, /^<(h2\b|section class="demo\b|ul class="shelf\b[^"]*\bcont\b)/, `${rel}: a fold opens on ${next.slice(0, 40)}, where the margin fix does not hold`);
      assert.ok(+m[1] >= 200, `${rel}: an intrinsic height of ${m[1]}px`);
    }
    // folds are siblings: every open after the first is preceded by the previous close
    const closes = (out.match(/<\/section>/g) || []).length - (html.match(/<\/section>/g) || []).length;
    assert.equal(closes, opens.length, `${rel}: ${opens.length} folds opened but ${closes} closed`);
  }
});

test("the LWE chat pages never fold", needsParser, () => {
  for (const [rel, html] of pages("src/pages/lwe/")) {
    assert.equal(foldLongProse(html), html, `${rel}: folded, but the LWE pages measured no gain and a scroll-height jump`);
  }
});

test("prose.css skips the folds and rebuilds the gap above an h2 fold", () => {
  const css = readFileSync(new URL("src/styles/prose.css", ROOT), "utf8");
  assert.match(css, /:where\(\.prose\) > \.fold \{ content-visibility: auto; \}/);
  assert.match(css, /:has\(\+ \.fold > h2:first-child\)[\s\S]*?\{ margin-bottom: 0; \}/, "the block before an h2 fold must drop its bottom margin");
});

// The /garage shelf is one long list, so the fold first cuts it into runs it can
// open between. Each cut has to be invisible: every item kept in order, an even
// count per run so nth-child(even) striping carries on, and the page's seam CSS
// for the classes that mark a cut. Measured with every fold forced visible, the
// split page is exactly as tall as the unsplit one (10,487 px on a phone).
test("the garage shelf splits into seamless runs of whole items", needsParser, () => {
  const html = readFileSync(new URL("src/pages/garage/index.html", ROOT), "utf8");
  const out = foldLongProse(html);
  const runs = [...out.matchAll(/<ul class="(shelf[^"]*)">([\s\S]*?)<\/ul>/g)].map((m) => ({ cls: m[1], items: (m[2].match(/<li\b/g) || []).length, text: visible(m[2]).replace(/\s+/g, " ").length }));
  assert.ok(runs.length >= 3, `the shelf split into ${runs.length} runs`);
  // the point of the split: the fold opens between runs
  const folds = [...out.matchAll(/<section class="fold"[^>]*>\s*<ul class="shelf[^"]*\bcont\b/g)].length;
  assert.ok(folds >= 2, `${folds} folds open on a shelf run`);
  assert.equal(runs.reduce((t, r) => t + r.items, 0), (html.match(/^ {6}<li>/gm) || []).length, "every item is in exactly one run");
  runs.forEach((r, i) => {
    const want = i === 0 ? "shelf open" : i === runs.length - 1 ? "shelf cont" : "shelf open cont";
    assert.equal(r.cls, want, `run ${i + 1} is marked "${r.cls}"`);
    if (i < runs.length - 1) {
      assert.equal(r.items % 2, 0, `run ${i + 1} holds ${r.items} items, which would flip the striping after it`);
      assert.ok(r.text >= SHELF_RUN_CHARS, `run ${i + 1} holds ${r.text} characters`);
    }
  });
  // the seam: a run that continues below loses its bottom edge and keeps its
  // last item's separator; a run that continues from above loses its top edge
  assert.match(html, /\.shelf\.open \{ margin-bottom: 0; border-bottom: 0; \}/);
  assert.match(html, /\.shelf\.open > li:last-child \{ border-bottom: 1px solid var\(--surface-desktop\); \}/);
  assert.match(html, /\.shelf\.cont \{ margin-top: 0; border-top: 0; \}/);
});
