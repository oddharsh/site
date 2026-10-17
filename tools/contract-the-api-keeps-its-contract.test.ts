// ── every documented API path keeps the API's contract (lib/api-contract.ts) ──
// Two promises belong to the API as a whole rather than to a handler: the
// methods a path answers and the shared read budget. /developers and
// /openapi.json print them from lib/public-api.ts, along with LEAVES_OUT, the
// machinery the API skips on purpose; this drives the layer that keeps them,
// and the dispatch that calls it.
import { assert, test } from "./contract-shared.ts";
import { allowedMethods, apiPreflight, withApiContract } from "../src/worker/lib/api-contract.ts";
import { LEAVES_OUT, OPERATIONS } from "../src/worker/lib/public-api.ts";
import { openApiDocument } from "../src/worker/lib/openapi.ts";
import { createDispatch } from "../src/worker/dispatch.ts";
import { API_READ_BUDGET } from "../src/worker/lib/api-limits.ts";
import { EXACT_ROUTES, PREFIX_ROUTES } from "../src/worker/routes.ts";

const req = (path, init?: any) => new Request(`https://aadhar.sh${path}`, init);

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

test("every API answer names its description; nothing else changes", async () => {
  const original = new Response('{"ok":true}', { headers: { "content-type": "application/json", link: '</llms.txt>; rel="alternate"' } });
  const out = withApiContract(original, "/search.json");
  const link = out.headers.get("link") || "";
  assert.match(link, /<\/llms\.txt>; rel="alternate"/, "a Link the handler set survives");
  assert.match(link, /<\/openapi\.json>; rel="service-desc"; type="application\/vnd\.oai\.openapi\+json"/);
  assert.equal(await out.text(), '{"ok":true}');
  const page = new Response("<p>");
  assert.equal(withApiContract(page, "/garage"), page, "a non-API path is handed back untouched");
});

test("the spec documents the contract on every operation, and says what it leaves out", () => {
  const spec = JSON.parse(JSON.stringify(openApiDocument()));
  for (const [path, item] of Object.entries<Record<string, any>>(spec.paths)) {
    for (const [method, op] of Object.entries(item)) {
      const at = `${method.toUpperCase()} ${path}`;
      assert.ok(op.responses["405"], `${at}: documents 405`);
      for (const [status, r] of Object.entries<{ headers?: Record<string, any> }>(op.responses)) assert.ok(r.headers?.Link, `${at} ${status}: the service-desc Link`);
      assert.ok(!(op.parameters ?? []).some((p) => p.in === "header"), `${at}: no header parameters, so no version pin`);
    }
  }
  // The absences are decisions, and the spec says so in LEAVES_OUT's words.
  for (const { what } of LEAVES_OUT) assert.ok(spec.info.description.includes(what), `the spec names "${what}"`);
});

test("dispatch runs the contract around the real route table", async () => {
  const fake = () => () => Response.json({ ok: true });
  const dispatch = createDispatch(({
    exact: Object.fromEntries(EXACT_ROUTES.map((r) => [r.path, fake()])),
    prefix: Object.fromEntries(PREFIX_ROUTES.map((r) => [r.label, fake()])),
    album: fake(), calHost: fake(),
  } as any));
  const env = ({ ASSETS: { fetch: async () => new Response("", { status: 404 }) } } as any);
  const ctx = { waitUntil() {}, passThroughOnException() {} };
  const serve = (path, init?: any) => dispatch.serveWorkerRequest(req(path, init), env, ctx);

  const ok = await serve("/search.json?q=fhe");
  assert.equal(ok.status, 200);
  assert.match(ok.headers.get("link") || "", /rel="service-desc"/);
  const wrong = await serve("/search.json", { method: "DELETE" });
  assert.equal(wrong.status, 405);
  assert.match(wrong.headers.get("link") || "", /rel="service-desc"/, "a refusal names the description too");
  assert.equal(wrong.headers.get("x-content-type-options"), "nosniff", "and the security headers");
  assert.equal(ok.headers.get("ratelimit-policy"), `"read";q=${API_READ_BUDGET.max};w=60`, "the policy reaches the wire");
  assert.equal(ok.headers.get("api-version"), null, "no version header (LEAVES_OUT)");
  assert.equal((await serve("/search.json?q=fhe", { headers: { "api-version": "1999-01-01" } })).status, 200, "a pin is ignored, since there is one shape");
  const page = await serve("/garage");
  assert.doesNotMatch(page.headers.get("link") || "", /<\/openapi\.json>/, "a page is not an API answer");
});

/** A limiter binding that refuses, and records the keys it was asked about. */
const refusing = () => {
  const keys: any[] = [];
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
  const served = withApiContract(new Response("{}"), "/photos/query.json");
  assert.equal(served.headers.get("ratelimit-policy"), `"read";q=${API_READ_BUDGET.max};w=60`);
  const lensAnswer = withApiContract(new Response("{}", { headers: { "ratelimit-policy": '"inspect";q=30;w=60' } }), "/lens/fetch");
  assert.equal(lensAnswer.headers.get("ratelimit-policy"), '"inspect";q=30;w=60');
  assert.equal(withApiContract(new Response("{}"), "/lens/fetch").headers.get("ratelimit-policy"), null,
    "the contract never names the read policy on a door that does not bill it");
});

test("the spec documents the read budget where it applies and nowhere else", () => {
  const spec = JSON.parse(JSON.stringify(openApiDocument()));
  const photos = spec.paths["/photos/query.json"].get.responses;
  assert.match(photos["200"].headers["RateLimit-Policy"].description, new RegExp(`"read";q=${API_READ_BUDGET.max};w=60`));
  assert.ok(photos["429"].headers["Retry-After"] && photos["429"].headers.RateLimit);
  assert.doesNotMatch(spec.paths["/lens/fetch"].get.responses["200"].headers["RateLimit-Policy"].description, /"read"/);
});
