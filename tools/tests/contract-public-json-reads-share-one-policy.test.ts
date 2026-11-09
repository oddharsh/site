// ── Public JSON reads share one cache and CORS policy ───────────────────────
// /search.json, /photos/query.json, /ledger.json and /rn/tracks answer through
// lib/http.ts's publicJsonResponse, which owns the policy those routes used to
// assemble by hand. An error must take the 30-second errorResp discipline, never
// the 5-minute success TTL, or a transient upstream 502 pins in browsers.
import { assert, test } from "./contract-shared.ts";

test("publicJsonResponse: success and error policies, compact body, noindex on request", async () => {
  const { publicJsonResponse, publicCacheControl } = await import("../../src/worker/lib/http.ts");
  const ok = publicJsonResponse({ a: 1 }, 200, { noindex: true });
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get("cache-control"), "public, max-age=300, s-maxage=600");
  assert.equal(ok.headers.get("access-control-allow-origin"), "*");
  assert.equal(ok.headers.get("content-type"), "application/json; charset=utf-8");
  assert.equal(ok.headers.get("x-robots-tag"), "noindex");
  assert.equal(await ok.text(), '{"a":1}');

  const failed = publicJsonResponse({ ok: false }, 502);
  assert.equal(failed.status, 502);
  assert.equal(failed.headers.get("cache-control"), "public, max-age=30, must-revalidate");
  assert.equal(failed.headers.get("x-robots-tag"), null, "noindex only when asked for");
  assert.equal(publicCacheControl(400), "public, max-age=30, must-revalidate");
  assert.equal(publicCacheControl(399), "public, max-age=300, s-maxage=600");
});
