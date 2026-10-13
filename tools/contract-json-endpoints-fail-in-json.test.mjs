// ── a JSON endpoint fails in JSON ────────────────────────────────────────────
// An agent reading /lens/census.json or /rn/tracks parses the body it gets. A
// storage throw used to escape both handlers and reach the client as
// Cloudflare's HTML 1101 page, and /ledger/speculation.json answered a wrong
// method with an empty 405. Each is driven into its failure here and must
// answer with the site's error shape: `error` (a sentence) and `code` (a token).
import { assert, test } from "./contract-shared.ts";
import { handleCensusJson } from "../src/worker/census.ts";
import { handleRnTracks } from "../src/worker/rn.ts";
import { handleSpeculationJson } from "../src/worker/speculation.ts";

/** @param {Response} r */
async function assertJsonError(r, status, code) {
  assert.equal(r.status, status);
  assert.match(r.headers.get("content-type") || "", /^application\/json/);
  const body = await r.json();
  assert.equal(typeof body.error, "string");
  assert.equal(body.code, code);
  return body;
}

const quiet = async (fn) => {
  const original = console.error;
  console.error = () => {};
  try { return await fn(); } finally { console.error = original; }
};

test("/lens/census.json answers a D1 throw with a JSON 503", async () => {
  const env = { RESTORE_DB: { prepare() { throw new Error("D1_ERROR: no such table"); }, exec() { throw new Error("D1_ERROR"); }, batch() { throw new Error("D1_ERROR"); } } };
  const r = await quiet(() => handleCensusJson(new Request("https://aadhar.sh/lens/census.json"), env));
  await assertJsonError(r, 503, "storage_unavailable");
  assert.equal(r.headers.get("retry-after"), "60");
});

test("/rn/tracks answers a KV throw with a JSON 503", async () => {
  const env = { RN_KV: { get() { throw new Error("KV GET failed: 500"); }, put() {} } };
  const ctx = { waitUntil() {}, passThroughOnException() {} };
  const r = await quiet(() => handleRnTracks(new Request("https://aadhar.sh/rn/tracks"), env, ctx));
  const body = await assertJsonError(r, 503, "storage_unavailable");
  assert.deepEqual(body.tracks, [], "the tracks key survives, so a client's empty-list path still works");
});

test("/ledger/speculation.json answers a wrong method with a JSON 405", async () => {
  const r = await handleSpeculationJson(new Request("https://aadhar.sh/ledger/speculation.json", { method: "POST" }), {});
  const body = await assertJsonError(r, 405, "method_not_allowed");
  assert.equal(r.headers.get("allow"), "GET, HEAD");
  assert.deepEqual(body.allow, ["GET", "HEAD"]);
});
