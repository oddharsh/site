// ── a non-blocking page paints from an ordered subset of luna.css ────────────
// build.ts step 5f swaps the render-blocking luna.css and prose.css links on the
// pages lib/critical-css.ts lists for a derived subset of each plus a
// non-blocking load of the whole sheet. Rendered output stays identical only
// while the subset is the sheet with rules dropped and none added or reordered,
// and first paint stays shift-free only while the subset keeps every rule the
// page's HTML or its scripts can match. These pin both, on small sheets whose
// answer is written out.
//
// HTMLRewriter is a bun global, so under node the suite skips, matching
// contract-long-pages-fold-below-the-screen.test.ts.
import assert from "node:assert/strict";
import { test } from "node:test";
import { criticalCss, isOrderedSubset, nonBlockingPage } from "../lib/critical-css.ts";

const needsParser = { skip: typeof HTMLRewriter === "undefined" && "needs bun's HTMLRewriter" };

const SHEET =
  '/*! banner */:root{--a:1px}@property --p{syntax:"<length>";inherits:false;initial-value:0px}' +
  ".window>.content{padding:var(--a)}.absent{color:red}" +
  "@media (width<720px){.window{gap:1px}.absent{gap:2px}}" +
  ".title-bar:hover{color:blue}a+b{margin:0}.axp-resize{position:absolute}#axp-clock .t{x:y}";
const HTML = '<html><body><div class="window"><div class="title-bar"></div><main class="content"></main></div></body></html>';

test("keeps what the page or its scripts can match, in the sheet's order", needsParser, async () => {
  const subset = await criticalCss(SHEET, HTML, ["el('<div class=\"axp-resize\">')"]);
  assert.equal(
    subset,
    ':root{--a:1px}@property --p{syntax:"<length>";inherits:false;initial-value:0px}' +
      ".window>.content{padding:var(--a)}@media (width<720px){.window{gap:1px}}" +
      ".title-bar:hover{color:blue}a+b{margin:0}.axp-resize{position:absolute}",
  );
  assert.equal(isOrderedSubset(subset, SHEET), true);
});

test("a script word only counts when every class and id in the selector is one", needsParser, async () => {
  assert.equal(
    (await criticalCss(SHEET, HTML, ['clock.id = "axp-clock"; span.className = "t"'])).includes("#axp-clock .t{x:y}"),
    true,
    "a rule only the page's scripts can match was dropped",
  );
  assert.equal((await criticalCss(SHEET, HTML, ['clock.id = "axp-clock"'])).includes("#axp-clock"), false);
});

test("a reordered or invented rule is not an ordered subset", () => {
  assert.equal(isOrderedSubset(".absent{color:red}.window>.content{padding:var(--a)}", SHEET), false, "a reordered rule passed as an ordered subset");
  assert.equal(isOrderedSubset(".window>.content{padding:0}", SHEET), false);
  assert.equal(isOrderedSubset(".window>.content{padding:var(--a)}.absent{color:red}", SHEET), true);
});

test("refuses a sheet with @layer, where a subset could reorder layers", needsParser, async () => {
  await assert.rejects(criticalCss("@layer a{.window{gap:0}}", HTML), /@layer/);
});

test("the page swaps each link once and waits for the first fold", needsParser, async () => {
  const page =
    '<head><meta charset="utf-8"><link rel="stylesheet" href="/luna.css"></head>' +
    '<body><div class="window"><main class="content"><section class="fold" style="x"></section><section class="fold"></section></main></div></body>';
  const out = await nonBlockingPage(page, [{ href: "/luna.css", css: ".window{gap:0}.absent{gap:1px}" }], []);
  assert.equal(
    out,
    '<head><meta charset="utf-8">\n<link rel="expect" href="#first-fold" blocking="render"><style>.window{gap:0}</style>\n' +
      '<link rel="stylesheet" href="/luna.css" media="print" id="luna-css">\n' +
      '<script>(function(){var l=document.getElementById("luna-css");function f(){l.media="all"}l.sheet?f():l.addEventListener("load",f,{once:true})})();</script>\n' +
      '<noscript><link rel="stylesheet" href="/luna.css"></noscript></head>' +
      '<body><div class="window"><main class="content"><section class="fold" id="first-fold" style="x"></section><section class="fold"></section></main></div></body>',
  );
  await assert.rejects(nonBlockingPage(page.replace('class="fold"', 'class="x"').replace('class="fold"', 'class="x"'), [], []), /no prose fold/);
});
