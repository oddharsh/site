// ── the SWR freshness stamp lives in KV metadata ────────────────────
// swrKV and the visit mirror both used to carry freshness in a second
// ":fresh" key, which cost a read on every lookup and a write on every
// rebuild. The stamp rides the value's own metadata now. These tests pin the
// operation COUNTS, because the whole change is invisible to a test that only
// checks the value that comes back, and they pin the legacy path, which is the
// one that runs on the first request after the deploy.
import {
  assert,
  deleteSWRKV,
  handleHit,
  swrKV,
  test,
} from "./contract-shared.ts";

// A KV fake that records ops and stores metadata beside each value, so a test
// can tell "one read" from "two reads that happen to agree".
function fakeKV(entries = []) {
  const store = new Map(entries);
  const ops = { get: 0, getWithMetadata: 0, put: 0, delete: 0 };
  const decode = (raw, typeOrOptions) => {
    const type = typeOrOptions && typeof typeOrOptions === "object"
      ? (typeOrOptions.type || "text")
      : (typeOrOptions || "text");
    return type === "json" ? JSON.parse(raw) : raw;
  };
  return {
    ops,
    store,
    async get(key, typeOrOptions) {
      ops.get += 1;
      const entry = store.get(key);
      return entry ? decode(entry.value, typeOrOptions) : null;
    },
    async getWithMetadata(key, typeOrOptions) {
      ops.getWithMetadata += 1;
      const entry = store.get(key);
      if (!entry) return { value: null, metadata: null };
      return { value: decode(entry.value, typeOrOptions), metadata: entry.metadata ?? null };
    },
    async put(key, value, options = {}) {
      ops.put += 1;
      store.set(key, { value, metadata: options.metadata ?? null });
    },
    async delete(key) {
      ops.delete += 1;
      store.delete(key);
    },
  };
}

const entry = (value, ageMs) => [
  "k",
  { value: JSON.stringify(value), metadata: ageMs === null ? null : { t: Date.now() - ageMs } },
];

function collector() {
  const kept = [];
  return { kept, ctx: { waitUntil: (p) => kept.push(p) } };
}

test("a fresh entry is one read, and no sentinel key is consulted", async () => {
  const kv = fakeKV([entry({ n: 1 }, 0)]);
  const { kept, ctx } = collector();
  const value = await swrKV({ RN_KV: kv }, ctx, "k", 60, () => { throw new Error("must not rebuild"); });

  assert.deepEqual(value, { n: 1 });
  assert.equal(kv.ops.getWithMetadata, 1, "value and stamp arrive in ONE read");
  assert.equal(kv.ops.get, 0, "nothing may read a second key for freshness");
  assert.equal(kept.length, 0, "a fresh stamp fires no background rebuild");
});

test("a lapsed stamp serves stale and rebuilds in ONE write", async () => {
  const kv = fakeKV([entry({ n: 1 }, 61_000)]);
  const { kept, ctx } = collector();
  const value = await swrKV({ RN_KV: kv }, ctx, "k", 60, () => ({ n: 2 }));

  assert.deepEqual(value, { n: 1 }, "the visitor never waits on the rebuild");
  assert.equal(kept.length, 1);
  await Promise.all(kept);
  assert.equal(kv.ops.put, 1, "one key written, where the sentinel era wrote two");
  assert.deepEqual([...kv.store.keys()], ["k"]);
  assert.equal(kv.store.get("k").value, JSON.stringify({ n: 2 }));
});

// THE MIGRATION PATH. Every entry already in production KV was written without
// metadata, so this is what the first read after the deploy actually does.
test("an entry with no metadata reads as stale, rebuilds once, and is fresh after", async () => {
  const kv = fakeKV([entry({ n: 1 }, null)]);
  const { kept, ctx } = collector();
  let builds = 0;
  const env = { RN_KV: kv };

  const stale = await swrKV(env, ctx, "k", 60, () => { builds += 1; return { n: 2 }; });
  assert.deepEqual(stale, { n: 1 }, "a legacy entry still serves instantly");
  assert.equal(kept.length, 1, "missing metadata is treated as stale, never as fresh");
  await Promise.all(kept);
  assert.equal(builds, 1);
  assert.ok(kv.store.get("k").metadata.t, "the rebuild is what writes the first stamp");

  const warm = await swrKV(env, ctx, "k", 60, () => { builds += 1; return { n: 3 }; });
  assert.deepEqual(warm, { n: 2 });
  assert.equal(builds, 1, "the stamp converges after exactly one rebuild per key");
  assert.equal(kept.length, 1);
});

test("a transient empty rebuild still cannot clobber a good stale value", async () => {
  const kv = fakeKV([["k", { value: JSON.stringify({ items: [1] }), metadata: { t: Date.now() - 61_000 } }]]);
  const { kept, ctx } = collector();
  const value = await swrKV({ RN_KV: kv }, ctx, "k", 60, () => ({ items: [] }), {
    isValid: (p) => Boolean(p && Array.isArray(p.items)),
    shouldStore: (p) => Boolean(p && Array.isArray(p.items) && p.items.length > 0),
  });

  assert.deepEqual(value, { items: [1] });
  await Promise.all(kept);
  assert.equal(kv.ops.put, 0, "a rejected rebuild writes neither the value nor a stamp");
  assert.deepEqual(JSON.parse(kv.store.get("k").value), { items: [1] });
});

test("deleteSWRKV drops the value key, and leaves a legacy sentinel to expire", async () => {
  const kv = fakeKV([entry({ n: 1 }, 0), ["k:fresh", { value: "1", metadata: null }]]);
  await deleteSWRKV({ RN_KV: kv }, "k");

  assert.equal(kv.ops.delete, 1, "the stamp dies with the value, so there is one key to drop");
  // Every sentinel was written with expirationTtl, so KV reaps the last of them
  // within one ttl of the deploy. Deleting one here would be a write against a
  // key nothing reads.
  assert.deepEqual([...kv.store.keys()], ["k:fresh"]);
});

// ── the visit mirror, which is the same shape by hand ────────────────
function counterStub(n) {
  return {
    idFromName: () => "homepage-visits",
    get: () => ({ async fetch() { return Response.json({ n }); } }),
  };
}

test("the visit mirror stamps the count key and throttles on that stamp", async () => {
  const kv = fakeKV();
  const env = { RN_KV: kv, COUNTER: counterStub(41) };
  const { kept, ctx } = collector();

  await handleHit(new Request("https://aadhar.sh/hit?tick=1"), env, ctx);
  await Promise.all(kept);
  assert.equal(kv.ops.put, 1);
  assert.equal(kv.store.get("counter:n").value, "41");
  assert.ok(kv.store.get("counter:n").metadata.t, "the write time rides the value");
  assert.deepEqual([...kv.store.keys()], ["counter:n"], "no counter:n:fresh sentinel");

  await handleHit(new Request("https://aadhar.sh/hit?tick=1"), env, ctx);
  await Promise.all(kept);
  assert.equal(kv.ops.put, 1, "a tick inside MIRROR_TTL mirrors nothing");
  assert.equal(kv.ops.get, 0, "freshness comes from metadata, never a second key");
});

test("the visit mirror rewrites a legacy count key that carries no stamp", async () => {
  const kv = fakeKV([["counter:n", { value: "40", metadata: null }]]);
  const env = { RN_KV: kv, COUNTER: counterStub(41) };
  const { kept, ctx } = collector();

  await handleHit(new Request("https://aadhar.sh/hit?tick=1"), env, ctx);
  await Promise.all(kept);
  assert.equal(kv.ops.put, 1, "no stamp reads as lapsed, so the first tick mirrors");
  assert.equal(kv.store.get("counter:n").value, "41");
  assert.ok(kv.store.get("counter:n").metadata.t);
});
