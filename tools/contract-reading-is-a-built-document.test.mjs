// ── /reading is a built document, with its list as an island ─────────────────
// It rendered per request until 2026-09-29, on config/per-request-pages.json with
// the reason that the Curius items are most of the page. build.ts step 5b now
// bakes the shell once (q11 twin, dcz delta, ETag, hashed CSP), and the list
// arrives from /reading/list.html. What this pins:
//   - the shell is deterministic, carries its island, and bakes no live value;
//   - the placeholder is the list renderer's own markup, fed a placeholder model;
//   - nothing visible follows the island, since its height is the list's;
//   - the island is edge-cached for everyone, and an empty read is not;
//   - the owner's bust still refuses a wrong secret.
import assert from "node:assert/strict";
import { test } from "node:test";
import { ISLAND_MARKER, islandPreload, islandScript } from "../src/worker/lib/island.ts";
import { handleReadingList, LIST_URL, refreshReadingList, renderReadingList, renderReadingPage } from "../src/worker/reading.ts";

const mountOf = (shell) => shell.slice(shell.indexOf("data-island="), shell.indexOf("<noscript>", shell.indexOf("data-island=")));
const NO_BINDINGS = /** @type {import("../src/worker/lib/env.ts").Env} */ (/** @type {unknown} */ ({}));

// cachedRender reads and writes caches.default, which neither test runtime
// provides. A cache that never hits is the cold-miss path every colo takes once.
async function withColdCache(fn) {
  const real = globalThis.caches;
  const puts = [];
  const fake = { default: { match: async () => undefined, put: async (k, v) => { puts.push([k, v]); }, delete: async () => false } };
  globalThis.caches = /** @type {CacheStorage} */ (/** @type {unknown} */ (fake));
  try { return await fn(puts); } finally { globalThis.caches = real; }
}

const ITEMS = [
  { title: "A post", link: "https://a.com/x", domain: "a.com", created: "2026-09-28T00:00:00Z", snippet: "s", highlights: ["h"] },
  { title: "Another", link: "https://b.com/", domain: "b.com", created: "2026-08-02T00:00:00Z" },
];

test("/reading's shell is deterministic and carries its island", async () => {
  const a = await renderReadingPage().text();
  assert.equal(a, await renderReadingPage().text(), "two renders differ, so the build would bake whichever it got");
  assert.ok(a.includes(`data-island="${LIST_URL}"`));
  assert.ok(a.includes(islandPreload(LIST_URL).html), "the fragment must be preloaded from <head>");
  assert.ok(a.includes(islandScript().html));
  assert.match(a, /<noscript>[\s\S]*?\/reading\/list\.html[\s\S]*?<\/noscript>/, "a no-JS reader is told where the list is");
});

test("the bake links no saved item and states no count or sync date", async () => {
  const shell = await renderReadingPage().text();
  assert.doesNotMatch(shell, /<a class="rd-title" href=/, "a linked title in the bake would be one build's list");
  assert.doesNotMatch(shell, /\d+ links? &middot;|last synced \d/);
  // The control: the same patterns do match a live list.
  const live = renderReadingList({ items: ITEMS, fetchedAt: "2026-09-29T00:00:00Z" }).html;
  assert.match(live, /<a class="rd-title" href=/);
  assert.match(live, /2 links &middot;[\s\S]*last synced 2026-09-29/);
});

test("the placeholder is the list's own markup, and nothing visible follows the island", async () => {
  const shell = await renderReadingPage().text();
  const mount = mountOf(shell);
  const live = renderReadingList({ items: ITEMS, fetchedAt: "2026-09-29T00:00:00Z" }).html;
  for (const cls of ["rd-bar", "rd-month", "rd-item", "rd-head", "rd-title", "rd-meta", "rd-dom"]) {
    assert.ok(mount.includes(`class="${cls}"`), `the placeholder lost .${cls}`);
    assert.ok(live.includes(`class="${cls}"`), `the live list lost .${cls}`);
  }
  assert.ok(mount.includes("<footer>") && live.includes("<footer>"), "the footer rides in the island");
  // After the mount: its failure note (hidden unless the fetch failed), then the
  // window chrome. The footer sat below the list before and would jump on swap.
  const mountEnd = shell.indexOf("</noscript></div>");
  assert.ok(mountEnd > 0 && shell.lastIndexOf("<footer>") < mountEnd, "the footer belongs inside the island");
  // Values are escaped by construction.
  const hostile = renderReadingList({ items: [{ title: "<script>x</script>", link: "https://e.example/", domain: "e.example" }] }).html;
  assert.ok(hostile.includes("&lt;script&gt;x&lt;/script&gt;") && !hostile.includes("<script>x"));
});

test("/reading/list.html is an island, and an empty read is cached briefly", async () => {
  await withColdCache(async (puts) => {
    const waits = [];
    const res = await handleReadingList(new Request("https://aadhar.sh" + LIST_URL), NO_BINDINGS, { waitUntil(p) { waits.push(p); } });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get(ISLAND_MARKER), "1");
    assert.equal(res.headers.get("x-robots-tag"), "noindex");
    // No store and no signing key: the can't-reach-Curius panel, for a minute.
    assert.equal(res.headers.get("cache-control"), "public, max-age=60");
    const body = await res.text();
    assert.match(body, /rd-empty/);
    assert.doesNotMatch(body, /<html|<head/i, "a fragment, never a document");
    await Promise.all(waits);
    assert.equal(puts.length, 1, "a 200 fragment is stored for the next visitor in this colo");
  });
});

test("the owner's bust refuses a wrong or unconfigured secret", async () => {
  const env = { RN_BUST_SECRET: "right" };
  const ctx = { waitUntil() {} };
  assert.equal(await refreshReadingList(new Request("https://aadhar.sh" + LIST_URL + "?bust=wrong"), env, ctx), null);
  assert.equal(await refreshReadingList(new Request("https://aadhar.sh" + LIST_URL + "?bust=right"), NO_BINDINGS, ctx), null, "no secret configured means no bust");
});
