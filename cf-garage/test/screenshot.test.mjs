import assert from "node:assert/strict";
import test from "node:test";
import worker from "../src/index.js";

const context = () => ({ waitUntil() {}, tracing: null });

test("a parked screenshot request never starts a browser", async () => {
  let called = false;
  const response = await worker.fetch(
    new Request("https://aadhar.sh/garage/cf/screenshot"),
    { BROWSER: { async quickAction() { called = true; } } },
    context(),
  );

  assert.equal(response.status, 503);
  assert.equal(called, false);
  assert.equal((await response.json()).parked, true);
});

test("an opted-in screenshot delegates the bounded operation to Browser Run", async () => {
  let action;
  let options;
  const png = new Uint8Array([137, 80, 78, 71]);
  const response = await worker.fetch(
    new Request("https://aadhar.sh/garage/cf/screenshot?go=1&url=https%3A%2F%2Fwww.aadhar.sh%2Fgarage"),
    {
      BROWSER: {
        async quickAction(name, input) {
          action = name;
          options = input;
          return new Response(png, { headers: { "content-type": "image/png" } });
        },
      },
    },
    context(),
  );

  assert.equal(action, "screenshot");
  assert.deepEqual(options, {
    url: "https://www.aadhar.sh/garage",
    viewport: { width: 900, height: 600, deviceScaleFactor: 1 },
    gotoOptions: { waitUntil: "domcontentloaded", timeout: 15000 },
    waitForTimeout: 800,
    actionTimeout: 10000,
    cacheTTL: 0,
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "image/png");
  assert.equal(response.headers.get("cache-control"), "public, max-age=300");
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), png);
});

test("the screenshot endpoint clamps foreign targets before invoking Browser Run", async () => {
  let target;
  await worker.fetch(
    new Request("https://aadhar.sh/garage/cf/screenshot?go=1&url=https%3A%2F%2Fexample.com%2Fprivate"),
    {
      BROWSER: {
        async quickAction(_name, options) {
          target = options.url;
          return new Response(new Uint8Array([137, 80, 78, 71]), { headers: { "content-type": "image/png" } });
        },
      },
    },
    context(),
  );

  assert.equal(target, "https://aadhar.sh");
});

test("a Browser Run refusal stays a generic gateway failure", async () => {
  const response = await worker.fetch(
    new Request("https://aadhar.sh/garage/cf/screenshot?go=1"),
    { BROWSER: { async quickAction() { return Response.json({ errors: [{ code: 2001 }] }, { status: 429 }); } } },
    context(),
  );

  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), { ok: false, error: "the browser did not complete the screenshot" });
});
