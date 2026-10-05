// /ledger and /speculation read Analytics Engine through two doors: the
// Analytics SQL binding (ANALYTICS) first, then the SQL API with
// ANALYTICS_READ_TOKEN. These pin the order, what each door is handed, and
// that a reply names the door that answered, which is how a preview shows
// whether production can retire the token.

import { assert, test } from "./contract-shared.ts";
import { analyticsSql } from "../src/worker/ledger.ts";

const SQL = "SELECT blob1 AS bot FROM aadhar_bot_ledger GROUP BY bot FORMAT JSON";

/** Swap global fetch for one test, recording every call. */
async function withFetch(answer, body) {
  const calls = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init) => { calls.push({ url: String(url), body: init?.body }); return answer(); };
  try { return { result: await body(), calls }; } finally { globalThis.fetch = real; }
}

const binding = (impl) => {
  const seen = [];
  return { seen, ANALYTICS: { query: async (req) => { seen.push(req); return impl(req); } } };
};

test("the binding answers first, without FORMAT JSON, and the token door is never opened", async () => {
  const b = binding(() => ({ data: [{ bot: "GPTBot" }], rows: 1, statistics: { elapsed_ms: 1, rows_read: 1, bytes_read: 1 } }));
  const { result, calls } = await withFetch(() => new Response("{}"), () =>
    analyticsSql({ ANALYTICS: b.ANALYTICS, ANALYTICS_READ_TOKEN: "t", CF_ACCOUNT_ID: "a" }, SQL));
  assert.deepEqual(result, { ok: true, data: [{ bot: "GPTBot" }], via: "binding" });
  assert.equal(b.seen[0].query, "SELECT blob1 AS bot FROM aadhar_bot_ledger GROUP BY bot", "FORMAT JSON is the HTTP endpoint's clause and must not reach the binding");
  assert.equal(calls.length, 0, "a binding that answered still paid for a subrequest");
});

test("with no binding the token door answers exactly as before, and names itself", async () => {
  const { result, calls } = await withFetch(() => Response.json({ data: [{ bot: "ClaudeBot" }] }), () =>
    analyticsSql({ ANALYTICS_READ_TOKEN: "t", CF_ACCOUNT_ID: "a" }, SQL));
  assert.deepEqual(result, { ok: true, data: [{ bot: "ClaudeBot" }], via: "token" });
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/accounts\/a\/analytics_engine\/sql$/);
  assert.equal(calls[0].body, SQL, "the SQL API still gets FORMAT JSON");
});

test("a binding that throws falls back to the token door and says why", async () => {
  const b = binding(() => { throw new Error("Analytics SQL is not enabled for this account"); });
  const { result } = await withFetch(() => Response.json({ data: [] }), () =>
    analyticsSql({ ANALYTICS: b.ANALYTICS, ANALYTICS_READ_TOKEN: "t", CF_ACCOUNT_ID: "a" }, SQL));
  assert.deepEqual(result, { ok: true, data: [], via: "token", binding_fallback: "Analytics SQL is not enabled for this account" });

  // With neither door able to answer, the token's reason leads and the binding's rides along.
  const none = await analyticsSql({ ANALYTICS: b.ANALYTICS }, SQL);
  assert.deepEqual(none, { ok: false, reason: "unconfigured", binding_fallback: "Analytics SQL is not enabled for this account" });
});

test("a dataset with no writes yet is an empty ledger through the binding too", async () => {
  const b = binding(() => { throw new Error("no such table: aadhar_bot_ledger"); });
  const read = await analyticsSql({ ANALYTICS: b.ANALYTICS }, SQL);
  assert.deepEqual(read, { ok: true, data: [], via: "binding" });
});
