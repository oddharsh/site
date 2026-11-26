// /lens/shot and /lens/browser are both Browser Run, and they disagreed about
// what "configured" means until 2026-10-01: Browser took the binding OR a REST
// token (hasRenderEngine), Shot demanded the binding, so a REST-only deployment
// rendered one view and answered 503 to the other. Shot goes through
// lens-render's runBrowserAction now, the seam with an adapter for each door.
import { assert, context, test } from "../../../tools/tests/contract-shared.ts";
import { handleLensShot } from "../lens.ts";
import { routeFetch } from "../../../tools/lib/fetch-routes.ts";

const SHOT = "https://aadhar.sh/lens/shot?url=https%3A%2F%2Fexample.com%2F";
const PNG = new Uint8Array([137, 80, 78, 71]);

test("a REST-only deployment takes a snapshot, through Chromium", async () => {
  const calls: any[] = [];
  {
    using _fetch = routeFetch({
      "https://api.cloudflare.com/client/v4/accounts/acct/browser-run/screenshot": async (request) => {
        calls.push({ url: request.url, authorization: request.headers.get("authorization"), body: await request.json() });
        return new Response(PNG, { headers: { "content-type": "image/png" } });
      },
    });
    const res = await handleLensShot(new Request(SHOT), { CF_ACCOUNT_ID: "acct", BROWSER_RUN_TOKEN: "token" }, context());
    assert.equal(res.status, 200, "a REST token is a configured Browser Run");
    assert.deepEqual(new Uint8Array(await res.arrayBuffer()), PNG);
  }
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/acct\/browser-run\/screenshot$/, "the REST screenshot action, with no engine selector");
  assert.equal(calls[0].authorization, "Bearer token");
  assert.equal(calls[0].body.url, "https://example.com/");
});

test("with neither door, it still says Browser Run is not configured", async () => {
  const res = await handleLensShot(new Request(SHOT), {}, context());
  assert.equal(res.status, 503);
});

test("the binding is asked for Chromium, never Kitesurf, since this is the human picture", async () => {
  let payload;
  const env = {
    BROWSER: {
      async quickAction(_name, input) {
        payload = input;
        return new Response(PNG, { headers: { "content-type": "image/png" } });
      },
    },
  };
  const res = await handleLensShot(new Request(SHOT), env, context());
  assert.equal(res.status, 200);
  assert.equal(payload.browser, undefined, "a Kitesurf selector would draw the page without its fonts and icons");
});
