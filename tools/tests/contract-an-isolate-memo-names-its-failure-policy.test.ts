// ── an isolate memo names its failure policy (src/worker/lib/isolate-memo.ts) ──
// One memo backs botauth's signing keys, the D1 DDL guards and the
// pixel-peeper manifest. Each state is pinned by running it: a pending
// derivation is shared, a success is cached, a rejection is retried or kept
// per the policy, and a new key derives afresh. Every "derived once" assertion
// sits beside a case that derives twice, so a counter that cannot move fails.
import { assert, test } from "./contract-shared.ts";
import { isolateMemo } from "../../src/worker/lib/isolate-memo.ts";

// A derivation the test resolves or rejects by hand, counting its starts.
function gate<T>() {
  const calls: string[] = [];
  const pending: { resolve: (v: T) => void; reject: (e: Error) => void }[] = [];
  const derive = (arg: string) => {
    calls.push(arg);
    return new Promise<T>((resolve, reject) => pending.push({ resolve, reject }));
  };
  return { calls, pending, derive };
}

test("isolate memo: concurrent callers share one pending derivation", async () => {
  const g = gate<number>();
  const get = isolateMemo(g.derive, { onFailure: "retry" });
  const a = get("x");
  const b = get("x");
  assert.equal(a, b);
  assert.deepEqual(g.calls, ["x"]);
  g.pending[0].resolve(7);
  assert.deepEqual(await Promise.all([a, b]), [7, 7]);
});

test("isolate memo: a success is cached, and without a key later arguments are ignored", async () => {
  const g = gate<number>();
  const get = isolateMemo(g.derive, { onFailure: "retry" });
  const first = get("x");
  g.pending[0].resolve(7);
  assert.equal(await first, 7);
  assert.equal(await get("y"), 7);
  assert.deepEqual(g.calls, ["x"]);
});

test("isolate memo: retry forgets a rejection, so the next call derives again", async () => {
  const g = gate<number>();
  const get = isolateMemo(g.derive, { onFailure: "retry" });
  const first = get("x");
  g.pending[0].reject(new Error("transient"));
  await assert.rejects(first, { message: "transient" });
  const second = get("x");
  g.pending[1].resolve(8);
  assert.equal(await second, 8);
  assert.deepEqual(g.calls, ["x", "x"]);
});

test("isolate memo: keep caches a rejection like any answer", async () => {
  const g = gate<number>();
  const get = isolateMemo(g.derive, { onFailure: "keep" });
  const first = get("x");
  g.pending[0].reject(new Error("bad secret"));
  await assert.rejects(first, { message: "bad secret" });
  await assert.rejects(get("x"), { message: "bad secret" });
  assert.deepEqual(g.calls, ["x"]);
});

test("isolate memo: a derive that throws before its first await still follows the policy", async () => {
  let starts = 0;
  const derive = (_: string): Promise<number> => {
    starts += 1;
    throw new Error("sync");
  };
  const retry = isolateMemo(derive, { onFailure: "retry" });
  await assert.rejects(retry("x"), { message: "sync" });
  await assert.rejects(retry("x"), { message: "sync" });
  assert.equal(starts, 2);
  const keep = isolateMemo(derive, { onFailure: "keep" });
  await assert.rejects(keep("x"), { message: "sync" });
  await assert.rejects(keep("x"), { message: "sync" });
  assert.equal(starts, 3);
});

test("isolate memo: a key change derives afresh, and a kept failure stays with its key", async () => {
  const g = gate<string>();
  const get = isolateMemo(g.derive, { onFailure: "keep", key: (k) => k });
  const a = get("a");
  g.pending[0].resolve("A");
  assert.equal(await a, "A");
  assert.equal(await get("a"), "A");
  const b = get("b");
  g.pending[1].reject(new Error("bad b"));
  await assert.rejects(b, { message: "bad b" });
  await assert.rejects(get("b"), { message: "bad b" });
  // one slot: going back to "a" derives again rather than remembering it
  const again = get("a");
  g.pending[2].resolve("A2");
  assert.equal(await again, "A2");
  assert.deepEqual(g.calls, ["a", "b", "a"]);
});

test("isolate memo: a stale key's late rejection does not evict the newer entry", async () => {
  const g = gate<string>();
  const get = isolateMemo(g.derive, { onFailure: "retry", key: (k) => k });
  const a = get("a");
  const b = get("b");
  g.pending[1].resolve("B");
  assert.equal(await b, "B");
  g.pending[0].reject(new Error("late a"));
  await assert.rejects(a, { message: "late a" });
  const again = get("b");
  assert.deepEqual(g.calls, ["a", "b"]);
  assert.equal(await again, "B");
});
