// ── /serendipity's dashboard is a built document, with its events as an island ─
// It rendered per request until 2026-09-25, behind a 60 s edge cache, with
// script-src 'unsafe-inline'. build.ts step 5b now bakes the shell, and the
// pool arrives from /serendipity/events.html. What this pins:
//   - the shell is deterministic and bakes no pool value;
//   - the island is cookie-free and edge-cached, and a mutation evicts it;
//   - a flash ?msg= view still renders live, whole, for the person who acted;
//   - serendipity's policy keeps img-src https: whichever script-src it carries.
import assert from "node:assert/strict";
import { test } from "node:test";
import { ISLAND_MARKER, islandPreload, islandScript } from "../src/worker/lib/island.ts";
import { EVENTS_URL, handleSerendipity, MCP_INFO_PATH, renderMcpInfoPage, renderSerendipityPage, SERENDIPITY_SECURITY_HEADERS, serendipityCsp } from "../serendipity/serendipity.ts";

const EVENTS = [
  { id: "e1", name: "Future <script>", start_at: "2099-01-02T18:00:00Z", location: "NYC", user_status: "going", cover_url: null, attendee_count: 4, host_count: 1, contributors: "alice" },
  { id: "e2", name: "Past thing", start_at: "2001-01-02T18:00:00Z", location: "SF", user_status: null, cover_url: null, attendee_count: 0, host_count: 0, contributors: "" },
];

// A D1 that answers the dashboard's two queries and nothing else.
function fakeDb(events = EVENTS) {
  return { prepare(sql) {
    const bound = { all: async () => ({ results: /FROM events e/.test(sql) ? events : [] }), first: async () => (/COUNT\(\*\) AS n/.test(sql) ? { n: 3 } : null) };
    return { ...bound, bind: () => bound };
  } };
}

// caches.default, which neither test runtime provides.
function fakeCache() {
  const store = new Map(), deleted = [];
  return { deleted, store, default: {
    match: async (k) => store.get(k.url)?.clone(),
    put: async (k, v) => { store.set(k.url, v); },
    delete: async (k) => { deleted.push(k.url); return store.delete(k.url); },
  } };
}

async function withCache(fn) {
  const real = globalThis.caches, c = fakeCache();
  globalThis.caches = /** @type {CacheStorage} */ (/** @type {unknown} */ (c));
  const waits = [];
  try { return await fn(c, { waitUntil(p) { waits.push(p); } }, () => Promise.all(waits)); }
  finally { globalThis.caches = real; }
}

test("the dashboard shell is deterministic, carries its island, and bakes no pool value", async () => {
  const a = await renderSerendipityPage().text();
  assert.equal(a, await renderSerendipityPage().text(), "two renders differ, so the build would bake whichever it got");
  assert.ok(a.includes(`data-island="${EVENTS_URL}"`));
  assert.ok(a.includes(islandPreload(EVENTS_URL).html), "the fragment must be preloaded from <head>");
  assert.ok(a.includes(islandScript().html));
  assert.match(a, /id="ev-search"/, "the toolbar is in the shell, so a search typed before the swap survives it");
  assert.doesNotMatch(a, /<a class="ev|\d+ events? in the pool|data-cover=/);
  // Placeholder cards are inert: no link to an event that does not exist.
  assert.match(a, /<div class="ev" aria-hidden="true">/);
});

test("/serendipity/events.html is a cookie-free, edge-cached island", async () => {
  await withCache(async (c, ctx, settle) => {
    const env = { SERENDIPITY_DB: fakeDb() };
    const res = await handleSerendipity(new Request("https://aadhar.sh" + EVENTS_URL), env, ctx);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get(ISLAND_MARKER), "1");
    assert.equal(res.headers.get("cache-control"), "public, max-age=60, s-maxage=60");
    assert.equal(res.headers.get("set-cookie"), null, "a shared fragment must never mint a visitor's uid");
    const body = await res.text();
    assert.match(body, /2 events in the pool, fed by 3 contributors/);
    assert.match(body, /<a class="ev"/);
    assert.ok(body.includes("Future &lt;script&gt;") && !body.includes("Future <script>"), "event names are escaped");
    await settle();
    assert.equal(c.store.size, 1, "the fragment is stored for the next visitor in this colo");
    // A mutation evicts the island, as it used to evict the cached dashboard.
    await handleSerendipity(new Request("https://aadhar.sh/serendipity/add-event", { method: "POST", body: new FormData() }), env, ctx);
    await settle();
    assert.ok(c.deleted.includes("https://aadhar.sh" + EVENTS_URL));
  });
});

test("a flash ?msg= view still renders live and whole", async () => {
  await withCache(async (_c, ctx) => {
    const res = await handleSerendipity(new Request("https://aadhar.sh/serendipity?msg=Thanks%20for%20contributing"), { SERENDIPITY_DB: fakeDb() }, ctx);
    assert.equal(res.status, 200);
    const body = await res.text();
    assert.match(body, /class="banner ok">Thanks for contributing/);
    assert.match(body, /2 events in the pool/, "the live view carries its own events, no island");
    assert.doesNotMatch(body, /data-island=/);
  });
});

test("an empty pool hides the toolbar in both renders", async () => {
  await withCache(async (_c, ctx) => {
    const live = await (await handleSerendipity(new Request("https://aadhar.sh/serendipity?msg=x"), { SERENDIPITY_DB: fakeDb([]) }, ctx)).text();
    assert.match(live, /The pool is empty/);
    assert.doesNotMatch(live, /id="ev-search"/);
  });
  // The built shell cannot know, so a :has() rule hides it once the island says so.
  assert.match(await renderSerendipityPage().text(), /\.toolbar:has\(\+ \[data-island\] \.empty\)\{display:none\}/);
});

test("serendipity's policy keeps its img-src whichever script-src it carries", () => {
  const hashed = serendipityCsp("'self' 'sha256-abc='");
  assert.match(hashed, /script-src 'self' 'sha256-abc='; /);
  assert.doesNotMatch(hashed, /unsafe-inline'; img/);
  assert.match(hashed, /img-src 'self' data: https:/, "the cover proxy's https fallback must stay loadable");
  assert.equal(SERENDIPITY_SECURITY_HEADERS["content-security-policy"], serendipityCsp("'self' 'unsafe-inline'"));
});

test("the agents page is a deterministic bake, and the live arm still renders it", async () => {
  // Baked by build.ts step 5b since 2026-09-25 with no island, because nothing
  // on it is read per request. The live arm stays for local dev's missing bake.
  const a = await renderMcpInfoPage().text();
  assert.equal(a, await renderMcpInfoPage().text(), "two renders differ, so the build would bake whichever it got");
  assert.match(a, /list_events/);
  assert.match(a, /https:\/\/aadhar\.sh\/serendipity\/mcp/, "the endpoint it tells an agent to call");
  await withCache(async (_c, ctx) => {
    const live = await handleSerendipity(new Request("https://aadhar.sh" + MCP_INFO_PATH), { SERENDIPITY_DB: fakeDb() }, ctx);
    assert.equal(live.status, 200);
    assert.equal(await live.text(), a, "the bake and the live render are the same bytes");
  });
});
