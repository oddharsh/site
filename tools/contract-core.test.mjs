// Split from contract-tests.test.mjs; shared imports live in contract-shared.mjs.
import {
  assert,
  botHeaders,
  test,
} from "./contract-shared.mjs";

// contract-tests.test.mjs — representation-boundary tests for the homepage Worker.
//
// These are deliberately dependency-free and deterministic. They test the
// public shape of the page/fragment and JSON/HTML handlers without starting a
// local Worker or making third-party network requests. verify-routes.mjs adds
// the same assertions against a deployed or local HTTP surface.



// Every path lookup below is relative to the REPO ROOT, not to this file.
// Naming it means moving this script again costs one line instead of 57.





// KV's get() takes the type either bare ("json") or inside an options object
// ({ type, cacheTtl }). Reads that pass cacheTtl use the second form, so a stub
// that only understands the first silently hands back a string where the caller
// expected a parsed object — which reads downstream as a cache miss, not as a
// broken fake. Normalize once, here.



test("AadharshBot refuses an external request without its signing key", async () => {
  await assert.rejects(
    botHeaders("https://example.com/", {}, { headers: { accept: "text/html" } }),
    /signing key is unavailable/
  );
});

test("self-dispatched bot headers can be built without putting a signature on the wire", async () => {
  const headers = await botHeaders("https://aadhar.sh/", {}, { sign: false });
  assert.equal(headers.get("user-agent"), "AadharshBot/1.0 (+https://aadhar.sh/bot)");
  assert.equal(headers.get("signature"), null);
});
