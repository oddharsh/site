// ── every documented API path keeps the API's contract (lib/api-contract.ts) ──
// Three promises belong to the API as a whole rather than to a handler: the
// methods a path answers, the version it serves, and how it announces a
// deprecation. /developers and /openapi.json print them from lib/public-api.ts;
// this drives the layer that keeps them, and the dispatch that calls it.
import { assert, test } from "./contract-shared.ts";
import { allowedMethods, apiPreflight, deprecationHeaders, withApiContract } from "../src/worker/lib/api-contract.ts";
import { API_VERSION, DEPRECATION_NOTICE_DAYS, OPERATIONS } from "../src/worker/lib/public-api.ts";
import { openApiDocument } from "../src/worker/lib/openapi.ts";
import { createDispatch } from "../src/worker/dispatch.ts";
import { API_READ_BUDGET } from "../src/worker/lib/api-limits.ts";
import { EXACT_ROUTES, PREFIX_ROUTES } from "../src/worker/routes.ts";
import { shouldUseWorkersCache } from "../src/worker/lib/cache.ts";

const req = (path, init) => new Request(`https://aadhar.sh${path}`, init);

test("a method a documented path does not serve is a JSON 405 with Allow", async () => {
  const r = await apiPreflight(req("/search.json", { method: "POST" }), "/search.json", {});
  assert.ok(r, "POST /search.json is refused before the handler");
  assert.equal(r.status, 405);
  assert.equal(r.headers.get("allow"), "GET, HEAD, OPTIONS");
  const body = await r.json();
  assert.equal(body.code, "method_not_allowed");
  assert.deepEqual(body.allow, ["GET", "HEAD", "OPTIONS"]);
  assert.equal(typeof body.error, "string");
  for (const method of ["DELETE", "PUT", "PATCH"]) assert.equal((await apiPreflight(req("/lens/fetch", { method }), "/lens/fetch", {}))?.status, 405, method);
  // The controls: what the path does serve passes through, and so does any
  // path the description does not name.
  for (const method of ["GET", "HEAD", "OPTIONS"]) assert.equal(await apiPreflight(req("/search.json", { method }), "/search.json", {}), null, method);
  assert.equal(await apiPreflight(req("/ask", { method: "POST" }), "/ask", {}), null, "POST /ask is documented");
  assert.deepEqual(allowedMethods(OPERATIONS.filter((o) => o.path === "/ask")), ["GET", "HEAD", "POST", "OPTIONS"]);
  assert.equal(await apiPreflight(req("/webmention", { method: "POST" }), "/webmention", {}), null, "an undocumented path is its handler's business");
});

test("an API-Version pin is served when it is the live version and refused otherwise", async () => {
  const pin = (v) => apiPreflight(req("/search.json?q=x", { headers: { "api-version": v } }), "/search.json", {});
  assert.equal(await pin(API_VERSION), null);
  assert.equal(await pin(` ${API_VERSION} `), null, "surrounding whitespace is not a different version");
  for (const v of ["2025-01-01", "2", "latest", ""]) {
    const r = await pin(v);
    assert.equal(r?.status, 400, `${JSON.stringify(v)} is refused`);
    const body = await r.json();
    assert.equal(body.code, "unsupported_api_version");
    assert.deepEqual(body.supported, [API_VERSION]);
  }
  assert.equal(await apiPreflight(req("/search.json?q=x"), "/search.json", {}), null, "no pin, no refusal");
  assert.equal(shouldUseWorkersCache(req("/images/manifest.json", { headers: { "api-version": "2025-01-01" } }), new Set(["/images/manifest.json"])), false,
    "a pinned request skips the edge cache, which could not refuse it");
  assert.equal(shouldUseWorkersCache(req("/images/manifest.json"), new Set(["/images/manifest.json"])), true, "the control");
});

test("every API answer names its version and its description; nothing else changes", async () => {
  const original = new Response('{"ok":true}', { headers: { "content-type": "application/json", link: '</llms.txt>; rel="alternate"' } });
  const out = withApiContract(original, "/search.json", "GET");
  assert.equal(out.headers.get("api-version"), API_VERSION);
  const link = out.headers.get("link") || "";
  assert.match(link, /<\/llms\.txt>; rel="alternate"/, "a Link the handler set survives");
  assert.match(link, /<\/openapi\.json>; rel="service-desc"; type="application\/vnd\.oai\.openapi\+json"/);
  assert.equal(await out.text(), '{"ok":true}');
  assert.equal(out.headers.get("deprecation"), null, "nothing is deprecated today");
  const page = new Response("<p>");
  assert.equal(withApiContract(page, "/garage", "GET"), page, "a non-API path is handed back untouched");
});

test("a deprecation is announced in RFC 9745 and RFC 8594 terms, and the policy's notice is held", () => {
  const h = deprecationHeaders({ since: "2026-01-01", sunset: "2026-04-01", successor: "/v2/search.json" });
  assert.equal(h.deprecation, "@1767225600", "an Item Date: @ and epoch seconds");
  assert.equal(h.sunset, "Wed, 01 Apr 2026 00:00:00 GMT", "an IMF-fixdate");
  assert.match(h.link, /rel="deprecation"/);
  assert.match(h.link, /<\/v2\/search\.json>; rel="successor-version"/);
  assert.doesNotMatch(deprecationHeaders({ since: "2026-01-01", sunset: "2026-04-01" }).link, /successor-version/);
  const days = (d) => (Date.parse(d.sunset) - Date.parse(d.since)) / 86400000;
  for (const op of OPERATIONS) {
    if (op.deprecated) assert.ok(days(op.deprecated) >= DEPRECATION_NOTICE_DAYS, `${op.operationId}: under ${DEPRECATION_NOTICE_DAYS} days of notice`);
  }
  assert.ok(days({ since: "2026-01-01", sunset: "2026-03-01" }) < DEPRECATION_NOTICE_DAYS, "the control: the check can fail");
});

test("the spec documents the contract on every operation", () => {
  const spec = JSON.parse(JSON.stringify(openApiDocument()));
  assert.equal(spec.info.version, API_VERSION);
  assert.match(spec.info.description, new RegExp(`at least ${DEPRECATION_NOTICE_DAYS} days`));
  for (const [path, item] of Object.entries(spec.paths)) {
    for (const [method, op] of Object.entries(item)) {
      const at = `${method.toUpperCase()} ${path}`;
      assert.ok(op.parameters.some((p) => p.in === "header" && p.name === "API-Version" && p.schema.type), `${at}: API-Version parameter`);
      assert.ok(op.responses["405"], `${at}: documents 405`);
      assert.match(op.responses["400"].description, /unsupported_api_version/, `${at}: documents the version refusal`);
      for (const [status, r] of Object.entries(op.responses)) assert.ok(r.headers?.["API-Version"], `${at} ${status}: API-Version header`);
    }
  }
  assert.ok(spec.components.headers.ApiVersion && spec.components.headers.Deprecation && spec.components.headers.Sunset);
});

test("dispatch runs the contract around the real route table", async () => {
  const fake = () => () => Response.json({ ok: true });
  const dispatch = createDispatch(/** @type {any} */ ({
    exact: Object.fromEntries(EXACT_ROUTES.map((r) => [r.path, fake()])),
    prefix: Object.fromEntries(PREFIX_ROUTES.map((r) => [r.label, fake()])),
    album: fake(), calHost: fake(),
  }));
  const env = /** @type {any} */ ({ ASSETS: { fetch: async () => new Response("", { status: 404 }) } });
  const ctx = { waitUntil() {}, passThroughOnException() {} };
  const serve = (path, init) => dispatch.serveWorkerRequest(req(path, init), env, ctx);

  const ok = await serve("/search.json?q=fhe");
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get("api-version"), API_VERSION);
  assert.match(ok.headers.get("link") || "", /rel="service-desc"/);
  const wrong = await serve("/search.json", { method: "DELETE" });
  assert.equal(wrong.status, 405);
  assert.equal(wrong.headers.get("api-version"), API_VERSION, "a refusal carries the version too");
  assert.equal(wrong.headers.get("x-content-type-options"), "nosniff", "and the security headers");
  assert.equal((await serve("/search.json", { headers: { "api-version": "1999-01-01" } })).status, 400);
  assert.equal(ok.headers.get("ratelimit-policy"), `"read";q=${API_READ_BUDGET.max};w=60`, "the policy reaches the wire");
  const page = await serve("/garage");
  assert.equal(page.headers.get("api-version"), null, "a page is not an API answer");
});

/** A limiter binding that refuses, and records the keys it was asked about. */
const refusing = () => {
  const keys = [];
  return { keys, env: { [API_READ_BUDGET.binding]: { async limit({ key }) { keys.push(key); return { success: false }; } } } };
};

test("an endpoint with no limiter of its own bills the shared read budget and says so", async () => {
  const { env, keys } = refusing();
  const ip = { headers: { "cf-connecting-ip": "203.0.113.9" } };
  const r = await apiPreflight(req("/photos/query.json?recipe=DR400", ip), "/photos/query.json", env);
  assert.equal(r?.status, 429);
  assert.deepEqual(keys, ["203.0.113.9"], "keyed on the caller");
  assert.equal(r.headers.get("retry-after"), "60");
  assert.equal(r.headers.get("ratelimit-policy"), `"read";q=${API_READ_BUDGET.max};w=60`);
  assert.equal(r.headers.get("ratelimit"), '"read";r=0;t=60');
  assert.equal((await r.json()).code, "rate_limited");

  // The Lens doors keep their own budgets and never bill this one; OPTIONS is
  // free; a request the binding allows routes; no binding fails open.
  const lens = refusing();
  assert.equal(await apiPreflight(req("/lens/fetch?url=example.com"), "/lens/fetch", lens.env), null);
  assert.deepEqual(lens.keys, [], "/lens/fetch is billed by LENS_BUDGETS, not the read budget");
  const options = refusing();
  assert.equal(await apiPreflight(req("/search.json", { method: "OPTIONS" }), "/search.json", options.env), null);
  assert.deepEqual(options.keys, []);
  const allowing = { [API_READ_BUDGET.binding]: { async limit() { return { success: true }; } } };
  assert.equal(await apiPreflight(req("/search.json?q=x"), "/search.json", allowing), null);
  assert.equal(await apiPreflight(req("/search.json?q=x"), "/search.json", {}), null, "no binding, no refusal");

  // A served answer names the policy; a Lens answer keeps the one its door set.
  const served = withApiContract(new Response("{}"), "/photos/query.json", "GET");
  assert.equal(served.headers.get("ratelimit-policy"), `"read";q=${API_READ_BUDGET.max};w=60`);
  const lensAnswer = withApiContract(new Response("{}", { headers: { "ratelimit-policy": '"inspect";q=30;w=60' } }), "/lens/fetch", "GET");
  assert.equal(lensAnswer.headers.get("ratelimit-policy"), '"inspect";q=30;w=60');
  assert.equal(withApiContract(new Response("{}"), "/lens/fetch", "GET").headers.get("ratelimit-policy"), null,
    "the contract never names the read policy on a door that does not bill it");
});

test("the spec documents the read budget where it applies and nowhere else", () => {
  const spec = JSON.parse(JSON.stringify(openApiDocument()));
  const photos = spec.paths["/photos/query.json"].get.responses;
  assert.match(photos["200"].headers["RateLimit-Policy"].description, new RegExp(`"read";q=${API_READ_BUDGET.max};w=60`));
  assert.ok(photos["429"].headers["Retry-After"] && photos["429"].headers.RateLimit);
  assert.doesNotMatch(spec.paths["/lens/fetch"].get.responses["200"].headers["RateLimit-Policy"].description, /"read"/);
});
