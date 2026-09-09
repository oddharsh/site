import { assert, fakeImages, representationD1, test, testGlobals } from "./contract-shared.ts";
import { imageInspect } from "../src/worker/image-tools.ts";
import { captureRepresentation } from "../src/worker/representation.ts";
import { discoverEndpoint } from "../src/worker/webmention-send.ts";
import { fetchFollowingPublicRedirects, validateLensTarget } from "../src/worker/lib/crawl.ts";

const start = "https://example.com/start";
const redirectStatuses = [301, 302, 303, 307, 308];

// Model automatic following as well as manual reads. A post-fetch refusal
// must fail the no-request assertion even when it hides the fetched body.
async function withResponses(respond, run) {
  const original = globalThis.fetch;
  const seen = [];
  testGlobals.fetch = async (input, init = {}) => {
    let url = String(input);
    for (let hop = 0; hop <= 20; hop++) {
      seen.push({ url, init });
      const response = respond(url, init);
      const location = response.headers.get("location");
      if (init.redirect !== "manual" && redirectStatuses.includes(response.status) && location !== null) {
        url = new URL(location, url).href;
        await response.body?.cancel();
        continue;
      }
      if (!response.url) Object.defineProperty(response, "url", { value: url });
      return response;
    }
    throw new TypeError("too many redirects");
  };
  try { return await run(seen); }
  finally { testGlobals.fetch = original; }
}

const blockedTargets = [
  "http://169.254.169.254/latest/meta-data/", "http://[::ffff:7f00:1]/",
  "https://user:secret@example.org/", "https://example.org:8443/", "ftp://example.org/file",
];

for (const { name, read } of [
  { name: "image", read: () => imageInspect({ source_url: start }, { IMAGES: fakeImages() }) },
  { name: "representation", read: () => captureRepresentation({ url: start, profiles: ["browser", "identity"] }, { RESTORE_DB: representationD1() }) },
  { name: "Webmention", read: () => discoverEndpoint(start) },
]) test(`${name} reads stop before a disallowed redirect hop`, async () => {
  for (const blocked of blockedTargets) {
    await withResponses((url) => url === start
      ? new Response(null, { status: 302, headers: { location: "/second" } })
      : url === "https://example.com/second"
        ? new Response(null, { status: 307, headers: { location: blocked } })
        : new Response("private data", { headers: { "content-type": "image/png" } }), async (seen) => {
      const result = await read();
      assert.ok(seen.length >= 2, `${name} exercises a redirect chain`);
      assert.ok(seen.every(({ url }) => url === start || url === "https://example.com/second"), `${name} must not request ${blocked}`);
      assert.ok(!JSON.stringify(result).includes("private data"));
    });
  }
});

test("public reads retain the native twenty-redirect allowance and final URL", async () => {
  for (const count of [0, 1, 20, 21]) {
    const first = "https://example.com/0";
    const final = `https://example.com/${count}`;
    const readers = [
      { name: "image", read: () => imageInspect({ source_url: first }, { IMAGES: fakeImages() }), finalUrl: (result) => result.input.url },
      { name: "representation", read: () => captureRepresentation({ url: first, profiles: ["identity"] }, { RESTORE_DB: representationD1() }), finalUrl: (result) => result.snapshots[0].finalUrl },
      { name: "webmention", read: () => discoverEndpoint(first), finalUrl: (result) => result },
    ];
    for (const { name, read, finalUrl } of readers) await withResponses((url) => {
      const step = Number(new URL(url).pathname.slice(1));
      return step < count
        ? new Response(null, { status: redirectStatuses[step % 5], headers: { location: `/${step + 1}` } })
        : new Response("image bytes", { headers: { "content-type": "image/png", link: '<>; rel="webmention"' } });
    }, async (seen) => {
      const result = await read();
      assert.equal(seen.length, Math.min(count + 1, 21), name);
      if (count <= 20) assert.equal(finalUrl(result), final, name);
      else assert.ok(result === null || result._error || result.snapshots?.[0].error, `${name} refuses the overflowing chain`);
      assert.ok(seen.every(({ init }) => init.signal === seen[0].init.signal), `${name} shares one deadline across hops`);
    });
  }
});

test("Webmention validates endpoints from Link headers and HTML with the same policy", async () => {
  for (const endpoint of [...blockedTargets, "../mentions"]) for (const fromHeader of [false, true]) {
    await withResponses(() => new Response(fromHeader ? "unused" : `<link rel="webmention" href="${endpoint}">`, {
      headers: fromHeader ? { link: `<${endpoint}>; rel="webmention"` } : {},
    }), async (seen) => {
      assert.equal(await discoverEndpoint(start), endpoint === "../mentions" ? "https://example.com/mentions" : null);
      assert.equal(seen.length, 1, "discovery never contacts the endpoint");
    });
  }
});

test("the redirect guard follows redirect statuses only", async () => {
  for (const status of [200, 300, 304, 305, 306, 399]) {
    await withResponses(() => new Response(null, { status, headers: { location: "/elsewhere" } }), async (seen) => {
      const result = await fetchFollowingPublicRedirects(start, {}, validateLensTarget);
      assert.equal(result.ok, true);
      assert.equal(result.response.status, status);
      assert.equal(seen.length, 1, `HTTP ${status} is not a redirect`);
    });
  }
  await withResponses(() => {
    const response = new Response("fixture");
    Object.defineProperty(response, "url", { value: start });
    return response;
  }, async () => {
    const result = await fetchFollowingPublicRedirects(start + "#fragment", {}, validateLensTarget);
    assert.equal(result.ok, true);
    assert.equal(result.finalUrl, start, "the fetched URL excludes the request fragment");
  });
});

test("the redirect guard cancels malformed redirects", async () => {
  let cancelled = false;
  await withResponses(() => new Response(new ReadableStream({ cancel() { cancelled = true; } }), {
    status: 302, headers: { location: "http://[" },
  }), async (seen) => {
    const result = await fetchFollowingPublicRedirects(start, {}, validateLensTarget);
    assert.equal(result.ok, false);
    assert.equal(seen.length, 1);
    assert.equal(cancelled, true, "a malformed Location must not leave its response stream open");
  });
});
