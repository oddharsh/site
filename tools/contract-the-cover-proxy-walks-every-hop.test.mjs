// /serendipity/cover fetches a third-party image URL on a visitor's request, so
// it is an SSRF surface like /lens/fetch, and it now holds the same rule: every
// redirect hop is checked BEFORE it is requested (lib/public-fetch.ts). Until
// 2026-10-01 it checked the URL it was handed and let fetch() follow the rest,
// so a public host that 302'd to a private address was followed.
//
// The fetch stub below FOLLOWS redirects itself unless asked not to, because
// that is what the runtime does. A stub that never followed would make the old
// code look safe too, and this test would pass on the bug it exists to catch.
import { createHmac } from "node:crypto";
import { assert, context, test, testGlobals } from "./contract-shared.ts";
import { handleSerendipity } from "../serendipity/serendipity.ts";

const SECRET = "cover-secret-for-the-contract-suite";
const RAW = "https://images.lumacdn.com/event-covers/hop.jpg";
const SIG = createHmac("sha256", SECRET).update(RAW).digest("base64url");

async function cover(routes) {
  const requested = [];
  const realFetch = testGlobals.fetch, hadCaches = "caches" in globalThis, realCaches = testGlobals.caches;
  const respond = async (url, init = {}) => {
    requested.push(url);
    const route = routes[url];
    if (!route) throw new Error(`unexpected fetch ${url}`);
    if (route.location && init.redirect !== "manual") return respond(new URL(route.location, url).toString(), init);
    return route.location
      ? new Response(null, { status: 302, headers: { location: route.location } })
      : new Response("png", { status: 200, headers: { "content-type": "image/png" } });
  };
  testGlobals.fetch = (input, init) => respond(String(input instanceof Request ? input.url : input), init);
  testGlobals.caches = { default: { match: async () => undefined, put: async () => {} } };
  try {
    const res = await handleSerendipity(new Request(
      `https://aadhar.sh/serendipity/cover?u=${encodeURIComponent(RAW)}&s=${encodeURIComponent(SIG)}`),
      { SERENDIPITY_DB: {}, COVER_SECRET: SECRET }, context());
    return { res, requested };
  } finally {
    testGlobals.fetch = realFetch;
    if (hadCaches) testGlobals.caches = realCaches; else delete testGlobals.caches;
  }
}

test("a redirect to a private host is refused before it is requested", async () => {
  for (const location of ["https://localhost/admin", "https://169.254.169.254/latest/meta-data"]) {
    const { res, requested } = await cover({ [RAW]: { location }, [location]: {} });
    assert.equal(res.status, 400, `${location}: the hop must be refused`);
    assert.deepEqual(requested, [RAW], `${location}: only the public first hop may be requested`);
  }
});

test("a redirect off https is refused too, since a hop can change the scheme", async () => {
  const next = "http://cdn.example.com/a.jpg";
  const { res, requested } = await cover({ [RAW]: { location: next }, [next]: {} });
  assert.equal(res.status, 400);
  assert.deepEqual(requested, [RAW]);
});

test("a public redirect is still followed, so the walk did not just break covers", async () => {
  const next = "https://cdn.example.com/a.jpg";
  const { res, requested } = await cover({ [RAW]: { location: next }, [next]: {} });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "image/png");
  assert.deepEqual(requested, [RAW, next]);
});
