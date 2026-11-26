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
});

test("a page with no fold waits for its task pane, and one with neither paints as it arrives", needsParser, async () => {
  const sheet = [{ href: "/luna.css", css: ".window{gap:0}" }];
  const page =
    '<head><meta charset="utf-8"><link rel="stylesheet" href="/luna.css"></head>' +
    '<body><div class="window"><main class="content"><p>x</p></main><div class="h2l"><aside></aside></div></div></body>';
  const held = await nonBlockingPage(page, sheet, [], { taskPane: '<div class="h2l"' });
  assert.match(held, /<meta charset="utf-8">\n<link rel="expect" href="#first-pane" blocking="render">/);
  assert.match(held, /<div class="h2l" id="first-pane"><aside>/);
  // No fold and no pane: swapped, with no expect, rather than refused.
  const bare = await nonBlockingPage(page.replace('<div class="h2l"><aside></aside></div>', ""), sheet, [], { taskPane: '<div class="h2l"' });
  assert.match(bare, /<style>\.window\{gap:0\}<\/style>/);
  assert.doesNotMatch(bare, /rel="expect"/);
});

test("a sheet the page never links is skipped, and luna.css is always required", needsParser, async () => {
  const page = '<head><meta charset="utf-8"><link rel="stylesheet" href="/luna.css"></head><body><div class="window"></div></body>';
  const out = await nonBlockingPage(
    page,
    [
      { href: "/luna.css", css: ".window{gap:0}" },
      { href: "/prose.css", css: ".p{gap:0}" },
    ],
    [],
  );
  assert.doesNotMatch(out, /prose/);
  await assert.rejects(nonBlockingPage("<head></head>", [{ href: "/luna.css", css: ".window{gap:0}" }], []), /expected exactly one/);
});

// Gotcha 116: authored names cannot match selectors after the class rename.
test("a readable twin derives the same subset from served markup while retaining authored class names", needsParser, async () => {
  const source = '<head><meta charset="utf-8"><link rel="stylesheet" href="/luna.css"></head><div class="authored"></div>';
  const served = source.replace('class="authored"', 'class="a"');
  const sheets = [{ href: "/luna.css", css: ".a{height:20px}.absent{height:30px}" }];
  const twin = await nonBlockingPage(source, sheets, [], { matchingHtml: served });
  const page = await nonBlockingPage(served, sheets, []);
  const inline = (html: string) => /<style>(.*?)<\/style>/.exec(html)?.[1];
  assert.equal(inline(twin), inline(page), "the readable twin must carry the served page's critical rules");
  assert.equal(inline(twin), ".a{height:20px}");
  assert.match(twin, /class="authored"/);
  assert.notEqual(inline(await nonBlockingPage(source, sheets, [])), inline(page), "control: matching authored names against renamed CSS loses the rule");
});

test("matches inside :where() and :is() and drops @media print", needsParser, async () => {
  const sheet =
    ":where(.window){display:block}:where(.xp-tabs){display:flex}" +
    ":where(.title-bar :is(.min,.absent):focus-visible){outline:1px solid}" +
    ":is(input,textarea){font-size:16px}" +
    ":where(.axp-acc){position:fixed}" +
    "@media print{.window{box-shadow:none}}";
  const doc = '<html><body><div class="window"><div class="title-bar"><button class="min"></button></div></div></body></html>';
  const subset = await criticalCss(sheet, doc, ['el("<div class=axp-acc>")']);
  assert.ok(!subset.includes(".xp-tabs"), "unused :where() rule must be dropped");
  assert.ok(!subset.includes("textarea"), "unused :is() rule must be dropped");
  assert.ok(!subset.includes("@media print"), "@media print rules must not be inlined for screen first paint");
  assert.equal(
    subset,
    ":where(.window){display:block}" + ":where(.title-bar :is(.min,.absent):focus-visible){outline:1px solid}" + ":where(.axp-acc){position:fixed}",
  );
  assert.equal(isOrderedSubset(subset, sheet), true);
});

test("prunes unreferenced :root custom properties while keeping transitive, script, and sibling-sheet refs", needsParser, async () => {
  const sheet =
    ":root{--used:var(--chain);--chain:#111;--dead:#222;--sa-t:0px;--prose-ink:#333}" +
    "@media (color-gamut:p3){:root{--used:color(display-p3 0 0 0);--dead:color(display-p3 1 0 0)}}" +
    ".window{color:var(--used)}";
  const page =
    '<head><meta charset="utf-8"><link rel="stylesheet" href="/luna.css"><link rel="stylesheet" href="/prose.css"></head>' +
    '<body><div class="window"></div></body>';
  const out = await nonBlockingPage(
    page,
    [
      { href: "/luna.css", css: sheet },
      { href: "/prose.css", css: ".window{border-color:var(--prose-ink)}" },
    ],
    ['getComputedStyle(root).getPropertyValue("--" + "sa-t")'],
  );
  const lunaInline = /<style>(.*?)<\/style>/.exec(out)?.[1] ?? "";
  assert.equal(
    lunaInline,
    ":root{--used:var(--chain);--chain:#111;--sa-t:0px;--prose-ink:#333}" +
      "@media (color-gamut:p3){:root{--used:color(display-p3 0 0 0)}}" +
      ".window{color:var(--used)}",
  );
  assert.equal(isOrderedSubset(lunaInline, sheet), true);
  assert.equal(isOrderedSubset(":root{--chain:#111;--used:var(--chain)}", sheet), false, "reordered :root declarations are not an ordered subset");
  assert.equal(isOrderedSubset(":root{--used:#999}", sheet), false, "mutated :root declarations are not an ordered subset");
});
