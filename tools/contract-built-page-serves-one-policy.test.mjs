// ── a built page's policy lands on every representation ─────────────────────
// lib/built-page.ts owns what "a built document with a live fallback" means.
// Until 2026-10-02 that was written at 18 routes, and the Markdown twin a page
// answers `Accept: text/markdown` with took NONE of the page's headers unless
// the route negotiated by hand first. /security, /whoareyou, /around and
// /search did; /inbox, /writing and /lens/census did not, so their twins lost
// the webmention Link and the robots header the HTML carried.
//
// index.ts cannot load outside workerd (gotcha 16), so this drives the module
// and the two routes that live outside index.ts (/inbox, /reading) against a
// fake ASSETS binding. What it pins:
//   - the q11 twin, the 304, the HEAD and the Markdown twin all carry the policy;
//   - the twin keeps its own no-store and never names the shell preloads;
//   - a tree with no bake renders live under the same policy;
//   - a live answer that is not the document (a 404) is left alone;
//   - a diverted request never touches the built file or the policy.
import assert from "node:assert/strict";
import { test } from "node:test";
import { serveMarkdownTwin, serveStaticPage, twinPolicy } from "../src/worker/lib/assets.ts";
import { serveBuiltPage } from "../src/worker/lib/built-page.ts";
import { handleInbox } from "../src/worker/inbox.ts";
import { handleReading } from "../src/worker/reading.ts";

const PRELOAD = '</a/luna.0dbcdba1.css>; rel="preload"; as="style", </a/nav.684e58a4.js>; rel="preload"; as="script"';
const POLICY = {
  "cache-control":   "public, max-age=0, s-maxage=86400, stale-while-revalidate=604800",
  "link":            `${PRELOAD}, </webmention>; rel="webmention"`,
  "x-robots-tag":    "noindex",
  "referrer-policy": "strict-origin-when-cross-origin",
};

// A staged tree: path -> [body, headers]. Counts every lookup, so a test can
// say the built file was never asked for.
function stagedAssets(files) {
  const asked = [];
  return {
    asked,
    async fetch(input) {
      const request = input instanceof Request ? input : new Request(input);
      const path = new URL(request.url).pathname;
      asked.push(path);
      const hit = files[path];
      if (!hit) return new Response("not found", { status: 404 });
      return new Response(request.method === "HEAD" ? null : hit[0], { headers: hit[1] });
    },
  };
}

const BUILT = {
  "/page":         ["<!doctype html><title>page</title>", { "content-type": "text/html; charset=utf-8", etag: '"plain"' }],
  "/page.html.br": ["br-bytes", { "content-type": "application/octet-stream", etag: '"twin"' }],
  "/page.md":      ["# Page\n\nprose about the page", { "content-type": "text/markdown; charset=utf-8" }],
};
const ask = (path, init = {}) => new Request("https://aadhar.sh" + path, init);
const MD = { accept: "text/markdown" };

test("the q11 twin, the 304 and the HEAD all carry the page's policy", async () => {
  const env = { ASSETS: stagedAssets(BUILT) };
  const page = { headers: POLICY, live: () => assert.fail("a staged page must not render live") };

  const get = await serveBuiltPage(ask("/page"), env, page);
  assert.equal(get.status, 200);
  assert.equal(get.headers.get("content-encoding"), "br", "the fixture reached the precompressed twin");
  for (const [name, value] of Object.entries(POLICY)) assert.equal(get.headers.get(name), value, `GET ${name}`);

  const fresh = await serveBuiltPage(ask("/page", { headers: { "if-none-match": get.headers.get("etag") } }), env, page);
  assert.equal(fresh.status, 304);
  for (const name of ["cache-control", "x-robots-tag"]) assert.equal(fresh.headers.get(name), POLICY[name], `304 ${name}`);

  const head = await serveBuiltPage(ask("/page", { method: "HEAD" }), env, page);
  assert.equal(head.status, 200);
  for (const [name, value] of Object.entries(POLICY)) assert.equal(head.headers.get(name), get.headers.get(name) && value, `HEAD ${name}`);
});

test("the Markdown twin carries the policy, keeps its no-store and drops the shell preloads", async () => {
  const env = { ASSETS: stagedAssets(BUILT) };
  const get = await serveBuiltPage(ask("/page", { headers: MD }), env, { headers: POLICY });
  assert.equal(get.headers.get("content-type"), "text/markdown; charset=utf-8");
  assert.equal(get.headers.get("x-robots-tag"), "noindex", "a noindex page's twin must not be its indexable copy");
  assert.equal(get.headers.get("referrer-policy"), POLICY["referrer-policy"]);
  assert.equal(get.headers.get("link"), '</webmention>; rel="webmention"',
    "the resource's own Link entries survive; the shell preloads describe the HTML and do not");
  assert.equal(get.headers.get("cache-control"), "no-store, must-revalidate",
    "the edge keys the URL, never the Accept, so the negotiated twin must stay uncacheable whatever the page says");

  const head = await serveBuiltPage(ask("/page", { method: "HEAD", headers: MD }), env, { headers: POLICY });
  assert.equal(await head.text(), "");
  assert.deepEqual([...head.headers].sort(), [...get.headers].sort(), "HEAD and GET agree on every header of the twin");

  // CONTROL: the shape every un-negotiated route had before, a twin served with
  // no policy. Each assertion above fails against it.
  const before = await serveMarkdownTwin(ask("/page", { headers: MD }), env, "/page.md");
  assert.ok(before, "the fixture stages the twin");
  assert.equal(before.headers.get("x-robots-tag"), null);
  assert.equal(before.headers.get("link"), null);
});

test("twinPolicy leaves out only what describes the HTML representation", () => {
  assert.deepEqual(twinPolicy(POLICY), {
    "link": '</webmention>; rel="webmention"',
    "x-robots-tag": "noindex",
    "referrer-policy": "strict-origin-when-cross-origin",
  });
  assert.deepEqual(twinPolicy({ "Cache-Control": "public", Link: PRELOAD }), {}, "a preload-only Link leaves no empty header behind");
  assert.deepEqual(twinPolicy({ link: '</a,b>; rel="sitemap", </x.css>; rel=preload; as=style' }), { link: '</a,b>; rel="sitemap"' },
    "a comma inside a URL does not split an entry, and an unquoted rel is still a preload");
  assert.deepEqual(twinPolicy(), {});
});

test("a tree with no bake renders live under the same policy", async () => {
  const env = { ASSETS: stagedAssets({}) };
  const live = () => new Response("<!doctype html>live", { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-own": "kept" } });
  for (const method of ["GET", "HEAD"]) {
    const res = await serveBuiltPage(ask("/page", { method }), env, { headers: POLICY, live });
    assert.equal(res.status, 200);
    for (const [name, value] of Object.entries(POLICY)) assert.equal(res.headers.get(name), value, `${method} live ${name}`);
    assert.equal(res.headers.get("x-own"), "kept", "the policy is laid over the render, not in place of it");
  }
  const frozen = await serveBuiltPage(ask("/page"), env, { headers: POLICY, live: () => Response.redirect("https://aadhar.sh/x", 302) });
  assert.equal(frozen.status, 302, "a redirect is not the document and is returned as it came");
  assert.equal(frozen.headers.get("cache-control"), null);
});

test("a live answer that is not the document keeps its own headers", async () => {
  const env = { ASSETS: stagedAssets({}) };
  const miss = await serveBuiltPage(ask("/writing/no-such-post"), env, {
    headers: POLICY,
    live: () => new Response("<!doctype html>404", { status: 404, headers: { "content-type": "text/html", "cache-control": "public, max-age=30, must-revalidate" } }),
  });
  assert.equal(miss.status, 404);
  assert.equal(miss.headers.get("cache-control"), "public, max-age=30, must-revalidate", "a miss must not inherit a day of shared cache");
  assert.equal(miss.headers.get("x-robots-tag"), null);

  const text = await serveBuiltPage(ask("/writing/post"), env, {
    headers: POLICY,
    live: () => new Response("plain", { headers: { "content-type": "text/plain; charset=utf-8" } }),
  });
  assert.equal(text.headers.get("cache-control"), null, "only an HTML 200 is the page");

  // no live renderer declared: the asset layer's clamped 404 is the answer
  const none = await serveBuiltPage(ask("/page"), env, { headers: POLICY });
  assert.equal(none.status, 404);
  assert.equal(none.headers.get("cache-control"), "public, max-age=0, must-revalidate");
});

test("a diverted request skips the built file and the policy", async () => {
  const env = { ASSETS: stagedAssets(BUILT) };
  const page = {
    headers: POLICY,
    divert: (url) => (url.searchParams.get("q") ? new Response("results", { headers: { "content-type": "text/html", "cache-control": "no-store" } }) : null),
    live: () => assert.fail("neither arm renders live here"),
  };
  const diverted = await serveBuiltPage(ask("/page?q=photos"), env, page);
  assert.equal(await diverted.text(), "results");
  assert.equal(diverted.headers.get("cache-control"), "no-store", "a per-query answer does not take the shell's cache policy");
  assert.equal(diverted.headers.get("x-robots-tag"), null);
  assert.deepEqual(env.ASSETS.asked, [], "the built file was never asked for");

  const plain = await serveBuiltPage(ask("/page"), env, page);
  assert.equal(plain.headers.get("content-encoding"), "br", "without the query the predicate declines and the document is served");
  // an async predicate that declines is awaited, not taken as truthy
  const declined = await serveBuiltPage(ask("/page"), env, { ...page, divert: async () => null });
  assert.equal(declined.headers.get("content-encoding"), "br");
});

// The two routes outside index.ts, through their real handlers. /inbox is the
// measured instance: its twin answered with no Link at all, so a webmention
// sender that negotiated Markdown could not discover the endpoint.
test("/inbox and /reading serve their twins under the page's policy", async () => {
  const twin = (path) => stagedAssets({ [`${path}.md`]: ["# twin\n\nbody", { "content-type": "text/markdown" }] });

  const inbox = await handleInbox(ask("/inbox", { headers: MD }), { ASSETS: twin("/inbox") });
  assert.equal(inbox.headers.get("content-type"), "text/markdown; charset=utf-8");
  assert.match(inbox.headers.get("link") || "", /^<[^>]*\/webmention>; rel="webmention"$/, "the endpoint is discoverable from the twin, and nothing else rides with it");
  assert.match(inbox.headers.get("cache-control") || "", /no-store/);
  // CONTROL: the call the route made before, which is what dropped it.
  const before = await serveMarkdownTwin(ask("/inbox", { headers: MD }), { ASSETS: twin("/inbox") }, "/inbox.md");
  assert.ok(before, "the fixture stages the twin");
  assert.equal(before.headers.get("link"), null);

  const reading = await handleReading(ask("/reading", { headers: MD }), { ASSETS: twin("/reading") }, { waitUntil() {} });
  assert.equal(reading.headers.get("referrer-policy"), "strict-origin-when-cross-origin");
  assert.equal(reading.headers.get("link"), null, "/reading's Link is the shell preload alone, which the twin leaves out");

  // and with nothing staged, both render live under their policy
  const live = await handleInbox(ask("/inbox"), { ASSETS: stagedAssets({}) });
  assert.equal(live.status, 200);
  assert.match(live.headers.get("link") || "", /rel="webmention"/);
  assert.match(live.headers.get("cache-control") || "", /stale-while-revalidate/);
});

// serveStaticPage is the engine under the module, and prefix routes call it with
// no policy at all. Their twins must be exactly what they were.
test("a page with no policy serves the twin it always did", async () => {
  const env = { ASSETS: stagedAssets(BUILT) };
  const viaEngine = await serveStaticPage(ask("/page", { headers: MD }), env);
  const direct = await serveMarkdownTwin(ask("/page", { headers: MD }), env, "/page.md");
  assert.ok(direct, "the fixture stages the twin");
  assert.deepEqual([...viaEngine.headers].sort(), [...direct.headers].sort());
});
