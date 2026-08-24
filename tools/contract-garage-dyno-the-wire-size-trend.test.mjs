// ── /garage/dyno, the wire-size trend ───────────────────────────────────────
// Split from contract-tests.test.mjs; shared imports live in contract-shared.mjs.
import {
  assert,
  test,
} from "./contract-shared.ts";

// ── /garage/dyno, the wire-size trend ───────────────────────────────────────
//
// The page is a pure function of its rows, which is what lets it be asserted
// here rather than only looked at. All three tests below came out of building
// it, and the middle one is a bug that shipped to a screenshot.

test("the dyno series merges hand-entered history under measured rows", async () => {
  const { mergeHistory } = await import("../src/worker/dyno.ts");
  const seeded = mergeHistory([]);
  assert.ok(seeded.length >= 4, "the seeded baseline history must survive an empty fetch");
  assert.ok(seeded.every((r) => r.source === "baseline-note"));
  // Sorted by date, so the chart's x-scale never has to.
  assert.deepEqual([...seeded].sort((a, b) => (a.ts < b.ts ? -1 : 1)).map((r) => r.ts), seeded.map((r) => r.ts));

  // A measured row for a seeded day REPLACES it. Both describe the same day and
  // the measured one is the better fact; keeping both would draw two points on
  // one date and a vertical line between them.
  const clash = seeded[seeded.length - 1].ts;
  const merged = mergeHistory([{ ts: clash, sha: "abc1234", worker_gzip: 1, source: "nightly" }]);
  const hit = merged.filter((r) => r.ts === clash);
  assert.equal(hit.length, 1);
  assert.equal(hit[0].source, "nightly");
});

test("the dyno chart draws lines, not filled regions", async () => {
  const { mergeHistory, renderDyno } = await import("../src/worker/dyno.ts");
  const rows = mergeHistory([
    { ts: "2026-08-10", sha: "aaa1111", worker_gzip: 264540, pages_br: 476528, assets_br: 58186, source: "nightly" },
    { ts: "2026-08-11", sha: "bbb2222", worker_gzip: 266000, pages_br: 476000, assets_br: 58200, source: "nightly" },
  ]);
  const html = await renderDyno(rows).text();

  // The bug this pins: a bare `.s-worker { stroke; fill }` outranks
  // `polyline { fill: none }` on specificity, so every series filled down to the
  // axis and the chart rendered as three coloured blobs. It looked like a data
  // problem and was a cascade problem. Every series rule must be element-
  // qualified so a line can never inherit a fill.
  for (const series of ["s-worker", "s-pages", "s-assets"]) {
    assert.match(html, new RegExp(`polyline\\.${series}\\{[^}]*fill:none`),
      `${series} must set fill:none on the polyline, or the line fills into a blob`);
    assert.doesNotMatch(html, new RegExp(`\\.chart \\.${series}\\{`),
      `${series} must not be styled unqualified — that rule outranks polyline{fill:none}`);
  }
  assert.match(html, /<polyline class="s-worker"/);
});

test("the dyno page distinguishes measured points from hand-entered ones", async () => {
  const { mergeHistory, renderDyno } = await import("../src/worker/dyno.ts");
  const html = await renderDyno(mergeHistory([
    { ts: "2026-08-10", sha: "aaa1111", worker_gzip: 264540, pages_br: 476528, assets_br: 58186, source: "nightly" },
  ])).text();
  // Dashed for the seeded prefix, solid for the measured tail, and the legend
  // says which is which. A chart that renders a number somebody typed into a
  // code comment identically to one a runner measured is lying about its own
  // provenance, which on a page ABOUT measurement discipline is the one thing
  // it cannot do.
  assert.match(html, /<polyline class="s-worker dashed"/);
  assert.match(html, /dashed: recorded by hand before this series existed/);
  assert.match(html, /<td class="src">by hand<\/td>/);
  assert.match(html, /<td class="src">measured<\/td>/);
  // Zero client JS: the whole chart is server-rendered SVG.
  assert.doesNotMatch(html.split('<svg class="chart"')[1].split("</svg>")[0], /<script/);
});
