// ── a guarded third-party read (src/worker/lens-pipeline.ts) ────────────────
// Every /lens door runs its work behind one pipeline: validate the target,
// answer from the cache, charge the caller, do the work, keep the answer. The
// ORDER is the invariant. It used to be pinned by reading source text for the
// position of `overLensBudget(` in each handler, because the behavioural
// version "needs a Rate Limiting binding plus a populated KV". Neither is
// needed. Both are two-method objects, so the order is tested here ONCE, by
// running it, with every event the fakes see recorded in sequence.
//
// These tests came over from lens-guard.ts (#1107), which shared the cached
// reads before defineLens took every door. Each assertion carries a control in
// the same test: a second run where the thing asserted absent is present, so a
// fake that cannot observe the event fails the control rather than passing.
import { assert, context, readFileSync, test } from "./contract-shared.ts";
import { LENS_BUDGETS, LENS_KV_MAX, budgetMessage, defineLens, lensSha256Hex } from "../src/worker/lens-pipeline.ts";

const TARGET = "https://example.com/page";
const REQUEST = new Request("https://aadhar.sh/lens/x", { headers: { "cf-connecting-ip": "203.0.113.7" } });

// A world with a KV, every limiter the budgets name, and one ordered log of
// what was asked of them. `refuse` names the bindings that say no.
/** @param {{ cached?: unknown, refuse?: string[], getThrows?: boolean, putRejects?: boolean, putThrows?: boolean, browser?: boolean }} [options] */
function world({ cached = null, refuse = [], getThrows = false, putRejects = false, putThrows = false, browser = false } = {}) {
  /** @type {string[]} */
  const log = [];
  const store = new Map();
  /** @type {any} */
  const env = {
    RN_KV: {
      async get(key, as) {
        log.push("get:" + as);
        if (getThrows) throw new Error("KV is down");
        return store.has(key) ? store.get(key) : cached;
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
  // A DevTools-shaped binding is the cheapest engine to fake: "cdp" checks for
  // a callable fetch and nothing else.
  if (browser) env.BROWSER = { fetch: async () => new Response(null) };
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

// defineLens refuses a prefix declared twice, and the suite shares one global
// per worker, so every lens made here gets a prefix nothing else can hold.
let made = 0;
/** @param {Record<string, any>} [overrides] @param {Record<string, any>} [cache] */
function lens(overrides = {}, cache = {}) {
  made += 1;
  return defineLens({
    span: "lens.wire",
    budget: "wire",
    targets: (p) => p.get("url") || "",
    cache: { prefix: `lens:guarded-${made}:`, ttl: 60, ...cache },
    run: async () => ({ ok: true, value: { answer: 42 } }),
    ...overrides,
  });
}

const ask = (url = TARGET) => new Request("https://aadhar.sh/lens/x?url=" + encodeURIComponent(url), { headers: REQUEST.headers });

test("a guarded read runs in one order: target, cache, per-IP budget, shared budget, work, write", async () => {
  const w = world({ browser: true });
  const l = lens({
    browser: "cdp",
    run: async ({ target }) => { w.log.push("run:" + target); return { ok: true, value: { answer: 42 } }; },
  });
  const res = await l.handle(ask(), w.env);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, answer: 42, fromCache: false });
  assert.deepEqual(w.log, [
    "get:json",
    "limit:LENS_RL_WIRE:203.0.113.7",
    "limit:LENS_RL_BROWSER_ALL:browser-run",
    "run:" + TARGET,
    "put",
  ]);
  assert.match(w.env.lastPut.key, /^lens:guarded-\d+:[0-9a-f]{64}$/);
  assert.equal(w.env.lastPut.key.split(":")[2], await lensSha256Hex(TARGET));
  assert.deepEqual(w.env.lastPut.options, { expirationTtl: 60 });

  // Control for the shared ceiling: a lens that does not spend Browser Run
  // never touches that bucket, so its presence above is the flag's doing.
  const plain = world();
  await lens().handle(ask(), plain.env);
  assert.deepEqual(plain.log, ["get:json", "limit:LENS_RL_WIRE:203.0.113.7", "put"]);
});

test("the seven cached lenses keep the KV prefixes they have always written", () => {
  // The key is `<prefix><sha256 of the identity>[:<variant>]`, the same shape
  // lens-guard.ts and every handler before it wrote. Changing a prefix orphans
  // every entry under it, so the literals are pinned here.
  const src = ["lens.ts", "lens-wire.ts", "lens-tools.ts", "lens-nlweb.ts", "lens-markdown.ts"]
    .map((f) => readFileSync("src/worker/" + f, "utf8")).join("\n");
  const prefixes = [...src.matchAll(/prefix: "(lens:[a-z-]+:)"/g)].map((m) => m[1]).sort();
  assert.deepEqual(prefixes, [
    "lens:browser:", "lens:cloudflare-score:", "lens:md:", "lens:nlweb:", "lens:shot:", "lens:tools:", "lens:wire:",
  ]);
});

test("a bad target is refused before anything is read or charged", async () => {
  const w = world();
  let ran = false;
  const l = lens({ run: async () => { ran = true; return { ok: true, value: {} }; } });
  for (const url of ["", "http://169.254.169.254/latest/meta-data", "http://localhost/", "ftp://example.com/"]) {
    const res = await l.handle(ask(url), w.env);
    assert.equal(res.status, 400, `${url || "(empty)"} must be a 400`);
    const body = await res.json();
    assert.equal(body.ok, false);
    assert.equal(typeof body.error, "string");
  }
  assert.deepEqual(w.log, [], "a refused target spends no KV read and no budget");
  assert.equal(ran, false);

  // Control: the same lens and world DO read and charge on a good target.
  await l.handle(ask(), w.env);
  // deepEqual(w.log, []) above narrowed the type to never[]; the log grew since.
  const after = /** @type {string[]} */ (w.log);
  assert.ok(after.includes("get:json") && after.includes("limit:LENS_RL_WIRE:203.0.113.7"));
});

test("a lens that needs Browser Run answers 503 without one, before the cache", async () => {
  const w = world({ cached: { ok: true } });
  const res = await lens({ browser: "cdp" }).handle(ask(), w.env);
  assert.equal(res.status, 503);
  assert.equal((await res.json()).ok, false);
  assert.deepEqual(w.log, []);
});

test("a cache hit answers with fromCache and charges no budget, even with every limiter refusing", async () => {
  const everyLimiter = Object.values(LENS_BUDGETS).map((b) => b.binding);
  // `cached` here is the wire summary's own COUNT of the target's cache-served
  // requests. The hit flag must not land on that key (it once did, and the pane
  // rendered "true served from cache").
  const w = world({ cached: { ok: true, cached: 3 }, refuse: everyLimiter, browser: true });
  let ran = false;
  const res = await lens({ browser: "cdp", run: async () => { ran = true; return { ok: true, value: {} }; } }).handle(ask(), w.env, context());
  assert.equal(res.status, 200, "a warm cache is answered whatever the limiters say");
  assert.deepEqual(await res.json(), { ok: true, cached: 3, fromCache: true });
  assert.deepEqual(w.log, ["get:json"], "a hit reads the cache and nothing else");
  assert.equal(ran, false);

  // Control: the same refusing limiters DO stop a cold read, so the 200 above
  // is the cache's doing and not a limiter that cannot say no.
  const cold = world({ refuse: everyLimiter, browser: true });
  const refused = await lens({ browser: "cdp" }).handle(ask(), cold.env, context());
  assert.equal(refused.status, 429);
  assert.deepEqual(cold.log, ["get:json", "limit:LENS_RL_WIRE:203.0.113.7"], "the per-IP refusal stops before the shared bucket is billed");
});

test("the shared browser ceiling is charged second and answers in its own words", async () => {
  const shared = world({ refuse: ["LENS_RL_BROWSER_ALL"], browser: true });
  let ran = false;
  const res = await lens({ browser: "cdp", run: async () => { ran = true; return { ok: true, value: {} }; } }).handle(ask(), shared.env);
  assert.equal(res.status, 429);
  assert.deepEqual(await res.json(), { ok: false, error: budgetMessage("browserAll") });
  assert.notEqual(budgetMessage("browserAll"), budgetMessage("wire"));
  assert.deepEqual(shared.log, ["get:json", "limit:LENS_RL_WIRE:203.0.113.7", "limit:LENS_RL_BROWSER_ALL:browser-run"]);
  assert.equal(ran, false);
});

test("a cache that fails, on the read or on the write, never fails the response", async () => {
  // Awaited (no ctx) and handed to waitUntil (ctx): both arms, both failure
  // shapes. Three handlers once passed a bare put() to waitUntil, where a
  // rejection was an unhandled one.
  for (const failure of [{ putRejects: true }, { putThrows: true }]) {
    const awaited = world(failure);
    const res = await lens().handle(ask(), awaited.env);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, answer: 42, fromCache: false });
    assert.ok(awaited.log.includes("put"), "the write was attempted");

    const deferred = world(failure);
    const pending = [];
    const res2 = await lens().handle(ask(), deferred.env, { waitUntil: (p) => pending.push(p) });
    assert.equal(res2.status, 200);
    assert.equal(pending.length, 1, "with a ctx the write rides waitUntil");
    // The promise handed to waitUntil must already be failure-proof. Awaiting
    // it is the assertion: a bare kv.put() rejection would throw right here.
    await pending[0];
  }

  // A cache READ that throws is a miss, and the work still runs.
  const down = world({ getThrows: true });
  const res = await lens().handle(ask(), down.env);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, answer: 42, fromCache: false });

  // Control: the pipeline swallows CACHE failures only. Work that throws is a
  // 502 naming the error, and nothing is kept, so a lens's own bug never reads
  // as a 200 or reaches the next visitor from KV.
  const broke = world();
  const failed = await lens({ run: async () => { throw new Error("the lens broke"); } }).handle(ask(), broke.env);
  assert.equal(failed.status, 502);
  assert.match((await failed.json()).error, /the lens broke/);
  assert.ok(!broke.log.includes("put"));
});

test("the cache key hashes the identity a lens names, and a suffix appends to the plain key", async () => {
  const w = world();
  await lens({}, { key: (url) => new URL(url).origin + "\nwhat is this" }).handle(ask(), w.env);
  const [, , hash] = w.env.lastPut.key.split(":");
  assert.equal(hash, await lensSha256Hex("https://example.com\nwhat is this"));
  assert.notEqual(hash, await lensSha256Hex("https://example.com\nanother question"),
    "one visitor's answer must not be served to another visitor's question");

  const v = world();
  await lens({ args: () => "expand" }, { suffix: (a) => a }).handle(ask(), v.env);
  assert.match(v.env.lastPut.key, /^lens:guarded-\d+:[0-9a-f]{64}:expand$/);
  const n = world();
  await lens({ args: () => null }, { suffix: (a) => a }).handle(ask(), n.env);
  assert.match(n.env.lastPut.key, /^lens:guarded-\d+:[0-9a-f]{64}$/, "no variant, no trailing colon");
});

test("a PNG lens reads bytes, stores bytes, misses on an empty entry, and skips what is too large to keep", async () => {
  const small = new Uint8Array([1, 2, 3]).buffer;
  const w = world({ cached: new Uint8Array(0).buffer });
  const png = lens({ body: "png", run: async () => ({ ok: true, value: small }) });
  const res = await png.handle(ask(), w.env);
  assert.equal(w.log[0], "get:arrayBuffer", "a PNG lens reads KV as bytes");
  assert.equal(res.headers.get("x-lens-cache"), "miss", "an empty entry is a miss");
  assert.equal(w.env.lastPut.value, small, "bytes are stored as bytes, not as JSON");

  const hit = await png.handle(ask(), w.env);
  assert.equal(hit.headers.get("x-lens-cache"), "hit");
  assert.deepEqual(new Uint8Array(await hit.arrayBuffer()), new Uint8Array([1, 2, 3]));

  const big = world();
  const kept = await lens({ body: "png", run: async () => ({ ok: true, value: new Uint8Array(LENS_KV_MAX + 1).buffer }) }).handle(ask(), big.env);
  assert.equal(kept.status, 200, "a result too large to keep is still answered");
  assert.ok(!big.log.includes("put"), "and is not written");
});

test("hits and misses open one span with the same name and keep their cache attributes", async () => {
  const { installTracing } = await import("../src/worker/lib/trace.ts");
  const records = [];
  installTracing({ enterSpan(name, run) {
    const attributes = {};
    records.push({ name, attributes });
    return run({ setAttribute(key, value) { attributes[key] = value; }, end() {}, isTraced: true });
  } });
  try {
    const w = world();
    const l = lens();
    await l.handle(ask(), w.env);
    await l.handle(ask(), w.env);
    assert.deepEqual(records, [
      { name: "lens.wire", attributes: { "lens.target_host": "example.com", "lens.cache": "miss", "lens.outcome": "ok" } },
      { name: "lens.wire", attributes: { "lens.target_host": "example.com", "lens.cache": "hit" } },
    ]);
  } finally { installTracing(null); }
});
