// ── around.js ────────────────────────────────────────────────────────────────
// Split from contract-tests.test.mjs; shared imports live in contract-shared.mjs.
import {
  NEIGHBORS,
  assert,
  diffAroundRows,
  renderAroundHtml,
  test,
} from "./contract-shared.mjs";

// ── around.js ────────────────────────────────────────────────────────────────
// Every degradation in the neighbourhood crawler is designed to be QUIET: a
// disallowing robots.txt is a legitimate skip, and a neighbour that has gone
// dark simply stops contributing rows. That is correct behaviour and it is also
// why nothing here announces a regression, which is how the module reached 24.9%
// line coverage while owning the site's only scheduled crawl.

test("around diffAroundRows() reports nothing without two snapshots to compare", () => {
  const row = { status: 200, title: "t", body_hash: "a" };
  assert.deepEqual(diffAroundRows(null, row), [], "no current snapshot is not a change");
  assert.deepEqual(diffAroundRows(row, null), [], "no previous snapshot is not a change either");
  assert.deepEqual(diffAroundRows(row, row), [], "an identical pair is not a change");
});

test("around diffAroundRows() names the field that moved", () => {
  const before = { status: 200, title: "Old", description: "d", final_url: "u", content_type: "text/html", robots: "allow" };
  const after = { ...before, title: "New" };
  const changes = diffAroundRows(after, before);
  assert.equal(changes.length, 1, "one field moved, one change reported");
  assert.equal(changes[0].field, "title");
  assert.equal(changes[0].before, "Old");
  assert.equal(changes[0].after, "New");

  const twoMoved = diffAroundRows({ ...before, title: "New", status: 301 }, before);
  assert.deepEqual(twoMoved.map((c) => c.field).sort(), ["status", "title"]);
});

test("around a content change requires BOTH snapshots to be live", () => {
  // The sharp rule in that function, and the one worth pinning: body_hash is
  // only compared when the neighbour was reachable on both sides. Without it
  // every outage and every recovery would report "content changed", because an
  // error page hashes differently from the real one — and the whole point of
  // this surface is that a quiet degradation stays legible rather than drowning
  // in noise it generated itself.
  const live = { status: 200, body_hash: "aaa" };
  const alsoLive = { status: 200, body_hash: "bbb" };
  const down = { status: 500, body_hash: "err" };
  const errored = { status: 200, error: "timeout", body_hash: "zzz" };

  const real = diffAroundRows(alsoLive, live);
  assert.ok(real.some((c) => c.field === "content"), "two live snapshots with different bodies IS a content change");

  for (const [current, previous, label] of [
    [live, down, "recovering from an outage"],
    [down, live, "going down"],
    [live, errored, "recovering from a fetch error"],
    [errored, live, "hitting a fetch error"],
  ]) {
    const changes = diffAroundRows(current, previous);
    assert.ok(!changes.some((c) => c.field === "content"),
      `${label} must not be reported as a content change`);
  }
});

test("around the neighbour roster is well formed", () => {
  assert.ok(NEIGHBORS.length >= 10, `expected the roster, found ${NEIGHBORS.length}`);
  const urls = new Set();
  for (const n of NEIGHBORS) {
    assert.ok(n.name && typeof n.name === "string", "every neighbour is named");
    const u = new URL(n.url);
    assert.equal(u.protocol, "https:", `${n.name} must be crawled over https`);
    assert.ok(!urls.has(u.href), `${n.name} duplicates ${u.href}`);
    urls.add(u.href);
  }
});

test("around renders an honest empty panel rather than a fabricated table", async () => {
  // The failure-honesty rule this file states at renderAroundHtml: no snapshot
  // means a visibly pending panel, never invented rows. Only ever seen before
  // the first cron run, which is exactly when nobody is looking.
  const response = renderAroundHtml(null);
  assert.ok(response instanceof Response, "it renders a Response, not a string");
  assert.equal(response.status, 200, "a pending panel is a 200, not an error");
  assert.match(response.headers.get("content-type") || "", /text\/html/);
  const empty = await response.text();
  assert.match(empty, /<html/i, "it still renders a page");
  assert.match(empty, /noindex/, "an empty snapshot is not indexable");
  for (const n of NEIGHBORS.slice(0, 3)) {
    assert.ok(!empty.includes(`>${n.name}<`), `${n.name} must not appear as a row when there is no data`);
  }
});
