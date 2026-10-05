// /ledger and /speculation read Analytics Engine through two doors: the
// Analytics SQL binding (ANALYTICS) first, then the SQL API with
// ANALYTICS_READ_TOKEN. The doors speak different SQL, so these pin what each
// is handed as well as the order, and that a reply names the door that
// answered. Measured 2026-10-05: both doors read 3,949 ledger hits over 30
// days, the binding only once it was given its own dataset naming.

import { assert, test } from "./contract-shared.ts";
import { analyticsSql as read } from "../src/worker/ledger.ts";

/** A partial Env is the point: each test hands the reader only the doors it means to open. */
const analyticsSql = (/** @type {any} */ env, /** @type {string} */ dataset, /** @type {any} */ build) => read(env, dataset, build);

const QUERY = (from, sum) => `SELECT blob1 AS bot, ${sum("double1")} AS hits FROM ${from} GROUP BY bot`;

/** Swap global fetch for one test, recording every call. */
async function withFetch(answer, body) {
  const calls = [];
  const real = globalThis.fetch;
  globalThis.fetch = /** @type {any} */ (async (/** @type {any} */ url, /** @type {any} */ init) => { calls.push({ url: String(url), body: init?.body }); return answer(); });
  try { return { result: await body(), calls }; } finally { globalThis.fetch = real; }
}

const binding = (impl) => {
  const seen = [];
  return { seen, ANALYTICS: { query: async (req) => { seen.push(req); return impl(req); } } };
};

test("the binding answers first in its own dialect, and the token door is never opened", async () => {
  const b = binding(() => ({ data: [{ bot: "GPTBot", hits: 3 }], rows: 1, statistics: { elapsed_ms: 1, rows_read: 1, bytes_read: 1 } }));
  const { result, calls } = await withFetch(() => new Response("{}"), () =>
    analyticsSql({ ANALYTICS: b.ANALYTICS, ANALYTICS_READ_TOKEN: "t", CF_ACCOUNT_ID: "a" }, "aadhar_bot_ledger", QUERY));
  assert.deepEqual(result, { ok: true, data: [{ bot: "GPTBot", hits: 3 }], via: "binding" });
  // The Analytics SQL engine names AE datasets under events.analyticsEngine,
  // weights samples itself and has no _sample_interval column (it rejects one
  // by name), and returns rows as data, so no FORMAT clause either.
  assert.equal(b.seen[0].query, "SELECT blob1 AS bot, SUM(double1) AS hits FROM events.analyticsEngine.aadhar_bot_ledger GROUP BY bot");
  assert.equal(calls.length, 0, "a binding that answered still paid for a subrequest");
});

test("with no binding the token door answers in the SQL API's dialect, and names itself", async () => {
  const { result, calls } = await withFetch(() => Response.json({ data: [{ bot: "ClaudeBot" }] }), () =>
    analyticsSql({ ANALYTICS_READ_TOKEN: "t", CF_ACCOUNT_ID: "a" }, "aadhar_bot_ledger", QUERY));
  assert.deepEqual(result, { ok: true, data: [{ bot: "ClaudeBot" }], via: "token" });
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/accounts\/a\/analytics_engine\/sql$/);
  assert.equal(calls[0].body, "SELECT blob1 AS bot, SUM(_sample_interval * double1) AS hits FROM aadhar_bot_ledger GROUP BY bot FORMAT JSON");
});

test("a binding that throws falls back to the token door and says why", async () => {
  const b = binding(() => { throw new Error("Analytics SQL is not enabled for this account"); });
  const { result } = await withFetch(() => Response.json({ data: [] }), () =>
    analyticsSql({ ANALYTICS: b.ANALYTICS, ANALYTICS_READ_TOKEN: "t", CF_ACCOUNT_ID: "a" }, "aadhar_bot_ledger", QUERY));
  assert.deepEqual(result, { ok: true, data: [], via: "token", binding_fallback: "Analytics SQL is not enabled for this account" });

  // With neither door able to answer, the token's reason leads and the binding's rides along.
  const none = await analyticsSql({ ANALYTICS: b.ANALYTICS }, "aadhar_bot_ledger", QUERY);
  assert.deepEqual(none, { ok: false, reason: "unconfigured", binding_fallback: "Analytics SQL is not enabled for this account" });
});

test("'not found' from the binding never reads as an empty ledger", async () => {
  // A dataset with no writes and a misnamed one answer the binding with the
  // same words, and the first preview hit the misnamed case: had this read as
  // empty, /ledger would have shown zero crawlers with ok: true.
  const b = binding(() => { throw new Error("Input was invalid: Error during planning: table `aadhar_bot_ledger` not found"); });
  const { result, calls } = await withFetch(() => new Response("no such table: aadhar_bot_ledger", { status: 422 }), () =>
    analyticsSql({ ANALYTICS: b.ANALYTICS, ANALYTICS_READ_TOKEN: "t", CF_ACCOUNT_ID: "a" }, "aadhar_bot_ledger", QUERY));
  assert.equal(calls.length, 1, "the binding's 'not found' must go to the token door, which can tell the two cases apart");
  assert.equal(result.via, "token");
  assert.deepEqual(result.data, []);
});
