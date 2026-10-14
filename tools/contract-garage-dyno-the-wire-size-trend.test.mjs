// ── /garage/dyno, the wire-size trend ───────────────────────────────────────
// Split from contract-tests.test.mjs; shared imports live in contract-shared.mjs.
import {
  assert,
  test,
} from "./contract-shared.ts";

test("the dyno series merges hand-entered history under measured rows", async () => {
  const { mergeHistory } = await import("../src/worker/dyno.ts");
  const seeded = mergeHistory([]);
  assert.ok(seeded.length >= 4, "the seeded baseline history must survive an empty fetch");
  assert.ok(seeded.every((r) => r.source === "baseline-note"));
  assert.deepEqual([...seeded].sort((a, b) => (a.ts < b.ts ? -1 : 1)).map((r) => r.ts), seeded.map((r) => r.ts));

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
  const css = await renderDynoPage().text();
  const html = renderDynoPulls(rows).html;

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
  assert.match(html, /<polyline class="s-worker dashed"/);
  assert.match(html, /dashed: recorded by hand before this series existed/);
  assert.match(html, /<td class="src">by hand<\/td>/);
  assert.match(html, /<td class="src">measured<\/td>/);
  assert.doesNotMatch(html.split('<svg class="chart"')[1].split("</svg>")[0], /<script/);
});

test("the dyno shell is deterministic, carries its island, and bakes no series point", async () => {
  const { PULLS_URL, renderDynoPage } = await import("../src/worker/dyno.ts");
  const { islandPreload, islandScript } = await import("../src/worker/lib/island.ts");
  const a = await renderDynoPage().text();
  assert.equal(a, await renderDynoPage().text(), "two renders differ, so the build would bake whichever it got");
  assert.ok(a.includes(`data-island="${PULLS_URL}"`));
  assert.ok(a.includes(islandPreload(PULLS_URL).html), "the fragment must be preloaded from <head>");
  assert.ok(a.includes(islandScript().html));
  assert.match(a, /<noscript>[\s\S]*?dyno\.json[\s\S]*?<\/noscript>/, "a no-JS reader is told where the series is");
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
