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
import { FOLD_AFTER_CHARS, foldLongProse } from "./lib/prose-fold.ts";

const needsParser = { skip: typeof HTMLRewriter === "undefined" && "needs bun's HTMLRewriter" };
const ROOT = new URL("../", import.meta.url);
const pages = (dir) => readdirSync(new URL(dir, ROOT)).filter((f) => f.endsWith(".html")).map((f) => [`${dir}${f}`, readFileSync(new URL(`${dir}${f}`, ROOT), "utf8")]);
const OPEN = /<section class="fold" style="contain-intrinsic-block-size:auto (\d+)px">/g;
// visible text: tags, comments, scripts and styles out
const visible = (html) => html.replace(/<!--[\s\S]*?-->/g, "").replace(/<(script|style|template)\b[\s\S]*?<\/\1>/gi, "").replace(/<[^>]+>/g, "");

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

test("every fold opens past the first screen, on an h2 or a .demo card, with an intrinsic height", needsParser, () => {
  for (const [rel, html] of pages("src/pages/garage/")) {
    const out = foldLongProse(html);
    const opens = [...out.matchAll(OPEN)];
    if (!opens.length) continue;
    const before = visible(out.slice(out.indexOf('<div class="content prose"'), opens[0].index)).length;
    assert.ok(before >= FOLD_AFTER_CHARS, `${rel}: the first fold opens after ${before} characters, inside the first screen`);
    for (const m of opens) {
      const next = out.slice(m.index + m[0].length).trimStart();
      assert.match(next, /^<(h2\b|section class="demo\b)/, `${rel}: a fold opens on ${next.slice(0, 40)}, where the margin fix does not hold`);
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
