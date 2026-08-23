// ── the SSR deadline ────────────────────────────────────────────────
// Split from contract-tests.test.mjs; shared imports live in contract-shared.mjs.
import {
  testGlobals,
  assert,
  deadline,
  gatherWhoareyou,
  test,
} from "./contract-shared.mjs";

// ── the SSR deadline ────────────────────────────────────────────────
// deadline() is what keeps a KV eviction (100-200ms, untunable) from gating
// homepage TTFB. Two properties are load-bearing: a fast read never marks
// itself deadlined (the timer is cleared on settle), and a slow read's
// fallback arrives at the budget while the underlying promise keeps running
// (so the read still warms the colo behind the response).
test("deadline lets a fast read through unmarked", async () => {
  let marked = false;
  const v = await deadline(Promise.resolve("fast"), 50, null, () => { marked = true; });
  assert.equal(v, "fast");
  // give the (cleared) timer a chance to prove it was cleared
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(marked, false, "a settled read must never be marked deadlined");
});

test("deadline ships the fallback at the budget and leaves the read running", async () => {
  let marked = false;
  let settled = false;
  const slow = new Promise((r) => setTimeout(() => { settled = true; r("late"); }, 60));
  const t0 = Date.now();
  const v = await deadline(slow, 15, "fallback", () => { marked = true; });
  assert.equal(v, "fallback");
  assert.equal(marked, true);
  assert.ok(Date.now() - t0 < 55, "fallback must arrive at the budget, not at the read");
  assert.equal(settled, false, "the read must still be in flight when the fallback ships");
  await slow;
  assert.equal(settled, true, "the abandoned read still completes");
});

test("deadline distinguishes fallback values for slow vs missing", async () => {
  // counter semantics: null = a real miss (triggers the mirror reseed),
  // undefined = merely slow (must NOT trigger it)
  const missing = await deadline(Promise.resolve(null), 50, undefined, () => {});
  assert.equal(missing, null);
  const slow = await deadline(new Promise(() => {}), 10, undefined, () => {});
  assert.equal(slow, undefined);
});

test("whoareyou lets cold RDAP finish off the critical path", async () => {
  const originalFetch = globalThis.fetch;
  let release;
  testGlobals.fetch = () => new Promise((resolve) => { release = resolve; });
  const background = [];
  const started = Date.now();
  try {
    const result = await gatherWhoareyou(
      new Request("https://aadhar.sh/whoareyou", { headers: { "cf-connecting-ip": "203.0.113.7" } }),
      { waitUntil(promise) { background.push(promise); } },
    );
    assert.equal(result.rdap, null, "a cold enrichment should not delay the page");
    assert.ok(Date.now() - started < 1000, "the optional lookup must leave well before its 2s network abort");
    assert.equal(background.length, 1, "the same lookup should keep running to warm Cloudflare's edge cache");

    release(new Response(JSON.stringify({ name: "TEST-NET-3" }), {
      headers: { "content-type": "application/rdap+json" },
    }));
    await background[0];
  } finally {
    testGlobals.fetch = originalFetch;
  }
});
