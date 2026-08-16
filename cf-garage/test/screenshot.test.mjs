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

test("the size of a successful screenshot reaches the log", async () => {
  // The binding announces no content-length, so reading the header logged
  // `bytes: undefined` on every success. Measured against the real binding on
  // 2026-08-16: two renders of 218,085 and 198,858 bytes, neither announced.
  const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const lines = [];
  const original = console.log;
  console.log = (line) => lines.push(line);
  try {
    await worker.fetch(
      new Request("https://aadhar.sh/garage/cf/screenshot?go=1"),
      {
        BROWSER: {
          async quickAction() { return new Response(png, { headers: { "content-type": "image/png" } }); },
        },
      },
      context(),
    );
  } finally {
    console.log = original;
  }

  const logged = lines.map((line) => { try { return JSON.parse(line); } catch { return {}; } });
  const success = logged.find((entry) => entry.feature === "browser-rendering" && entry.bytes !== undefined);
  assert.ok(success, `no browser-rendering log line carried a byte count: ${JSON.stringify(lines)}`);
  assert.equal(success.bytes, png.byteLength);
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

// The three failure shapes are deliberately three different answers. Browser
// Run refusing us on a spent budget is the most likely one on the free plan,
// and it is a fact about this account rather than about the demo.
const refuse = (body, init) => worker.fetch(
  new Request("https://aadhar.sh/garage/cf/screenshot?go=1"),
  { BROWSER: { async quickAction() { return body instanceof Response ? body : Response.json(body, init); } } },
  context(),
);

test("a spent Browser Run budget is reported as OUR limit, not an upstream fault", async () => {
  const response = await refuse({ errors: [{ code: 2001 }] }, { status: 429 });
  const payload = await response.json();

  assert.equal(response.status, 429, "a 502 here sends the reader to debug a page that is fine");
  assert.equal(payload.budget, true);
  assert.match(payload.error, /rate-limited/);
  assert.match(payload.error, /10 min\/day/, "the message should quote the ceiling that was actually hit");
});

test("any other Browser Run failure names its status and stays a 502", async () => {
  const response = await refuse({ errors: [{ code: 9999 }] }, { status: 500 });

  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), { ok: false, error: "Browser Run returned 500." });
});

test("a 200 that is not an image never ships as one", async () => {
  // The old code trusted `ok` and defaulted the type to image/png, so a JSON
  // body could reach an <img> as a broken picture with no reason attached.
  const response = await refuse(new Response('{"success":false}', {
    status: 200, headers: { "content-type": "application/json" },
  }));

  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), { ok: false, error: "Browser Run returned 200." });
});

test("a binding that throws publishes no platform text", async () => {
  const response = await worker.fetch(
    new Request("https://aadhar.sh/garage/cf/screenshot?go=1"),
    { BROWSER: { async quickAction() { throw new Error("internal detail nobody outside should read"); } } },
    context(),
  );

  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), { ok: false, error: "the browser did not complete the screenshot" });
});
