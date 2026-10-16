// ── a declared-keyless site is not graded on delegated authority ────────────
// The three authority checks ask how an agent gets scoped permission to act
// for a user. A site whose OpenAPI document declares every operation keyless
// has nothing to scope, so lens.ts marks those checks neutral and
// notApplicable instead of "fix" (lensKeylessDeclaration). The evidence must
// be the site's explicit declaration: an omitted `security` stays a fail.
import { assert, lensReadiness, readFileSync, test } from "./contract-shared.ts";
import { lensKeylessDeclaration } from "../src/worker/lens.ts";

const AUTHORITY = ["oauthDiscovery", "oauthProtectedResource", "authMd"];
const probe = (spec) => ({ ok: true, status: 200, body: JSON.stringify(spec), truncated: false });
const keyless = { openapi: "3.1.0", security: [], paths: { "/search.json": { get: { operationId: "search" } } } };
const missing = { ok: false, status: 404, body: "" };
const base = {
  headers: {},
  robots: null,
  sitemap: null,
  terms: null,
  agent: null,
  botViews: [],
  discovery: { oauthDiscovery: { openidConfiguration: missing, oauthAuthorizationServer: missing }, oauthProtectedResource: missing, authMd: missing },
};

test("only an explicit, unqualified security: [] reads as keyless", () => {
  assert.match(lensKeylessDeclaration(probe(keyless)) ?? "", /security: \[\]/);
  // The controls, each one a way a spec can look keyless without saying so.
  const omitted = { openapi: "3.1.0", paths: {} };
  const schemes = { ...keyless, components: { securitySchemes: { key: { type: "apiKey", in: "header", name: "x-key" } } } };
  const perOp = { ...keyless, paths: { "/me": { get: { security: [{ oauth: ["read"] }] } } } };
  const required = { ...keyless, security: [{ key: [] }] };
  const swagger2 = { swagger: "2.0", security: [], securityDefinitions: { key: { type: "apiKey" } } };
  for (const [name, spec] of Object.entries({ omitted, schemes, perOp, required, swagger2 })) {
    assert.equal(lensKeylessDeclaration(probe(spec)), null, name);
  }
  assert.equal(lensKeylessDeclaration({ ...probe(keyless), truncated: true }), null, "a truncated body is not a declaration");
  assert.equal(lensKeylessDeclaration({ ok: true, status: 200, body: "<html>" }), null, "an HTML 200 is not a spec");
  assert.equal(lensKeylessDeclaration(missing), null);
  assert.equal(lensKeylessDeclaration(probe({ security: [] })), null, "not an OpenAPI document");
});

test("a keyless site's authority checks are not applicable and leave the score", () => {
  const graded = lensReadiness({ ...base, openapi: missing });
  const declared = lensReadiness({ ...base, openapi: probe(keyless) });
  for (const key of AUTHORITY) {
    assert.equal(graded.checks[key].status, "fail", `${key}: the control fails without a declaration`);
    assert.equal(graded.checks[key].notApplicable, undefined);
    assert.equal(declared.checks[key].status, "neutral", key);
    assert.equal(declared.checks[key].notApplicable, true, key);
    assert.match(declared.checks[key].detail, /^not applicable: /, key);
  }
  assert.equal(graded.counted - declared.counted, AUTHORITY.length, "exactly the three authority checks leave the denominator");
  assert.equal(declared.passed, graded.passed, "and nothing is passed for free");
  assert.ok(!declared.nextActions.some((a) => AUTHORITY.includes(a.key)), "no fix is suggested for a check that does not apply");
  assert.match(declared.keyless ?? "", /keyless/);
  assert.equal(graded.keyless, null);
});

test("a keyless site that publishes OAuth anyway keeps the pass", () => {
  const ok = { ok: true, status: 200, body: JSON.stringify({ resource: "https://x.test/" }) };
  const r = lensReadiness({ ...base, openapi: probe(keyless), discovery: { ...base.discovery, oauthProtectedResource: ok } });
  assert.equal(r.checks.oauthProtectedResource.status, "pass");
  assert.equal(r.checks.oauthProtectedResource.notApplicable, undefined);
  assert.equal(r.checks.authMd.notApplicable, true, "the others still do not apply");
});

test("the client prints n/a and treats the Authorize stage as satisfied", () => {
  const client = readFileSync("./src/client/lens.js", "utf8");
  assert.match(client, /if \(item\.notApplicable\) return \{ text: "n\/a"/, "the grid chip says n/a, not optional");
  assert.match(client, /var satisfied = x\.observed \|\| !!x\.na \|\|/, "a not-applicable stage does not break the chain");
  assert.match(client, /!cfNotApplicable\(x\.key, checks\)/, "the projection never adds a not-applicable check");
});
