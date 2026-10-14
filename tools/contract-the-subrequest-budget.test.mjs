// ── the per-invocation subrequest budget ────────────────────────────
// Shared imports live in contract-shared.ts.
import {
  assert,
  readFileSync,
  test,
} from "./contract-shared.ts";

// The error text is the load-bearing string in the module, so it is asserted
// against the wording actually observed rather than against a paraphrase.
const REAL_CAP_ERROR = "Too many subrequests by single Worker";

const budget = async () => await import("../src/worker/lib/budget.ts");

const fakeSpan = () => {
  const set = new Map();
  return { set, setAttribute: (k, v) => set.set(k, v), end() {}, isTraced: false };
};

test("the cap error is recognised, and ordinary failures are not", async () => {
  const { isSubrequestLimit } = await budget();

  assert.equal(isSubrequestLimit(new Error(REAL_CAP_ERROR)), true);
  assert.equal(isSubrequestLimit(new Error("too many subrequests")), true, "case must not matter");
  assert.equal(isSubrequestLimit(REAL_CAP_ERROR), true, "a thrown string is still the ceiling");

  for (const other of [
    new Error("Network connection lost."),
    new Error("KV GET failed: 429 Too Many Requests"),
    new Error("Too many redirects"),
    new Error("subrequests"),
    new TypeError("fetch failed"),
    null,
    undefined,
  ]) {
    assert.equal(isSubrequestLimit(other), false, `${other} must not read as the cap`);
  }
});

test("a ledger holds its reserve back and never reports a negative remainder", async () => {
  const { createBudget } = await budget();

  const b = createBudget(50, { reserve: 6 });
  assert.equal(b.limit, 44, "the reserve comes off the cap");
  assert.equal(b.left, 44);
  assert.equal(b.exhausted, false);

  assert.equal(b.afford(40), true);
  assert.equal(b.spent, 40);
  assert.equal(b.left, 4);
  assert.equal(b.afford(5), false, "an unaffordable reservation must be refused");
  assert.equal(b.spent, 40, "a refused reservation must charge nothing");
  assert.equal(b.afford(4), true);
  assert.equal(b.exhausted, true);

  b.charge(10);
  assert.equal(b.spent, 54);
  assert.equal(b.left, 0, "left is clamped at zero");
});

test("fault() separates the ceiling from the work, which is the whole file", async () => {
  const { createBudget } = await budget();
  const b = createBudget(10);

  assert.equal(b.fault(new Error("upstream returned 502")), "item");
  assert.equal(b.fault(new Error(REAL_CAP_ERROR)), "cap");
});

test("a ceiling hit while the ledger shows headroom is reported as an overrun", async () => {
  const { createBudget, recordBudget } = await budget();

  // The reconciliation, and the only thing in this module that finds a bug
  // nobody already knew about. A Worker cannot read its own subrequest count,
  // so the ledger sees only what is routed through it. The platform refusing
  // while we still show room is proof that something in this invocation is
  // spending subrequests unmetered.
  const leaky = createBudget(50);
  leaky.afford(3);
  assert.equal(leaky.overrun, false);
  assert.equal(leaky.fault(new Error(REAL_CAP_ERROR)), "cap");
  assert.equal(leaky.overrun, true, "the platform disagreed with our count, and that is findable");
  const leakySpan = fakeSpan();
  recordBudget(leakySpan, leaky);
  assert.equal(leakySpan.set.get("budget.overrun"), true);

  const honest = createBudget(4);
  honest.afford(4);
  assert.equal(honest.fault(new Error(REAL_CAP_ERROR)), "cap");
  assert.equal(honest.overrun, false, "an expected ceiling is not an accounting bug");
  const honestSpan = fakeSpan();
  recordBudget(honestSpan, honest);
  assert.equal(
    honestSpan.set.has("budget.overrun"), false,
    "a false overrun is omitted rather than emitted on every span",
  );
});

test("recordBudget stamps a span and omits what it has nothing to say about", async () => {
  const { createBudget, recordBudget } = await budget();
  const b = createBudget(20, { reserve: 4 });
  b.afford(5);

  const s = fakeSpan();
  recordBudget(s, b);
  assert.equal(s.set.get("budget.limit"), 16);
  assert.equal(s.set.get("budget.spent"), 5);
  assert.equal(s.set.get("budget.exhausted"), false);
  assert.equal(s.set.has("budget.overrun"), false);
});

test("mapWithBudget stops at the ledger and calls the rest skipped, not failed", async () => {
  const { createBudget, mapWithBudget } = await budget();
  const b = createBudget(3);
  const seen = [];

  const run = await mapWithBudget([1, 2, 3, 4, 5], b, async (n) => { seen.push(n); return n * 2; });

  assert.deepEqual(seen, [1, 2, 3], "only what the ledger could afford ran");
  assert.deepEqual(run.results, [2, 4, 6]);
  assert.equal(run.skipped, 2);
  assert.equal(run.failed, 0, "an item that never ran did not fail");
  assert.equal(run.hitCap, false, "running out of OUR budget is not the platform refusing");
});

test("mapWithBudget will not let a per-item failure hide the ceiling", async () => {
  const { createBudget, mapWithBudget } = await budget();
  const b = createBudget(50);

  const seen = [];
  const run = await mapWithBudget([1, 2, 3, 4, 5, 6], b, async (n) => {
    seen.push(n);
    if (n === 2) throw new Error("upstream returned 500");
    if (n === 4) throw new Error(REAL_CAP_ERROR);
    return n;
  });

  assert.deepEqual(seen, [1, 2, 3, 4], "the run stopped at the ceiling rather than pressing on");
  assert.equal(run.failed, 1, "exactly the one genuine item failure");
  assert.equal(run.hitCap, true);
  assert.equal(run.skipped, 3, "the item the ceiling landed on counts as unattempted, with the two after it");
  assert.deepEqual(run.results, [1, 3]);
  assert.equal(b.overrun, true);
});

test("the declared cap is one constant, not a number typed out per surface", async () => {
  const { SUBREQUEST_CAP_FREE, SUBREQUEST_CAP_PAID } = await budget();
  assert.equal(SUBREQUEST_CAP_FREE, 50);
  assert.equal(SUBREQUEST_CAP_PAID, 1000);

  const src = readFileSync("serendipity/serendipity.ts", "utf8");
  assert.ok(
    !/^\s*const\s+CRON_SUBREQUEST_CAP\s*=\s*\d+/m.test(src),
    "serendipity re-declares the subrequest cap instead of importing SUBREQUEST_CAP_FREE",
  );
});
