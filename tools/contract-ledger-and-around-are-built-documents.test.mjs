// ── /ledger and /around are built documents, with their live half as an island ─
// Both rendered per request until 2026-09-25. build.ts step 5b now bakes each
// shell once (q11 twin, dcz delta, ETag), and the part that comes from a remote
// read arrives from an island: /ledger/lines.html (Analytics Engine and the
// billing feed) and /around/snapshot.html (the daily crawl). What this pins:
//   - each shell is deterministic and bakes no live value;
//   - each placeholder is its renderer's own frame with the live row count, so
//     the swap adds no rows;
//   - each island is shared across visitors and so edge-cached, unlike
//     /whoareyou's, and carries the marker the loader requires;
//   - /around's owner bust still refuses a wrong secret.
import assert from "node:assert/strict";
import { test } from "node:test";
import { ISLAND_MARKER, islandPreload, islandScript } from "../src/worker/lib/island.ts";
import { CRAWLERS, handleLedgerLines, LINES_URL, renderLedgerLines, renderLedgerPage } from "../src/worker/ledger.ts";
import { handleAroundSnapshot, NEIGHBORS, refreshAroundSnapshot, renderAroundPage, renderAroundSnapshot, SNAPSHOT_URL } from "../src/worker/around.ts";

const mountOf = (shell) => shell.slice(shell.indexOf("data-island="), shell.indexOf("<noscript>", shell.indexOf("data-island=")));
// No bindings at all: every read degrades to its unconfigured arm.
const NO_BINDINGS = /** @type {import("../src/worker/lib/env.ts").Env} */ (/** @type {unknown} */ ({}));
const count = (s, re) => (s.match(re) || []).length;

// cachedRender reads and writes caches.default, which neither test runtime
// provides. A cache that never hits is the cold-miss path every colo takes once.
async function withColdCache(fn) {
  const real = globalThis.caches;
  const puts = [];
  const fake = { default: { match: async () => undefined, put: async (k, v) => { puts.push([k, v]); }, delete: async () => false } };
  globalThis.caches = /** @type {CacheStorage} */ (/** @type {unknown} */ (fake));
  try { return await fn(puts); } finally { globalThis.caches = real; }
}

for (const { name, render, url, loaderIn } of [
  { name: "/ledger", render: renderLedgerPage, url: LINES_URL, loaderIn: "ledger.json" },
  { name: "/around", render: renderAroundPage, url: SNAPSHOT_URL, loaderIn: "around/json" },
]) {
  test(`${name}'s shell is deterministic and carries its island`, async () => {
    const a = await render().text();
    assert.equal(a, await render().text(), "two renders differ, so the build would bake whichever it got");
    assert.ok(a.includes(`data-island="${url}"`));
    assert.ok(a.includes(islandPreload(url).html), "the fragment must be preloaded from <head>");
    assert.ok(a.includes(islandScript().html));
    assert.match(a, new RegExp(`<noscript>[\\s\\S]*?${loaderIn.replace("/", "\\/")}[\\s\\S]*?<\\/noscript>`), "a no-JS reader is told where the data is");
    assert.doesNotMatch(a, /\d{4}-\d\d-\d\dT\d\d:/, "no timestamp can be baked");
  });
}

test("the ledger placeholder is one unread line per nameable crawler, and names none", async () => {
  const shell = await renderLedgerPage().text();
  const mount = mountOf(shell);
  const rows = [
    { bot: "GPTBot", owner: "OpenAI", kind: "train", hits: 40 },
    { bot: "ClaudeBot", owner: "Anthropic", kind: "train", hits: 30 },
  ];
  // Production's trailing window has held every crawler the table can name, so
  // a full read is what the placeholder is sized for. It is sized from CRAWLERS
  // rather than from the mount, or the comparison could only agree with itself.
  const full = Array.from({ length: CRAWLERS.length }, (_, i) => ({ ...rows[i % 2], bot: `Bot${i}` }));
  const live = renderLedgerLines({ ok: true, rows: full }, { ok: false, reason: "unconfigured" }).html;
  assert.equal(count(mount, /<tr>/g), count(live, /<tr>/g), "the swap would add or remove invoice lines");
  assert.equal(count(mount, /class="lg-cost"/g), count(live, /class="lg-cost"/g));
  assert.doesNotMatch(mount, /<td class="mono">[A-Za-z]/, "the placeholder names no crawler");
  assert.match(mount, /Total due<\/span> <b>\$…<\/b>/);
  assert.match(live, /Total due<\/span> <b>\$\d/);
  // Values are escaped by construction.
  const hostile = renderLedgerLines({ ok: true, rows: [{ bot: "<script>x</script>", owner: "o", kind: "train", hits: 1 }] }, { ok: false, reason: "unconfigured" }).html;
  assert.ok(hostile.includes("&lt;script&gt;x&lt;/script&gt;"));
});

test("/ledger/lines.html is an edge-cached island that degrades without tokens", async () => {
  await withColdCache(async (puts) => {
    const res = await handleLedgerLines(new Request("https://aadhar.sh" + LINES_URL), NO_BINDINGS, { waitUntil(p) { return p; } });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get(ISLAND_MARKER), "1");
    assert.equal(res.headers.get("cache-control"), "public, max-age=60, s-maxage=300");
    assert.equal(res.headers.get("x-robots-tag"), "noindex");
    const body = await res.text();
    assert.match(body, /can't read it back yet/, "no read token is the meter-unreadable line, not an error");
    assert.doesNotMatch(body, /<html|<head/i, "a fragment, never a document");
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(puts.length, 1, "a 200 fragment is stored for the next visitor in this colo");
  });
});

test("the around placeholder is one unnamed row per neighbour", async () => {
  const mount = mountOf(await renderAroundPage().text());
  const report = {
    crawledAt: "2026-09-25T05:41:00.000Z",
    results: NEIGHBORS.map((n, i) => ({ ...n, status: 200, title: `${n.name} home`, description: i % 2 ? "a line" : "", elapsedMs: 100 + i })),
  };
  const live = renderAroundSnapshot(report).html;
  assert.equal(count(mount, /<tr>/g), count(live, /<tr>/g), "the swap would add or remove rows");
  assert.equal(count(live, /<tr>/g), NEIGHBORS.length + 1, "one row per neighbour plus the header");
  assert.equal(count(mount, /class="meta"/g), 1);
  assert.match(mount, /Last crawl:<\/strong> …/);
  // The cron runs daily at 05:41 UTC since 2026-08-14; the page said every 30 min.
  assert.match(live, /once a day by cron/);
  assert.doesNotMatch(live, /every 30 min/);
});

test("/around/snapshot.html refuses a wrong bust secret and serves the cached read", async () => {
  const env = { RN_BUST_SECRET: "right", RN_KV: { get: async () => null } };
  assert.equal(await refreshAroundSnapshot(new Request("https://aadhar.sh" + SNAPSHOT_URL + "?bust=wrong"), env), null);
  assert.equal(await refreshAroundSnapshot(new Request("https://aadhar.sh" + SNAPSHOT_URL), { RN_KV: env.RN_KV }), null, "no secret configured means no bust");
  await withColdCache(async () => {
    const res = await handleAroundSnapshot(new Request("https://aadhar.sh" + SNAPSHOT_URL + "?bust=wrong"), env, { waitUntil(p) { return p; } });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get(ISLAND_MARKER), "1");
    // No snapshot in KV: the pending panel, cached briefly, never a table.
    assert.equal(res.headers.get("cache-control"), "public, max-age=60");
    assert.match(await res.text(), /class="pending"/);
  });
});
