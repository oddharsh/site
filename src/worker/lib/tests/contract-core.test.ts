// AadharshBot's signing door: no key means no external request, and a self-dispatch carries no signature.
import { assert, test } from "../../../../tools/tests/contract-shared.ts";
import { botHeaders } from "../botauth.ts";

test("AadharshBot refuses an external request without its signing key", async () => {
  await assert.rejects(botHeaders("https://example.com/", {}, { headers: { accept: "text/html" } }), /signing key is unavailable/);
});

test("self-dispatched bot headers can be built without putting a signature on the wire", async () => {
  const headers = await botHeaders("https://aadhar.sh/", {}, { sign: false });
  assert.equal(headers.get("user-agent"), "AadharshBot/1.0 (+https://aadhar.sh/bot)");
  assert.equal(headers.get("signature"), null);
});
