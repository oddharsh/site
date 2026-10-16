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
  // The call, inside readDoors itself. A bare /originDiscovery/ also matched the
  // import line, so a readDoors that stopped calling it still passed.
  const start = src.indexOf("export async function readDoors(");
  assert.ok(start >= 0, "readDoors moved out of doors.ts; point this test at it");
  const next = src.indexOf("\nexport ", start + 1);
  const body = src.slice(start, next < 0 ? src.length : next);
  assert.match(body, /originDiscovery\(origin\b/, "readDoors must consume the shared discovery");
  // A re-probe of any of the three, however the URL is spelled: concatenated,
  // templated, or through fetch rather than lensProbe.
  const reprobe = /\b(lensProbe|fetch|outboundRead)\([^;]*?(\/llms\.txt|agent-card\.json|api-catalog)/;
  assert.match("lensProbe(`${origin}/llms.txt`, env)", reprobe, "the re-probe pattern must catch a templated URL");
  assert.doesNotMatch(src, reprobe, "doors re-probes a discovery file instead of reusing lens's discovery");
});
