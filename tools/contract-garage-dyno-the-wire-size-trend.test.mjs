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
  const { mergeHistory, renderDynoPage, renderDynoPulls } = await import("../src/worker/dyno.ts");
  const rows = mergeHistory([
    { ts: "2026-08-10", sha: "aaa1111", worker_gzip: 264540, pages_br: 476528, assets_br: 58186, source: "nightly" },
    { ts: "2026-08-11", sha: "bbb2222", worker_gzip: 266000, pages_br: 476000, assets_br: 58200, source: "nightly" },
  ]);
  // The CSS lives in the built shell and the markup in the island, so each
  // half is read from where it ships.
  const css = await renderDynoPage().text();
  const html = renderDynoPulls(rows).html;

  // The bug this pins: a bare `.s-worker { stroke; fill }` outranks
  // `polyline { fill: none }` on specificity, so every series filled down to the
  // axis and the chart rendered as three coloured blobs. It looked like a data
  // problem and was a cascade problem. Every series rule must be element-
  // qualified so a line can never inherit a fill.
  for (const series of ["s-worker", "s-pages", "s-assets"]) {
    assert.match(css, new RegExp(`polyline\\.${series}\\{[^}]*fill:none`),
      `${series} must set fill:none on the polyline, or the line fills into a blob`);
    assert.doesNotMatch(css, new RegExp(`\\.chart \\.${series}\\{`),
      `${series} must not be styled unqualified — that rule outranks polyline{fill:none}`);
  }
  assert.match(html, /<polyline class="s-worker"/);
});

test("the dyno page distinguishes measured points from hand-entered ones", async () => {
  const { mergeHistory, renderDynoPulls } = await import("../src/worker/dyno.ts");
  const html = renderDynoPulls(mergeHistory([
    { ts: "2026-08-10", sha: "aaa1111", worker_gzip: 264540, pages_br: 476528, assets_br: 58186, source: "nightly" },
  ])).html;
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

// ── a built shell and one island, since 2026-09-25 ──────────────────────────
//
// build.ts step 5b bakes renderDynoPage() once; the chart and table arrive from
// /garage/dyno/pulls.html (lib/island.ts). What this pins: the shell is
// deterministic and carries no series point, the placeholder is the same
// renderer's frame with the live row count, and the island may be cached,
// unlike /whoareyou's, because every visitor reads the same series.

test("the dyno shell is deterministic, carries its island, and bakes no series point", async () => {
  const { PULLS_URL, renderDynoPage } = await import("../src/worker/dyno.ts");
  const { islandPreload, islandScript } = await import("../src/worker/lib/island.ts");
  const a = await renderDynoPage().text();
  assert.equal(a, await renderDynoPage().text(), "two renders differ, so the build would bake whichever it got");
  assert.ok(a.includes(`data-island="${PULLS_URL}"`));
  assert.ok(a.includes(islandPreload(PULLS_URL).html), "the fragment must be preloaded from <head>");
  assert.ok(a.includes(islandScript().html));
  assert.match(a, /<noscript>[\s\S]*?dyno\.json[\s\S]*?<\/noscript>/, "a no-JS reader is told where the series is");
  // The build cannot read perf-history, so any line or commit here would be a
  // fixture served as the chart for a week.
  assert.doesNotMatch(a, /<polyline|<circle/);
  assert.doesNotMatch(a, /<td class="mono sha">[0-9a-f]{7}/);
});

test("the dyno placeholder draws the live frame: same chart box, same row count", async () => {
  const { mergeHistory, renderDynoPage, renderDynoPulls } = await import("../src/worker/dyno.ts");
  const nightly = Array.from({ length: 30 }, (_, i) => ({
    ts: `2026-08-${String(i + 1).padStart(2, "0")}`, sha: `abc${String(i).padStart(4, "0")}`,
    worker_gzip: 260000 + i * 100, pages_br: 470000 + i * 50, assets_br: 58000 + i, source: "nightly",
  }));
  const live = renderDynoPulls(mergeHistory(nightly)).html;
  const shell = await renderDynoPage().text();
  const mount = shell.slice(shell.indexOf("data-island="), shell.indexOf("<noscript>", shell.indexOf("data-island=")));
  const count = (s, re) => (s.match(re) || []).length;
  assert.equal(count(mount, /<tr>/g), count(live, /<tr>/g), "the swap would add or remove table rows, which is a layout shift");
  assert.equal(count(mount, /<div class="callout">/g), count(live, /<div class="callout">/g));
  assert.equal(count(mount, /<line class="grid"/g), count(live, /<line class="grid"/g));
  assert.match(mount, /viewBox="0 0 620 210"/);
  assert.match(live, /viewBox="0 0 620 210"/);
});

test("/garage/dyno/pulls.html is an island the browser may cache for five minutes", async () => {
  const { handleDynoPulls } = await import("../src/worker/dyno.ts");
  const { ISLAND_MARKER } = await import("../src/worker/lib/island.ts");
  // No RN_KV: swrKV falls through to the fetch, and a stubbed fetch that fails
  // leaves the seeded history, which is what an unreadable branch renders.
  const realFetch = globalThis.fetch;
  // Object.assign keeps the stub the shape of `typeof fetch`, which carries a
  // `preconnect` member under bun's types.
  globalThis.fetch = Object.assign(async () => { throw new Error("offline"); }, { preconnect: realFetch.preconnect });
  try {
    const res = await handleDynoPulls(new Request("https://aadhar.sh/garage/dyno/pulls.html"), {}, { waitUntil() {} });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get(ISLAND_MARKER), "1");
    assert.equal(res.headers.get("cache-control"), "public, max-age=300, s-maxage=300");
    assert.equal(res.headers.get("x-robots-tag"), "noindex");
    const body = await res.text();
    assert.match(body, /<svg class="chart"/);
    assert.match(body, /by hand/);
    assert.doesNotMatch(body, /<html|<head/i, "a fragment, never a document");
  } finally {
    globalThis.fetch = realFetch;
  }
});
