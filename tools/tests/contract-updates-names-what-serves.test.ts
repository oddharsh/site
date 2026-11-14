// ── /updates never passes off a logged release as the running build ─────────
// The newest checkpoint is the newest LOGGED release. On 2026-10-17 /updates and
// /updates.json called aadhar-v195-cota-wec (logged 2026-09-12) the running
// build while production served commit 2d0efdb2. /updates.json renders per
// version, so it names the serving version from CF_VERSION_METADATA beside the
// release; /updates is baked at build step 1f, so it names the release by date
// and sends the reader to /whoareyou for the serving version.
import assert from "node:assert/strict";
import { test } from "node:test";
import checkpoints from "../../src/worker/checkpoints.json" with { type: "json" };
import { handleUpdatesJson, renderWindowsUpdate } from "../../src/worker/updates.ts";

// cachedRender reads and writes caches.default, which neither test runtime
// provides. A cache that never hits is the cold-miss path every colo takes once.
async function withColdCache(fn) {
  const real = globalThis.caches;
  globalThis.caches = { default: { match: async () => undefined, put: async () => {}, delete: async () => false } } as unknown as CacheStorage;
  try {
    return await fn();
  } finally {
    globalThis.caches = real;
  }
}

const newest = checkpoints[checkpoints.length - 1];
const get = (env) => withColdCache(() => handleUpdatesJson(new Request("https://aadhar.sh/updates.json"), env, undefined).then((r) => r.json()));

test("/updates.json names the version that rendered it beside the newest logged release", async () => {
  const j = await get({ CF_VERSION_METADATA: { id: "0a1b2c3d-4e5f-6789-abcd-ef0123456789", tag: "", timestamp: "" } });
  assert.deepEqual(Object.keys(j), ["serving", "release", "items"]);
  assert.equal(j.serving, "0a1b2c3d-4e5f-6789-abcd-ef0123456789");
  assert.equal(j.release, newest.version);
  assert.deepEqual(j.items[0], { slug: newest.slug, title: newest.title });
  assert.equal(j.items.length, 8);
});

test("/updates.json says null for the serving version when the binding is absent", async () => {
  const j = await get({});
  assert.equal(j.serving, null);
  assert.equal(j.release, newest.version);
});

test("the baked /updates header names the newest release as logged and points at /whoareyou", async () => {
  const page = await (await renderWindowsUpdate({ points: checkpoints, state: "ok" })).text();
  assert.ok(!page.includes("running build"), "a baked page can't know the running build");
  assert.ok(page.includes(`newest logged release <span class="mono">${newest.version}</span>, ${newest.ymd}.`));
  assert.ok(page.includes(`the version serving this page is on <a href="/whoareyou">/whoareyou</a>`));
});
