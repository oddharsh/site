// ── A wrong method gets one 405 ──────────────────────────────────────────────
// lib/http.ts's methodGuard is how a route refuses a method it does not serve:
// JSON naming the methods, and the same list in Allow (RFC 9110 section
// 15.5.6). The JSON API's own preflight (lib/api-contract.ts) and the two MCP
// servers, which answer in their protocol's envelope with CORS, keep theirs.
import { assert, test } from "./contract-shared.ts";

test("methodGuard: GET implies HEAD; anything else is a JSON 405 whose Allow matches its body", async () => {
  const { methodGuard } = await import("../../src/worker/lib/http.ts");
  const req = (method: string) => new Request("https://aadhar.sh/x", { method });
  assert.equal(methodGuard(req("GET"), ["GET"]), null);
  assert.equal(methodGuard(req("HEAD"), ["GET"]), null, "HEAD rides on GET");
  assert.equal(methodGuard(req("POST"), ["GET", "POST"]), null);

  const refused = methodGuard(req("PUT"), ["POST", "GET"]);
  assert.equal(refused?.status, 405);
  assert.equal(refused?.headers.get("allow"), "GET, HEAD, POST");
  assert.deepEqual(await refused?.json(), {
    ok: false,
    error: "PUT is not served here. Use GET, HEAD, POST.",
    code: "method_not_allowed",
    allow: ["GET", "HEAD", "POST"],
  });
  assert.equal(methodGuard(req("HEAD"), ["POST"])?.headers.get("allow"), "POST", "HEAD is not implied by POST alone");
});
