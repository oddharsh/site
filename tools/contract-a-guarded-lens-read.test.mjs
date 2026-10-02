// ── a guarded third-party read (src/worker/lens-guard.ts) ───────────────────
// Six /lens tabs run their work behind one shell: validate the target, answer
// from the cache, charge the caller, do the work, keep the answer. The ORDER is
// the invariant, and until this module existed it was pinned by reading source
// text for the position of `overLensBudget(` in each handler, because the
// behavioural version "needs a Rate Limiting binding plus a populated KV".
// Neither is needed. Both are two-method objects, so the order is tested here
// ONCE, by running it, with every event the fakes see recorded in sequence.
//
// Each assertion carries a control in the same test: a second run where the
// thing being asserted absent is present, so a fake that cannot observe the
// event fails the control rather than passing the assertion.
import { assert, context, test } from "./contract-shared.ts";
import { LENS_BUDGETS, guardedRead, lensCacheKey } from "../src/worker/lens-guard.ts";

const TARGET = "https://example.com/page";
const REQUEST = new Request("https://aadhar.sh/lens/x", { headers: { "cf-connecting-ip": "203.0.113.7" } });

// A world with a KV, every limiter the budgets name, and one ordered log of
// what was asked of them. `refuse` names the bindings that say no.
/** @param {{ cached?: unknown, refuse?: string[], getThrows?: boolean, putRejects?: boolean, putThrows?: boolean }} [options] */
function world({ cached = null, refuse = [], getThrows = false, putRejects = false, putThrows = false } = {}) {
  const log = [];
  const store = new Map();
  const env = {
    RN_KV: {
      async get(key, as) {
        log.push("get");
        if (getThrows) throw new Error("KV is down");
        return store.has(key) ? store.get(key) : (typeof cached === "function" ? cached(key, as) : cached);
      },
      put(key, value, options) {
        log.push("put");
        if (putThrows) throw new Error("KV refused synchronously");
        if (putRejects) return Promise.reject(new Error("KV refused"));
        store.set(key, typeof value === "string" ? JSON.parse(value) : value);
        env.lastPut = { key, value, options };
        return Promise.resolve();
      },
    },
  };
  for (const budget of Object.values(LENS_BUDGETS)) {
    env[budget.binding] = {
      async limit({ key }) {
        log.push("limit:" + budget.binding + ":" + key);
        return { success: !refuse.includes(budget.binding) };
      },
    };
  }
  return { env, log, store };
}

/**
 * @param {Partial<import("../src/worker/lens-guard.ts").GuardedRead<any>>} [overrides]
 * @returns {import("../src/worker/lens-guard.ts").GuardedRead<any>}
 */
function read(overrides = {}) {
  return {
    span: "lens.wire",
    url: TARGET,
    budget: "wire",
    limited: (max) => `Wire traces are rate-limited to ${max}/min. Hang on a moment.`,
    cache: { tab: "wire", ttl: 60 },
    run: async () => ({ ok: true, answer: 42 }),
    ...overrides,
  };
}

test("a guarded read runs in one order: target, cache, per-IP budget, shared budget, work, write", async () => {
  const w = world();
  const res = await guardedRead(REQUEST, w.env, undefined, read({
    browser: () => true,
    run: async (url) => { w.log.push("run:" + url); return { ok: true, answer: 42 }; },
  }));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, answer: 42 }, "a fresh answer carries no cache flag");
  assert.deepEqual(w.log, [
    "get",
    "limit:LENS_RL_WIRE:203.0.113.7",
    "limit:LENS_RL_BROWSER_ALL:browser-run",
    "run:" + TARGET,
    "put",
  ]);
  assert.equal(w.env.lastPut.key, await lensCacheKey("wire", TARGET));
  assert.match(w.env.lastPut.key, /^lens:wire:[0-9a-f]{64}$/, "the key shape is load-bearing: changing it orphans every entry in KV");
  assert.deepEqual(w.env.lastPut.options, { expirationTtl: 60 });

  // Control for the shared ceiling: a read that does not say it spends Browser
  // Run never touches that bucket, so its presence above is the flag's doing.
  const plain = world();
  await guardedRead(REQUEST, plain.env, undefined, read());
  assert.deepEqual(plain.log, ["get", "limit:LENS_RL_WIRE:203.0.113.7", "put"]);
});

test("a bad target is refused before anything is read or charged", async () => {
  const w = world();
  let ran = false;
  for (const url of ["", "http://169.254.169.254/latest/meta-data", "http://localhost/", "ftp://example.com/"]) {
    const res = await guardedRead(REQUEST, w.env, undefined, read({ url, run: async () => { ran = true; return {}; } }));
    assert.equal(res.status, 400, `${url || "(empty)"} must be a 400`);
    const body = await res.json();
    assert.equal(body.ok, false);
    assert.equal(typeof body.error, "string");
  }
  assert.deepEqual(w.log, [], "a refused target spends no KV read and no budget");
  assert.equal(ran, false);

  // The tab's own refusal comes after the target's and still before the cache.
  const own = new Response("{}", { status: 400 });
  assert.equal(await guardedRead(REQUEST, w.env, undefined, read({ refuse: own })), own);
  const both = await guardedRead(REQUEST, w.env, undefined, read({ url: "http://localhost/", refuse: own }));
  assert.notEqual(both, own, "a bad target outranks the tab's own refusal");
  assert.equal(both.status, 400);
  assert.deepEqual(w.log, []);
});

test("a tab that needs Browser Run answers 503 without one, before the cache", async () => {
  const w = world({ cached: { ok: true } });
  const res = await guardedRead(REQUEST, w.env, undefined, read({ browser: () => false }));
  assert.equal(res.status, 503);
  assert.deepEqual(await res.json(), { ok: false, error: "Browser Run is not configured on this deployment." });
  assert.deepEqual(w.log, []);
});

test("a cache hit answers with fromCache and charges no budget, even with every limiter refusing", async () => {
  const everyLimiter = Object.values(LENS_BUDGETS).map((b) => b.binding);
  // `cached` here is the wire summary's own COUNT of the target's cache-served
  // requests. The hit flag must not land on that key (it once did, and the pane
  // rendered "true served from cache").
  const w = world({ cached: { ok: true, cached: 3 }, refuse: everyLimiter });
  let ran = false;
  const res = await guardedRead(REQUEST, w.env, context(), read({ browser: () => true, run: async () => { ran = true; return {}; } }));
  assert.equal(res.status, 200, "a warm cache is answered whatever the limiters say");
  assert.deepEqual(await res.json(), { ok: true, cached: 3, fromCache: true });
  assert.deepEqual(w.log, ["get"], "a hit reads the cache and nothing else");
  assert.equal(ran, false);

  // Control: the same refusing limiters DO stop a cold read, so the 200 above
  // is the cache's doing and not a limiter that cannot say no.
  const cold = world({ refuse: everyLimiter });
  const refused = await guardedRead(REQUEST, cold.env, context(), read({ browser: () => true }));
  assert.equal(refused.status, 429);
  assert.deepEqual(cold.log, ["get", "limit:LENS_RL_WIRE:203.0.113.7"], "the per-IP refusal stops before the shared bucket is billed");
});

test("the 429 quotes the ceiling LENS_BUDGETS holds, and the shared ceiling has its own sentence", async () => {
  for (const name of Object.keys(LENS_BUDGETS).filter((n) => n !== "browserAll")) {
    const w = world({ refuse: [LENS_BUDGETS[name].binding] });
    const res = await guardedRead(REQUEST, w.env, undefined, read({ budget: /** @type {import("../src/worker/lens-guard.ts").LensBudgetName} */ (name), limited: (max) => `limited to ${max}/min` }));
    assert.equal(res.status, 429);
    assert.deepEqual(await res.json(), { ok: false, error: `limited to ${LENS_BUDGETS[name].max}/min` },
      `${name}: the number in the message is the tab's own ceiling`);
  }
  // Two budgets with DIFFERENT ceilings, so a module quoting a constant, or the
  // wrong budget's max, cannot pass both.
  assert.notEqual(LENS_BUDGETS.inspect.max, LENS_BUDGETS.wire.max);

  // Per-IP allowed, shared refused: charged in that order, answered in its own words.
  const shared = world({ refuse: ["LENS_RL_BROWSER_ALL"] });
  let ran = false;
  const res = await guardedRead(REQUEST, shared.env, undefined, read({ browser: () => true, run: async () => { ran = true; return {}; } }));
  assert.equal(res.status, 429);
  assert.deepEqual(await res.json(), { ok: false, error: "The shared browser budget for this minute is spent. Try again shortly." });
  assert.deepEqual(shared.log, ["get", "limit:LENS_RL_WIRE:203.0.113.7", "limit:LENS_RL_BROWSER_ALL:browser-run"]);
  assert.equal(ran, false);
});

test("a run that returns a Response is answered as is and never cached", async () => {
  const w = world();
  const failure = new Response(JSON.stringify({ ok: false, error: "the door is shut" }), { status: 502 });
  const res = await guardedRead(REQUEST, w.env, context(), read({ run: async () => failure }));
  assert.equal(res, failure, "the tab's own failure shape reaches the caller untouched");
  assert.ok(!w.log.includes("put"), "a failed read must not be kept: the next visitor would be served the failure");
  assert.equal(w.store.size, 0);

  // Control: the same world DOES write a result, so the missing put is the
  // Response's doing.
  await guardedRead(REQUEST, w.env, context(), read());
  assert.equal(w.log.filter((e) => e === "put").length, 1);
  assert.equal(w.store.size, 1);
});

test("a cache that fails, on the read or on the write, never fails the response", async () => {
  // Awaited (no ctx) and handed to waitUntil (ctx): both arms, both failure
  // shapes. Three of the six handlers used to pass a bare put() to waitUntil,
  // where a rejection was an unhandled one.
  for (const failure of [{ putRejects: true }, { putThrows: true }]) {
    const awaited = world(failure);
    const res = await guardedRead(REQUEST, awaited.env, undefined, read());
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, answer: 42 });
    assert.ok(awaited.log.includes("put"), "the write was attempted");

    const deferred = world(failure);
    const pending = [];
    const res2 = await guardedRead(REQUEST, deferred.env, { waitUntil: (p) => pending.push(p) }, read());
    assert.equal(res2.status, 200);
    assert.equal(pending.length, 1, "with a ctx the write rides waitUntil");
    // The promise handed to waitUntil must already be failure-proof. Awaiting
    // it is the assertion: a bare kv.put() rejection would throw right here.
    await pending[0];
  }

  // A cache READ that throws is a miss, and the work still runs.
  const down = world({ getThrows: true });
  const res = await guardedRead(REQUEST, down.env, undefined, read());
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, answer: 42 });

  // Control: the guard swallows CACHE failures only. Work that throws still
  // throws, so a tab's own bug is not hidden behind a 200.
  await assert.rejects(
    guardedRead(REQUEST, world().env, undefined, read({ run: async () => { throw new Error("the tab broke"); } })),
    /the tab broke/,
  );
});

test("the cache key hashes the identity a tab names, and a variant appends to the plain key", async () => {
  const w = world();
  await guardedRead(REQUEST, w.env, undefined, read({
    cache: { tab: "nlweb", identity: (url) => new URL(url).origin + "\nwhat is this", ttl: 5 },
  }));
  assert.equal(w.env.lastPut.key, await lensCacheKey("nlweb", "https://example.com\nwhat is this"));
  assert.notEqual(w.env.lastPut.key, await lensCacheKey("nlweb", "https://example.com\nanother question"),
    "one visitor's answer must not be served to another visitor's question");

  const plain = await lensCacheKey("browser", TARGET);
  assert.equal(await lensCacheKey("browser", TARGET, "expand"), plain + ":expand");
  assert.equal(await lensCacheKey("browser", TARGET, null), plain);
});

test("a stored form decides what a hit is, what is written, and what is skipped", async () => {
  // The seam /lens/shot (bytes) and /lens/browser (a size cap, its own flag)
  // sit on. Exercised with a stand-in so the rule is tested without a browser.
  /** @type {import("../src/worker/lens-guard.ts").LensCacheForm<ArrayBuffer>} */
  const form = {
    as: "arrayBuffer",
    usable: (cached) => cached.byteLength > 0,
    hit: (cached) => new Response(cached, { headers: { "x-from": "cache" } }),
    fresh: (bytes) => new Response(bytes, { headers: { "x-from": "work" } }),
    stored: (bytes) => (bytes.byteLength > 4 ? null : bytes),
  };
  const asked = [];
  const w = world({ cached: (_key, as) => { asked.push(as); return new Uint8Array(0).buffer; } });
  const small = new Uint8Array([1, 2, 3]).buffer;
  const res = await guardedRead(REQUEST, w.env, undefined, read({ cache: { tab: "shot", ttl: 9, form }, run: async () => small }));
  assert.deepEqual(asked, ["arrayBuffer"], "the form names how KV is read");
  assert.equal(res.headers.get("x-from"), "work", "an unusable entry is a miss");
  assert.equal(w.env.lastPut.value, small, "bytes are stored as bytes, not as JSON");

  const hit = await guardedRead(REQUEST, w.env, undefined, read({ cache: { tab: "shot", ttl: 9, form } }));
  assert.equal(hit.headers.get("x-from"), "cache");
  assert.deepEqual(new Uint8Array(await hit.arrayBuffer()), new Uint8Array([1, 2, 3]));

  const big = world();
  const kept = await guardedRead(REQUEST, big.env, undefined, read({
    cache: { tab: "shot", ttl: 9, form }, run: async () => new Uint8Array(8).buffer,
  }));
  assert.equal(kept.status, 200, "a result too large to keep is still answered");
  assert.ok(!big.log.includes("put"), "and is not written");
});


test("hits and misses open one span with the same name and preserve their cache attributes", async () => {
  const { installTracing } = await import("../src/worker/lib/trace.ts");
  const records = [];
  installTracing({ enterSpan(name, run) {
    const attributes = {};
    records.push({ name, attributes });
    return run({ setAttribute(key, value) { attributes[key] = value; }, end() {}, isTraced: true });
  } });
  try {
    const w = world();
    await guardedRead(REQUEST, w.env, undefined, read());
    await guardedRead(REQUEST, w.env, undefined, read());
    assert.deepEqual(records, [
      { name: "lens.wire", attributes: { "lens.target_host": "example.com", "lens.cache": "miss" } },
      { name: "lens.wire", attributes: { "lens.target_host": "example.com", "lens.cache": "hit" } },
    ]);
  } finally { installTracing(null); }
});
