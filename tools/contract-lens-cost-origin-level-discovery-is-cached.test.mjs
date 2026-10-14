// ── lens cost: origin-level discovery is cached ──────────────────────────
// Split from contract-tests.test.mjs; shared imports live in contract-shared.mjs.
import {
  testGlobals,
  assert,
  readFileSync,
  test,
} from "./contract-shared.ts";

const doh = () => new Response(JSON.stringify({ Status: 3 }), { headers: { "content-type": "application/dns-json" } });

let dohCalls = 0;
const countedDoh = () => { dohCalls++; return doh(); };

test("a second scan of the same origin reuses discovery instead of re-probing", async () => {
  const { originDiscovery } = await import("../src/worker/lens.ts");
  const store = new Map();
  const realCaches = globalThis.caches;
  const realFetch = globalThis.fetch;
  dohCalls = 0;
  testGlobals.fetch = countedDoh;
  testGlobals.caches = {
    default: {
      async match(req) { const hit = store.get(req.url); return hit ? new Response(hit) : undefined; },
      async put(req, res) { store.set(req.url, await res.text()); },
    },
  };
  try {
    const first = await originDiscovery("https://example.com", "example.com", {});
    assert.equal(first.cached, false, "a cold origin must actually probe");
    assert.equal(store.size, 1, "the result must be cached for the next scan");
    assert.ok(dohCalls > 0, "a cold origin that made no request did not probe at all");

    const cold = dohCalls;
    const second = await originDiscovery("https://example.com", "example.com", {});
    assert.equal(second.cached, true, "a warm origin must not re-probe");
    assert.equal(dohCalls, cold, "a warm origin re-probed the network behind the cached flag");
    const { cached: _a, ...firstBody } = first;
    const { cached: _b, ...secondBody } = second;
    assert.deepEqual(secondBody, firstBody);

    const other = await originDiscovery("https://other.example", "other.example", {});
    assert.equal(other.cached, false);
    assert.equal(store.size, 2);
    assert.ok(dohCalls > cold, "a different origin must actually be probed, not served a stale hit");

    const warm = dohCalls;
    const forced = await originDiscovery("https://example.com", "example.com", {}, { fresh: true });
    assert.equal(forced.cached, false);
    assert.ok(dohCalls > warm, "`fresh` returned the cached body rather than bypassing the cache");
  } finally {
    testGlobals.fetch = realFetch;
    if (realCaches === undefined) delete globalThis.caches; else testGlobals.caches = realCaches;
  }
});

test("discovery still works with no cache at all", async () => {
  const { originDiscovery } = await import("../src/worker/lens.ts");
  const realCaches = globalThis.caches;
  const realFetch = globalThis.fetch;
  testGlobals.fetch = doh;
  delete globalThis.caches;
  try {
    const out = await originDiscovery("https://example.com", "example.com", {});
    assert.equal(out.cached, false);
    assert.ok("robots" in out && "llms" in out && "mcp" in out);
  } finally {
    testGlobals.fetch = realFetch;
    if (realCaches !== undefined) testGlobals.caches = realCaches;
  }
});

test("readDoors reads lens's discovery rather than re-probing the same files", async () => {
  const src = readFileSync("src/worker/lib/doors.ts", "utf8");
  assert.match(src, /originDiscovery/, "doors must consume the shared discovery");
  for (const dup of ["/llms.txt", "/.well-known/agent-card.json", "/.well-known/api-catalog"]) {
    assert.ok(!src.includes(`lensProbe(origin + "${dup}"`), `doors re-probes ${dup} instead of reusing discovery`);
  }
});
