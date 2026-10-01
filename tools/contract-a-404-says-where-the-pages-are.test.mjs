// ── a 404 gets one more look (src/worker/lib/not-found.ts) ───────────────────
// Each deterministic rule is pinned with the Location it sends, and so is what
// must NOT be answered: a capability this site does not serve stays 404, a
// probe gets no suggestions, and a handler's own 404 body is left alone. The
// route oracle covers the same rules end to end through workerd.
import { assert, test } from "./contract-shared.ts";
import { HASHED_ASSETS } from "../src/worker/lib/shell-assets.ts";
import { _resetPhotoCaches } from "../src/worker/photos.ts";
import {
  DISCOVERY_ALIASES, MISS_LINKS, _resetSitemap, callerClass, canonicalPage, countMiss, missBucket, nearestPages, recoverNotFound,
} from "../src/worker/lib/not-found.ts";

const SITEMAP = `<?xml version="1.0"?><urlset>
  ${["/", "/garage", "/garage/resample", "/garage/masonry", "/garage/encoding", "/lwe", "/lwe/fhe", "/writing", "/writing/colophon"]
    .map((p) => `<url><loc>https://aadhar.sh${p}</loc></url>`).join("")}</urlset>`;

/**
 * An ASSETS binding serving a sitemap, a hashes.json and whatever else is listed.
 * @param {Record<string, any>} [extra]
 * @param {Record<string, Response>} [files]
 * @returns {any}
 */
function env(extra = {}, files = {}) {
  _resetSitemap();
  _resetPhotoCaches();
  const served = {
    "/sitemap.xml": new Response(SITEMAP),
    "/images/hashes.json": Response.json({ XT500010: { a: "aaaaaaaa", j: "jjjjjjjj", s: "ssssssss", x: "xxxxxxxx" } }),
    ...files,
  };
  return {
    ASSETS: {
      async fetch(input) {
        const path = new URL(input instanceof Request ? input.url : input).pathname;
        const r = served[path];
        return r ? r.clone() : new Response("", { status: 404 });
      },
    },
    ...extra,
  };
}

const empty404 = () => new Response("", { status: 404 });
/** @type {(path: string, init?: RequestInit) => Request} */
const get = (path, init) => new Request(`https://aadhar.sh${path}`, init);
/** @type {(path: string, e?: any, init?: RequestInit, response?: Response) => ReturnType<typeof recoverNotFound>} */
const recover = (path, e = env(), init, response = empty404()) => recoverNotFound(get(path, init), e, response);

test("a superseded /a/ hash answers with the current one", async () => {
  Object.assign(HASHED_ASSETS, { "icons.svg": "/a/icons.11111111.svg" });
  try {
    const r = await recover("/a/icons.cd1fc133.svg");
    assert.equal(r.response.status, 301);
    assert.equal(r.response.headers.get("location"), "https://aadhar.sh/a/icons.11111111.svg");
    assert.equal(r.response.headers.get("cache-control"), "public, max-age=86400", "a day, since the target moves next release");
    assert.equal(r.outcome, "redirect:stale-asset");
    assert.equal((await recover("/a/icons.11111111.svg")).response.status, 404, "the current hash never redirects to itself");
    assert.equal((await recover("/a/nothing.22222222.js")).response.status, 404, "a name the build never made is a plain miss");
  } finally { delete HASHED_ASSETS["icons.svg"]; }
});

test("a superseded /i/ photo tile answers with the same tier's current hash", async () => {
  const cases = {
    "/i/XT500010.0000aaaa.avif": "/i/XT500010.aaaaaaaa.avif",
    "/i/XT500010.0000aaaa.jpg": "/i/XT500010.jjjjjjjj.jpg",
    "/i/XT500010-400.0000aaaa.avif": "/i/XT500010-400.ssssssss.avif",
    "/i/XT500010-200.0000aaaa.avif": "/i/XT500010-200.xxxxxxxx.avif",
  };
  for (const [from, to] of Object.entries(cases)) {
    const r = await recover(from);
    assert.equal(r.response.headers.get("location"), `https://aadhar.sh${to}`, from);
  }
  assert.equal((await recover("/i/NOPE.0000aaaa.avif")).response.status, 404, "an unknown stem stays a miss");
});

test("share cards, terminal tools and MCP card probes go where the thing actually is", async () => {
  const withCard = env({}, { "/og/garage-pqc.jpg": new Response("jpg") });
  assert.equal((await recover("/og/garage-pqc.png", withCard)).response.headers.get("location"), "https://aadhar.sh/og/garage-pqc.jpg");
  assert.equal((await recover("/og/nope.png", withCard)).response.status, 404, "only a card that exists as .jpg is redirected");

  assert.equal((await recover("/finger.md")).response.headers.get("location"), "https://aadhar.sh/finger.txt");
  assert.equal((await recover("/writing.md")).response.status, 404, "only a registered text-frame tool maps .md to .txt");

  for (const [from, to] of Object.entries(DISCOVERY_ALIASES)) {
    assert.equal((await recover(from)).response.headers.get("location"), `https://aadhar.sh${to}`, from);
  }
  for (const honest of ["/openapi.json", "/.well-known/ai-plugin.json", "/.well-known/x402", "/.well-known/agents.json"]) {
    assert.equal((await recover(honest)).response.status, 404, `${honest} names a capability this site does not serve`);
  }
});

test("the sitemap is the authority for the easy fixes, and the query survives", async () => {
  const pages = ["/garage", "/garage/resample", "/writing/colophon"];
  assert.equal(canonicalPage("/Garage/Resample/", pages), "/garage/resample");
  assert.equal(canonicalPage("/writing/colophon.html", pages), "/writing/colophon");
  assert.equal(canonicalPage("/garage/index.html", pages), "/garage");
  assert.equal(canonicalPage("/garage/resample", pages), null, "a page already spelled right is not a fix");
  const r = await recover("/Garage/Resample?ref=hn");
  assert.equal(r.response.headers.get("location"), "https://aadhar.sh/garage/resample?ref=hn");
  assert.equal(r.outcome, "redirect:canonical-page");
});

test("an empty 404 names the closest pages in its own section, and the sitemap", async () => {
  const r = await recover("/garage/resampe");
  assert.equal(r.response.status, 404);
  assert.equal(r.outcome, "404:suggested");
  assert.match(r.response.headers.get("content-type") || "", /^text\/plain/);
  assert.equal(r.response.headers.get("link"), MISS_LINKS);
  const body = await r.response.text();
  assert.match(body, /^404 Not Found: \/garage\/resampe/);
  assert.match(body, /Closest pages in \/garage:\n {2}\/garage\/resample\n/, "the typo's sibling first");
  assert.ok(!body.includes("/lwe/fhe"), "suggestions stay inside the section");
  assert.match(body, /Section index: \/garage/);
  assert.match(body, /\/sitemap\.xml/);

  assert.deepEqual(nearestPages("/zzzzzz-qqqq", ["/garage", "/garage/resample"]), { section: null, pages: [] },
    "an unrelated guess is not offered a near miss");

  const clamped = new Response("not found", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
  assert.match(await (await recover("/garage/resampe", env(), undefined, clamped)).response.text(), /Closest pages in \/garage/,
    "the clamp's generic \"not found\" is rewritten like an empty body");

  const head = await recover("/garage/resampe", env(), { method: "HEAD" });
  assert.equal(head.response.status, 404);
  assert.equal(await head.response.text(), "", "HEAD carries no body");
});

test("a probe gets the pointers and nothing else; a handler's own 404 keeps its body", async () => {
  const probe = await recover("/.env");
  assert.equal(probe.bucket, "probe");
  assert.equal(probe.outcome, "404");
  assert.ok(!(await probe.response.text()).includes("Closest pages"), "a vulnerability probe is offered no pages");

  const json = new Response('{"error":"not found"}', { status: 404, headers: { "content-type": "application/json" } });
  const kept = await recover("/serendipity/event/nope", env(), undefined, json);
  assert.equal(await kept.response.text(), '{"error":"not found"}');
  assert.equal(kept.response.headers.get("content-type"), "application/json");
  assert.match(kept.response.headers.get("link") || "", /rel="sitemap"/, "but it still points at the sitemap");
});

test("the counter records caller class, bucket and outcome for every miss", async () => {
  const points = [];
  const e = env({ MISS_LEDGER: { writeDataPoint: (p) => points.push(p) } });
  const req = get("/garage/resampe", { headers: { "user-agent": "Mozilla/5.0 (compatible; ClaudeBot/1.0)" } });
  const miss = await recoverNotFound(req, e, empty404());
  countMiss(e, req, "/garage/resampe", miss);
  assert.deepEqual(points, [{ blobs: ["ai-crawler", "page", "404:suggested", "/garage/resampe"], doubles: [1], indexes: ["page"] }]);
  countMiss({}, req, "/x", miss);   // no binding: nothing to write, and nothing thrown

  assert.equal(callerClass("curl/8.7.1"), "http-tool");
  assert.equal(callerClass("tphotobot/0.1 (+https://crawler.estidraft.com/bot)"), "other-bot");
  assert.equal(callerClass(""), "empty");
  assert.equal(missBucket("/a/icons.cd1fc133.svg"), "stale-asset");
  assert.equal(missBucket("/.well-known/ai-plugin.json"), "discovery");
  assert.equal(missBucket("/wp-admin/setup.php"), "probe");
});
