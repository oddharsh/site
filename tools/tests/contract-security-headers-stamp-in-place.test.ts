// ── security headers: stamped in place when the Worker built the response ────
// withSecurityHeaders writes into a Response the Worker built, whose headers are
// mutable, and copies and rebuilds one whose headers carry the Fetch spec's
// "immutable" guard (fetch() and the ASSETS binding hand those back). bun has no
// immutable guard at all, so the immutable case here is a Headers whose set()
// throws the TypeError workerd and node throw.
import { assert, test } from "./contract-shared.ts";
import { withSecurityHeaders } from "../../src/worker/lib/security.ts";

const html = (headers: Record<string, string> = {}) => new Response("<p>hi</p>", { headers: { "content-type": "text/html; charset=utf-8", ...headers } });

function immutable(response: Response): Response {
  const set = () => {
    throw new TypeError("Can't modify immutable headers.");
  };
  for (const method of ["set", "append", "delete"]) Object.defineProperty(response.headers, method, { value: set });
  return response;
}

const listed = (response: Response) => [...response.headers].map(([k, v]) => `${k}: ${v}`).sort();

test("a Worker-built response is stamped in place, an immutable one is copied, and both end up alike", () => {
  const built = html();
  const stamped = withSecurityHeaders(built, "/garage/horizon");
  assert.equal(stamped, built, "the Worker's own response comes back as itself");
  assert.equal(stamped.headers.get("x-frame-options"), "DENY");
  assert.equal(stamped.headers.get("x-content-type-options"), "nosniff");

  const frozen = immutable(html());
  const before = listed(frozen);
  const copied = withSecurityHeaders(frozen, "/garage/horizon");
  assert.notEqual(copied, frozen, "an immutable response is rebuilt");
  assert.deepEqual(listed(frozen), before, "and left as it was");
  assert.deepEqual(listed(copied), listed(stamped), "both paths stamp the same headers");
});

test("a route's own policy survives either path", () => {
  const own = { "content-security-policy": "default-src 'none'", "x-content-type-options": "nosniff" };
  for (const response of [html(own), immutable(html(own))]) {
    const out = withSecurityHeaders(response, "/lens");
    assert.equal(out.headers.get("content-security-policy"), "default-src 'none'");
    assert.equal(out.headers.get("x-content-type-options"), "nosniff");
  }
});
