// ── lens cost: origin-level discovery is cached ──────────────────────────
// Split from contract-tests.test.mjs; shared imports live in contract-shared.mjs.
import {
  testGlobals,
  assert,
  readFileSync,
  test,
} from "./contract-shared.mjs";

// ── lens cost: origin-level discovery is cached ──────────────────────────

// The fan-out reaches the real internet, and both tests below were latent
// flakes because of it. 24 of the 26 probes go through lensProbe, which needs
// the AadharshBot signing key and so fails instantly under plain node
// ("AadharshBot signing key is unavailable") without a packet leaving. The
// other two are lensProbeDnsAid and lensProbeEch, which query
// cloudflare-dns.com over DNS-over-HTTPS: 4 requests per fan-out, each guarded
// by a 4.5s AbortController — a ceiling that sits just under the 5s test
// timeout, so ONE slow DoH round fails the whole file.
//
// Measured 2026-08-21 in this worktree, three fan-outs (the exact sequence the
// first test runs): 206ms live on a good network, 1ms with fetch stubbed, and
// 4503ms for a SINGLE fan-out when the DoH endpoint never answers. That last
// number is the flake: the reported failure was 5004.15ms against a 5s budget
// and passed on three identical reruns, which is the signature of a wall clock
// that belongs to the internet rather than to the code.
//
// So fetch is stubbed. Nothing here asserts on what a probe found — the subject
// is the origin-keyed CACHE — and the DoH answer is discarded either way.
const doh = () => new Response(JSON.stringify({ Status: 3 }), { headers: { "content-type": "application/dns-json" } });

test("a second scan of the same origin reuses discovery instead of re-probing", async () => {
  // This is where lens's cost lived: a production trace put lens.discovery at
  // 656ms of a 685ms scan, re-asking one host the same 26 questions it had
  // already answered. The cache is keyed by ORIGIN, not URL, because not one of
  // those 26 depends on which page was scanned.
  const { originDiscovery } = await import("../src/worker/lens.ts");
  const store = new Map();
  const realCaches = globalThis.caches;
  const realFetch = globalThis.fetch;
  testGlobals.fetch = doh;
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
    testGlobals.fetch = realFetch;
    if (realCaches === undefined) delete globalThis.caches; else testGlobals.caches = realCaches;
  }
});

test("discovery still works with no cache at all", async () => {
  // Under plain node `caches` does not exist, and a scan must degrade to the
  // previous behaviour (a live fan-out every time) rather than throw.
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
  // doors.js originally fetched llms.txt, the agent card and the api-catalog
  // itself, duplicating four of lens's twenty-six probes. Worse than wasteful:
  // two surfaces on one site could disagree about the same origin.
  const src = readFileSync("src/worker/lib/doors.ts", "utf8");
  assert.match(src, /originDiscovery/, "doors must consume the shared discovery");
  for (const dup of ["/llms.txt", "/.well-known/agent-card.json", "/.well-known/api-catalog"]) {
    assert.ok(!src.includes(`lensProbe(origin + "${dup}"`), `doors re-probes ${dup} instead of reusing discovery`);
  }
});
