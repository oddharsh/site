// ── og:video plays for the bots that play it ────────────────────────────────
// lib/og-video.ts hands a page's clip to two preview fetchers only: HEVC to
// iMessage, AV1 to Discord. What this pins:
//   - the picker matches those two by the UA each sends, and NOT Facebook's
//     crawler, bare Twitterbot, or a person, which all keep the still card;
//   - every clip it names is on disk in the container and codec it claims, so a
//     clip that never got baked is a failing test rather than a blank player;
//   - the rewrite turns og:type into video.other (Discord needs it), lands
//     on a minified page with no </head> (gotcha 83), and can't be cached
//     for a person;
//   - the clip route answers Range, which the asset layer ignores;
//   - public/og/video holds the named clips and nothing else (AVFoundation's
//     .sb- leftovers landed there once);
//   - both page handlers ask before they take the static path, and Workers
//     Cache, which answers `/` before any handler runs, lets these requests by.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { assert, ROOT, test } from "./contract-shared.ts";
import { shouldUseWorkersCache } from "../src/worker/lib/cache.ts";
import { OG_VIDEOS, ogVideoFor, parseRange, serveOgVideo, withOgVideo } from "../src/worker/lib/og-video.ts";
import { CACHEABLE_PATHS, claimedByWorker } from "../src/worker/routes.ts";
import { OG_PAGE_DIRS } from "./photos/og-pages.ts";

const read = (rel: string) => readFileSync(new URL(rel, ROOT));
const PAGE = "/garage/encoding";

// Each as the fetcher sends it, not trimmed to the token.
const UA = {
  iMessage:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_11_1) AppleWebKit/601.2.4 (KHTML, like Gecko) Version/9.0.1 Safari/601.2.4 facebookexternalhit/1.1 Facebot Twitterbot/1.0",
  discord: "Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)",
  facebook: "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)",
  x: "Twitterbot/1.0",
  slack: "Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)",
  safari: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
};

test("iMessage gets HEVC, Discord gets AV1, and nobody else gets a clip", () => {
  assert.equal(ogVideoFor(PAGE, UA.iMessage)?.codec, "hevc");
  assert.equal(ogVideoFor(PAGE, UA.discord)?.codec, "av1");
  for (const who of ["facebook", "x", "slack", "safari"] as const) assert.equal(ogVideoFor(PAGE, UA[who]), null, `${who} should keep the still card`);
  assert.equal(ogVideoFor(PAGE, null), null);
  // control: a page with no clip gives nothing, even to a bot that plays one
  assert.equal(ogVideoFor("/garage/horizon", UA.discord), null);
});

test("every clip is on disk in the container and codec it claims", () => {
  for (const [page, v] of Object.entries(OG_VIDEOS)) {
    for (const file of [v.hevc, v.av1])
      assert.ok(existsSync(new URL(`public${file}`, ROOT)), `${page}: ${file} is missing; run bun tools/photos/og-video/bake.ts`);
    const mp4 = read(`public${v.hevc}`);
    assert.equal(mp4.subarray(4, 8).toString("latin1"), "ftyp", `${v.hevc} is not an MP4`);
    // hvc1, not hev1: hvc1 is the HEVC sample entry AVFoundation plays from MP4
    assert.ok(mp4.includes("hvc1"), `${v.hevc} carries no hvc1 sample entry`);
    assert.ok(mp4.indexOf("moov") < mp4.indexOf("mdat"), `${v.hevc} has moov after mdat, so a fetcher must download it all before it can decode`);
    const webm = read(`public${v.av1}`);
    assert.equal(webm.readUInt32BE(0), 0x1a45dfa3, `${v.av1} is not EBML`);
    assert.ok(webm.includes("V_AV1"), `${v.av1} is not AV1`);
    // the poster: Discord drops the player without og:image
    const html = readFileSync(new URL(`src/pages/${page === "/" ? "index" : page.slice(1)}.html`, ROOT), "utf8");
    const img = html.match(/<meta property="og:image" content="https:\/\/aadhar\.sh(\/og\/[^"]+)">/)?.[1];
    assert.ok(img && existsSync(new URL(`public${img}`, ROOT)), `${page} has no og:image on disk to be the clip's poster`);
  }
});

const noRewriter = typeof HTMLRewriter === "undefined" && "needs bun's HTMLRewriter";

test("the rewrite makes the page a video and keeps it out of shared caches", { skip: noRewriter }, async () => {
  // As the minifier ships it: unquoted attributes, content first, and no
  // </head>. The first cut appended to <head> and passed a fixture that had
  // one, while the built page wrote nothing (2026-10-23).
  const page = new Response(
    "<html><head><meta content=website property=og:type><meta property=og:image content=https://aadhar.sh/og/x.jpg><body>hi</body></html>",
    {
      headers: { "content-type": "text/html; charset=utf-8", etag: '"abc"', "cache-control": "public, max-age=60", "cf-cache-status": "HIT", age: "12" },
    },
  );
  const v = ogVideoFor(PAGE, UA.discord);
  assert.ok(v);
  const res = withOgVideo(page, "https://preview.example", v);
  const html = await res.text();
  assert.match(html, /<meta content="?video\.other"? property=og:type>/);
  assert.ok(
    html.includes('<meta property="og:video" content="https://preview.example/og/video/garage-encoding.av1.webm">'),
    "the clip takes the request's origin",
  );
  assert.ok(html.includes('<meta property="og:video:type" content="video/webm">'));
  assert.ok(html.includes("og:image content=https://aadhar.sh/og/x.jpg"), "the poster is untouched");
  assert.equal(res.headers.get("cache-control"), "no-store");
  assert.equal(res.headers.get("vary"), "User-Agent");
  assert.equal(res.headers.get("etag"), null, "the asset's validator no longer names these bytes");
  assert.equal(res.headers.get("cf-cache-status"), null, "the asset fetch's HIT would claim this copy came from a cache");
  assert.equal(res.headers.get("age"), null);
});

test("parseRange reads the forms a player sends", () => {
  assert.deepEqual(parseRange("bytes=0-99", 1000), { start: 0, end: 99 });
  assert.deepEqual(parseRange("bytes=900-", 1000), { start: 900, end: 999 });
  assert.deepEqual(parseRange("bytes=-100", 1000), { start: 900, end: 999 });
  assert.deepEqual(parseRange("bytes=0-5000", 1000), { start: 0, end: 999 }, "an end past the body clamps");
  assert.equal(parseRange("bytes=1000-", 1000), "unsatisfiable");
  // no usable range means the whole body, never an error
  for (const h of [null, "", "bytes=0-1,5-9", "items=0-9", "bytes=-", "bytes=9-1"]) assert.equal(parseRange(h, 1000), null, String(h));
});

test("the clip route answers Range with 206 and the rest with 200", async () => {
  const body = new Uint8Array(1000).map((_, i) => i % 256);
  const assets = { fetch: async () => new Response(body, { headers: { etag: '"v1"' } }) };
  const url = "https://aadhar.sh/og/video/garage-encoding.hevc.mp4";
  const part = await serveOgVideo(new Request(url, { headers: { range: "bytes=10-19" } }), assets);
  assert.equal(part.status, 206);
  assert.equal(part.headers.get("content-range"), "bytes 10-19/1000");
  assert.equal(part.headers.get("content-type"), "video/mp4");
  assert.deepEqual([...new Uint8Array(await part.arrayBuffer())], [10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
  const whole = await serveOgVideo(new Request(url), assets);
  assert.equal(whole.status, 200);
  assert.equal(whole.headers.get("accept-ranges"), "bytes");
  assert.equal((await whole.arrayBuffer()).byteLength, 1000);
  assert.equal((await serveOgVideo(new Request(url, { headers: { range: "bytes=5000-" } }), assets)).status, 416);
  assert.equal((await serveOgVideo(new Request(url, { headers: { "if-none-match": '"v1"' } }), assets)).status, 304);
  assert.equal((await serveOgVideo(new Request(url.replace(".mp4", ".mov")), assets)).status, 404, "only the two clip types");
  assert.ok(claimedByWorker()("/og/video/garage-encoding.av1.webm"), "the asset layer would answer without Range");
  assert.ok(!claimedByWorker()("/og/garage-encoding.jpg"), "control: the still cards stay with the asset layer");
});

test("public/og/video holds the named clips and nothing else", () => {
  const named = new Set(Object.values(OG_VIDEOS).flatMap((v) => [v.hevc, v.av1].map((f) => f.replace("/og/video/", ""))));
  const onDisk = readdirSync(new URL("public/og/video/", ROOT));
  assert.deepEqual(
    onDisk.filter((f) => !named.has(f)),
    [],
    "a file nothing serves; bake.ts should leave only the clips",
  );
});

test("both page handlers ask for a clip before they take the static path", () => {
  const src = readFileSync(new URL("src/worker/index.ts", ROOT), "utf8");
  const body = (name: string) => {
    const at = src.indexOf(`async function ${name}(`);
    assert.ok(at > 0, `${name} is gone or no longer async`);
    return src.slice(at, src.indexOf("\n}\n", at));
  };
  for (const name of ["routeStaticPage", "routeHomepage"]) {
    const fn = body(name);
    const ask = fn.indexOf("ogVideoPage(");
    assert.ok(ask > 0, `${name} no longer checks for a clip`);
    assert.ok(ask < fn.indexOf("serveStaticPage("), `${name}: the check has to come before the static path`);
  }
});

test("Workers Cache lets a clip request by, and only that one", () => {
  const req = (ua: string) => new Request("https://aadhar.sh/", { headers: { "user-agent": ua } });
  assert.ok(CACHEABLE_PATHS.has("/"), "the homepage left the cache; this test can't see the bail any more");
  assert.equal(shouldUseWorkersCache(req(UA.discord), CACHEABLE_PATHS), false, "a cache hit would hand Discord the plain page");
  assert.equal(shouldUseWorkersCache(req(UA.iMessage), CACHEABLE_PATHS), false);
  // control: a person, and a bot that gets no clip, still take the cache
  assert.equal(shouldUseWorkersCache(req(UA.safari), CACHEABLE_PATHS), true);
  assert.equal(shouldUseWorkersCache(req(UA.slack), CACHEABLE_PATHS), true);
});

// The homepage's og:image is its clip's first frame, written by bake.ts. A
// full og-cards run used to capture every page dir, and would put the live
// homepage back over it without a word.
test("a card the clip bakes is one og-cards never captures", () => {
  const baked = OG_PAGE_DIRS.flatMap((p) => ("bakedBy" in p && typeof p.bakedBy === "string" ? [{ id: p.id, bakedBy: p.bakedBy }] : []));
  assert.ok(
    baked.some((p) => p.id === "home"),
    "the homepage card is no longer the clip's frame; update this test with the reason",
  );
  for (const p of baked) assert.ok(existsSync(new URL(p.bakedBy, ROOT)), `${p.id}: bakedBy names ${p.bakedBy}, which is gone`);
  const src = readFileSync(new URL("tools/photos/gen-og-cards.ts", ROOT), "utf8");
  const walk = src.slice(src.indexOf("for (const p of OG_PAGE_DIRS)"), src.indexOf("async function capture("));
  assert.ok(walk.includes('"bakedBy" in p') && walk.indexOf('"bakedBy" in p') < walk.indexOf("out.push("), "the page-dir walk captures baked cards again");
});
