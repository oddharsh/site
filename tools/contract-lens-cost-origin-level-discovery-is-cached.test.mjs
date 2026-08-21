// ── lens cost: origin-level discovery is cached ──────────────────────────
// Split from contract-tests.test.mjs; shared imports live in contract-shared.mjs.
import {
  testGlobals,
  assert,
  readFileSync,
  test,
} from "./contract-shared.mjs";

// ── lens cost: origin-level discovery is cached ──────────────────────────

test("a second scan of the same origin reuses discovery instead of re-probing", async () => {
  // This is where lens's cost lived: a production trace put lens.discovery at
  // 656ms of a 685ms scan, re-asking one host the same 26 questions it had
  // already answered. The cache is keyed by ORIGIN, not URL, because not one of
  // those 26 depends on which page was scanned.
  const { originDiscovery } = await import("../src/worker/lens.ts");
  const store = new Map();
  const realCaches = globalThis.caches;
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

    const second = await originDiscovery("https://example.com", "example.com", {});
    assert.equal(second.cached, true, "a warm origin must not re-probe");
    // Same answers, minus the flag — a cache that returned different data would
    // make two surfaces on this site disagree about the same host.
    const { cached: _a, ...firstBody } = first;
    const { cached: _b, ...secondBody } = second;
    assert.deepEqual(secondBody, firstBody);

    // A different origin is a different key, not a stale hit.
    const other = await originDiscovery("https://other.example", "other.example", {});
    assert.equal(other.cached, false);
    assert.equal(store.size, 2);

    // And `fresh` bypasses for a caller that needs the live answer.
    const forced = await originDiscovery("https://example.com", "example.com", {}, { fresh: true });
    assert.equal(forced.cached, false);
  } finally {
    if (realCaches === undefined) delete globalThis.caches; else testGlobals.caches = realCaches;
  }
});

test("discovery still works with no cache at all", async () => {
  // Under plain node `caches` does not exist, and a scan must degrade to the
  // previous behaviour (a live fan-out every time) rather than throw.
  const { originDiscovery } = await import("../src/worker/lens.ts");
  const realCaches = globalThis.caches;
  delete globalThis.caches;
  try {
    const out = await originDiscovery("https://example.com", "example.com", {});
    assert.equal(out.cached, false);
    assert.ok("robots" in out && "llms" in out && "mcp" in out);
  } finally { if (realCaches !== undefined) testGlobals.caches = realCaches; }
});

test("readDoors reads lens's discovery rather than re-probing the same files", async () => {
  // doors.js originally fetched llms.txt, the agent card and the api-catalog
  // itself, duplicating four of lens's twenty-six probes. Worse than wasteful:
  // two surfaces on one site could disagree about the same origin.
  const src = readFileSync("src/worker/lib/doors.ts", "utf8");
  assert.match(src, /originDiscovery/, "doors must consume the shared discovery");
  for (const dup of ["/llms.txt", "/.well-known/agent-card.json", "/.well-known/api-catalog"]) {
    assert.ok(!src.includes(`lensProbe(origin + "${dup}"`), `doors re-probes ${dup} instead of reusing discovery`);
  }
});
