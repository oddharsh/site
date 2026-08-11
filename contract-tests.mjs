#!/usr/bin/env node
// contract-tests.mjs — representation-boundary tests for the homepage Worker.
//
// These are deliberately dependency-free and deterministic. They test the
// public shape of the page/fragment and JSON/HTML handlers without starting a
// local Worker or making third-party network requests. verify-routes.mjs adds
// the same assertions against a deployed or local HTTP surface.

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import { brotliCompressSync, constants as zlibConstants } from "node:zlib";

import {
  lensDetectWebmcp,
  lensFieldEvidence,
  lensParseCloudflareAgentScore,
  handleLensBrowser,
  handleLensCompare,
  handleLensFetch,
  handleLensShot,
  renderLensShell,
  validateLensTarget,
} from "./holding/_worker.js/lens.js";
import { lensRecipe, lensRecipeIds, lensRecipeScript } from "./holding/_worker.js/lens-recipes.js";
import { handleCoffeeAvailability, readCoffeeAvailability } from "./holding/_worker.js/coffee.js";
import { reservationName } from "./cal/src/reservation.js";
import { handleSiteMcp, MCP_TOOLS as SITE_MCP_TOOLS, SITE_MCP_SERVER_INFO } from "./holding/_worker.js/mcp.js";
import { documentContent, handleWebmention, handleWebmentionDecision, linksTo } from "./holding/_worker.js/webmention.js";
import { handleInbox } from "./holding/_worker.js/inbox.js";
import { citationsIn, findEndpointIn, SELF_LINK_HOSTS } from "./holding/_worker.js/webmention-send.js";
import { sign } from "./cal/src/sign.js";
import { AGENT_SURFACES, WEBMENTION_PATHS } from "./holding/_worker.js/lib/site-manifest.js";
import { handleWritingIndex } from "./holding/_worker.js/writing.js";
import { handleTool, tokenizeKeys } from "./holding/_worker.js/terminal.js";
import { handleTerminal } from "./holding/_worker.js/wire.js";
import { DATA_TOOLS } from "./holding/_worker.js/lib/tools.js";
import { cronJob } from "./holding/_worker.js/lib/cron.js";
import { serveStaticPage } from "./holding/_worker.js/lib/assets.js";
import { serveMarkdown } from "./holding/_worker.js/home.js";
import { readManifest, workerModule, navFenceBody, readFenceBody } from "./scripts/gen-manifest.mjs";
import { INDEXED_SECTIONS, TWIN_FACTS, buildTwins, checkTwinFacts, htmlFileFor, twinPath } from "./scripts/gen-md-twins.mjs";
import { collectBlockClasses, readDocument } from "./scripts/lib/html-to-md.mjs";
import {
  MCP_TOOLS,
  SERENDIPITY_MCP_SERVER_INFO,
  SERENDIPITY_SYNC_LIMITS,
  cookieJar,
  parseCookies,
  staleGuestIds,
} from "./serendipity/serendipity.js";
import { MCP_SUPPORTED as MCP_SUPPORTED_VERSIONS } from "./holding/_worker.js/lib/mcp-protocol.js";
import { derivePhotoPool, renderPhotosPage, getImagesManifest, handlePhotoQuery, queryPhotos, _resetPhotoCaches } from "./holding/_worker.js/photos.js";
import { renderPhotoSlots } from "./holding/_worker.js/lib/photo-grid.js";
import { cachedRender, deadline } from "./holding/_worker.js/lib/cache.js";
import { ifNoneMatchMatches, notModifiedIfFresh, withWeakEtag } from "./holding/_worker.js/lib/cache.js";
import { fetchFollowingPublicRedirects, privateHostBlocked } from "./holding/_worker.js/lib/crawl.js";
import { handleHit } from "./holding/_worker.js/counter.js";
import { cronHomeProbe, parseServerTiming } from "./holding/_worker.js/perf-probe.js";
import { gatherWhoareyou } from "./holding/_worker.js/whoareyou.js";
import { handleSearchJson, searchSite } from "./holding/_worker.js/search.js";
import { getPublicAvailability } from "./cal/src/slots.js";
import { botHeaders } from "./holding/_worker.js/lib/botauth.js";
import { ml_dsa44 } from "@noble/post-quantum/ml-dsa.js";
import { mapWithConcurrency, readResponseCapped } from "./holding/_worker.js/lib/crawl.js";
import { diffAroundRows, handleAroundChangesJson, readAroundChanges } from "./holding/_worker.js/around.js";
import {
  ART_VERSION,
  WARM_MAX_URLS,
  artUrls,
  artWarmList,
  canonicalArtUrl,
  handleRnArt,
  handleRnTracks,
  handleRnTracksHtml,
  renderTrackListHtml,
  spotifyArtHash,
  warmArtCache,
} from "./holding/_worker.js/rn.js";

const PLAYLIST_ID = "4IRq9W1N2tOWHhH0O3vXiF";
const TRACKS = {
  playlist_id: PLAYLIST_ID,
  playlist_name: "rn",
  tracks: [{
    id: "track-1",
    title: "A <song>",
    artists_text: "An Artist",
    artists: [{
      id: "artist-1",
      name: "An Artist",
      spotify_url: "https://open.spotify.com/artist/artist-1",
      image_url: null,
    }],
    song_link_url: "https://song.link/s/track-1",
    duration_ms: 65000,
    image_url: null,
    is_explicit: false,
  }],
};

function context() {
  return { waitUntil() {} };
}

function fakeImages() {
  return {
    async info(bytes) { return { format: "jpeg", width: 100, height: 50, fileSize: bytes.byteLength, animated: false }; },
    input(bytes) {
      return {
        transform(options) { this.options = options; return this; },
        output(options) {
          return {
            async response() {
              const marker = new TextEncoder().encode(JSON.stringify({ input: bytes.byteLength, options: this.options || {}, output: options }));
              return new Response(marker, { headers: { "content-type": options.format } });
            },
          };
        },
      };
    },
  };
}

function representationD1() {
  const rows = [];
  return {
    prepare(sql) {
      return {
        bind(...args) {
          return {
            async run() {
              if (/INSERT OR REPLACE INTO http_representation_vault/i.test(sql)) {
                const [id, url, profile, observed_at, final_url, status, content_type, content_encoding, content_length, cache_control, vary, etag, last_modified, server, age, cf_cache_status, body_bytes, body_hash, truncated, title, word_count] = args;
                const row = { id, url, profile, observed_at, final_url, status, content_type, content_encoding, content_length, cache_control, vary, etag, last_modified, server, age, cf_cache_status, body_bytes, body_hash, truncated, title, word_count };
                const index = rows.findIndex((existing) => existing.id === id);
                if (index >= 0) rows[index] = row; else rows.push(row);
              }
              return { success: true, meta: { changes: 1 } };
            },
            async all() {
              if (/WHERE id = \?/i.test(sql)) return { results: rows.filter((row) => row.id === args[0]) };
              return { results: rows };
            },
          };
        },
        async run() { return { success: true, meta: { changes: 0 } }; },
      };
    },
    rows,
  };
}

// KV's get() takes the type either bare ("json") or inside an options object
// ({ type, cacheTtl }). Reads that pass cacheTtl use the second form, so a stub
// that only understands the first silently hands back a string where the caller
// expected a parsed object — which reads downstream as a cache miss, not as a
// broken fake. Normalize once, here.
function kvType(typeOrOptions) {
  if (typeOrOptions && typeof typeOrOptions === "object") return typeOrOptions.type || "text";
  return typeOrOptions || "text";
}

function kvForTracks() {
  return {
    async get(key, typeOrOptions) {
      const type = kvType(typeOrOptions);
      if (key === "playlist-id") return PLAYLIST_ID;
      if (key === `tracks:${PLAYLIST_ID}`) return type === "json" ? TRACKS : JSON.stringify(TRACKS);
      if (key === `tracks:${PLAYLIST_ID}:fresh`) return "1";
      return null;
    },
  };
}

function assertFullDocument(html) {
  assert.match(html, /^<!DOCTYPE html>/i);
  assert.match(html, /<html\b/i);
  assert.match(html, /<head\b/i);
  assert.match(html, /<body\b/i);
  assert.match(html, /<\/html>/i);
}

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

// ── Web Bot Auth: the post-quantum second label ──────────────────────
// sig2 is additive by design. These tests pin the two properties that make it
// safe to ship before the IANA registry has a codepoint: sig1 must survive
// untouched, and sig2 must verify against the key the directory publishes.

async function edEnv() {
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  jwk.kid = "test-ed";
  return { RN_SIGNING_KEY_JWK: JSON.stringify(jwk) };
}

function mldsaEnv(seed = crypto.getRandomValues(new Uint8Array(32))) {
  const { publicKey } = ml_dsa44.keygen(seed);
  return {
    publicKey,
    RN_SIGNING_KEY_MLDSA_JWK: JSON.stringify({
      kty: "AKP", alg: "ML-DSA-44", kid: "test-mldsa", use: "sig",
      priv: Buffer.from(seed).toString("base64url"),
    }),
  };
}

function labels(headers) {
  return (headers.get("signature-input").match(/(^|, )(sig\d+)=/g) || [])
    .map((m) => m.replace(/^, /, "").replace(/=$/, ""));
}

test("a missing ML-DSA key leaves the ed25519 signature alone", async () => {
  const headers = await botHeaders("https://example.com/", await edEnv());
  assert.deepEqual(labels(headers), ["sig1"]);
  assert.match(headers.get("signature-input"), /alg="ed25519"/);
});

test("a configured ML-DSA key adds sig2 without disturbing sig1", async () => {
  const env = { ...(await edEnv()), ...mldsaEnv() };
  const headers = await botHeaders("https://example.com/", env);
  assert.deepEqual(labels(headers), ["sig1", "sig2"]);

  const input = headers.get("signature-input");
  assert.match(input, /sig1=\("@authority" "signature-agent"\);created=\d+;keyid="test-ed";alg="ed25519";tag="web-bot-auth"/);
  assert.match(input, /sig2=\("@authority" "signature-agent"\);created=\d+;keyid="test-mldsa";alg="ml-dsa-44";tag="web-bot-auth"/);

  // one request, one instant: a verifier comparing the two labels must not see
  // a skew we invented between them.
  const created = [...input.matchAll(/created=(\d+)/g)].map((m) => m[1]);
  assert.equal(created.length, 2);
  assert.equal(created[0], created[1]);
});

test("sig2 verifies against the ML-DSA key the JWKS publishes", async () => {
  const pq = mldsaEnv();
  const headers = await botHeaders("https://example.com/robots.txt", { ...(await edEnv()), ...pq });

  const params = headers.get("signature-input").match(/sig2=(.+)$/)[1];
  const base = new TextEncoder().encode([
    `"@authority": example.com`,
    `"signature-agent": "https://aadhar.sh/"`,
    `"@signature-params": ${params}`,
  ].join("\n"));
  const sig = Uint8Array.from(atob(headers.get("signature").match(/sig2=:([^:]+):/)[1]), (c) => c.charCodeAt(0));

  assert.equal(sig.length, 2420);
  assert.equal(ml_dsa44.verify(sig, base, pq.publicKey), true);
  // and it must not verify a base it did not sign
  base[13] ^= 1;
  assert.equal(ml_dsa44.verify(sig, base, pq.publicKey), false);
});

test("the published key directory carries a usable ML-DSA-44 key", async () => {
  const dir = JSON.parse(await readFile(new URL("./holding/.well-known/http-message-signatures-directory", import.meta.url), "utf8"));
  const key = dir.keys.find((k) => k.kty === "AKP");
  assert.ok(key, "directory must publish the AKP key the bot signs sig2 with");
  assert.equal(key.alg, "ML-DSA-44");           // RFC 9964 names the algorithm here
  assert.equal(key.use, "sig");
  assert.equal(Buffer.from(key.pub, "base64url").length, 1312);
  assert.equal(key.priv, undefined, "a published key must never carry the seed");
  // the ed25519 key Cloudflare actually verifies has to survive the addition
  assert.ok(dir.keys.some((k) => k.kty === "OKP" && k.crv === "Ed25519"));
});

test("a malformed ML-DSA key fails loudly rather than silently dropping sig2", async () => {
  const ed = await edEnv();
  await assert.rejects(
    botHeaders("https://example.com/", { ...ed, RN_SIGNING_KEY_MLDSA_JWK: JSON.stringify({ kty: "OKP", alg: "EdDSA", priv: "x" }) }),
    /ML-DSA key is malformed/
  );
  await assert.rejects(
    botHeaders("https://example.com/", { ...ed, RN_SIGNING_KEY_MLDSA_JWK: JSON.stringify({ kty: "AKP", alg: "ML-DSA-44", priv: "AAAA" }) }),
    /ML-DSA seed is 3 bytes, expected 32/
  );
});

test("bounded response reads report truncation without buffering the tail", async () => {
  const capped = await readResponseCapped(new Response("abcdef"), 3);
  assert.equal(capped.text, "abc");
  assert.equal(capped.bytesRead, 3);
  assert.equal(capped.truncated, true);

  const exact = await readResponseCapped(new Response("abc"), 3);
  assert.equal(exact.text, "abc");
  assert.equal(exact.truncated, false);
});

test("scheduled crawl fan-out respects its concurrency cap", async () => {
  let active = 0;
  let peak = 0;
  const output = await mapWithConcurrency([1, 2, 3, 4, 5], 2, async (value) => {
    active++;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 1));
    active--;
    return value * 2;
  });
  assert.equal(peak, 2);
  assert.deepEqual(output, [2, 4, 6, 8, 10]);
});

test("Change Radar reports normalized field and bounded-content changes", () => {
  const changes = diffAroundRows(
    { status: 200, title: "New title", body_hash: "b", robots: "allow" },
    { status: 200, title: "Old title", body_hash: "a", robots: "allow" },
  );
  assert.deepEqual(changes, [
    { field: "title", before: "Old title", after: "New title" },
    { field: "content", detail: "bounded response sample changed" },
  ]);
});

test("Change Radar keeps the latest two observations per target", async () => {
  const db = {
    prepare() {
      return {
        async all() {
          return { results: [
            { target: "https://example.com/", name: "Example", observed_at: 2000, status: 503, title: null, body_hash: null, robots: "allow" },
            { target: "https://example.com/", name: "Example", observed_at: 1000, status: 200, title: "Example", body_hash: "a", robots: "allow" },
          ] };
        },
      };
    },
  };
  const payload = await readAroundChanges({ RESTORE_DB: db });
  assert.equal(payload.available, true);
  assert.equal(payload.changes.length, 1);
  assert.equal(payload.changes[0].changes[0].field, "status");
});

test("Change Radar remains a stable public JSON surface without D1", async () => {
  const response = await handleAroundChangesJson(
    new Request("https://aadhar.sh/around/changes.json"),
    {},
  );
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") || "", /^application\/json/);
  assert.equal((await response.json()).available, false);
});


test("Lens shell is a complete document, not a fragment", () => {
  const response = renderLensShell();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") || "", /^text\/html/);
  return response.text().then(assertFullDocument);
});

test("Lens shell states the past, present, and future argument before the instrument", async () => {
  const html = await renderLensShell().text();
  assert.match(html, /The semantic web asked publishers to mark meaning/);
  assert.match(html, /today&rsquo;s models scrape the human page/);
  assert.match(html, /the next web must decide how machines act/);
  assert.doesNotMatch(html, /6-minute tour|Demo path/);
});


test("track HTML renderer emits rows only", () => {
  const html = renderTrackListHtml(TRACKS);
  assert.match(html, /^<li\b/);
  assert.match(html, /np-title/);
  assert.match(html, /A &lt;song&gt;/);
  assert.doesNotMatch(html, /<(?:!doctype|html|head|body)\b/i);
});

test("Spotify art collapses onto one host, and only where it is safe to", () => {
  const hash = "ab67616d00001e026b458d1409d938dad4e3ba2c";
  // every alias lands on the canonical host, path untouched
  for (const host of ["image-cdn-fa", "image-cdn-ak", "image-cdn-zz9"]) {
    assert.equal(
      canonicalArtUrl(`https://${host}.spotifycdn.com/image/${hash}`),
      `https://i.scdn.co/image/${hash}`,
    );
  }
  // already canonical is a no-op, so applying it at both scrape and emit is safe
  assert.equal(canonicalArtUrl(`https://i.scdn.co/image/${hash}`), `https://i.scdn.co/image/${hash}`);
  // anything the rewrite was not proven safe for passes through UNCHANGED. a
  // wrong rewrite is a broken image; the untouched value is one that already works.
  for (const keep of [
    "https://mosaic.scdn.co/640/abc",                          // different scdn service
    "https://image-cdn-fa.spotifycdn.com/other/xyz",           // right host, not an /image/ path
    "https://evil.example.com/image/abc",                      // unrelated host
    "not-a-url",                                               // unparseable
    "",
    null,
    undefined,
  ]) assert.equal(canonicalArtUrl(keep), keep);
});

const ART_HASH_A = "ab67616d00001e026b458d1409d938dad4e3ba2c";

test("art URLs are derived from the hash, whatever alias it arrived under", () => {
  for (const host of ["i.scdn.co", "image-cdn-fa.spotifycdn.com", "image-cdn-ak.spotifycdn.com"]) {
    assert.equal(spotifyArtHash(`https://${host}/image/${ART_HASH_A}`), ART_HASH_A);
  }
  // null means "emit no browser image", so every unrecognized shape has to land
  // here rather than produce a /rn/art/ URL that would 404 or a CSP-blocked
  // third-party frame.
  for (const no of [
    "https://mosaic.scdn.co/640/abc",
    `https://evil.example.com/image/${ART_HASH_A}`,
    "https://i.scdn.co/image/NOTHEX",
    "https://i.scdn.co/image/ab67616d",            // too short
    `https://i.scdn.co/image/${ART_HASH_A}extra`,  // too long
    "not-a-url", "", null, undefined,
  ]) assert.equal(spotifyArtHash(no), null);

  const u = artUrls(`https://i.scdn.co/image/${ART_HASH_A}`);
  assert.equal(u.src, `/rn/art/${ART_HASH_A}-240-${ART_VERSION}.avif`);
  // The warm tier and browser tier are the SAME URL. Keeping a JPEG fallback
  // and 120w candidate beside it is what let repeated hover reconstruction turn
  // one cover into an unbounded list of image work in the 2026-08-11 HAR.
  assert.equal(u.warm, `/rn/art/${ART_HASH_A}-240-${ART_VERSION}.avif`);
  assert.equal(u.src, u.warm);
  assert.equal("srcset" in u, false);
  assert.equal(artUrls("https://mosaic.scdn.co/640/abc"), null);
});

// 40 lowercase hex, the shape ART_HASH demands, and injective in n so no two
// fixtures can collide and quietly weaken a dedupe or cap assertion.
const artHash = (n) => n.toString(16).padStart(40, "0");

test("the art warm list covers first, dedupes, and skips what cannot be re-hosted", () => {
  const payload = {
    tracks: [
      // Two tracks sharing one album cover, so the dedupe has something to do.
      { image_url: `https://i.scdn.co/image/${artHash(1)}`,
        artists: [{ image_url: `https://image-cdn-fa.spotifycdn.com/image/${artHash(3)}` }] },
      { image_url: `https://i.scdn.co/image/${artHash(1)}`,
        artists: [{ image_url: `https://i.scdn.co/image/${artHash(4)}` }] },
      { image_url: `https://i.scdn.co/image/${artHash(2)}`, artists: [] },
      // A collage cover and an artist with no picture: neither can be re-hosted,
      // so neither may appear. A /rn/art/ URL for these would 404 on hover.
      { image_url: "https://mosaic.scdn.co/640/abc", artists: [{ image_url: null }] },
    ],
  };
  const urls = artWarmList(payload, "https://aadhar.sh");

  assert.deepEqual(urls, [
    `https://aadhar.sh/rn/art/${artHash(1)}-240-${ART_VERSION}.avif`,
    `https://aadhar.sh/rn/art/${artHash(2)}-240-${ART_VERSION}.avif`,
    `https://aadhar.sh/rn/art/${artHash(3)}-240-${ART_VERSION}.avif`,
    `https://aadhar.sh/rn/art/${artHash(4)}-240-${ART_VERSION}.avif`,
  ]);
  // Covers ahead of artist pictures, because the cap truncates the tail and a
  // row is a far bigger hover target than the artist name inside it.
  assert.ok(urls.indexOf(`https://aadhar.sh/rn/art/${artHash(2)}-240-${ART_VERSION}.avif`)
          < urls.indexOf(`https://aadhar.sh/rn/art/${artHash(3)}-240-${ART_VERSION}.avif`));

  // Every warmed URL must be one handleRnArt will actually serve, or the warm
  // spends a subrequest and a transformation to cache a 404.
  for (const u of urls) {
    assert.match(new URL(u).pathname,
      /^\/rn\/art\/[0-9a-f]{40}-(120|240)-\d{1,4}\.(avif|jpg)$/);
  }

  assert.deepEqual(artWarmList({ tracks: [] }, "https://aadhar.sh"), []);
  assert.deepEqual(artWarmList(null, "https://aadhar.sh"), []);
});

test("the art warm is capped, so one long playlist cannot drain the subrequest budget", () => {
  const many = { tracks: Array.from({ length: 60 }, (_, i) => ({
    image_url: `https://i.scdn.co/image/${artHash(i)}`,
    artists: [{ image_url: `https://i.scdn.co/image/${artHash(i + 100)}` }],
  })) };
  const urls = artWarmList(many, "https://aadhar.sh");
  assert.equal(urls.length, WARM_MAX_URLS);
  // Workers allows 1000 subrequests per request and the warm rides in the
  // fragment's waitUntil, so the cap is headroom rather than a hard limit. It is
  // asserted anyway: an uncapped warm scales with a playlist anyone can lengthen.
  assert.ok(WARM_MAX_URLS <= 50);
});

// REGRESSION. The first version of the warm probed urls[0] and returned early on
// a cache hit, assuming the set is only ever warmed as a set. It is not: one
// HOVER warms one URL, /rn/art is immutable for a year, and the first track's
// cover is the likeliest thing to be hovered first. Measured in production
// 2026-08-10 on the shipped build — urls[0] was `hit`, and 11 of 13 artist
// images the warm should have covered were still cold.
//
// This drives the real handleRnArt against a fake cache and a fake upstream,
// because the bug lived in the interaction between the two, and a test of
// artWarmList alone could never have seen it.
test("the art warm attempts every URL even when one is already cached", async () => {
  const store = new Map();
  const realFetch = globalThis.fetch;
  const hadCaches = "caches" in globalThis;
  globalThis.caches = {
    default: {
      async match(req) { const r = store.get(req.url); return r ? r.clone() : undefined; },
      async put(req, res) { store.set(req.url, res); },
    },
  };
  globalThis.fetch = async () =>
    new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "content-type": "image/jpeg" } });

  try {
    const payload = { tracks: [
      { image_url: `https://i.scdn.co/image/${artHash(1)}`,
        artists: [{ image_url: `https://i.scdn.co/image/${artHash(2)}` }] },
      { image_url: `https://i.scdn.co/image/${artHash(3)}`, artists: [] },
    ] };
    const urls = artWarmList(payload, "https://aadhar.sh");
    assert.equal(urls.length, 3);

    // The exact production state: ONE url already warm because somebody hovered
    // it. The old guard read that as "the whole set is warm" and did nothing.
    store.set(urls[0], new Response(new Uint8Array([9]), { status: 200 }));

    const waits = [];
    const res = await warmArtCache(
      payload, new Request("https://aadhar.sh/rn/tracks.html"), {}, { waitUntil: (p) => waits.push(p) });
    await Promise.all(waits);

    assert.equal(res.already, 1, "the pre-warmed URL must report as already cached, not as work done");
    assert.equal(res.warmed, 2, "a warm colo entry must not stop the other URLs from being warmed");
    for (const u of urls) assert.ok(store.has(u), `${u} was never warmed`);
  } finally {
    globalThis.fetch = realFetch;
    if (!hadCaches) delete globalThis.caches;
  }
});

test("rendered track rows re-host recognized art and pass everything else through", () => {
  const html = renderTrackListHtml({
    tracks: [{
      title: "t", song_link_url: "https://song.link/x", duration_ms: 1000,
      image_url: `https://image-cdn-ak.spotifycdn.com/image/${ART_HASH_A}`,
      artists: [{ name: "a", spotify_url: "https://open.spotify.com/artist/1",
                  image_url: `https://image-cdn-fa.spotifycdn.com/image/${ART_HASH_A}` }],
    }],
  });
  assert.match(html, new RegExp(`data-track-image="/rn/art/${ART_HASH_A}-240-${ART_VERSION}\\.avif"`));
  assert.match(html, new RegExp(`data-artist-image="/rn/art/${ART_HASH_A}-240-${ART_VERSION}\\.avif"`));
  assert.doesNotMatch(html, /data-(?:track|artist)-imageset=|\/rn\/art\/[^" ]+\.jpg/,
    "each hover target must name the one warmed AVIF, not alternate browser resources");
  // the whole point: a hover no longer reaches Spotify at all
  assert.doesNotMatch(html, /scdn\.co|spotifycdn\.com/);

  // art with no parseable hash emits NO image attribute at all. It used to fall
  // back to the Spotify URL, which was right while img-src still allowed those
  // hosts; now that it does not, that URL would render as a frame the browser
  // refuses to load. The row falls through to the text card instead.
  const odd = renderTrackListHtml({
    tracks: [{ title: "t", song_link_url: "https://song.link/x",
               image_url: "https://mosaic.scdn.co/640/abc", artists: [] }],
  });
  assert.doesNotMatch(odd, /data-track-image/);
  assert.doesNotMatch(odd, /data-track-imageset/);
  assert.doesNotMatch(odd, /scdn\.co|spotifycdn\.com/);
  // the text card's inputs still have to survive, or "falls through to the text
  // card" is a claim about a card with nothing on it
  assert.match(odd, /data-track-title="t"/);
});

// (the CSP's img-src end of this bargain is asserted alongside the other
// directives in the RUM first-party test near the bottom of this file)

test("the art route 404s every shape that is not one it minted", async () => {
  // This grammar is the only thing between the route and an open image proxy,
  // so each rejection below is a way someone could otherwise aim it or burn the
  // monthly transformation allowance by hand.
  const bad = [
    `/rn/art/${ART_HASH_A}-999-${ART_VERSION}.avif`,   // width not in the tier set
    `/rn/art/${ART_HASH_A}-240-${ART_VERSION}.png`,    // format we do not mint
    `/rn/art/${ART_HASH_A}-240-${ART_VERSION}`,        // no extension
    `/rn/art/${ART_HASH_A.toUpperCase()}-240-1.avif`,  // uppercase hex
    "/rn/art/nothex-240-1.avif",
    `/rn/art/${ART_HASH_A}.avif`,
    "/rn/art/",
    `/rn/art/${ART_HASH_A}-240-1.avif/../../etc`,
  ];
  for (const p of bad) {
    const res = await handleRnArt(new Request(`https://aadhar.sh${p}`), {}, null);
    assert.equal(res.status, 404, `expected 404 for ${p}`);
    assert.equal(res.headers.get("cache-control"), "no-store", `a 404 for ${p} must not be cacheable`);
  }
});

test("track endpoints keep JSON and HTML contracts independent of Accept", async () => {
  const env = { RN_KV: kvForTracks() };
  const request = new Request("https://aadhar.sh/rn/tracks", {
    headers: { accept: "text/html" },
  });
  const json = await handleRnTracks(request, env, context());
  assert.equal(json.status, 200);
  assert.match(json.headers.get("content-type") || "", /^application\/json/);
  assert.equal(json.headers.get("vary"), null);
  assert.deepEqual(await json.json(), TRACKS);

  const html = await handleRnTracksHtml(
    new Request("https://aadhar.sh/rn/tracks.html", { headers: { accept: "application/json" } }),
    env,
    context(),
  );
  assert.equal(html.status, 200);
  assert.match(html.headers.get("content-type") || "", /^text\/html/);
  assert.equal(html.headers.get("vary"), null);
  const body = await html.text();
  assert.match(body, /^<li\b/);
  assert.doesNotMatch(body, /<(?:!doctype|html|head|body)\b/i);

  // Both representations say "read me, don't list me" with the header that can
  // actually say it. robots.txt used to try with `Disallow: /rn/tracks` while
  // four discovery surfaces pointed agents here, which blocked the fetch and so
  // blocked its own noindex.
  assert.equal(json.headers.get("x-robots-tag"), "noindex");
  assert.equal(html.headers.get("x-robots-tag"), "noindex");
});

test("Lens fetch keeps its JSON contract regardless of Accept", async () => {
  const json = await handleLensFetch(
    new Request("https://aadhar.sh/lens/fetch?url=javascript%3Aalert(1)", {
      headers: { accept: "text/html" },
    }),
    {},
    context(),
  );
  assert.equal(json.status, 400);
  assert.match(json.headers.get("content-type") || "", /^application\/json/);
  assert.equal(json.headers.get("vary"), null);
  assert.equal((await json.json()).ok, false);
});

test("Lens parses only Cloudflare's normalized readiness level from an MCP SSE answer", () => {
  const body = 'event: message\ndata: ' + JSON.stringify({
    jsonrpc: "2.0", id: "lens-cloudflare-score",
    result: { content: [{ type: "text", text: "## Result\n**Level 4/5 — Agent-Optimized**\n21 checks follow" }] },
  }) + "\n\n";
  assert.deepEqual(lensParseCloudflareAgentScore(body), {
    available: true,
    level: 4,
    score: 80,
    levelName: "Agent-Optimized",
    source: "Cloudflare Agent Readiness",
    sourceUrl: "https://isitagentready.com/",
  });
  assert.equal(lensParseCloudflareAgentScore("not a score"), null);
});

test("Lens field evidence scores observed access without borrowing the standards rubric", () => {
  const botViews = Array.from({ length: 6 }, (_, i) => ({ status: i === 5 ? 403 : 200, blocked: i === 5, challenge: false }));
  const field = lensFieldEvidence({
    status: 200,
    anatomy: { wordCount: 300 },
    agent: { strategy: { action: [], readable: ["markdown negotiation"], unknowns: [] } },
    botViews,
  });
  assert.deepEqual(field.components.map((component) => component.score), [100, 83, 100, 60]);
  assert.equal(field.overall, 86);

  const partial = lensFieldEvidence({ status: 200, anatomy: { wordCount: 300 }, agent: null, botViews: botViews.slice(0, 5) });
  assert.equal(partial.overall, null, "missing evidence must leave the score unfinished, not reweight it");
});

test("Lens proxies Cloudflare's public scanner but stores only the normalized score", async () => {
  const realFetch = globalThis.fetch;
  const writes = [];
  let upstream = null;
  try {
    globalThis.fetch = async (url, init) => {
      upstream = { url: String(url), body: JSON.parse(init.body) };
      return new Response('data: ' + JSON.stringify({
        jsonrpc: "2.0", id: "lens-cloudflare-score",
        result: { content: [{ type: "text", text: "**Level 5/5 -- Agent-Native**\nprivate report details" }] },
      }) + "\n\n", { status: 200, headers: { "content-type": "text/event-stream" } });
    };
    const response = await handleLensFetch(
      new Request("https://aadhar.sh/lens/fetch?mode=cloudflare&url=https%3A%2F%2Fexample.com"),
      { RN_KV: { get: async () => null, put: async (key, value, options) => writes.push({ key, value, options }) } },
      context(),
    );
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.score, 100);
    assert.equal(payload.level, 5);
    assert.equal(upstream.url, "https://isitagentready.com/mcp");
    assert.equal(upstream.body.params.arguments.url, "https://example.com/");
    assert.equal(writes.length, 1);
    assert.deepEqual(JSON.parse(writes[0].value), {
      available: true, level: 5, score: 100, levelName: "Agent-Native",
      source: "Cloudflare Agent Readiness", sourceUrl: "https://isitagentready.com/",
    });
    assert.doesNotMatch(writes[0].value, /private report details/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("the WebMCP detector sees a CDN bridge, not just hand-written call sites", () => {
  // The detector read the document for `navigator.modelContext` and friends, which
  // finds a site that wrote its own tools and MISSES the far larger population that
  // flipped WebMCP on at their CDN: the loader tag is all that reaches the HTML, and
  // every registerTool call lives in the external module. That population grows by
  // dashboard toggle, so the blind spot widens on its own.
  const bridge = lensDetectWebmcp('<script type="module" src="/.webmcp/bridge.js" data-packs="c2pa,mcp-server-client"></script>');
  assert.equal(bridge.found, true, "an injected bridge loader is WebMCP");
  assert.equal(bridge.kind, "bridge");

  // Both spellings of the page API. Chrome 146 ships `document.modelContext`; the
  // earlier drafts (and this site's own retired inline block) used `navigator`.
  for (const marker of ["document.modelContext.registerTool({})", "navigator.modelContext.registerTool({})"]) {
    const hit = lensDetectWebmcp(`<script>${marker}</script>`);
    assert.equal(hit.found, true, `${marker} must register as WebMCP`);
    assert.equal(hit.kind, "inline", "a page that calls the API itself is not a bridge");
  }

  // The claim has to stay falsifiable: a page merely TALKING about WebMCP is not a
  // page serving it. /garage and /lwe are full of prose about specs the site does
  // not implement, and this detector runs over arbitrary third-party HTML.
  assert.equal(lensDetectWebmcp("<p>WebMCP is a browser standard for model context.</p>").found, false);
  assert.equal(lensDetectWebmcp("").found, false);
});

test("Lens Browser Run endpoint validates targets before invoking the binding", async () => {
  let called = false;
  const response = await handleLensBrowser(
    new Request("https://aadhar.sh/lens/browser?url=javascript%3Aalert(1)", {
      headers: { accept: "text/html" },
    }),
    { BROWSER: { quickAction: async () => { called = true; } } },
    context(),
  );
  assert.equal(response.status, 400);
  assert.equal(called, false);
  assert.match(response.headers.get("content-type") || "", /^application\/json/);
  assert.equal((await response.json()).ok, false);
});

test("both browser routes report an upstream 429 as a 429, not a bad gateway", async () => {
  // Production, 2026-08-06: /lens/browser answered 502 with a body carrying
  // {"code":2001,"message":"Rate limit exceeded"}. /lens/shot had already been
  // taught that Browser Run refusing US is not the scanned site failing; the
  // sibling route had not, so the same bug shipped on half the surface. On the
  // free plan (one Quick Action per 10s account-wide) this is the single most
  // likely response either route will ever get, and a 502 sends whoever reads it
  // to go inspect a third-party site that is perfectly healthy.
  const env = { BROWSER: { quickAction: async () => new Response('{"errors":[{"code":2001}]}', { status: 429 }) } };
  const url = "?url=https%3A%2F%2Fexample.com%2F";

  for (const [name, handler] of [["shot", handleLensShot], ["browser", handleLensBrowser]]) {
    const response = await handler(new Request(`https://aadhar.sh/lens/${name}${url}`), env, context());
    assert.equal(response.status, 429, `/lens/${name} must pass the upstream 429 through as a 429`);
    const body = await response.json();
    assert.equal(body.ok, false);
    // The message has to name OUR budget, since that is the thing the reader can
    // act on. Naming the target would be the same lie the 502 told.
    assert.match(body.error, /rate-limited|budget/i, `/lens/${name} must say whose limit was hit`);
  }
});

test("Lens Browser Run endpoint normalizes a snapshot into the comparison contract", async () => {
  let action;
  let payload;
  const response = await handleLensBrowser(
    new Request("https://aadhar.sh/lens/browser?url=https%3A%2F%2Fexample.com%2F"),
    {
      BROWSER: {
        async quickAction(name, input) {
          action = name;
          payload = input;
          return Response.json({
            result: {
              content: "<html><title>Rendered</title><body><p>hello</p></body></html>",
              markdown: "# hello",
              accessibilityTree: { role: "RootWebArea", children: [] },
              screenshot: "AAAA",
            },
            meta: { status: 200, title: "Rendered", url: "https://example.com/" },
          });
        },
      },
    },
    context(),
  );
  assert.equal(response.status, 200);
  assert.equal(action, "snapshot");
  assert.deepEqual(payload.formats, ["content", "screenshot", "markdown", "accessibilityTree"]);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.title, "Rendered");
  assert.equal(body.finalUrl, "https://example.com/");
  assert.equal(body.screenshot, "data:image/png;base64,AAAA");
  assert.equal(body.webmcp.status, "lab-required");
  assert.doesNotMatch(body.content, /__lens_webmcp_runtime__/);
});

test("Lens screenshot endpoint delegates PNG rendering to the Browser Run binding", async () => {
  let action;
  const png = new Uint8Array([137, 80, 78, 71]);
  const response = await handleLensShot(
    new Request("https://aadhar.sh/lens/shot?url=https%3A%2F%2Fexample.com%2F"),
    {
      BROWSER: {
        async quickAction(name) {
          action = name;
          return new Response(png, { headers: { "content-type": "image/png" } });
        },
      },
    },
    context(),
  );
  assert.equal(response.status, 200);
  assert.equal(action, "screenshot");
  assert.equal(response.headers.get("content-type"), "image/png");
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), png);
});

test("neither browser route waits on a condition a live site never reaches", async () => {
  // `networkidle0` demands ZERO in-flight connections for 500ms, which any page
  // carrying analytics, ads, a websocket or a poll never reaches. The wait then
  // burns the whole timeout and Cloudflare discards a render it already had
  // (`422 / code 6002`). Both routes shipped it until 2026-08-07; measured
  // against production, theverge.com failed on BOTH at ~18.8s while the static
  // example.com passed, so the failure tracked the TARGET and read as flaky.
  //
  // This is pinned rather than left to review because the cost is invisible at
  // the call site: the setting is one word in a payload, the failure looks like
  // the scanned site being slow, and each timeout also spends 18s of a browser
  // budget that is 10 MINUTES PER DAY account-wide on the free plan.
  const captured = {};
  const env = {
    BROWSER: {
      async quickAction(name, input) {
        captured[name] = input;
        if (name === "screenshot") return new Response(new Uint8Array([137, 80, 78, 71]), { headers: { "content-type": "image/png" } });
        return Response.json({ result: { content: "<html></html>" }, meta: { status: 200 } });
      },
    },
  };
  const url = "?url=https%3A%2F%2Fexample.com%2F";
  await handleLensShot(new Request(`https://aadhar.sh/lens/shot${url}`), env, context());
  await handleLensBrowser(new Request(`https://aadhar.sh/lens/browser${url}`), env, context());

  assert.deepEqual(Object.keys(captured).sort(), ["screenshot", "snapshot"], "both routes must have reached the binding");
  for (const [action, payload] of Object.entries(captured)) {
    assert.notEqual(payload.gotoOptions.waitUntil, "networkidle0", `${action} must not wait for total network silence`);
    assert.equal(payload.gotoOptions.waitUntil, "networkidle2", `${action} must wait for the page to settle, not go silent`);
    assert.ok(payload.gotoOptions.timeout > 0, `${action} must keep a bounded timeout`);
  }
  // One object, so a later edit cannot fix one route and leave the other.
  assert.equal(captured.screenshot.gotoOptions, captured.snapshot.gotoOptions, "both routes must share one goto config");
});

// ── /lens/browser?do=<recipe> — interaction recipes ────────────────────────
// The feature runs JavaScript inside somebody else's page. Almost every test
// below is about the blast radius of that rather than the feature working.

const recipeEnv = (content, capture) => ({
  BROWSER: {
    async quickAction(name, input) {
      if (capture) capture[name] = input;
      return Response.json({ result: { content }, meta: { status: 200 } });
    },
  },
});
const browserReq = (query) => new Request("https://aadhar.sh/lens/browser?url=https%3A%2F%2Fexample.com%2F" + query);

test("a plain browser run is byte-for-byte what it was before recipes existed", async () => {
  const captured = {};
  const response = await handleLensBrowser(browserReq(""), recipeEnv("<html><body>hi</body></html>", captured), context());
  const body = await response.json();
  // The whole backwards-compatibility claim in one place: no injection is sent,
  // and no consumer of this route sees a new key appear.
  assert.equal(captured.snapshot.addScriptTag, undefined, "a plain run must inject nothing");
  assert.equal(captured.snapshot.waitForTimeout, undefined);
  assert.equal("interaction" in body, false, "the field is absent, not null, on a plain run");
  assert.equal(body.ok, true);
});

test("an unknown recipe is refused rather than quietly served as a plain render", async () => {
  // Falling through to the plain render would hand back a perfectly good
  // snapshot the caller believes is post-interaction. That is the exact failure
  // this feature exists to avoid, so a typo has to be loud.
  for (const bad of ["", "   ", "../", "expand;", "<script>", "EXPAND", " expand", "x".repeat(10000)]) {
    let called = false;
    const env = { BROWSER: { quickAction: async () => { called = true; return Response.json({}); } } };
    const response = await handleLensBrowser(browserReq("&do=" + encodeURIComponent(bad)), env, context());
    assert.equal(response.status, 400, `"${bad.slice(0, 20)}" must 400`);
    assert.equal(called, false, `"${bad.slice(0, 20)}" must never reach the binding`);
    const body = await response.json();
    assert.deepEqual(body.recipes, lensRecipeIds(), "a refusal names the ids that would work");
  }
});

test("no caller byte reaches the injected script, and none ever will", async () => {
  // THE test. `addScriptTag` runs arbitrary JS in a third-party page, so a `js=`
  // or `selector=` parameter would make /lens an open remote-code-execution
  // proxy running attacker code from Cloudflare IPs under this account's browser
  // identity. The allowlist is the only thing standing there.
  for (const id of lensRecipeIds()) {
    const captured = {};
    // Every hostile shape a caller controls, all at once: extra query params the
    // handler must ignore, and payload-ish text inside the url itself.
    await handleLensBrowser(
      new Request("https://aadhar.sh/lens/browser?url=" + encodeURIComponent("https://example.com/?evil=</script><script>alert(1)</script>") +
        "&do=" + id + "&js=alert(9)&selector=body&script=pwn"),
      recipeEnv("<html></html>", captured),
      context(),
    );
    const sent = captured.snapshot.addScriptTag;
    assert.equal(sent.length, 1, `${id} must inject exactly one tag`);
    const nonce = (sent[0].content.match(/\}\)\("([0-9a-f]{16})"\);$/) || [])[1];
    assert.ok(nonce, `${id} must carry a server-generated 16-hex nonce`);
    // As an IIFE argument, never a top-level `var`. A `var` lands on `window`,
    // where any timer on the page reads it and forges a receipt that passes the
    // nonce check. Verified in Chromium 2026-08-08 before this was tightened.
    assert.equal(/^\s*var\s/.test(sent[0].content), false, `${id} must not leak the nonce to window`);
    assert.equal(sent[0].content, lensRecipeScript(lensRecipe(id), nonce), `${id} must be the registry script verbatim`);

    // Nothing the caller typed may appear anywhere in the payload except in url.
    const rest = JSON.stringify({ ...captured.snapshot, url: "" });
    for (const smuggled of ["alert(9)", "selector", "pwn", "evil"]) {
      assert.equal(rest.includes(smuggled), false, `${id} leaked "${smuggled}" into the payload`);
    }
  }
});

test("two runs of one recipe never share a nonce", async () => {
  // A fixed nonce would be discoverable by rendering the page once, which is
  // exactly what the attacker here is already able to do.
  const seen = new Set();
  for (let i = 0; i < 5; i++) {
    const captured = {};
    await handleLensBrowser(browserReq("&do=expand"), recipeEnv("<html></html>", captured), context());
    seen.add(captured.snapshot.addScriptTag[0].content.match(/\}\)\("([0-9a-f]{16})"\);$/)[1]);
  }
  assert.equal(seen.size, 5, "each run must mint a fresh nonce");
});

test("the recipe registry stays inside what it is allowed to do", async () => {
  const { LENS_RECIPES } = await import("./holding/_worker.js/lens-recipes.js");
  const ids = new Set();
  for (const r of LENS_RECIPES) {
    assert.match(r.id, /^[a-z][a-z0-9-]{1,15}$/, `${r.id} is not a safe id`);
    assert.equal(ids.has(r.id), false, `${r.id} is declared twice`);
    ids.add(r.id);
    assert.ok(r.label && r.claim, `${r.id} must say what it does before it does it`);
    // A recipe is a DOM edit, never a network actor. Any of these would turn an
    // observation into an action taken on somebody else's behalf.
    for (const banned of ["fetch(", "XMLHttpRequest", "import(", "eval(", "new Function", "document.cookie",
      "localStorage", "sessionStorage", "sendBeacon", "location=", "location =", ".submit(", "postMessage"]) {
      assert.equal(r.script.includes(banned), false, `${r.id} must not contain ${banned}`);
    }
    // Parses as a program. A syntax error would surface as a page that silently
    // never interacts, which reads identically to a CSP refusal.
    new Function(r.script);
  }
});

test("no shipping recipe presses a control on somebody else's page", async () => {
  const { LENS_RECIPES } = await import("./holding/_worker.js/lens-recipes.js");
  // Removing a consent overlay from our own copy of the DOM sets no cookie and
  // records no choice. Clicking "Accept all" from a Cloudflare IP would be this
  // site manufacturing a consent record on a third party's page, which is the
  // machine behaviour /lens was built to criticise. The distinction is the whole
  // ethical argument for shipping `consent` at all, so it is pinned here rather
  // than left to a reviewer noticing a `.click()` in a minified string.
  for (const r of LENS_RECIPES) {
    assert.equal(r.script.includes(".click("), false, `${r.id} must not click`);
    assert.equal(/\.(submit|requestSubmit)\(/.test(r.script), false, `${r.id} must not submit`);
  }
});

test("the published scripts are the scripts that run", async () => {
  const { LENS_RECIPES } = await import("./holding/_worker.js/lens-recipes.js");
  const response = await handleLensBrowser(new Request("https://aadhar.sh/lens/browser?recipes=1"), {}, context());
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.deepEqual(body.recipes.map((r) => r.id), LENS_RECIPES.map((r) => r.id));
  for (const published of body.recipes) {
    // Disclosure that can drift from execution is worse than no disclosure.
    assert.equal(published.script, LENS_RECIPES.find((r) => r.id === published.id).script);
  }
});

test("the receipt is read, then removed before anything counts or caps it", async () => {
  const nonceOf = (captured) => captured.snapshot.addScriptTag[0].content.match(/"([0-9a-f]{16})"/)[1];
  const captured = {};
  const env = {
    BROWSER: {
      async quickAction(name, input) {
        captured[name] = input;
        const n = input.addScriptTag[0].content.match(/"([0-9a-f]{16})"/)[1];
        // 500 words of padding inside the receipt: if the strip happens after
        // documentShape, they land in the word count and the delta lies.
        return Response.json({
          result: { content: `<html><body><p>one two three</p><script type="application/lens-receipt" id="lens-recipe-receipt">{"v":1,"n":"${n}","acted":4,"scanned":9,"note":"acted","pad":"${"word ".repeat(500)}"}</script></body></html>` },
          meta: { status: 200 },
        });
      },
    },
  };
  const body = await (await handleLensBrowser(browserReq("&do=expand"), env, context())).json();
  assert.equal(nonceOf(captured).length, 16);
  assert.equal(body.interaction.ran, true);
  assert.equal(body.interaction.acted, 4);
  assert.equal(body.interaction.scanned, 9);
  assert.equal(body.content.includes("lens-recipe-receipt"), false, "the receipt must not reach the reader's content");
  assert.equal(body.shape.words, 3, "the receipt must be gone before the words are counted");
});

test("a page cannot forge a result for a script it was not given", async () => {
  // Without the nonce a hostile page ships its own receipt claiming Lens tore
  // down a wall it never touched, and /lens repeats the lie in its own voice.
  const body = await (await handleLensBrowser(
    browserReq("&do=consent"),
    recipeEnv('<html><body><script type="application/lens-receipt" id="lens-recipe-receipt">{"v":1,"n":"deadbeefdeadbeef","acted":9999,"scanned":9999,"note":"acted"}</script></body></html>'),
    context(),
  )).json();
  assert.equal(body.interaction.ran, false);
  assert.equal(body.interaction.note, "forged-receipt");
  assert.equal(body.interaction.acted, 0, "a forged count must never be repeated as ours");
  assert.equal(body.content.includes("lens-recipe-receipt"), false, "and it still must not reach the reader");
});

test("nonsense counts in a receipt are clamped rather than believed", async () => {
  const { lensRecipeReceipt } = await import("./holding/_worker.js/lens-recipes.js");
  const wrap = (json) => `<script type="application/lens-receipt" id="lens-recipe-receipt">${json}</script>`;
  const read = (json) => lensRecipeReceipt(wrap(json), "n").receipt;
  assert.equal(read('{"n":"n","acted":"12","scanned":0,"note":"acted"}').acted, 0, "a string is not a count");
  assert.equal(read('{"n":"n","acted":1e9,"scanned":0,"note":"acted"}').acted, 100000, "clamped, not believed");
  assert.equal(read('{"n":"n","acted":-5,"scanned":0,"note":"acted"}').acted, 0);
  assert.equal(read('{"n":"n","acted":1,"scanned":0,"note":"whatever"}').note, "unknown", "an unknown note is not echoed");
  assert.equal(lensRecipeReceipt("<p>no receipt here</p>", "n").receipt, null);
  assert.equal(lensRecipeReceipt(wrap("{not json"), "n").receipt, null);
});

test("a recipe that finds nothing, or never runs, is a 200 and says which", async () => {
  // Both are successful observations. Reporting either as an error would teach
  // the reader to distrust the instrument on the pages where it is most useful.
  const nothing = await handleLensBrowser(
    browserReq("&do=expand"),
    recipeEnv('<html><body><script type="application/lens-receipt" id="lens-recipe-receipt">{"v":1,"n":"REPLACED","acted":0,"scanned":12,"note":"none-found"}</script></body></html>'),
    context(),
  );
  assert.equal(nothing.status, 200);
  // The nonce will not match, so this lands as forged; what matters here is the
  // status and that a body came back. The no-receipt path is the real case:
  const blind = await handleLensBrowser(browserReq("&do=expand"), recipeEnv("<html><body><p>a b c</p></body></html>"), context());
  const body = await blind.json();
  assert.equal(blind.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.interaction.ran, false);
  assert.equal(body.interaction.note, "no-receipt", "a CSP-refused injection is reported, not hidden");
  assert.equal(body.shape.words, 3, "and the snapshot itself is still returned in full");
});

test("a recipe run caches beside the plain snapshot, never on top of it", async () => {
  // The plain key keeps its exact legacy shape. Changing its format would
  // invalidate the whole namespace in one deploy and buy a wave of fresh Quick
  // Actions against a budget of ten browser-minutes a day.
  const writes = [];
  const kv = {
    get: async () => null,
    put: async (k, _v, o) => { writes.push([k, o]); },
  };
  const env = { ...recipeEnv("<html></html>"), RN_KV: kv };
  await handleLensBrowser(browserReq(""), env, context());
  await handleLensBrowser(browserReq("&do=expand"), env, context());
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(writes.length, 2);
  assert.match(writes[0][0], /^lens:browser:[0-9a-f]{64}$/, "the plain key shape is load-bearing");
  assert.equal(writes[1][0], writes[0][0] + ":expand", "a recipe appends, so the plain entry survives as the before");
  assert.equal(writes[0][1].expirationTtl, 900);
  assert.equal(writes[1][1].expirationTtl, 900);
});

test("the before comes from the cached plain snapshot, and is never manufactured", async () => {
  // Rendering a before on demand would be two Quick Actions for one click.
  let quickActions = 0;
  const plain = { ok: true, shape: { words: 210, headings: 2, links: 14, images: 3, jsonld: 0 } };
  const env = {
    BROWSER: { async quickAction() { quickActions++; return Response.json({ result: { content: "<html><body>a b c</body></html>" }, meta: {} }); } },
    RN_KV: { get: async (k) => (k.endsWith(":expand") ? null : plain), put: async () => {} },
  };
  const body = await (await handleLensBrowser(browserReq("&do=expand"), env, context())).json();
  assert.equal(quickActions, 1, "one click must cost exactly one render");
  assert.deepEqual(body.interaction.before, plain.shape);
  assert.equal(body.interaction.beforeSource, "kv");

  // And with no plain entry, no delta is claimed rather than a zero invented.
  const bare = { ...env, RN_KV: { get: async () => null, put: async () => {} } };
  const alone = await (await handleLensBrowser(browserReq("&do=expand"), bare, context())).json();
  assert.equal(alone.interaction.before, null);
  assert.equal(alone.interaction.beforeSource, "none");
});

test("a recipe run bills against the same two buckets as a plain one", async () => {
  // A third bucket would let one visitor stack 3 plain + 3 recipe renders a
  // minute while the shared ceiling is 4, so the per-IP limit would stop
  // bounding anything. This repo has already made that mistake once.
  for (const spent of ["LENS_RL_BROWSER", "LENS_RL_BROWSER_ALL"]) {
    let called = false;
    const env = {
      BROWSER: { quickAction: async () => { called = true; return Response.json({}); } },
      [spent]: { limit: async () => ({ success: false }) },
    };
    const response = await handleLensBrowser(browserReq("&do=expand"), env, context());
    assert.equal(response.status, 429, `${spent} must bound the recipe path too`);
    assert.equal(called, false, `${spent} must short-circuit before the render`);
  }
});

function staticAssets(files) {
  return {
    async fetch(input) {
      const path = new URL(input).pathname;
      if (!(path in files)) return new Response("not found", { status: 404 });
      return Response.json(files[path]);
    },
  };
}

test("site search and JSON contract share the generated corpus", async () => {
  const env = { ASSETS: staticAssets({
    "/search-index.json": { records: [{ url: "/writing/agents", title: "Agents", description: "Notes on agents", text: "Cloudflare agents and tools", kind: "writing" }] },
  }) };
  const result = await searchSite(env, "cloudflare", 5);
  assert.equal(result.total, 1);
  assert.equal(result.results[0].url, "/writing/agents");
  const response = await handleSearchJson(new Request("https://aadhar.sh/search.json?q=cloudflare"), env);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).returned, 1);
  assert.equal((await handleSearchJson(new Request("https://aadhar.sh/search.json"), env)).status, 400);
});

test("photo query filters public metadata and never exposes unlisted fields", async () => {
  const env = { ASSETS: staticAssets({
    "/images/metadata.json": { A: { camera: "X-T50", lens: "XF18mm", film: "Classic Chrome", date: "2026:01:02", gps: "secret" }, B: { camera: "Leica", film: "Monochrome", date: "2025:01:02" } },
    "/images/alt.json": { A: "a blue car", B: "a lamp" },
    "/images/hashes.json": { A: { a: "aaaa", j: "bbbb", s: "cccc" }, B: { a: "dddd", j: "eeee", s: "ffff" } },
  }) };
  const result = await queryPhotos(env, { camera: "x-t50", film: "chrome", limit: 10 });
  assert.equal(result.total, 1);
  assert.equal(result.photos[0].stem, "A");
  assert.equal(result.photos[0].thumb.small, "/i/A-400.cccc.avif");
  assert.equal("gps" in result.photos[0].metadata, false);
  const response = await handlePhotoQuery(new Request("https://aadhar.sh/photos/query.json?q=car"), env, context());
  assert.equal(response.status, 200);
});

// The archive the ranking tests run against. B exists to be a plausible WRONG
// answer for "classic chrome": it carries both words in its caption without
// being a Classic Chrome frame, which is exactly the confusion a joined
// haystack cannot resolve and a field weighting can.
function rankingEnv() {
  _resetPhotoCaches();
  return { ASSETS: staticAssets({
    "/images/metadata.json": {
      A: { camera: "X-T50", lens: "XF27mm", film: "Classic Chrome", date: "2026:01:02" },
      B: { camera: "Leica Q3", lens: "Summilux", film: "Monochrome", date: "2025:01:02" },
      C: { camera: "X-T50", lens: "XF18mm", film: "Classic Chrome", date: "2024:05:05" },
    },
    "/images/alt.json": {
      A: "a bridge over a river",
      B: "a chrome bumper on a classic car",
      C: "a lamp on a desk",
    },
    "/images/hashes.json": {},
  }) };
}

test("photo query scores each term independently instead of matching one substring", async () => {
  // The regression this whole path exists for. The old haystack joined five
  // fields and required `q` to appear inside the result CONTIGUOUSLY, so a
  // query naming a film simulation and a subject could never match a photo that
  // had both — the words were present but not adjacent.
  const result = await queryPhotos(rankingEnv(), { q: "classic chrome bridge" });
  assert.equal(result.ranking.mode, "all-terms");
  assert.deepEqual(result.ranking.terms, ["classic", "chrome", "bridge"]);
  assert.equal(result.total, 1);
  assert.equal(result.photos[0].stem, "A");
  // Scored on the film simulation AND the caption, which is the claim.
  assert.deepEqual(result.photos[0].matched.slice().sort(), ["alt", "film"]);
});

test("photo ranking prefers the film simulation over the same words in a caption", async () => {
  const result = await queryPhotos(rankingEnv(), { q: "classic chrome" });
  assert.equal(result.total, 3, "all three mention both words somewhere");
  // A and C are genuine Classic Chrome frames and outrank B, whose caption
  // merely contains the words. A leads C on date, both leading B on score.
  assert.deepEqual(result.photos.map((photo) => photo.stem), ["A", "C", "B"]);
  assert.ok(result.photos[0].score > result.photos[2].score);
  assert.deepEqual(result.photos[2].matched, ["alt"]);
});

test("photo query reports partial coverage rather than silently widening", async () => {
  // "sunset" is in no field, so nothing covers both terms. The partial set is
  // still the best available answer and comes back labelled as partial.
  const result = await queryPhotos(rankingEnv(), { q: "monochrome sunset" });
  assert.equal(result.ranking.mode, "partial");
  assert.equal(result.photos[0].stem, "B");
  assert.equal(result.photos[0].matched.includes("film"), true);
  // Nothing matched at all is a different answer from partially matched, and a
  // caller deciding whether to broaden its query needs the two kept apart.
  const none = await queryPhotos(rankingEnv(), { q: "aurora borealis" });
  assert.equal(none.ranking.mode, "no-match");
  assert.equal(none.total, 0);
});

test("word boundaries keep chrome out of monochrome", async () => {
  // A plain substring test passes every other assertion in this file and still
  // scores every black-and-white frame as a Classic Chrome match, at the FILM
  // weight — the highest there is — so the false hits outrank the true ones.
  const result = await queryPhotos(rankingEnv(), { q: "chrome" });
  assert.deepEqual(result.photos.map((photo) => photo.stem), ["A", "C", "B"]);
  assert.equal(result.photos.find((photo) => photo.stem === "B").matched.includes("film"), false,
    "B is a Monochrome frame and must not match on film");
  // The digit-gated substring escape stays open for part numbers, which live
  // inside a larger alphanumeric run with no boundary to match on.
  const lens = await queryPhotos(rankingEnv(), { q: "27mm" });
  assert.equal(lens.total, 1);
  assert.equal(lens.photos[0].stem, "A");
});

test("photo query drops stopwords and says which it dropped", async () => {
  const result = await queryPhotos(rankingEnv(), { q: "show me photos of a bridge" });
  assert.deepEqual(result.ranking.terms, ["bridge"]);
  assert.ok(result.ranking.dropped.includes("photos"));
  assert.equal(result.total, 1);
  assert.equal(result.photos[0].stem, "A");
  // A query that is nothing BUT stopwords must not score every photo on noise.
  const empty = await queryPhotos(rankingEnv(), { q: "show me some photos" });
  assert.equal(empty.ranking.mode, "no-terms");
  assert.equal(empty.total, 0);
});

test("photo query omits score entirely when nothing was ranked", async () => {
  // Absent, not zero — the same rule lens follows for a phase it never ran.
  const result = await queryPhotos(rankingEnv(), { film: "classic" });
  assert.equal(result.ranking.mode, "filters-only");
  assert.equal(result.total, 2);
  assert.equal("score" in result.photos[0], false);
  assert.equal("matched" in result.photos[0], false);
  // Filters stay exact even while `q` is ranked, so a filter cannot be widened
  // into a near miss.
  assert.deepEqual(result.photos.map((photo) => photo.stem), ["A", "C"]);
});

test("a term that matches most of the corpus in a field stops counting there", async () => {
  // The live failure: every Fuji recipe card carries "Exposure Compensation",
  // so "long exposure" matched "exposure" in 151 of 158 cards and returned the
  // entire archive ranked by a word that distinguished nothing. Nothing in the
  // archive is a long exposure, so the only correct total is zero.
  _resetPhotoCaches();
  const metadata = {};
  const alt = {};
  for (let i = 0; i < 8; i += 1) {
    metadata[`P${i}`] = {
      camera: "X-T50", film: i < 4 ? "Classic Chrome" : "Nostalgic Neg",
      date: `2026:01:0${i + 1}`,
      recipe: { "Exposure Compensation": "0", "Color Chrome Effect": "Strong" },
    };
    alt[`P${i}`] = "a street";
  }
  const env = { ASSETS: staticAssets({
    "/images/metadata.json": metadata, "/images/alt.json": alt, "/images/hashes.json": {},
  }) };
  const flood = await queryPhotos(env, { q: "long exposure" });
  assert.equal(flood.total, 0, "a universal recipe word must not drag in the archive");
  assert.equal(flood.ranking.mode, "no-match");
  assert.deepEqual(flood.ranking.common, ["exposure"]);

  // Suppression is per FIELD, not per term. "chrome" is in all 8 recipe cards
  // AND is the film simulation of 4 of them; killing the term outright would
  // blind the query to exactly the photos it describes best.
  _resetPhotoCaches();
  const film = await queryPhotos(env, { q: "classic chrome" });
  assert.equal(film.total, 4);
  assert.deepEqual(film.photos[0].matched, ["film"]);
  assert.equal("common" in film.ranking, false);

  // A term nothing has is ABSENT, not common, and the two must not be conflated
  // — one says broaden your query, the other says this word is useless here.
  _resetPhotoCaches();
  const missing = await queryPhotos(env, { q: "aurora" });
  assert.equal(missing.ranking.mode, "no-match");
  assert.equal("common" in missing.ranking, false);
});

test("photo query reports whether the offline semantic tier is present", async () => {
  const bare = await queryPhotos(rankingEnv(), { q: "bridge" });
  assert.equal(bare.ranking.semantic, false, "no semantics.json shipped");
  _resetPhotoCaches();
  const env = { ASSETS: staticAssets({
    "/images/metadata.json": { A: { camera: "X-T50", film: "Classic Chrome", date: "2026:01:02" } },
    "/images/alt.json": { A: "a bridge over a river" },
    "/images/hashes.json": {},
    "/images/semantics.json": { A: { terms: "span crossing viaduct overpass" } },
  }) };
  const expanded = await queryPhotos(env, { q: "viaduct" });
  assert.equal(expanded.ranking.semantic, true);
  assert.equal(expanded.total, 1, "matched a word that appears in no caption or EXIF field");
  assert.deepEqual(expanded.photos[0].matched, ["expansion"]);
});

function coffeeEnv() {
  const snapshot = { busy: [], ts: Date.now() };
  return {
    HOST_TIMEZONE: "America/New_York", WORKING_HOURS_START: "9", WORKING_HOURS_END: "18",
    WORKING_DAYS: "1,2,3,4,5", SLOT_MINUTES: "30", BUFFER_MINUTES: "15",
    MIN_NOTICE_HOURS: "0", MAX_LOOKAHEAD_DAYS: "2", DAILY_LIMIT: "3", WEEKLY_LIMIT: "5",
    // listHeld pages KV with list({ prefix: "held:" }), one key per held slot.
    // An empty first page is the "nothing booked" fixture.
    BOOKINGS: {
      async get(key, typeOrOptions) { if (key === "cal:busy" && kvType(typeOrOptions) === "json") return snapshot; return null; },
      async list() { return { keys: [], list_complete: true, cursor: null }; },
    },
  };
}

test("coffee availability reuses the booking slot calculation and returns a safe shape", async () => {
  const payload = await getPublicAvailability(coffeeEnv(), context());
  assert.equal(payload.available, true);
  assert.equal(payload.timezone, "America/New_York");
  assert.ok(Array.isArray(payload.slots));
  assert.ok(payload.slots.every((slot) => slot.start.endsWith("Z") && slot.durationMinutes === 30));
  const response = await handleCoffeeAvailability(new Request("https://aadhar.sh/coffee/availability.json"), coffeeEnv(), context());
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") || "", /^application\/json/);
});

test("Lens comparison rejects invalid targets before any fetch", async () => {
  const response = await handleLensCompare(new Request("https://aadhar.sh/lens/compare.json?left=javascript%3Aalert(1)&right=https%3A%2F%2Fexample.com"), {}, context());
  assert.equal(response.status, 400);
  assert.equal((await response.json()).ok, false);
});

test("site MCP exposes one read-only tool catalog and calls shared search", async () => {
  const env = { ASSETS: staticAssets({
    "/search-index.json": { records: [{ url: "/writing/agents", title: "Agents", description: "Notes on agents", text: "Cloudflare agents and tools", kind: "writing" }] },
  }) };
  const initialize = await handleSiteMcp(new Request("https://aadhar.sh/mcp", { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } }), headers: { "content-type": "application/json" } }), env, context());
  assert.equal(initialize.status, 200);
  assert.equal((await initialize.json()).result.serverInfo.name, "aadhar.sh");
  const call = await handleSiteMcp(new Request("https://aadhar.sh/mcp", { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "search_site", arguments: { q: "cloudflare" } } }), headers: { "content-type": "application/json" } }), env, context());
  const callBody = await call.json();
  assert.equal(callBody.result.structuredContent.returned, 1);
  assert.equal((await handleSiteMcp(new Request("https://aadhar.sh/mcp"), env, context())).status, 405);
});

// The annotations are a CLAIM made to every client that lists this server, so
// the test names the exceptions instead of asserting one shape over all of them.
// A blanket "everything is read-only" assertion passed right up until the vault
// tools landed, and would have kept passing while advertising a tool that writes
// a D1 row as read-only.
const MCP_WRITE_TOOLS = new Set(["representation_capture", "representation_compare"]);

test("MCP tools publish honest client metadata for calling and WebMCP", async () => {
  const response = await handleSiteMcp(mcpPost({
    jsonrpc: "2.0", id: "metadata", method: "tools/list", params: { ...MODERN_META },
  }), {}, context());
  const listed = (await response.json()).result.tools;
  assert.deepEqual(listed, SITE_MCP_TOOLS, "tools/list must expose the canonical decorated registry");
  assert.equal(listed.length, 24);
  for (const tool of listed) {
    assert.ok(tool.title, `${tool.name} needs a human-readable title`);
    const writes = MCP_WRITE_TOOLS.has(tool.name);
    assert.deepEqual(tool.annotations, {
      readOnlyHint: !writes,
      destructiveHint: false,
      idempotentHint: !writes,
      openWorldHint: tool.annotations.openWorldHint,
    }, `${tool.name} annotations must be explicit`);
    assert.deepEqual(tool.outputSchema, { type: "object", additionalProperties: true }, `${tool.name} needs an object output schema`);
    // A write must ALSO say so in its description, because Cloudflare's WebMCP
    // bridge registers {name, description, inputSchema, execute} and drops
    // `annotations` entirely — a browser agent never sees the flags asserted
    // above. Description is the only field that reaches it, so the two have to
    // agree. Asserting both directions is the point: prose on a read-only tool
    // would be a false warning, and that rots as quietly as a missing one.
    assert.equal(
      /\bWrites:/.test(tool.description), writes,
      writes
        ? `${tool.name} writes, so its description must carry the "Writes:" clause the WebMCP bridge can actually see`
        : `${tool.name} is read-only but its description claims it writes`,
    );
  }
  assert.equal(listed.find((tool) => tool.name === "lens_inspect").annotations.openWorldHint, true);
  assert.equal(listed.find((tool) => tool.name === "search_site").annotations.openWorldHint, false);
  // Every tool that can be handed a caller-supplied URL reaches off this origin,
  // and that is the whole meaning of openWorldHint. Pinning the set here is what
  // makes the omission loud the next time a fetching tool is added.
  for (const name of ["image_transform", "photo_recipe", "representation_capture"]) {
    assert.equal(listed.find((tool) => tool.name === name).annotations.openWorldHint, true, `${name} fetches caller-supplied URLs`);
  }
});

test("site MCP image workbench returns an image content block and exact receipt", async () => {
  const env = { IMAGES: fakeImages() };
  const list = await handleSiteMcp(new Request("https://aadhar.sh/mcp", { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }), headers: { "content-type": "application/json" } }), env, context());
  const names = (await list.json()).result.tools.map((tool) => tool.name);
  assert.ok(names.includes("image_inspect"));
  assert.ok(names.includes("image_transform"));
  assert.ok(names.includes("image_compare"));
  const call = await handleSiteMcp(new Request("https://aadhar.sh/mcp", { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "image_transform", arguments: { image_data: "aGVsbG8=", preset: "thumbnail" } } }), headers: { "content-type": "application/json" } }), env, context());
  const body = await call.json();
  assert.equal(body.result.structuredContent.engine, "cloudflare-images");
  assert.equal(body.result.content[1].type, "image");
  assert.equal(body.result.content[1].mimeType, "image/avif");
});

test("photo_recipe only claims exact archive identities", async () => {
  const metadata = JSON.parse(readFileSync("holding/images/metadata.json", "utf8"));
  const hashes = JSON.parse(readFileSync("holding/images/hashes.json", "utf8"));
  const alt = JSON.parse(readFileSync("holding/images/alt.json", "utf8"));
  const fingerprints = JSON.parse(readFileSync("holding/images/fingerprints.json", "utf8"));
  const stem = Object.keys(metadata)[0];
  const env = { ASSETS: staticAssets({ "/images/metadata.json": metadata, "/images/hashes.json": hashes, "/images/alt.json": alt, "/images/fingerprints.json": fingerprints }) };
  const exact = await handleSiteMcp(new Request("https://aadhar.sh/mcp", { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "photo_recipe", arguments: { stem } } }), headers: { "content-type": "application/json" } }), env, context());
  const exactBody = await exact.json();
  assert.equal(exactBody.result.structuredContent.matched, true);
  assert.equal(exactBody.result.structuredContent.photo.stem, stem);
  assert.equal("gps" in exactBody.result.structuredContent.photo.metadata, false);
  const jpgPath = `holding/i/${stem}.${hashes[stem].j}.jpg`;
  const bytes = readFileSync(jpgPath).toString("base64");
  const byBytes = await handleSiteMcp(new Request("https://aadhar.sh/mcp", { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "photo_recipe", arguments: { image_data: bytes } } }), headers: { "content-type": "application/json" } }), env, context());
  const byBytesBody = await byBytes.json();
  assert.equal(byBytesBody.result.structuredContent.matched, true);
  assert.equal(byBytesBody.result.structuredContent.photo.matchKind, "published-thumbnail");
  assert.equal(byBytesBody.result.structuredContent.photo.matchedTier, "j");
  const miss = await handleSiteMcp(new Request("https://aadhar.sh/mcp", { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "photo_recipe", arguments: { image_data: "aGVsbG8=" } } }), headers: { "content-type": "application/json" } }), env, context());
  const missBody = await miss.json();
  assert.equal(missBody.result.structuredContent.matched, false);
});

test("representation vault stores normalized snapshots and compares digests", async () => {
  const db = representationD1();
  const realFetch = globalThis.fetch;
  let version = "one";
  globalThis.fetch = async () => new Response(`<!doctype html><title>${version}</title><p>${version}</p>`, { headers: { "content-type": "text/html; charset=utf-8", etag: `"${version}"`, "cache-control": "public, max-age=60" } });
  try {
    const env = { RESTORE_DB: db };
    const capture = await handleSiteMcp(new Request("https://aadhar.sh/mcp", { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "representation_capture", arguments: { url: "https://example.com/page", profiles: ["browser"] } } }), headers: { "content-type": "application/json" } }), env, context());
    const captured = (await capture.json()).result.structuredContent;
    const first = captured.snapshots[0];
    assert.ok(first.id);
    assert.equal(first.title, "one");
    assert.equal(db.rows[0].body, undefined);
    version = "two";
    const compare = await handleSiteMcp(new Request("https://aadhar.sh/mcp", { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "representation_compare", arguments: { snapshot_id: first.id } } }), headers: { "content-type": "application/json" } }), env, context());
    const compared = (await compare.json()).result.structuredContent;
    assert.equal(compared.changed, true);
    assert.ok(compared.changes.body_hash);
  } finally { globalThis.fetch = realFetch; }
});

// ── webmention (inbound) ────────────────────────────────────────────────────
// A tiny in-memory D1 stand-in: enough SQL surface for the handful of statements
// webmention.js issues, so the verify → store → approve → display path runs end
// to end without a real database.
function fakeD1() {
  const rows = [];
  const run = (sql, args) => {
    const s = sql.replace(/\s+/g, " ").trim();
    if (/^CREATE/i.test(s)) return { results: [], meta: { changes: 0 } };
    if (/^INSERT INTO webmentions/i.test(s)) {
      const [id, source, target, kind, author, author_url, title, excerpt, received_at] = args;
      const existing = rows.find((r) => r.source === source && r.target === target);
      if (existing) Object.assign(existing, { kind, author, author_url, title, excerpt, received_at });
      else rows.push({ id, source, target, kind, author, author_url, title, excerpt, status: "pending", received_at, approved_at: null });
      return { meta: { changes: 1 } };
    }
    if (/^SELECT status FROM webmentions/i.test(s)) {
      const [source, target] = args;
      return rows.find((r) => r.source === source && r.target === target) || null;
    }
    if (/^UPDATE webmentions SET status = 'approved'/i.test(s)) {
      const [ts, id] = args;
      const r = rows.find((x) => x.id === id);
      if (r) { r.status = "approved"; r.approved_at = ts; }
      return { meta: { changes: r ? 1 : 0 } };
    }
    if (/^DELETE FROM webmentions WHERE id/i.test(s)) {
      const i = rows.findIndex((x) => x.id === args[0]);
      if (i >= 0) rows.splice(i, 1);
      return { meta: { changes: i >= 0 ? 1 : 0 } };
    }
    if (/^DELETE FROM webmentions WHERE source/i.test(s)) {
      const [source, target] = args;
      const i = rows.findIndex((x) => x.source === source && x.target === target);
      if (i >= 0) rows.splice(i, 1);
      return { meta: { changes: i >= 0 ? 1 : 0 } };
    }
    if (/^SELECT source, target/i.test(s)) {
      return { results: rows.filter((r) => r.status === "approved").sort((a, b) => b.approved_at - a.approved_at) };
    }
    return { results: [], meta: { changes: 0 } };
  };
  return {
    rows,
    prepare(sql) {
      let bound = [];
      const api = {
        bind: (...a) => { bound = a; return api; },
        run: async () => run(sql, bound),
        all: async () => run(sql, bound),
        first: async () => run(sql, bound),
      };
      return api;
    },
  };
}

const WM_SECRET = "test-signing-secret";
function wmEnv(db) {
  return {
    SOCIAL_DB: db,
    SIGNING_SECRET: WM_SECRET,
    ASSETS: staticAssets({ "/writing/posts.json": [{ slug: "in-flux", title: "in flux", date: "2026-01-01" }] }),
  };
}
// the shared context() discards waitUntil promises; webmention does its real
// work there (verification is deliberately off the request path), so the test
// needs a context it can await.
function deferredContext() {
  const pending = [];
  return { waitUntil: (p) => pending.push(p), settle: () => Promise.all(pending) };
}
const wmPost = (source, target) => new Request("https://aadhar.sh/webmention", {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ source, target }).toString(),
});

test("webmention rejects targets that do not accept mentions", async () => {
  const env = wmEnv(fakeD1());
  // /ledger is a real page but is not flagged webmention in the registry.
  for (const target of ["https://aadhar.sh/ledger", "https://elsewhere.example/post", "https://aadhar.sh/writing/nope"]) {
    const res = await handleWebmention(wmPost("https://mari.example/post", target), env, context());
    assert.equal(res.status, 400, `should reject target ${target}`);
  }
});

test("webmention rejects private, non-http, and same-origin sources", async () => {
  const env = wmEnv(fakeD1());
  const target = "https://aadhar.sh/garage/chunks";
  for (const source of ["http://127.0.0.1/x", "http://169.254.169.254/latest/meta-data", "javascript:alert(1)", "https://aadhar.sh/writing/in-flux"]) {
    const res = await handleWebmention(wmPost(source, target), env, context());
    assert.equal(res.status, 400, `should reject source ${source}`);
  }
});

test("webmention verifies the source really links back, then moderates before publishing", async () => {
  const db = fakeD1();
  const env = wmEnv(db);
  const target = "https://aadhar.sh/writing/in-flux";   // a post, via the /writing section flag
  const source = "https://mari.example/resto-mod-web";
  const realFetch = globalThis.fetch;

  // 1. a source that does NOT link back is verified away and never stored.
  globalThis.fetch = async () => new Response("<html><a href='https://example.com'>elsewhere</a></html>", { headers: { "content-type": "text/html" } });
  try {
    let ctx1 = deferredContext();
    let res = await handleWebmention(wmPost(source, target), env, ctx1);
    assert.equal(res.status, 202, "the sender is always accepted; verification is async");
    await ctx1.settle();
    assert.equal(db.rows.length, 0, "an unverified mention must never be stored");

    // 2. a source that DOES link back is stored, but only as pending.
    globalThis.fetch = async () => new Response(
      `<html><head><title>Resto-mod web</title><meta name="author" content="Mari"></head>
       <body><p class="e-content">A lovely note about <a class="u-in-reply-to" href="${target}">in flux</a> and its ideas.</p></body></html>`,
      { headers: { "content-type": "text/html" } });
    const ctx2 = deferredContext();
    res = await handleWebmention(wmPost(source, target), env, ctx2);
    assert.equal(res.status, 202);
    await ctx2.settle();
    assert.equal(db.rows.length, 1);
    assert.equal(db.rows[0].status, "pending", "nothing is displayed unmoderated");
    assert.equal(db.rows[0].kind, "reply", "u-in-reply-to reads as a reply");
    assert.equal(db.rows[0].author, "Mari");

    // 3. it stays out of /inbox until approved.
    let inbox = await handleInbox(new Request("https://aadhar.sh/inbox"), env, context());
    let html = await inbox.text();
    assert.ok(!html.includes("Resto-mod web"), "a pending mention must not render");
    assert.match(inbox.headers.get("link") || "", /rel="webmention"/, "the inbox advertises the endpoint");

    // 4. a forged approval is refused; only the HMAC-signed one works.
    const id = db.rows[0].id;
    const badUrl = new URL(`https://aadhar.sh/webmention/approve?t=${id}&sig=nope`);
    const forged = await handleWebmentionDecision(new Request(badUrl), env, context(), badUrl);
    assert.equal(forged.status, 403, "nobody can approve their own mention");
    assert.equal(db.rows[0].status, "pending");

    const sig = await sign(`${id}|approve`, WM_SECRET);
    const okUrl = new URL(`https://aadhar.sh/webmention/approve?t=${id}&sig=${sig}`);
    const approved = await handleWebmentionDecision(new Request(okUrl), env, context(), okUrl);
    assert.equal(approved.status, 200);
    assert.equal(db.rows[0].status, "approved");

    // 5. now it renders, links out to the source, and is filed under its page.
    inbox = await handleInbox(new Request("https://aadhar.sh/inbox"), env, context());
    html = await inbox.text();
    assert.ok(html.includes("Resto-mod web"), "an approved mention renders");
    assert.ok(html.includes(source), "the row links out to the source");
    assert.ok(html.includes("/writing/in-flux"), "filed under the page it mentions");

    // 6. re-sending after the link is removed retracts it (the spec's delete signal).
    globalThis.fetch = async () => new Response("<html><p>rewritten, no link anymore</p></html>", { headers: { "content-type": "text/html" } });
    const ctx3 = deferredContext();
    res = await handleWebmention(wmPost(source, target), env, ctx3);
    assert.equal(res.status, 202);
    await ctx3.settle();
    assert.equal(db.rows.length, 0, "a mention whose source dropped the link is retracted");
  } finally { globalThis.fetch = realFetch; }
});

test("/inbox degrades honestly when the mention store is unbound", async () => {
  const res = await handleInbox(new Request("https://aadhar.sh/inbox"), { ASSETS: staticAssets({}) }, context());
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /not connected/i, "says the store is missing rather than pretending there is no mail");
});

test("every page that accepts a mention also advertises where to send it", async () => {
  // Accepting a webmention it never advertises makes a page undiscoverable to a
  // spec-compliant sender, which is the same as not accepting it. /writing was
  // exactly that for one deploy: flagged in the registry, 202 on POST, and no
  // Link header on the folder itself. Tie the two together so they cannot drift.
  const headers = await readFile("holding/_headers", "utf8");
  const advertisedByHeaders = headers
    .split(/\n(?=\S)/)
    .filter((block) => /Link:.*rel="webmention"/.test(block))
    .map((block) => block.split("\n")[0].trim());

  const coveredByStatics = (path) =>
    advertisedByHeaders.some((rule) =>
      rule.endsWith("/*") ? path.startsWith(rule.slice(0, -1)) : rule === path);

  for (const path of WEBMENTION_PATHS) {
    if (coveredByStatics(path)) continue;
    // anything the statics don't cover is worker-rendered, so ask the worker.
    // Going through the real handler (not the inner render) also catches an
    // edge-cache wrapper that drops the header on its way out.
    assert.equal(path, "/writing", `no advertisement path known for ${path}`);
    const priorCaches = globalThis.caches;
    globalThis.caches = { default: { match: async () => undefined, put: async () => {} } };
    let res;
    try {
      res = await handleWritingIndex(
        new Request("https://aadhar.sh/writing"),
        { ASSETS: staticAssets({}) },
        context()
      );
    } finally {
      if (priorCaches === undefined) delete globalThis.caches;
      else globalThis.caches = priorCaches;
    }
    assert.match(
      res.headers.get("link") || "",
      /rel="webmention"/,
      "/writing accepts mentions, so it must say where to send them"
    );
  }
});

// ── webmention (outbound) ───────────────────────────────────────────────────
test("outbound citations exclude the shell, self-links, and non-public URLs", () => {
  const origin = "https://aadhar.sh";
  const page = `
    <head><link rel="canonical" href="https://aadhar.sh/garage/chunks"><a href="https://head-link.example/nope">head</a></head>
    <body>
      <!-- axp:desktop --><div id="axp-desktop"></div><!-- /axp:desktop -->
      <p>Concepts credit <a href="https://github.com/officialunofficial/mkit">officialunofficial/mkit</a>,
         and the streaming docs at <a href="https://mkit.makechain.net/streaming">makechain</a>.</p>
      <p>See also <a href="https://docs.makechain.net/#anchor">the docs</a> and
         <a href="/garage/encoding">my own page</a> and <a href="mailto:a@b.c">mail</a>.</p>
      <p>Dupe: <a href="https://github.com/officialunofficial/mkit">same repo again</a></p>
      <p>Blocked: <a href="http://127.0.0.1/x">local</a> <a href="http://169.254.169.254/meta">metadata</a></p>
      <p>Hover cards, not citations:
         <a interestfor="pop-singer" href="https://www.google.com/search?q=Singer+Porsche+911" rel="external">Singer</a>
         <a class="car-link" href="https://www.google.com/search?q=Tuthill+911K" rel="external">Tuthill</a></p>
      <!-- axp:shell -->
        <a href="https://github.com/oddharsh">GitHub</a>
        <a href="https://open.spotify.com/user/aadharsh2010">Music</a>
        <a href="https://www.instagram.com/aadharsh.hif">Photos</a>
      <!-- /axp:shell -->
    </body>`;
  const found = citationsIn(page, origin);

  assert.ok(found.includes("https://github.com/officialunofficial/mkit"), "a real citation is sent");
  assert.ok(found.includes("https://mkit.makechain.net/streaming"), "a second real citation is sent");
  assert.ok(found.some((u) => u.startsWith("https://docs.makechain.net/")), "anchors are normalized, not dropped");
  assert.equal(found.filter((u) => u.includes("officialunofficial")).length, 1, "deduped");

  for (const bad of ["oddharsh", "spotify", "instagram", "aadhar.sh/garage", "127.0.0.1", "169.254", "mailto", "head-link",
                     // an anchor that exists to open a hover card is chrome. These
                     // point at Google SEARCH pages, so a webmention to them would
                     // be noise rather than credit.
                     "google.com/search"]) {
    assert.ok(!found.some((u) => u.includes(bad)), `must not send to ${bad}`);
  }
});

test("outbound self-link list stays in sync with the desktop shell profiles", async () => {
  // the filter is only correct while it knows every profile nav.js stamps on
  // every page; a new profile added there must be excluded here too.
  const nav = await readFile("holding/nav.js", "utf8");
  const block = (nav.match(/var PROFILES = \[([\s\S]*?)\];/) || [, ""])[1];
  const urls = [...block.matchAll(/url:\s*"([^"]+)"/g)].map((m) => m[1]);
  assert.ok(urls.length >= 5);
  for (const raw of urls) {
    const u = new URL(raw);
    const bare = (u.host + u.pathname).replace(/^www\./, "").replace(/\/$/, "");
    assert.ok(
      SELF_LINK_HOSTS.some((self) => bare === self || bare.startsWith(self + "/")),
      `nav.js PROFILES has ${bare} but webmention-send.js SELF_LINK_HOSTS does not exclude it`
    );
  }
});

// ── shell infotips ──────────────────────────────────────────────────────────
// infotip.js cannot be imported here: it reaches /hoist.js by absolute
// specifier, which node's loader will not resolve (the same wall gotcha 16
// describes). So these assert on the source text, and each one guards a
// failure that would ship silently.

test("\"what was hovered\" is answered in exactly one place", async () => {
  const nav = await readFile(new URL("holding/nav.js", import.meta.url), "utf8");
  const tip = await readFile(new URL("holding/infotip.js", import.meta.url), "utf8");
  // nav.js's loader has to match the same elements the module does, or the
  // first hover over something it forgot never loads the module at all — and
  // the failure is a tooltip that works everywhere except where you look first.
  // So the matcher is a function nav.js passes over, not a selector each side
  // keeps a copy of.
  assert.match(nav, /var INFOTIP_TARGETS = \[/, "nav.js owns the target selector");
  assert.match(nav, /var INFOTIP_SKIP = /, "and the list of hovers a richer surface already owns");
  assert.match(nav, /find: targetFor/, "and hands the matcher itself to the module");
  assert.match(tip, /const findTarget = o\.find;/, "infotip.js takes the matcher it is given");
  // It still reads the DOM for per-family facts (which builder, and whether the
  // target sits on the taskbar), and those are single selectors. What it must
  // never grow is a LIST — that is the copy this test exists to stop.
  assert.doesNotMatch(tip, /\.axp-\w[^\n"]*,[^\n"]*\.axp-/, "a second target list in infotip.js is the drift this test exists to stop");
});

test("the infotip yields to every richer hover surface on the page", async () => {
  const nav = await readFile(new URL("holding/nav.js", import.meta.url), "utf8");
  const skip = (nav.match(/var INFOTIP_SKIP = "([^"]+)"/) || [, ""])[1].split(",");
  // Each of these draws its own card from the same engine, and `.lx-term` is
  // the sharp one: those ship a `title` as their no-JS fallback and lens.js
  // strips it once its surface is live, so without the skip a race between two
  // lazy modules decides whether you get the glossary card or a flat line.
  for (const owned of [".lx-term", ".photos a", ".np-list li", ".np-artist-link", ".car-link", ".ev[data-cover]"]) {
    assert.ok(skip.includes(owned), `${owned} has its own hover card — the infotip must not double up on it`);
  }
});

test("every string an infotip prints is escaped on the way in", async () => {
  const tip = await readFile(new URL("holding/infotip.js", import.meta.url), "utf8");
  // The surface renders `title` text from ANY page now, and some of those
  // strings are not ours: /inbox carries webmention titles, /around and
  // /reading carry text from sites this server crawled. innerHTML with one
  // un-escaped hole would turn a remote string into markup on every page that
  // loads the shell. Verified in a browser too (a title holding
  // `<img src=x onerror=alert(1)>` renders as text and creates no element),
  // but the source assertion is what fails a future edit.
  for (const hole of [/<div class="n">\$\{esc\(/, /<div class="h">\$\{esc\(/, /<dt>\$\{esc\(/, /<dd>\$\{esc\(/]) {
    assert.match(tip, hole, `${hole} must interpolate through esc()`);
  }
  const printed = tip.match(/<div class="n">\$\{[^}]+\}/g) || [];
  assert.ok(printed.length >= 2 && printed.every((p) => p.includes("esc(")),
    "every name line must be escaped, including any added later");
});

test("an infotip row is dropped rather than filled in", async () => {
  const tip = await readFile(new URL("holding/infotip.js", import.meta.url), "utf8");
  // Same rule the photo tooltip follows: a missing value prints nothing. A
  // card that rendered "Contains: 0 pages" or "Colo: unknown" would be stating
  // something the shell does not know, on chrome describing the shell.
  assert.match(tip, /\.filter\(\(p\) => p && p\[1\]\)/, "card() must drop pairs with no value");
  assert.doesNotMatch(tip, /"unknown"|"n\/a"|\|\| 0\)\s*\+\s*" page/i, "no placeholder stands in for a value");
});

test("the shell infotip ships minified, hashed, and with a readable twin", async () => {
  const build = await readFile(new URL("build.mjs", import.meta.url), "utf8");
  // Missing from SHELLS it would ship unminified with no /infotip.src.js twin;
  // missing from STRING_ASSETS its import specifier would stay unhashed and
  // the module would serve at max-age=300 forever beside its immutable peers.
  assert.match(build, /\["infotip\.js",\s*"\/infotip\.src\.js"/, "infotip.js belongs in SHELLS");
  assert.match(build, /\{ file: "\/infotip\.js",\s*base: "infotip"/, "and in STRING_ASSETS, so nav.js's import() is repointed");
  const shells = build.slice(build.indexOf("const SHELLS = ["));
  assert.ok(shells.indexOf('"/hoist.js"') < shells.indexOf('{ file: "/infotip.js"'),
    "hoist must be hashed before infotip, or infotip's /a/ copy keeps the unhashed specifier");
});

test("outbound endpoint discovery follows the spec's precedence", () => {
  const base = "https://example.com/post";
  // Link header wins over markup.
  assert.equal(
    findEndpointIn('<link rel="webmention" href="/from-markup">', '</from-header>; rel="webmention"', base),
    "https://example.com/from-header");
  // then <link>, resolved relative to the fetched URL
  assert.equal(findEndpointIn('<link rel="webmention" href="/wm">', null, base), "https://example.com/wm");
  // then <a>, and rel lists with extra tokens still count
  assert.equal(findEndpointIn('<a rel="me webmention" href="https://wm.example/e">x</a>', null, base), "https://wm.example/e");
  // no endpoint is the common case, and is not an error
  assert.equal(findEndpointIn("<p>nothing here</p>", null, base), null);
});

test("the excerpt survives a page full of inline SVG chrome", async () => {
  // A real mention from a GitHub gist arrived with 280 characters of SVG path
  // geometry as its excerpt, which is what made a legitimate mention read as
  // spam. Two causes: <svg> was not stripped alongside <script>/<style>, and the
  // fixed-width window around the link opens mid-attribute (the target lives in
  // an href), leaving a partial tag that the complete-tag stripper cannot touch.
  const db = fakeD1();
  const target = "https://aadhar.sh/writing/in-flux";
  // The path has to be long enough that the 400-character window opening before
  // the link lands INSIDE the d="..." attribute, because that is the only way
  // the geometry escapes: the tag stripper removes complete tags, attributes and
  // all, so a short icon is harmless. On the real gist the icon sat directly
  // before the link with roughly this much path data, which is why it leaked.
  const path = "M9.64a1.998 1.998 0 0 0 2.83 0l1.25-1.25a.751.751 0 0 1 1.042.018Z".repeat(12);
  const page = `<html><body>
    <svg aria-hidden="true"><path d="${path}"></path></svg>
    <p>The teardown at <a href="${target}" class="Link--primary">this note</a> is the useful part.</p>
    </body></html>`;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(page, { headers: { "content-type": "text/html" } });
  try {
    const ctx = deferredContext();
    await handleWebmention(wmPost("https://gist.example/x", target), wmEnv(db), ctx);
    await ctx.settle();
  } finally {
    globalThis.fetch = realFetch;
  }
  const row = db.rows[0];
  assert.ok(row, "the mention verified and stored");
  assert.doesNotMatch(row.excerpt, /\d\.\d{3}\s|[Ma]\d+\.\d+[a-z]/, `SVG path data leaked into the excerpt: ${row.excerpt}`);
  assert.doesNotMatch(row.excerpt, /^["'>]/, "excerpt starts with the tail of a chopped attribute");
  assert.match(row.excerpt, /is the useful part/, "the sentence around the link survived");
});

test("an accepted webmention answers 202 without a Location header", async () => {
  // The spec ties Location to 201, where it must name a status URL the sender
  // can poll. On a 202 it has no defined meaning, and webmention.rocks receiver
  // test #1 fails an endpoint that sends one anyway. Easy to reintroduce by
  // "helpfully" pointing at /inbox, so pin it.
  const db = fakeD1();
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response('<a href="https://aadhar.sh/writing/in-flux">x</a>', { headers: { "content-type": "text/html" } });
  try {
    const res = await handleWebmention(
      wmPost("https://mari.example/post", "https://aadhar.sh/writing/in-flux"),
      wmEnv(db),
      deferredContext()
    );
    assert.equal(res.status, 202);
    assert.equal(res.headers.get("location"), null, "202 must not carry a Location header");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("endpoint discovery survives the webmention.rocks decoys", () => {
  // Fixtures lifted from the live pages at webmention.rocks/test/N, the
  // IndieWeb conformance suite. Kept as fixtures rather than live fetches
  // because this file is deliberately network-free; the real 23 were run
  // against the deployed implementation and all pass. Numbers name the test.
  const at = (n) => `https://webmention.rocks/test/${n}`;
  const cases = [
    // #1 relative Link header, unquoted rel. #2 absolute. #7 odd casing.
    [1, "", "</test/1/webmention>; rel=webmention", at(1) + "/webmention"],
    [8, "", '<https://webmention.rocks/test/8/webmention>; rel="webmention"', at(8) + "/webmention"],
    // #10 the rel is a token LIST; webmention is one of several.
    [10, "", '<https://webmention.rocks/test/10/webmention>; rel="webmention somethingelse"', at(10) + "/webmention"],
    // #19 one header, several values: the non-webmention one must not win.
    [19, "", '<https://webmention.rocks/test/19/webmention/error>; rel="other", <https://webmention.rocks/test/19/webmention>; rel="webmention"', at(19) + "/webmention"],
    // #12 rel="not-webmention" is a DIFFERENT rel. A \bwebmention\b regex
    // matches it anyway, because "-" is a word boundary.
    [12, '<link rel="not-webmention" href="/test/12/webmention/error"><a href="/test/12/webmention" rel="webmention">ok</a>', null, at(12) + "/webmention"],
    // #13 a decoy inside an HTML comment is not markup.
    [13, 'comment <!-- <a href="/test/13/webmention/error" rel="webmention"></a> --> then <a href="/test/13/webmention" rel="webmention">correct</a>', null, at(13) + "/webmention"],
    // #14 the same decoy, escaped. Never matched a "<"-anchored pattern.
    [14, '<code>&lt;a href="/test/14/webmention/error" rel="webmention"&gt;&lt;/a&gt;</code><a href="/test/14/webmention" rel="webmention">x</a>', null, at(14) + "/webmention"],
    // #15 href="" is a legitimate self-reference, not a missing href.
    [15, '<link rel="webmention" href="">', null, at(15)],
    // #16 <a> first, <link> later: DOCUMENT ORDER decides, not tag name. An
    // implementation that scans every <link> before any <a> takes the decoy.
    [16, '<a href="/test/16/webmention" rel="webmention">a</a><link rel="webmention" href="/test/16/webmention/error">', null, at(16) + "/webmention"],
    // #17 the same page with the tags swapped, to catch the opposite bias.
    [17, '<link rel="webmention" href="/test/17/webmention"><a href="/test/17/webmention/error" rel="webmention">a</a>', null, at(17) + "/webmention"],
    // #20 a candidate with NO href is not an endpoint. Skip it and keep
    // looking, rather than letting it shadow the real one below.
    [20, '<link rel="webmention"><a href="/test/20/webmention" rel="webmention">x</a>', null, at(20) + "/webmention"],
  ];
  for (const [n, html, header, expected] of cases) {
    assert.equal(findEndpointIn(html, header, at(n)), expected, `webmention.rocks discovery test #${n}`);
  }
});

test("site-manifest.json is a well-formed registry with unique paths", async () => {
  const { surfaces } = readManifest();
  assert.ok(surfaces.length > 0);
  const seen = new Set();
  for (const s of surfaces) {
    assert.match(s.path, /^\//, `path must be absolute: ${s.path}`);
    assert.ok(s.title && s.description && s.hint, `${s.path} missing title/description/hint`);
    for (const f of ["run", "taskbar", "sitemap", "gallery", "agents", "searchIndex"]) {
      assert.equal(typeof s.flags?.[f], "boolean", `${s.path} flag ${f} must be boolean`);
    }
    assert.ok(!seen.has(s.path), `duplicate path ${s.path}`);
    seen.add(s.path);
  }
});

test("committed manifest projections match a fresh generation", async () => {
  // guards against a commit that edits site-manifest.json but forgets
  // `pnpm run gen:manifest` — the same drift build.mjs #8 blocks, checked here too.
  const { surfaces } = readManifest();
  const mod = await readFile("holding/_worker.js/lib/site-manifest.js", "utf8");
  assert.equal(mod.trim(), workerModule(surfaces).trim(), "lib/site-manifest.js is stale — run pnpm run gen:manifest");
  const nav = await readFile("holding/nav.js", "utf8");
  for (const [section, marker] of [["garage", "garage-pages"], ["lwe", "lwe-pages"]]) {
    assert.equal(readFenceBody(nav, marker), navFenceBody(surfaces, section), `nav.js generated:${marker} is stale — run pnpm run gen:manifest`);
  }
});

test("site MCP lists the agent surfaces as resources", async () => {
  const init = await handleSiteMcp(new Request("https://aadhar.sh/mcp", { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }), headers: { "content-type": "application/json" } }), {}, context());
  assert.deepEqual((await init.json()).result.capabilities.resources, {}, "initialize must declare the resources capability");
  const list = await handleSiteMcp(new Request("https://aadhar.sh/mcp", { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "resources/list" }), headers: { "content-type": "application/json" } }), {}, context());
  const resources = (await list.json()).result.resources;
  assert.equal(resources.length, AGENT_SURFACES.length);
  assert.ok(resources.length > 0);
  const home = resources.find((r) => r.name === "/");
  assert.equal(home.uri, "https://aadhar.sh/", "uri is absolute against the request origin");
  assert.equal(home.mimeType, "text/html");
});

test("site MCP resources/read serves listed surfaces only, same-origin", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("<!doctype html><title>ok</title>", { headers: { "content-type": "text/html; charset=utf-8" } });
  try {
    const read = await handleSiteMcp(new Request("https://aadhar.sh/mcp", { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "resources/read", params: { uri: "https://aadhar.sh/whoareyou" } }), headers: { "content-type": "application/json" } }), {}, context());
    const content = (await read.json()).result.contents[0];
    assert.equal(content.uri, "https://aadhar.sh/whoareyou");
    assert.match(content.text, /ok/);
    // an unlisted path and a cross-origin host are both rejected without fetching.
    for (const uri of ["https://aadhar.sh/etc/passwd", "https://evil.example.com/whoareyou"]) {
      const bad = await handleSiteMcp(new Request("https://aadhar.sh/mcp", { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 4, method: "resources/read", params: { uri } }), headers: { "content-type": "application/json" } }), {}, context());
      assert.equal((await bad.json()).error.code, -32602, `must reject ${uri}`);
    }
  } finally { globalThis.fetch = realFetch; }
});

// Server cards are pre-connection metadata. The live `server/discover` and
// `tools/list` responses remain the protocol source of truth, so the cards are
// generated projections rather than a second hand-maintained tool catalog.
test("published MCP server cards and discovery files stay aligned with both live servers", async () => {
  const { handleMcp } = await import("./serendipity/serendipity.js");
  const siteLive = await (await handleSiteMcp(mcpPost({
    jsonrpc: "2.0", id: "site-tools", method: "tools/list", params: { ...MODERN_META },
  }), {}, context())).json();
  const serendipityPost = (body) => new Request("https://aadhar.sh/serendipity/mcp", {
    method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" },
  });
  const serendipityLive = await (await handleMcp(serendipityPost({
    jsonrpc: "2.0", id: "serendipity-tools", method: "tools/list", params: { ...MODERN_META },
  }), {}, null)).json();
  const cards = [
    {
      file: "holding/.well-known/mcp/server-card.json",
      endpoint: "https://aadhar.sh/mcp",
      live: siteLive.result.tools,
      info: { name: SITE_MCP_SERVER_INFO.name, title: SITE_MCP_SERVER_INFO.title, version: SITE_MCP_SERVER_INFO.version },
      capabilities: { tools: true, resources: true, prompts: false },
    },
    {
      file: "holding/.well-known/mcp.json",
      endpoint: "https://aadhar.sh/serendipity/mcp",
      live: serendipityLive.result.tools,
      info: { name: SERENDIPITY_MCP_SERVER_INFO.name, title: SERENDIPITY_MCP_SERVER_INFO.title, version: SERENDIPITY_MCP_SERVER_INFO.version },
      capabilities: { tools: true, resources: false, prompts: false },
    },
    {
      file: "holding/.well-known/mcp/serendipity.json",
      endpoint: "https://aadhar.sh/serendipity/mcp",
      live: serendipityLive.result.tools,
      info: { name: SERENDIPITY_MCP_SERVER_INFO.name, title: SERENDIPITY_MCP_SERVER_INFO.title, version: SERENDIPITY_MCP_SERVER_INFO.version },
      capabilities: { tools: true, resources: false, prompts: false },
    },
  ];
  for (const { file, endpoint, live, info, capabilities } of cards) {
    const card = JSON.parse(await readFile(new URL(file, import.meta.url), "utf8"));
    assert.equal(card.protocolVersion, "2026-07-28", `${file} must advertise the current MCP revision`);
    assert.deepEqual(card.serverInfo, { ...info, description: card.serverInfo.description }, `${file} server identity drifted`);
    assert.equal(card.transport.url, endpoint, `${file} points at the wrong transport`);
    assert.deepEqual(card.capabilities, capabilities, `${file} capabilities drifted`);
    assert.deepEqual(card.tools, live, `${file} tool metadata drifted from tools/list`);
  }

  const agentCard = JSON.parse(await readFile(new URL("holding/.well-known/agent-card.json", import.meta.url), "utf8"));
  const interfaces = agentCard["x-aadhar-sh"].interfaces.mcp;
  assert.deepEqual(
    interfaces.map((entry) => [entry.url, entry.serverCard]),
    [
      ["https://aadhar.sh/mcp", "https://aadhar.sh/.well-known/mcp/server-card.json"],
      ["https://aadhar.sh/serendipity/mcp", "https://aadhar.sh/.well-known/mcp/serendipity.json"],
    ],
    "agent-card MCP interfaces must name their server cards",
  );
  const catalog = JSON.parse(await readFile(new URL("holding/.well-known/api-catalog", import.meta.url), "utf8"));
  const links = new Map(catalog.linkset.map((entry) => [entry.anchor, entry]));
  assert.equal(links.get("https://aadhar.sh/mcp")["service-desc"][0].href, "https://aadhar.sh/.well-known/mcp/server-card.json");
  assert.equal(links.get("https://aadhar.sh/serendipity/mcp")["service-desc"][0].href, "https://aadhar.sh/.well-known/mcp/serendipity.json");
  const llms = await readFile(new URL("holding/llms.txt", import.meta.url), "utf8");
  assert.match(llms, /https:\/\/aadhar\.sh\/\.well-known\/mcp\/server-card\.json/);
  assert.match(llms, /https:\/\/aadhar\.sh\/\.well-known\/mcp\/serendipity\.json/);
});

// ── the Luma session jar ────────────────────────────────────────────
// Two failure modes these guard. (1) A whole-domain browser export drags in
// cookies that must never be stored or replayed: __cf_bm is a 30-minute,
// IP-bound Cloudflare bot-management token, and replaying a stale one from
// Worker egress IPs reads as a scraper. (2) Luma rotates luma.* cookies via
// Set-Cookie on api2 responses; a client that drops those ends up presenting
// a key Luma no longer honours, which is how the deployed sync went stale
// where local dev (cookies pasted minutes earlier) never did.

const LUMA_EXPORT = JSON.stringify([
  { name: "__cf_bm", value: "edge-noise", domain: ".luma.com" },
  { name: "luma.auth-session-key", value: "usr-abc123.token0", domain: ".luma.com", expirationDate: 1800000000 },
  { name: "__stripe_mid", value: "stripe-noise", domain: ".luma.com" },
  { name: "luma.did", value: "device-1", domain: ".luma.com" },
]);

test("parseCookies keeps only luma.* cookies and reads the user id off the session key", () => {
  const parsed = parseCookies(LUMA_EXPORT);
  const names = JSON.parse(parsed.cookiesJson).cookies.map((c) => c.name).sort();
  assert.deepEqual(names, ["luma.auth-session-key", "luma.did"]);
  assert.equal(parsed.lumaUserId, "usr-abc123");
});

test("parseCookies filters the header-string form too; a junk-only paste gets the human message", () => {
  const parsed = parseCookies("__cf_bm=noise; luma.auth-session-key=usr-x.y");
  assert.deepEqual(JSON.parse(parsed.cookiesJson).cookies.map((c) => c.name), ["luma.auth-session-key"]);
  assert.throws(() => parseCookies('[{"name":"__cf_bm","value":"noise"}]'), /Missing luma\.auth-session-key/);
});

const setCookieRes = (...lines) => {
  const h = new Headers();
  for (const l of lines) h.append("set-cookie", l);
  return { headers: h };
};

test("cookieJar strips stored junk on load and marks itself dirty so the row heals on the next sync", () => {
  const jar = cookieJar(JSON.stringify({ cookies: [
    { name: "__cf_bm", value: "stale" },
    { name: "luma.auth-session-key", value: "usr-x.token0" },
  ] }));
  assert.equal(jar.header(), "luma.auth-session-key=usr-x.token0");
  assert.equal(jar.dirty, true);
  const healed = cookieJar(jar.json());
  assert.equal(healed.dirty, false, "a healed jar must not rewrite itself every sync");
});

test("cookieJar absorbs a luma.* rotation, ignores edge noise, and turns Max-Age into an absolute expiry", () => {
  const jar = cookieJar(JSON.stringify({ cookies: [{ name: "luma.auth-session-key", value: "usr-x.token0" }] }));
  assert.equal(jar.dirty, false);
  jar.absorb(setCookieRes(
    "__cf_bm=fresh-noise; Path=/; Expires=Thu, 30 Jul 2026 21:41:05 GMT; HttpOnly; Secure",
    "luma.auth-session-key=usr-x.token1; Max-Age=31536000; Path=/; HttpOnly; Secure",
  ));
  assert.equal(jar.dirty, true);
  assert.equal(jar.header(), "luma.auth-session-key=usr-x.token1", "the NEXT request must send what Luma just issued");
  const stored = JSON.parse(jar.json()).cookies;
  assert.equal(stored.length, 1, "__cf_bm from the response must not enter the jar");
  assert.ok(stored[0].expires > Date.now() / 1000, "Max-Age lands as absolute epoch seconds");
});

test("cookieJar treats a same-value re-issue as clean and an explicit deletion as removal", () => {
  const jar = cookieJar(JSON.stringify({ cookies: [
    { name: "luma.auth-session-key", value: "usr-x.token0" },
    { name: "luma.did", value: "device-1" },
  ] }));
  jar.absorb(setCookieRes("luma.auth-session-key=usr-x.token0; Path=/"));
  assert.equal(jar.dirty, false, "a same-value re-issue is not a rotation");
  jar.absorb(setCookieRes("luma.did=; Max-Age=0; Path=/"));
  assert.equal(jar.dirty, true);
  assert.equal(jar.header(), "luma.auth-session-key=usr-x.token0");
});

test("cookieJar learns a brand-new luma.* cookie from a response", () => {
  const jar = cookieJar(JSON.stringify({ cookies: [{ name: "luma.auth-session-key", value: "usr-x.t" }] }));
  jar.absorb(setCookieRes("luma.polyjuice.sign-in-state=abc; Path=/; Secure"));
  assert.equal(jar.dirty, true);
  assert.match(jar.header(), /luma\.polyjuice\.sign-in-state=abc/);
});

test("serendipity keeps historical feed and roster backfills alive", () => {
  assert.equal(SERENDIPITY_SYNC_LIMITS.pastPages, 4,
    "the Worker port must retain the original app's four-page event history");
  assert.ok(SERENDIPITY_SYNC_LIMITS.pastGuestEvents > 0,
    "each scheduled pass must advance the past-event roster backlog");

  const next = [{ id: "still-going" }, { id: "self" }, { id: null }, null];
  assert.deepEqual(
    staleGuestIds(["still-going", "cancelled", "self"], next, "self"),
    ["cancelled", "self"],
    "a fresh roster removes stale links and never retains the contributor as their own attendee",
  );
});

// ── the bundled photo pool ──────────────────────────────────────────
// The pool is BUILD DATA: photos.js imports photo-index.json + hashes.json and
// derives the render-ready rows at module scope. These tests run the real
// derivation over the real committed files, so a half-run pipeline (an index
// entry without hashes, a hash without an index entry, a malformed /i/ URL)
// fails here as well as in check-photo-pipeline.mjs — the worker and the
// checker must not be able to disagree about what is published.
test("bundled photo pool derives one well-formed row per committed stem", async () => {
  const index = JSON.parse(await readFile(new URL("holding/_worker.js/photo-index.json", import.meta.url), "utf8"));
  const hashes = JSON.parse(await readFile(new URL("holding/images/hashes.json", import.meta.url), "utf8"));
  const pool = derivePhotoPool(index, hashes);
  assert.equal(pool.length, Object.keys(index).length, "every indexed stem must derive a row");
  assert.equal(pool.length, Object.keys(hashes).length, "index and hashes must be in bijection");
  for (const p of pool) {
    assert.match(p.thumb_avif, new RegExp(`^/i/${p.stem}\\.[a-f0-9]{8}\\.avif$`));
    assert.match(p.thumb_jpg, new RegExp(`^/i/${p.stem}\\.[a-f0-9]{8}\\.jpg$`));
    assert.match(p.thumb_small, new RegExp(`^/i/${p.stem}-400\\.[a-f0-9]{8}\\.avif$`));
    assert.ok(p.full.startsWith(`${p.stem}.`), `${p.stem}: full must be the stem's R2 key`);
    assert.ok(Number.isInteger(p.size) && p.size > 0, `${p.stem}: size must be positive bytes`);
  }
  const fulls = pool.map((p) => p.full);
  assert.deepEqual(fulls, [...fulls].sort((a, b) => a.localeCompare(b)), "pool keeps the manifest's sort order");
  // an incomplete hash entry is SKIPPED, never rendered as /i/undefined
  assert.equal(derivePhotoPool({ X1: { full: "X1.jpg", size: 1, uploaded: null } }, { X1: { a: "aaaaaaaa" } }).length, 0);
});

test("getImagesManifest serves the bundled pool without env", async () => {
  // no env, no ctx: the pool must not depend on any binding
  const pool = await getImagesManifest(undefined, undefined);
  assert.ok(Array.isArray(pool) && pool.length > 0);
});

test("both homepage fragments are preloaded, and the reason that is free still holds", async () => {
  const page = await readFile(new URL("holding/index.html", import.meta.url), "utf8");

  // `crossorigin` is load-bearing even same-origin: without it the preload is
  // mode "no-cors" and will NOT match the hydrator's fetch(), whose default is
  // "cors". The two would not dedupe and the page would fetch each fragment
  // TWICE, turning a latency win into an extra request for every visitor.
  for (const href of ["/photos/grid.html", "/rn/tracks.html"]) {
    assert.match(page, new RegExp(
      `<link rel="preload" as="fetch" href="${href}" crossorigin>`),
      `${href} must be preloaded with crossorigin, or its hydrator fetch is made twice`);
  }

  // A preload can only ever be free while the fetch it names is UNCONDITIONAL.
  // The tracks hydrator is guarded on data-ssr="0", which is currently vacuous
  // because the worker no longer server-renders the playlist at all. If SSR ever
  // comes back, the guard starts declining and this preload starts paying for a
  // fragment nobody fetches, so pin the premise rather than trust the comment:
  // the last two times this stopped being true, only the comments knew.
  assert.match(page, /<ol class="np-list" id="np-list" data-ssr="0">/,
    "the document must ship data-ssr='0', or the preloaded fragment goes unfetched");
  const workerDir = new URL("holding/_worker.js/", import.meta.url);
  for (const file of await readdir(workerDir)) {
    if (!file.endsWith(".js")) continue;
    const src = await readFile(new URL(file, workerDir), "utf8");
    assert.doesNotMatch(src, /SSR_DEADLINE_MS|serveHomepageWithPrerenderedTracks/,
      `${file} reintroduces homepage SSR; revisit the /rn/tracks.html preload and the comments that call the fetch unconditional`);
  }
});

test("homepage selects 12 photos and transfers all of them", async () => {
  const worker = await readFile(new URL("holding/_worker.js/home.js", import.meta.url), "utf8");
  const page = await readFile(new URL("holding/index.html", import.meta.url), "utf8");
  const luna = await readFile(new URL("holding/luna.css", import.meta.url), "utf8");
  const nav = await readFile(new URL("holding/nav.js", import.meta.url), "utf8");
  const hoist = await readFile(new URL("holding/hoist.js", import.meta.url), "utf8");
  const tooltip = await readFile(new URL("holding/tooltip.js", import.meta.url), "utf8");

  const build = await readFile(new URL("build.mjs", import.meta.url), "utf8");
  assert.match(worker, /pickRandom\(pool,\s*12\)/, "the per-request random draw must remain 12");
  assert.match(build, /deterministicTwelve/, "the document must carry a baked fallback grid, or `/` stops being crawlable without JS");
  // The two renderings differ in exactly one way, so assert on the OUTPUT
  // rather than on the source that produces it.
  const photo = [{ stem: "X1", full: "X1.jpg", thumb_jpg: "/i/X1.aaaaaaaa.jpg", thumb_avif: "/i/X1.aaaaaaaa.avif", thumb_small: "/i/X1-400.aaaaaaaa.avif", size: 1, uploaded: "2026-01-01" }];
  const baked = renderPhotoSlots(photo, {});
  const fragment = renderPhotoSlots(photo, {}, { deferred: false });

  // Baked: a fallback the hydrator replaces, so a real src outside the
  // <noscript> twin is a thumbnail fetched and discarded milliseconds later.
  assert.match(baked, /data-photo-deferred/, "baked tiles must keep their URLs in data-* until hydration decides");
  assert.match(baked, /data-src="\/i\/X1-400\.aaaaaaaa\.avif"/, "the baked tile carries its one 400px AVIF in data-src");
  assert.match(baked, /<noscript><img/, "every baked tile needs its script-off twin");
  assert.doesNotMatch(baked.slice(0, baked.indexOf("<noscript>")), /\ssrc="/,
    "a real src outside the noscript twin is a discarded download");

  // Fragment: these tiles ARE the grid. Nothing replaces them, so they carry
  // live URLs and start on innerHTML.
  assert.match(fragment, /\ssrc="\/i\/X1-400\.aaaaaaaa\.avif"/, "the fragment tile must carry its live 400px AVIF");
  assert.doesNotMatch(fragment, /<picture|<source|srcset=|\ssrc="[^"]+\.jpg"/,
    "one grid tile must expose one browser image resource, with no JPEG fallback to churn on hover");
  assert.doesNotMatch(fragment, /data-photo-deferred|data-src=|data-srcset=/,
    "a fragment tile has nothing to defer for; leaving it deferred is how the grid went blank in an unrendered tab");
  assert.doesNotMatch(fragment, /<noscript>/, "the fragment only ever arrives via fetch(), so a script-off twin is dead bytes");
  assert.match(worker, /\{ deferred: false \}/, "/photos/grid.html must render the live-URL form");

  // Priority is split WITHIN the grid, and the two halves fail differently.
  // The CEILING is the #156 invariant: the LCP element is the prose, so no tile
  // may ever be raised to high. The FLOOR is the reason the split exists: one
  // urgency bucket for all twelve is what makes the edge round-robin them, and
  // AVIF has no progressive mode, so an interleaved tile paints nothing until
  // it is whole. Assert the exact PARTITION rather than a count, because six
  // low tiles in the wrong six is the same bug wearing the right total.
  const twelve = Array.from({ length: 12 }, (_, i) => ({ ...photo[0], stem: `X${i}`, full: `X${i}.jpg` }));
  const grid12 = renderPhotoSlots(twelve, {}, { deferred: false });
  const tiles = grid12.split("<a href=").slice(1);
  assert.equal(tiles.length, 12, "the fragment must render all twelve tiles");
  assert.deepEqual(
    tiles.map((t) => /fetchpriority="low"/.test(t)),
    [false, false, false, false, false, false, true, true, true, true, true, true],
    "the first six tiles ride the default urgency and the last six stay low; flattening that back to one bucket restores the fair-share interleave",
  );
  assert.doesNotMatch(grid12, /fetchpriority="high"/,
    "no photo may outrank the introductory prose, which is the measured LCP element at 390px and 1280px alike");

  // A → B → A must move A's already-loaded nodes back into the shared surface,
  // not parse a third image element. The HAR that motivated this recorded up to
  // 13 memory-cache image loads for one photo and repeated album/artist AVIFs.
  assert.match(hoist, /const rendered = new Map\(\)/);
  assert.match(hoist, /node\.replaceChildren\(\.\.\.children\)/);
  assert.doesNotMatch(hoist, /node\.innerHTML\s*=\s*html/);
  assert.doesNotMatch(tooltip, /<picture><source type="image\/avif"|dataset\.(?:track|artist)Imageset/,
    "album and artist cards must not reconstruct a picture fallback set");

  // The hover target includes the list padding and the grid gutters. Those used
  // to alternate auto/pointer under a moving cursor even though one hover system
  // owned the whole region.
  assert.match(page, /\.photos\s*\{[^}]*cursor:\s*pointer/s);
  assert.match(luna, /\.np-list li\[data-track-title\]\s*\{\s*cursor:\s*pointer;\s*\}/);

  assert.doesNotMatch(worker, /rel="preload" as="image"/, "a non-LCP random photo must not consume the preload lane");
  assert.match(page, /fetch\("\/photos\/grid\.html"\)/, "the homepage must hydrate its random twelve");
  assert.match(page, /\.catch\(\(\) => \{\}\)\s*\.then\(boot\)/, "a failed grid fetch must still hydrate the baked tiles");
  // Removed 2026-07-29. It withheld 3 of 12 tiles to save ~34 KB out of ~136 KB,
  // and the 9 it allowed finished 48ms apart, so the row it held back showed up
  // as white squares on the first scroll for no measurable gain.
  // Matches the construction, not the word, so the comment explaining why the
  // observer is gone does not trip its own tripwire.
  assert.doesNotMatch(page, /new IntersectionObserver|rootMargin:/,
    "the photo grid must not reintroduce viewport gating; the whole set is ~136 KB off the LCP path, and the urgency split is what orders it now");
  assert.doesNotMatch(page, /requestIdleCallback\(load/, "the tooltip island must not transfer before hover intent");
  assert.match(nav, /getElementById\("axp-desktop"\).*getElementById\("axp-taskbar"\)/, "every server-rendered shell must opt into post-paint enhancement");
  assert.match(nav, /D\.prerendering\) return boot\(\)/, "prerendered static shells must enhance before activation");
  assert.match(nav, /requestAnimationFrame\(\(\) => requestAnimationFrame\(boot\)\)/, "ordinary static shell enhancement must follow the first useful paint");
  assert.ok(
    page.indexOf('type="application/ld+json"') > page.indexOf('<section class="now-playing"'),
    "non-rendering JSON-LD belongs after the visible homepage content",
  );
  assert.match(luna, /homepage music island \(below the fold\)/);
  assert.match(luna, /homepage hover island \(non-critical\)/);
});

test("robots.txt never forbids a path the site advertises to agents", async () => {
  // Found by a Cloudflare agent-readiness scan on 2026-08-07, which counted
  // </rn/tracks>; rel="service-desc" toward a discoverability PASS while
  // robots.txt carried `Disallow: /rn/tracks`. Sixteen conflicts across six
  // surfaces at the time. Both sides are this site's own declarations, so one of
  // them was always going to be a lie, and neither side can see the other.
  //
  // The rule is about FETCHING, not indexing: a path that should stay out of a
  // search index says so with X-Robots-Tag, which a crawler can only read if it
  // is allowed to fetch the response carrying it.
  const read = (p) => readFile(new URL(p, import.meta.url), "utf8");
  const robots = await read("holding/robots.txt");

  const disallowed = [...new Set(
    robots.split("\n").filter((l) => /^Disallow:/i.test(l)).map((l) => l.slice(9).trim()),
  )];
  assert.ok(disallowed.length, "robots.txt must still carry Disallow rules");
  // The action endpoints. Nothing advertises them and nothing should.
  assert.deepEqual(disallowed.sort(), ["/lwe/ask", "/rn/admin", "/rn/set"]);

  const { HOMEPAGE_DISCOVERY_LINK } = await import("./holding/_worker.js/lib/security.js");
  const surfaces = {
    "the homepage Link header": HOMEPAGE_DISCOVERY_LINK,
    "_headers":                 await read("holding/_headers"),
    ".well-known/api-catalog":  await read("holding/.well-known/api-catalog"),
    "agent-card.json":          await read("holding/.well-known/agent-card.json"),
    "auth.md":                  await read("holding/auth.md"),
    "llms.txt":                 await read("holding/llms.txt"),
  };

  for (const [name, text] of Object.entries(surfaces)) {
    const advertised = new Set();
    // absolute URLs (auth.md, llms.txt, the JSON catalogs) …
    for (const m of text.matchAll(/https:\/\/aadhar\.sh(\/[^\s"'`)>,]*)/g)) advertised.add(m[1]);
    // … and RFC 8288 Link targets, which are relative here
    for (const m of text.matchAll(/<(\/[^\s">]*)>\s*;\s*rel=/g)) advertised.add(m[1]);
    for (const path of advertised) {
      // robots.txt prefix semantics: /around also covers /around/json. Match the
      // separator too, so /aroundabout would not count as blocked by /around.
      const rule = disallowed.find((d) => path === d || path.startsWith(`${d}/`) || path.startsWith(`${d}.`));
      assert.ok(!rule, `${name} advertises ${path}, which robots.txt blocks with Disallow: ${rule}`);
    }
  }
});

test("the RUM beacon is first-party on both legs, and every page that says so agrees", async () => {
  const page = await readFile(new URL("holding/index.html", import.meta.url), "utf8");
  const headers = await readFile(new URL("holding/_headers", import.meta.url), "utf8");
  const security = await readFile(new URL("holding/_worker.js/lib/security.js", import.meta.url), "utf8");
  const whoareyou = await readFile(new URL("holding/_worker.js/whoareyou.js", import.meta.url), "utf8");
  const securityPage = await readFile(new URL("holding/_worker.js/security.js", import.meta.url), "utf8");

  // Both legs. The script alone is not enough: without send.to the beacon falls
  // back to its hardcoded cloudflareinsights.com endpoint, which the CSP below now
  // blocks — so the script would load and every report would silently fail.
  assert.match(page, /<script type="module" src="\/ledger\/rum\.js"/, "the beacon script must be served from this origin");
  assert.match(page, /"send": \{"to": "\/ledger\/rum"\}/, "the beacon must be told to report to this origin too");
  assert.doesNotMatch(page, /src="https:\/\/static\.cloudflareinsights\.com/, "no cross-origin beacon script");

  // The CSP must not keep permitting an origin nothing calls any more. _headers is
  // matched as TEXT (it is a literal header line). security.js is matched on the
  // policy it ASSEMBLES, because the per-document script-src work split the string
  // into pieces and a source scrape would now be checking punctuation instead of
  // the thing that reaches the browser. `/unmapped` deliberately misses the hash
  // map, so this is the fallback policy every live worker page still gets.
  const { cspHeadersFor } = await import("./holding/_worker.js/lib/security.js");
  const assembled = cspHeadersFor("/unmapped-probe")["content-security-policy"];
  for (const [name, text] of [["_headers", headers], ["lib/security.js", assembled]]) {
    const policy = (text.match(/default-src 'self';[^"\n]*upgrade-insecure-requests/) || [])[0];
    assert.ok(policy, `${name} must still declare a CSP`);
    assert.doesNotMatch(policy, /cloudflareinsights\.com/, `${name}: drop the beacon's old third-party CSP entries`);
    assert.match(policy, /connect-src 'self';/, `${name}: connect-src should be back to pure 'self'`);
    assert.match(policy, /script-src 'self' 'unsafe-inline';/, `${name}: script-src should carry no external origin`);
    // Same rule, one directive over: album art is re-hosted behind /rn/art/, so
    // the two Spotify hosts that used to sit in img-src have nothing left to
    // serve. rn.js's artAttrs is what makes this safe (it emits no attribute for
    // art it cannot re-host) and the rn test asserts that end.
    assert.match(policy, /img-src 'self' data:;/, `${name}: img-src should be this origin only`);
    assert.doesNotMatch(policy, /scdn\.co|spotifycdn\.com/, `${name}: album art is first-party now`);
  }

  // The honesty surfaces. A CSP that quietly disagrees with the page describing it
  // is the failure this repo keeps designing against, and "first-party" is the
  // easiest claim on this site to round up into a privacy win it is not. Both pages
  // must keep saying that the forwarding still happens.
  assert.match(whoareyou, /\/ledger\/rum\.js/, "/whoareyou must name the first-party beacon paths");
  assert.match(whoareyou, /forwards those timings to Cloudflare/,
    "/whoareyou must keep stating that the reporting did not stop, it moved server-side");
  assert.match(whoareyou, /content blocker, the report it used to stop now gets through/,
    "/whoareyou must keep disclosing what proxying costs a blocker-running visitor");
  assert.match(securityPage, /it does not mean nothing is forwarded from here/,
    "/security must not let 'no external origin' imply nothing leaves this server");
});

test("weak validators turn unchanged rendered HTML into an empty 304", async () => {
  const tagged = await withWeakEtag(new Response("<!doctype html><p>same</p>", {
    headers: { "content-type": "text/html", "cache-control": "public, max-age=0", "content-encoding": "br" },
  }));
  const etag = tagged.headers.get("etag");
  assert.match(etag, /^W\/"sha256-[0-9a-f]{64}"$/);
  assert.equal(ifNoneMatchMatches(new Request("https://aadhar.sh/x", { headers: { "if-none-match": etag } }), etag), true);
  assert.equal(ifNoneMatchMatches(new Request("https://aadhar.sh/x", { headers: { "if-none-match": etag.replace(/^W\//, "") } }), etag), true);
  const notModified = notModifiedIfFresh(new Request("https://aadhar.sh/x", {
    headers: { "if-none-match": `"old", ${etag}` },
  }), tagged);
  assert.equal(notModified.status, 304);
  assert.equal(notModified.headers.get("etag"), etag);
  assert.equal(notModified.headers.get("content-encoding"), null);
  assert.equal(await notModified.text(), "");
});

test("cached renders stream the first miss while tagging the background copy", async () => {
  const priorCaches = globalThis.caches;
  const stored = [];
  globalThis.caches = {
    default: {
      match: async () => undefined,
      put: async (_key, response) => {
        stored.push({ response, body: await response.text() });
      },
    },
  };
  const pending = [];
  try {
    const first = await cachedRender(
      new Request("https://aadhar.sh/whoareyou"),
      { waitUntil: (promise) => pending.push(promise) },
      async () => new Response("rendered", { headers: { "content-type": "text/html" } }),
      "/whoareyou",
      { CF_VERSION_METADATA: { id: "test" } },
    );
    assert.equal(first.headers.get("etag"), null, "the miss does not buffer before sending");
    assert.equal(await first.text(), "rendered");
    assert.equal(pending.length, 1);
    await Promise.all(pending);
    assert.match(stored[0].response.headers.get("etag"), /^W\//);
    assert.equal(stored[0].body, "rendered");
  } finally {
    if (priorCaches === undefined) delete globalThis.caches;
    else globalThis.caches = priorCaches;
  }
});

// The twin converter reads each page's own inline CSS to find elements the page
// takes out of the inline flow, because otherwise their text welds together. It
// looked only at the element's OWN display, which a flex or grid ITEM never
// declares: its box comes from the parent. /updates converted
// `<span class=wu-tag>hit-route</span><span class=wu-desc>counter tick …</span>`
// into "hit-routecounter tick …", a string that appears nowhere on the page.
//
// buildTwins and friends were imported here and never called, so this file
// asserted nothing about any of it. Same shape as the quiz test CLAUDE.md
// describes, which read the wrong field names and passed while checking nothing.
test("a flex item is its own box, and promoting one never eats an image", () => {
  const page = (style, body) =>
    `<html><head><title>T</title><style>${style}</style></head><body><main>${body}</main></body></html>`;

  // the /updates shape: the item declares `flex`, never `display`
  const welded = readDocument(
    page(".tag{flex:0 0 92px}", "<p><span class=tag>hit-route</span><span>counter tick endpoint renamed</span></p>"),
    { origin: "https://aadhar.sh" });
  assert.doesNotMatch(welded.body, /hit-routecounter/, "a flex item must not weld onto the text after it");
  assert.match(welded.body, /hit-route/);
  assert.match(welded.body, /counter tick endpoint renamed/);

  // the /lwe/encoding regression: an <img> carrying a flex-item class renders as
  // a token already, and the block path has no case for it, so promoting it drops
  // the image entirely.
  const withImage = readDocument(
    page(".pic{flex:0 0 auto}", '<p>before<img src="/enc/c.jpg" alt="sample photo" class="pic">after</p>'),
    { origin: "https://aadhar.sh" });
  assert.match(withImage.body, /!\[sample photo\]\(https:\/\/aadhar\.sh\/enc\/c\.jpg\)/,
    "an image must survive its class being promoted out of the inline flow");

  // container properties say nothing about THIS element and must not promote it
  const container = readDocument(
    page(".row{flex-direction:row;flex-flow:wrap}", "<p><span class=row>alpha</span><span>beta</span></p>"),
    { origin: "https://aadhar.sh" });
  assert.match(container.body, /alphabeta|alpha beta/, "flex-direction/flex-flow describe children, not this box");

  // and the original heuristic still holds
  assert.ok(collectBlockClasses("<style>.x{display:block}.y{float:right}.z{flex:1}</style>").size >= 3);
});

// RFC 9110 asks a HEAD to send the header fields its GET would send. serveStaticPage
// bailed on the method before reaching the Markdown branch, so HEAD answered
// text/html on pages whose GET answers text/markdown. Verified on production
// 2026-07-31 (GET /garage/encoding -> text/markdown, HEAD -> text/html), which is
// also a convincing false positive for the #195 cache bug because `curl -I` is the
// reflex probe.
// The homepage was the last route answering HEAD from a hand-written header set,
// and the one header it dropped was x-markdown-tokens. It hid because `/` is
// workers-cacheable: a plain HEAD is satisfied from the stored GET entry and never
// runs the duplicate, so the only path that DID run it was the markdown one, which
// bails the cache. The unwatched path is the one that drifted.
test("the homepage HEAD carries the token count its GET sends", async () => {
  const env = {
    ASSETS: {
      async fetch(input) {
        const path = new URL(typeof input === "string" ? input : input.url).pathname;
        if (path === "/index.md") return new Response("# aadhar.sh\n\nsome prose about the site");
        return new Response("<h1>aadhar.sh</h1>", { headers: { "content-type": "text/html" } });
      },
    },
  };
  const md = { accept: "text/markdown" };
  const get = await serveMarkdown(new Request("https://aadhar.sh/", { headers: md }), env);
  const head = await serveMarkdown(new Request("https://aadhar.sh/", { method: "HEAD", headers: md }), env);

  assert.equal(head.headers.get("x-markdown-tokens"), get.headers.get("x-markdown-tokens"));
  assert.ok(Number(head.headers.get("x-markdown-tokens")) > 0, "a token count of zero is not a count");
  assert.equal(await head.text(), "", "a HEAD carries no body");
  for (const name of ["content-type", "cache-control", "vary", "link", "x-content-type-options"]) {
    assert.equal(head.headers.get(name), get.headers.get(name), `HEAD and GET must agree on ${name}`);
  }
  // the homepage's own discovery links are the one thing this route adds over the
  // shared negotiated response, so losing them in the delegation would be silent
  assert.match(get.headers.get("link") || "", /rel="sitemap"/);
  // and the negotiated representation must stay uncacheable, per the edge's per-URL key
  assert.match(get.headers.get("cache-control"), /no-store/);
});

test("HEAD advertises the same representation its GET would serve", async () => {
  const env = {
    ASSETS: {
      async fetch(input) {
        const path = new URL(typeof input === "string" ? input : input.url).pathname;
        if (path === "/garage/encoding.md") return new Response("# Encoding\n\nbody text here");
        if (path === "/garage/encoding") return new Response("<h1>Encoding</h1>", { headers: { "content-type": "text/html" } });
        return new Response("not found", { status: 404 });
      },
    },
  };
  const md = { accept: "text/markdown" };
  const get = await serveStaticPage(new Request("https://aadhar.sh/garage/encoding", { headers: md }), env);
  const head = await serveStaticPage(new Request("https://aadhar.sh/garage/encoding", { method: "HEAD", headers: md }), env);

  assert.equal(get.headers.get("content-type"), "text/markdown; charset=utf-8");
  assert.equal(head.headers.get("content-type"), "text/markdown; charset=utf-8",
    "HEAD must not advertise HTML for a URL whose GET negotiates Markdown");
  assert.equal(head.status, 200);
  assert.equal(await head.text(), "", "a HEAD carries no body");

  // The whole header set, not just the content-type: a HEAD that agreed on the media
  // type but disagreed on freshness would be the same class of lie.
  for (const name of ["cache-control", "vary", "x-markdown-tokens", "x-content-type-options"]) {
    assert.equal(head.headers.get(name), get.headers.get(name), `HEAD and GET must agree on ${name}`);
  }
  assert.equal(head.headers.get("x-markdown-tokens"), get.headers.get("x-markdown-tokens"));

  // A HEAD that is NOT negotiating still takes the asset layer, exactly as before.
  const plain = await serveStaticPage(new Request("https://aadhar.sh/garage/encoding", { method: "HEAD" }), env);
  assert.equal(plain.status, 200);
  assert.match(plain.headers.get("content-type"), /text\/html/);
});

test("static page negotiation prefers 304, then DCZ with the current validator", async () => {
  const digest = Buffer.alloc(32, 1);
  const tag = digest.toString("hex").slice(0, 16);
  const available = `:${digest.toString("base64")}:`;
  const makeEnv = (cacheControl) => ({
    ASSETS: {
      async fetch(input) {
        const path = new URL(typeof input === "string" ? input : input.url).pathname;
        if (path === "/lwe/drivers.html.br") {
          return new Response("brotli bytes", {
            headers: {
              "etag": '"page"',
              "cache-control": cacheControl,
              "link": "</shell.css>; rel=preload; as=style",
            },
          });
        }
        if (path === `/pd/lwe__drivers.${tag}.dcz`) {
          return new Response("delta bytes", { headers: { "cache-control": "public, max-age=0" } });
        }
        return new Response("not found", { status: 404 });
      },
    },
  });
  const env = makeEnv("public, max-age=0, s-maxage=86400");
  const currentBr = 'W/"page-br"';
  const currentDcz = 'W/"page-dcz"';
  const unchanged = await serveStaticPage(new Request("https://aadhar.sh/lwe/drivers", {
    headers: { "if-none-match": currentBr, "available-dictionary": available },
  }), env);
  assert.equal(unchanged.status, 304);
  assert.equal(unchanged.headers.get("etag"), currentBr);

  const changed = await serveStaticPage(new Request("https://aadhar.sh/lwe/drivers", {
    headers: { "if-none-match": '"old"', "available-dictionary": available },
  }), env);
  assert.equal(changed.status, 200);
  assert.equal(changed.headers.get("content-encoding"), "dcz");
  assert.equal(changed.headers.get("etag"), currentDcz);
  assert.equal(changed.headers.get("cache-control"), "public, max-age=0, s-maxage=86400");
  assert.equal(changed.headers.get("link"), "</shell.css>; rel=preload; as=style");
  assert.equal(changed.headers.get("vary"), "accept-encoding, available-dictionary");

  const dczUnchanged = await serveStaticPage(new Request("https://aadhar.sh/lwe/drivers", {
    headers: { "if-none-match": currentDcz, "available-dictionary": available },
  }), env);
  assert.equal(dczUnchanged.status, 304);
  assert.equal(dczUnchanged.headers.get("etag"), currentDcz);

  // A page offers ITSELF as a dictionary only when its cache-control lets the browser
  // keep the offer. Chromium sizes a registered dictionary's lifetime from the response's
  // own freshness, so an offer on a stale-on-arrival response is stored already-expired
  // and dropped, costing a DevTools error per navigation and buying nothing. Measured in
  // Chrome 2026-07-29 across seven policies; the table is in lib/assets.js.
  for (const cc of [
    "public, max-age=0, s-maxage=86400",                       // today's page policy
    "public, max-age=0, must-revalidate, s-maxage=86400",
    "max-age=0, must-revalidate, stale-while-revalidate=604800", // must-revalidate wins
    "private, no-cache, must-revalidate",                      // `/` until 2026-07-31
    "no-store",
  ]) {
    const res = await serveStaticPage(new Request("https://aadhar.sh/lwe/drivers", {
      headers: { "available-dictionary": available },
    }), makeEnv(cc));
    assert.equal(res.headers.get("use-as-dictionary"), null, `must not self-offer under "${cc}"`);
  }
  // ...and it comes back on its own if a page is ever given a policy that survives to the
  // moment of use. stale-while-revalidate is RFC 5861's permission to serve stale, which
  // is the second arm of RFC 9842's "fresh or allowed to be served stale".
  for (const cc of ["public, max-age=600", "public, max-age=0, stale-while-revalidate=604800"]) {
    const res = await serveStaticPage(new Request("https://aadhar.sh/lwe/drivers", {
      headers: { "available-dictionary": available },
    }), makeEnv(cc));
    assert.equal(res.headers.get("use-as-dictionary"),
                 'match="/lwe/drivers", match-dest=("document")', `must self-offer under "${cc}"`);
  }

  // The policy every deploy-time document actually ships has to be one of those, or the
  // whole per-page tier (its /pd/ deltas, its committed p-dict snapshots, its build time)
  // is spent on offers no browser keeps. Pinned against the live constant rather than a
  // copy, so editing the policy runs this check instead of quietly bypassing it.
  const { PAGE_CACHE_CONTROL } = await import("./holding/_worker.js/lib/const.js");
  const shipped = await serveStaticPage(new Request("https://aadhar.sh/lwe/drivers", {
    headers: { "available-dictionary": available },
  }), makeEnv(PAGE_CACHE_CONTROL));
  assert.equal(shipped.headers.get("use-as-dictionary"),
               'match="/lwe/drivers", match-dest=("document")',
               `PAGE_CACHE_CONTROL must register as a dictionary, got "${PAGE_CACHE_CONTROL}"`);
  // swr is the clause doing that work AND the registered dictionary's lifetime, so a
  // future trim below a day would keep every assertion above green while shortening how
  // long the tier keeps working. Measured 2026-07-29: swr=5 registered nothing.
  const swr = Number(PAGE_CACHE_CONTROL.match(/stale-while-revalidate=(\d+)/)?.[1] || 0);
  assert.ok(swr >= 86400, `PAGE_CACHE_CONTROL needs a useful dictionary lifetime, got swr=${swr}`);
});

test("LWE pages share one base stylesheet and the build derives one site-page dictionary", async () => {
  const base = await readFile(new URL("holding/lwe-base.css", import.meta.url), "utf8");
  assert.match(base, /\.controls \{ display: inline-flex/);
  const build = await readFile(new URL("build.mjs", import.meta.url), "utf8");
  assert.match(build, /site-page corpus/);
  assert.match(build, /page-family\.\$\{hash8\(dictionary\)\}\.dict/);
  assert.match(build, /holding\/p-dict/);
  assert.match(build, /site-page dictionary/);
  const assetIgnore = await readFile(new URL("holding/.assetsignore", import.meta.url), "utf8");
  assert.match(assetIgnore, /^p-dict$/m, "page dictionary snapshots stay build input, not public assets");
  const security = await readFile(new URL("holding/_worker.js/lib/security.js", import.meta.url), "utf8");
  assert.match(security, /rel="compression-dictionary"/);
  for (const name of ["index", "dac", "drivers", "encoding", "fhe", "knots", "mpc", "pcrypto", "tee", "utf8", "vigenere"]) {
    const html = await readFile(new URL(`holding/lwe/${name}.html`, import.meta.url), "utf8");
    assert.match(html, /<link rel="stylesheet" href="\/lwe-base\.css">/);
    assert.doesNotMatch(html, /compression-dictionary/);
    assert.doesNotMatch(html.match(/<style>([\s\S]*?)<\/style>/)?.[1] || "", /\.controls \{ display: inline-flex/);
  }
});

// ── the SSR deadline ────────────────────────────────────────────────
// deadline() is what keeps a KV eviction (100-200ms, untunable) from gating
// homepage TTFB. Two properties are load-bearing: a fast read never marks
// itself deadlined (the timer is cleared on settle), and a slow read's
// fallback arrives at the budget while the underlying promise keeps running
// (so the read still warms the colo behind the response).
test("deadline lets a fast read through unmarked", async () => {
  let marked = false;
  const v = await deadline(Promise.resolve("fast"), 50, null, () => { marked = true; });
  assert.equal(v, "fast");
  // give the (cleared) timer a chance to prove it was cleared
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(marked, false, "a settled read must never be marked deadlined");
});

test("deadline ships the fallback at the budget and leaves the read running", async () => {
  let marked = false;
  let settled = false;
  const slow = new Promise((r) => setTimeout(() => { settled = true; r("late"); }, 60));
  const t0 = Date.now();
  const v = await deadline(slow, 15, "fallback", () => { marked = true; });
  assert.equal(v, "fallback");
  assert.equal(marked, true);
  assert.ok(Date.now() - t0 < 55, "fallback must arrive at the budget, not at the read");
  assert.equal(settled, false, "the read must still be in flight when the fallback ships");
  await slow;
  assert.equal(settled, true, "the abandoned read still completes");
});

test("deadline distinguishes fallback values for slow vs missing", async () => {
  // counter semantics: null = a real miss (triggers the mirror reseed),
  // undefined = merely slow (must NOT trigger it)
  const missing = await deadline(Promise.resolve(null), 50, undefined, () => {});
  assert.equal(missing, null);
  const slow = await deadline(new Promise(() => {}), 10, undefined, () => {});
  assert.equal(slow, undefined);
});

test("whoareyou lets cold RDAP finish off the critical path", async () => {
  const originalFetch = globalThis.fetch;
  let release;
  globalThis.fetch = () => new Promise((resolve) => { release = resolve; });
  const background = [];
  const started = Date.now();
  try {
    const result = await gatherWhoareyou(
      new Request("https://aadhar.sh/whoareyou", { headers: { "cf-connecting-ip": "203.0.113.7" } }),
      { waitUntil(promise) { background.push(promise); } },
    );
    assert.equal(result.rdap, null, "a cold enrichment should not delay the page");
    assert.ok(Date.now() - started < 1000, "the optional lookup must leave well before its 2s network abort");
    assert.equal(background.length, 1, "the same lookup should keep running to warm Cloudflare's edge cache");

    release(new Response(JSON.stringify({ name: "TEST-NET-3" }), {
      headers: { "content-type": "application/rdap+json" },
    }));
    await background[0];
  } finally {
    globalThis.fetch = originalFetch;
  }
});


// ── the /hit beacon ─────────────────────────────────────────────────
// The counter's Durable Object is a single global instance, so reaching it costs
// a real round trip (185-308ms from SJC; 630ms observed on a cold contended
// load). The ?tick=1 beacon discards the number, so it must not wait for one —
// but the tick still has to happen, which is what waitUntil buys. The SVG shape
// DOES need the number, so it must keep waiting. These two tests pin that split;
// collapsing either direction is a real regression.
function slowCounter() {
  let release;
  const gate = new Promise((r) => { release = r; });
  const seen = [];
  return {
    release,
    seen,
    env: {
      COUNTER: {
        idFromName: () => "homepage-visits",
        get: () => ({
          async fetch(u) { seen.push(new URL(u).search); await gate; return Response.json({ n: 41 }); },
        }),
      },
    },
  };
}

test("the /hit beacon answers 204 without waiting on the Durable Object", async () => {
  const { env, seen, release } = slowCounter();
  const kept = [];
  const ctx = { waitUntil: (p) => kept.push(p) };

  const res = await handleHit(new Request("https://aadhar.sh/hit?tick=1"), env, ctx);
  assert.equal(res.status, 204);
  assert.equal(res.headers.get("cache-control"), "no-store");
  assert.equal(seen.length, 1, "the tick must still be initiated, not skipped");
  assert.equal(seen[0], "", "a real beacon advances the count (no ?peek)");
  assert.equal(kept.length, 1, "the unfinished DO trip must be handed to waitUntil");

  release();
  await kept[0];   // and it still completes behind the response
});

test("the /hit beacon still ticks when there is no ctx to defer onto", async () => {
  const { env, seen, release } = slowCounter();
  release();   // resolve immediately; without a ctx the handler must await it
  const res = await handleHit(new Request("https://aadhar.sh/hit?tick=1"), env, undefined);
  assert.equal(res.status, 204);
  assert.equal(seen.length, 1, "no ctx must mean await, never a dropped tick");
});

test("the /hit odometer waits for the number it renders", async () => {
  const { env, release } = slowCounter();
  const ctx = { waitUntil: () => {} };
  let settled = false;
  const pending = handleHit(new Request("https://aadhar.sh/hit"), env, ctx).then((r) => { settled = true; return r; });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(settled, false, "the SVG shape must not answer before the DO does");
  release();
  const res = await pending;
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") || "", /^image\/svg\+xml/);
  assert.match(await res.text(), /000041/, "the odometer renders the DO's number");
});

test("a peeking /hit reads without advancing, in either shape", async () => {
  for (const [label, req] of [
    ["prefetch", new Request("https://aadhar.sh/hit?tick=1", { headers: { "sec-purpose": "prefetch;prerender" } })],
    ["bot", new Request("https://aadhar.sh/hit", { headers: { "user-agent": "ClaudeBot/1.0" } })],
  ]) {
    const { env, seen, release } = slowCounter();
    release();
    const kept = [];
    await handleHit(req, env, { waitUntil: (p) => kept.push(p) });
    await Promise.all(kept);
    assert.equal(seen[0], "?peek=1", `${label} must peek, never advance`);
  }
});


// ── the perf probe ──────────────────────────────────────────────────
// The probe's value is that its numbers mean what home.js's Server-Timing
// means. The parser is the seam: if it misreads a span or drops a deadline
// mark, the AE series lies quietly. The datapoint's column order is part of
// the contract too — AE columns are positional, so a reorder here scrambles
// every already-written row's meaning.
test("parseServerTiming reads spans, deadline marks, and survives junk", () => {
  const { spans, deadlined } = parseServerTiming(
    "assets;dur=5, tracks;dur=25;desc=deadline, alt;dur=0, counter;dur=7, total;dur=25",
  );
  assert.deepEqual(spans, { assets: 5, tracks: 25, alt: 0, counter: 7, total: 25 });
  assert.deepEqual(deadlined, ["tracks"]);
  // junk in, nothing invented out
  assert.deepEqual(parseServerTiming(null), { spans: {}, deadlined: [] });
  assert.deepEqual(parseServerTiming("garbage"), { spans: {}, deadlined: [] });
  assert.deepEqual(parseServerTiming("x;dur=NaN, ;dur=3").spans, {});
});

test("the probe writes one positionally-stable datapoint and never throws", async () => {
  // no PERF_PROBE binding -> a clean no-op, so preview/dev without the dataset
  // cannot crash the scheduled() handler
  await cronHomeProbe({}, { waitUntil() {} });

  // The probe used to dispatch the homepage SSR, which needed ASSETS +
  // HTMLRewriter, so a bindingless env was itself the "broken render" case and
  // this asserted the resulting gap. `/` is a static document now and the probe
  // follows the two fragments instead; the photo grid answers from the BUNDLED
  // pool, so it succeeds with no bindings at all and there is no longer an env
  // that fails both arms by omission. The write-nothing rule still holds in the
  // code (both arms null -> early return), it just cannot be provoked this way.
  //
  // So assert what this env can actually prove: exactly one datapoint, with the
  // positional arity Analytics Engine reads by index. A column silently
  // appearing or vanishing is the failure that corrupts a whole dataset.
  const written = [];
  const env = { PERF_PROBE: { writeDataPoint: (d) => written.push(d) } };
  await cronHomeProbe(env, { waitUntil() {} });
  assert.equal(written.length, 1, "a working probe writes exactly one datapoint");
  const [dp] = written;
  assert.equal(dp.doubles.length, 5, "doubles are positional: [assets, tracks, alt, counter, total]");
  assert.ok(dp.doubles.every((v) => typeof v === "number"), "every double must be a real number");
  assert.equal(dp.blobs.length, 2, "blobs are positional: [deadlined CSV, version id]");
  assert.deepEqual(dp.indexes, ["home"]);
});

test("cron dispatch survives Cloudflare's expression normalization", () => {
  // The dispatcher used to exact-match event.cron against the strings in
  // wrangler.jsonc, but Cloudflare normalizes expressions between declaration
  // and delivery (day-of-week tokens especially), and the census schedule is
  // the only one carrying a day-of-week token: three straight Monday sweeps
  // fell into the else-branch and ran the /around crawl with nothing logged.
  // The rule now matches minute+hour signatures, which normalization leaves
  // alone. Both spellings of Monday must land on the census.
  assert.equal(cronJob("17 8 * * 1"), "census");
  assert.equal(cronJob("17 8 * * MON"), "census");
  assert.equal(cronJob("7,37 * * * *"), "home_probe");
  assert.equal(cronJob("41 5 * * *"), "webmention_send");
  assert.equal(cronJob("23 */6 * * *"), "serendipity");
  assert.equal(cronJob("*/30 * * * *"), "around");
  // Unknown expressions surface as null (a traced cron.unmatched event), never
  // as somebody else's job — that silent fallback is the bug class this fixes.
  assert.equal(cronJob("0 0 * * *"), null);
  assert.equal(cronJob(""), null);
  assert.equal(cronJob(null), null);
});

// The SSRF host floor is shared by /lens, webmention verification, and
// serendipity's cover proxy. It used to be two byte-identical copies
// (lensHostBlocked + coverHostBlocked); this pins the set so the one that is
// left cannot quietly narrow, which is the failure the duplication invited.
test("the shared SSRF host floor blocks every non-public shape", () => {
  const blocked = [
    "localhost", "app.localhost", "printer.local", "db.internal", "x.onion",
    "::1", "[::1]", "fc00::1", "fd12::9", "fe80::1",
    "0.0.0.0", "10.1.2.3", "127.0.0.1", "192.168.1.1",
    "169.254.169.254",                    // cloud metadata, the one that matters most
    "172.16.0.1", "172.31.255.254",       // RFC1918 lower + upper edge
    "100.64.0.1", "100.127.255.255",      // CGNAT lower + upper edge
    "224.0.0.1", "255.255.255.255",       // multicast / reserved
  ];
  for (const h of blocked) assert.equal(privateHostBlocked(h), true, `should block ${h}`);

  const allowed = [
    "aadhar.sh", "example.com", "8.8.8.8", "1.1.1.1",
    "172.15.0.1", "172.32.0.1",           // just OUTSIDE RFC1918's 172.16-31
    "100.63.0.1", "100.128.0.1",          // just OUTSIDE CGNAT's 100.64-127
    "223.255.255.255",                    // just below the multicast floor
    "localhost.example.com",              // ends in a real TLD, not a bare localhost
  ];
  for (const h of allowed) assert.equal(privateHostBlocked(h), false, `should allow ${h}`);
});

// Each shape below was measured passing this floor on 2026-08-07, so these are
// closed holes rather than hypotheticals. The v4-mapped rows are the ones worth
// keeping honest: the whole dotted-quad table was being skipped for an address
// spelled ::ffff:169.254.169.254, which is the metadata endpoint by another name.
test("the SSRF floor covers the alternate spellings of a blocked host", () => {
  const blocked = [
    "localhost.", "127.0.0.1.", "db.internal.",     // trailing dot is a legal FQDN
    "::", "[::]",                                    // unspecified address
    "::ffff:127.0.0.1", "[::ffff:169.254.169.254]",  // v4-mapped IPv6
    "::ffff:10.0.0.1", "::ffff:192.168.1.1",
    "fe81::1", "fe9f::1", "fea0::1", "febf::1",      // fe80::/10 is 64 prefixes, not one
    "LOCALHOST", "169.254.169.254.",                 // case and dot together
    "",                                              // an empty host resolves to nothing good
  ];
  for (const h of blocked) assert.equal(privateHostBlocked(h), true, `should block ${h}`);

  // Both spellings of a v4-mapped address, because the caller decides which one
  // this function sees and it is NOT the one written above.
  const mappedHex = ["::ffff:a9fe:a9fe", "::ffff:7f00:1", "::ffff:a00:1", "::ffff:c0a8:101"];
  for (const h of mappedHex) assert.equal(privateHostBlocked(h), true, `should block ${h}`);

  // The neighbours of the widened rules must still pass, or the fix overreached.
  const allowed = ["fec0::1", "ff00::1".replace("ff00", "2001"), "::ffff:8.8.8.8", "::ffff:808:808", "example.com."];
  for (const h of allowed) assert.equal(privateHostBlocked(h), false, `should allow ${h}`);
});

// THE regression, and the reason this test exists separately from the one above.
//
// `new URL("https://[::ffff:169.254.169.254]/").hostname` is `[::ffff:a9fe:a9fe]`
// — the WHATWG parser rewrites the dotted tail into hex groups. So the host this
// guard actually receives is never the host anybody types, and a floor tested
// only on the typed form reported a hole closed while it was open. Production
// answered `ok: true` for the metadata address on 2026-08-08, hours after the
// unit test above went green.
//
// Assert through validateLensTarget, which is the door every scan really uses.
test("a blocked address stays blocked through the URL parser that rewrites it", () => {
  const refused = [
    "https://[::ffff:169.254.169.254]/",   // cloud metadata, the one that matters
    "https://[::ffff:127.0.0.1]/",
    "https://[::ffff:10.0.0.1]/",
    "https://[::ffff:192.168.1.1]/",
    "https://[::]/",
    "https://[fe9f::1]/",
    "https://localhost./x",
  ];
  for (const raw of refused) {
    const verdict = validateLensTarget(raw);
    assert.equal(verdict.ok, false, `${raw} normalizes to ${(() => { try { return new URL(raw).hostname; } catch { return "unparseable"; } })()} and must be refused`);
  }
  // A public v4-mapped address is still a public address.
  assert.equal(validateLensTarget("https://[::ffff:8.8.8.8]/").ok, true);
});

// A scan republishes what it fetched, so a URL carrying credentials is refused
// rather than stripped: stripping would scan a different resource than the one
// that was typed, and pass the secret to the third party on the way.
test("lens targets refuse embedded credentials", () => {
  for (const raw of ["https://user:pass@example.com/", "https://user@example.com/", "https://:pass@example.com/"]) {
    assert.equal(validateLensTarget(raw).ok, false, `should refuse ${raw}`);
  }
  assert.equal(validateLensTarget("https://example.com/user:pass@notauth").ok, true, "a colon in the PATH is not a credential");
});

// The guard follows redirects one hop at a time so a public URL cannot bounce
// into private space. Before this, the request to the blocked host was still
// made; only the discovery fan-out that came after it was skipped.
test("redirect following validates every hop, not just the landing", async () => {
  const seen = [];
  const chain = {
    "https://example.com/start": { status: 302, location: "https://example.com/second" },
    "https://example.com/second": { status: 302, location: "http://169.254.169.254/latest/meta-data/" },
    "https://example.com/ok": { status: 200 },
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    seen.push(String(url));
    const hop = chain[String(url)] ?? { status: 200 };
    return new Response(null, { status: hop.status, headers: hop.location ? { location: hop.location } : {} });
  };
  try {
    const check = (candidate) => validateLensTarget(candidate);
    const blocked = await fetchFollowingPublicRedirects("https://example.com/start", {}, check);
    assert.equal(blocked.ok, false, "a hop into link-local space must be refused");
    assert.ok(!seen.includes("http://169.254.169.254/latest/meta-data/"), "the blocked host must never be requested");
    assert.equal(seen.length, 2, "it stops at the refusal instead of continuing");

    const fine = await fetchFollowingPublicRedirects("https://example.com/ok", {}, check);
    assert.equal(fine.ok, true);
    assert.equal(fine.finalUrl, "https://example.com/ok");

    globalThis.fetch = async (url) => new Response(null, { status: 302, headers: { location: `${url}x` } });
    const looping = await fetchFollowingPublicRedirects("https://example.com/loop", {}, check, 3);
    assert.equal(looping.ok, false, "an endless redirect chain is bounded");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// Booking degrades to the old behaviour without a COUNTER binding, so that cal
// stays runnable and testable with no Durable Object, the same way a missing
// BOOKING_WORKFLOW only costs the expiry timer. That fallback is only acceptable
// while production genuinely binds it: unbound, two simultaneous bookings take
// the same slot again and nothing says so. This is the assertion that keeps the
// degraded path from quietly becoming the real one.
test("production binds the Durable Object the slot claim needs", async () => {
  const { parseJsonc } = await import("./scripts/lib/jsonc.mjs");
  for (const config of ["wrangler.jsonc", "wrangler.dev.jsonc"]) {
    const parsed = parseJsonc(readFileSync(config, "utf8"));
    const bindings = parsed.durable_objects?.bindings ?? [];
    const counter = bindings.find((b) => b.name === "COUNTER");
    assert.ok(counter, `${config} must bind COUNTER for the coffee slot claim`);
    assert.equal(counter.class_name, "Counter");

    // The claim rides the EXISTING class on purpose: a second class needs a
    // new_sqlite_classes migration, and `wrangler versions upload` cannot apply
    // one. If someone adds that migration later this assertion should be
    // revisited deliberately rather than silently outgrown.
    const classes = (parsed.migrations ?? []).flatMap((m) => m.new_sqlite_classes ?? []);
    assert.deepEqual(classes, ["Counter"],
      `${config} declares Durable Object classes ${JSON.stringify(classes)}; the slot claim assumes Counter is the only one`);
  }
});

// One instance per slot is the entire exclusivity argument: two different times
// must never share an instance, and one time must always resolve to the same
// one. It also must not collide with the visit counter's instance name.
test("slot reservations name one Durable Object instance per slot", () => {
  const start = Date.UTC(2026, 7, 10, 14);
  const end = start + 30 * 60_000;
  assert.equal(reservationName(start, end), reservationName(start, end));
  assert.notEqual(reservationName(start, end), reservationName(start + 1, end));
  assert.notEqual(reservationName(start, end), reservationName(start, end + 1));
  assert.notEqual(reservationName(start, end), "homepage-visits");
  assert.match(reservationName(start, end), /^coffee-slot:\d+:\d+$/);
});

// ── the deploy-time page renderers ──────────────────────────────────
// build.mjs step 1e runs these in Node and writes photos.html / bot.html, which
// step 8 then turns into the q11 twin and the dcz deltas. The whole scheme rests on
// one property: the renderer is PURE over build-time artifacts, so Node and the
// Worker produce identical bytes. If it ever reaches for runtime state the twin
// stops matching what a visitor gets, and nothing else in the tree would notice —
// the page would just quietly serve stale-but-plausible HTML.
test("renderPhotosPage is pure over the committed pool", async () => {
  const index = JSON.parse(await readFile(new URL("holding/_worker.js/photo-index.json", import.meta.url), "utf8"));
  const hashes = JSON.parse(await readFile(new URL("holding/images/hashes.json", import.meta.url), "utf8"));
  const alt = JSON.parse(await readFile(new URL("holding/images/alt.json", import.meta.url), "utf8"));
  const pool = derivePhotoPool(index, hashes);

  // no env, no ctx, no bindings: the signature cannot smuggle in runtime state
  const a = await renderPhotosPage(pool, alt).text();
  const b = await renderPhotosPage(pool, alt).text();
  assert.equal(a, b, "same inputs must give byte-identical output");
  assert.equal(a.split('class="ph"').length - 1, pool.length, "one tile per pooled photo");
  assert.ok(a.includes("<!DOCTYPE html>") || a.includes("<!doctype html>"), "must be a whole document");

  // an empty pool is a failed build, not a blank contact sheet
  const empty = renderPhotosPage([], alt);
  assert.equal(empty.status, 503, "an empty pool must refuse rather than ship bare frames");
});

test("renderBotPage takes no arguments and is deterministic", async () => {
  const { renderBotPage } = await import("./holding/_worker.js/bot.js");
  assert.equal(renderBotPage.length, 0, "any parameter is a door for runtime state");
  const a = await renderBotPage().text();
  const b = await renderBotPage().text();
  assert.equal(a, b);
  assert.ok(a.includes("AadharshBot"), "must name the crawler the page exists to explain");
});

// ── the speculation ledger ────────────────────────────────────────────────────
// Both halves are best-effort counters wrapped around a live response, so the
// contract that matters most is the negative one: they must never throw, and
// they must never count something that isn't a speculation.

function speculationEnv() {
  const points = [];
  return { env: { SPECULATION: { writeDataPoint: (p) => points.push(p) } }, points };
}

test("the speculation denominator counts real speculations and nothing else", async () => {
  const { countSpeculativeLoad } = await import("./holding/_worker.js/speculation.js");
  const ok = new Response("", { status: 200 });

  const cases = [
    ["prefetch", "prefetch", 1],
    ["prefetch;prerender", "prerender", 1],   // the stronger claim wins
    ["prerender", "prerender", 1],
    ["", null, 0],                            // a plain navigation is not a speculation
    ["fetch", null, 0],                       // Sec-Purpose exists but isn't speculative
  ];
  for (const [purpose, kind, expected] of cases) {
    const { env, points } = speculationEnv();
    const headers = purpose ? { "sec-purpose": purpose } : {};
    countSpeculativeLoad(env, new Request("https://aadhar.sh/garage", { headers }), ok, "/garage");
    assert.equal(points.length, expected, `sec-purpose: "${purpose}" should write ${expected}`);
    if (expected) {
      assert.equal(points[0].blobs[0], kind);
      assert.equal(points[0].blobs[1], "/garage");
      assert.deepEqual(points[0].indexes, [kind], "one index, so precision is a GROUP BY not a join");
    }
  }

  // a speculation that errored is not a speculation worth counting
  const { env, points } = speculationEnv();
  countSpeculativeLoad(env, new Request("https://aadhar.sh/nope", { headers: { "sec-purpose": "prefetch" } }),
    new Response("", { status: 404 }), "/nope");
  assert.equal(points.length, 0, "a 4xx speculation must not enter the denominator");

  // no binding, and a binding that throws, must both be survivable
  assert.doesNotThrow(() => countSpeculativeLoad({}, new Request("https://aadhar.sh/", {
    headers: { "sec-purpose": "prefetch" } }), ok, "/"));
  assert.doesNotThrow(() => countSpeculativeLoad(
    { SPECULATION: { writeDataPoint() { throw new Error("AE down"); } } },
    new Request("https://aadhar.sh/", { headers: { "sec-purpose": "prefetch" } }), ok, "/"));
});

test("the activation beacon answers 204 and records which page paid off", async () => {
  const { handlePrefetchActivation, prefetchActivationHeader } =
    await import("./holding/_worker.js/speculation.js");

  // the header the browser is handed must round-trip a path through the query
  const value = prefetchActivationHeader("/garage/horizon");
  assert.equal(value, "/ledger/prefetch?p=%2Fgarage%2Fhorizon");
  assert.equal(new URL(value, "https://aadhar.sh").searchParams.get("p"), "/garage/horizon");

  // the browser sends HEAD; the response is an acknowledgement, never a document
  const { env, points } = speculationEnv();
  const res = handlePrefetchActivation(
    new Request("https://aadhar.sh" + value, { method: "HEAD" }), env);
  assert.equal(res.status, 204);
  assert.equal(res.headers.get("cache-control"), "no-store", "a cached beacon counts once, forever");
  assert.equal(await res.text(), "", "204 means no body");
  assert.equal(points.length, 1);
  assert.equal(points[0].blobs[0], "activated");
  assert.equal(points[0].blobs[1], "/garage/horizon");

  // anything that isn't a read is refused, and says so properly
  const bad = handlePrefetchActivation(
    new Request("https://aadhar.sh/ledger/prefetch", { method: "POST" }), env);
  assert.equal(bad.status, 405);
  assert.equal(bad.headers.get("allow"), "GET, HEAD");

  // a beacon with no binding still answers; telemetry never gates the reply
  assert.equal(handlePrefetchActivation(
    new Request("https://aadhar.sh/ledger/prefetch", { method: "HEAD" }), {}).status, 204);
});

test("the activation header lands on navigable HTML only", async () => {
  const { withSecurityHeaders } = await import("./holding/_worker.js/lib/security.js");
  const html = () => new Response("<p>hi", { headers: { "content-type": "text/html; charset=utf-8" } });
  const HDR = "on-prefetch-activation";

  assert.equal(withSecurityHeaders(html(), "/garage/horizon").headers.get(HDR),
    "/ledger/prefetch?p=%2Fgarage%2Fhorizon");

  // no pathname means no navigable document (the /lens self-fetch), so no beacon
  assert.equal(withSecurityHeaders(html()).headers.get(HDR), null);

  // a JSON endpoint is not something a browser navigates to and prerenders
  const json = new Response("{}", { headers: { "content-type": "application/json" } });
  assert.equal(withSecurityHeaders(json, "/ledger.json").headers.get(HDR), null);

  // redirects return untouched, so they can't carry it either
  const redirect = new Response(null, { status: 307, headers: { location: "/garage" } });
  assert.equal(withSecurityHeaders(redirect, "/garage/").headers.get(HDR), null);

  // gotcha 13: rebuilding a response must carry encodeBody, and adding this
  // header must not be the thing that quietly reintroduces double compression.
  const encoded = new Response("body", {
    headers: { "content-type": "text/html", "content-encoding": "br" },
  });
  assert.equal(withSecurityHeaders(encoded, "/").headers.get("content-encoding"), "br");
});

test("the homepage's Link header carries the shell preloads, or it gets no Early Hints 103", async () => {
  // Cloudflare Early Hints harvests ONLY the rel=preload entries out of a Link
  // header. `/` had none between the serveStaticPage refactor and this test, so
  // it was the single page on the site answering without a 103 — verified
  // against production on 2026-07-30, where /whoareyou returned one carrying
  // luna.css + nav.js and `/` returned discovery links alone.
  //
  // Nothing failed when that broke. The route kept serving, the discovery links
  // kept working, and the preloads were still written down in a function no
  // route imported. This test is the part that was missing: an assertion that
  // ties the header to the route rather than to a helper that may drift out of
  // the call graph.
  const index = await readFile(new URL("holding/_worker.js/index.js", import.meta.url), "utf8");
  const block = index.match(/const HOMEPAGE_HEADERS = \{[\s\S]*?\};/);
  assert.ok(block, "HOMEPAGE_HEADERS must still exist");
  assert.match(block[0], /SHELL_PRELOAD_LINK/,
    "the homepage Link header must include the shell preloads, or Early Hints has nothing to harvest");
  assert.match(block[0], /HOMEPAGE_DISCOVERY_LINK/,
    "the homepage Link header must still carry the discovery links");

  // Dead code is how this hid the first time: the behaviour stayed described in
  // lib/security.js while nothing called it, so reading that file suggested the
  // homepage was fine. One home for the header, and it is the route's.
  // Matched on the DEFINITIONS, not on mentions: the comment left behind in that
  // file explains what used to live there and why it went, which is worth
  // keeping. It is a second LIVE definition that must not come back.
  const security = await readFile(new URL("holding/_worker.js/lib/security.js", import.meta.url), "utf8");
  assert.doesNotMatch(security, /^\s*(export )?function withHomepageDiscoveryHeaders/m,
    "lib/security.js should not keep a second, uncalled definition of the homepage Link header");
  assert.doesNotMatch(security, /^\s*(export )?const HOMEPAGE_LINK\s*=/m,
    "the homepage Link header should be composed at the route, not in a constant nothing imports");

  // `/` shipped `private, no-cache, must-revalidate` from its SSR era, which cost it
  // two things at once: no shared cache could hold it (so every front-door hit ran the
  // worker) and no browser would keep a dictionary offered under it (so it was the one
  // page outside the per-page dcz tier). It takes PAGE_CACHE_CONTROL now. Four surfaces
  // have to agree on that string or the fix is partial in a way nothing else reports.
  assert.match(block[0], /\.\.\.GENERATED_PAGE_HEADERS/,
    "the homepage must take the shared generated-page policy, not a hand-written one");
  assert.doesNotMatch(block[0], /no-cache|must-revalidate|private/,
    "no-cache/must-revalidate/private each veto dictionary registration; `/` cannot carry them");
  assert.match(index, /WORKERS_CACHEABLE_PATHS = new Set\("\/ /,
    "`/` must be in WORKERS_CACHEABLE_PATHS, or a cacheable homepage still invokes the worker every hit");

  // The HEAD path used to write its own headers, which is how it drifted: a
  // hand-maintained duplicate can only be checked by asserting it restates the
  // right constants, and that check passed while its markdown branch quietly
  // omitted x-markdown-tokens. The duplicate is gone, so assert it stays gone
  // rather than that a second copy still agrees. Same move as the
  // withHomepageDiscoveryHeaders assertions above.
  const home = await readFile(new URL("holding/_worker.js/home.js", import.meta.url), "utf8");
  assert.doesNotMatch(home, /^\s*(export )?function homepageHeadResponse/m,
    "the homepage HEAD must not go back to a hand-written header set; it takes the GET's own path");
  assert.doesNotMatch(index, /method === "HEAD"\s*\)\s*return homepageHeadResponse/,
    "routeHomepage must not fork on HEAD again");

  // _headers is the static-asset fallback for the same URL, and check-dictionary-support
  // exists precisely because production policy for some pages comes from this file, which
  // canRegisterAsDictionary never sees.
  const { PAGE_CACHE_CONTROL } = await import("./holding/_worker.js/lib/const.js");
  const headers = await readFile(new URL("holding/_headers", import.meta.url), "utf8");
  const rootRule = headers.match(/^\/\n((?:  .*\n)+)/m);
  assert.ok(rootRule, "_headers must still carry a rule for /");
  assert.match(rootRule[1], new RegExp(`Cache-Control: ${PAGE_CACHE_CONTROL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m"),
    "_headers `/` must state the same policy the worker route does");

  // The predicate itself is exercised where serveStaticPage is already under test, in
  // "static page negotiation prefers 304, then DCZ with the current validator".
});

// Every `_headers` rule for a page has to be written against the TWIN, because that is
// the asset serveStaticPage actually fetches: findBrotli reads `<base>.html.br` and
// copies ITS cache-control and link onto the page response. So a rule spelled as the
// request path (`/pixel-peeper`) matches nothing, and the page silently falls back to
// the Workers-assets default `public, max-age=0, must-revalidate`.
//
// That failed quietly in production for as long as /pixel-peeper had been a page. Two
// costs, and the second is the one nothing reports: no s-maxage means no shared cache
// entry, and must-revalidate VETOES dictionary registration (canRegisterAsDictionary in
// lib/assets.js), so the page drops out of the per-page dcz tier while still
// advertising `vary: available-dictionary`. /garage/* and /lwe/* were always fine
// because a glob covers the twin, the plain .html, and a section index's
// `<base>/index.html.br` alike, which is exactly why one hand-written exact rule could
// sit wrong next to them without ever looking wrong.
test("_headers page rules match the twin the worker fetches, not the request path", async () => {
  const { PAGE_CACHE_CONTROL } = await import("./holding/_worker.js/lib/const.js");
  const { readdir } = await import("node:fs/promises");
  const raw = await readFile(new URL("holding/_headers", import.meta.url), "utf8");

  // `_headers` blocks: a line starting with `/`, then its indented header lines.
  const rules = [...raw.matchAll(/^(\/\S*)\n((?:[ \t]+\S.*\n)+)/gm)].map(([, pattern, body]) => ({
    pattern,
    cacheControl: (body.match(/^[ \t]+Cache-Control:[ \t]*(.+?)\s*$/mi) || [])[1] || null,
    // Matching rules ACCUMULATE and duplicate headers are comma-joined with no
    // most-specific-wins, so `*` has to be modelled as a real glob, not a prefix test.
    matches: (path) => new RegExp(`^${pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\\*/g, ".*")}$`).test(path),
  }));

  // The families whose pages take their policy from this file. Pages routed with
  // GENERATED_PAGE_HEADERS get theirs from the worker instead and are pinned above.
  const families = ["garage", "lwe", "pixel-peeper"];
  let checked = 0;
  for (const family of families) {
    for (const file of (await readdir(new URL(`holding/${family}`, import.meta.url))).sort()) {
      if (!file.endsWith(".html")) continue;
      const twin = `/${family}/${file}.br`;
      const hit = rules.filter((rule) => rule.matches(twin) && rule.cacheControl);
      assert.ok(hit.length > 0,
        `${twin}: no _headers rule matches the twin, so this page ships the Workers-assets default`);
      for (const rule of hit) {
        assert.equal(rule.cacheControl, PAGE_CACHE_CONTROL,
          `${rule.pattern} matches ${twin} but states a different policy than every other page`);
      }
      checked++;
    }
  }
  // A collapsed loop would pass vacuously, which is the failure mode this whole file
  // keeps re-learning (the markdown-twin contract test asserted nothing for a while).
  assert.ok(checked >= 30, `expected to check 30+ page twins, checked ${checked}`);

  // The other half of the same edit: a page rule must not widen into a sibling that
  // sets its own policy, because the comma-join would prepend max-age=0 to it.
  const tile = "/pixel-peeper/tiles/05c532a8be2a.jpg";
  const tileRules = rules.filter((rule) => rule.matches(tile) && rule.cacheControl);
  assert.deepEqual(tileRules.map((rule) => rule.cacheControl), ["public, max-age=31536000, immutable"],
    "exactly one rule may set Cache-Control on a pixel-peeper tile, or its immutable year gets clamped");
});

test("the offscreen Horizon iframe does not start ticking during initial load", async () => {
  const horizon = await readFile(new URL("holding/garage/horizon.html", import.meta.url), "utf8");
  const iframe = horizon.match(/<iframe\s+[^>]*id="mb-frame"[^>]*>/)?.[0];
  assert.ok(iframe, "the state-preserving move demo must keep its uptime iframe");
  assert.match(iframe, /\sloading="lazy"(?:\s|>)/,
    "the deep-page iframe runs a perpetual timer and must wait until it nears the viewport");
});

test("the CSP falls back to 'unsafe-inline' only where the build cannot speak", async () => {
  const { canonicalPath, scriptHashesFor } = await import("./holding/_worker.js/lib/csp-hashes.js");

  // canonicalPath folds the spellings a request can arrive in onto the one the
  // build emits. If these two ever disagree the map misses SILENTLY and the page
  // just stays loose, so pin the folding rather than trusting it.
  assert.equal(canonicalPath("/"), "/");
  assert.equal(canonicalPath("/index.html"), "/");
  assert.equal(canonicalPath("/garage/"), "/garage");
  assert.equal(canonicalPath("/garage/index.html"), "/garage");
  assert.equal(canonicalPath("/garage/scroll.html"), "/garage/scroll");
  assert.equal(canonicalPath("/writing/colophon"), "/writing/colophon");

  // The committed map is empty on purpose (readable dev serves unminified bytes
  // whose hashes differ), so every lookup here misses and takes the loose policy.
  assert.equal(scriptHashesFor("/garage/scroll"), null);
  // and a response with no pathname must never inherit the homepage's entry
  assert.equal(scriptHashesFor(undefined), null);
  assert.equal(scriptHashesFor(""), null);
});

test("the hashed policy is well-formed and keeps 'self' for the external scripts", async () => {
  const { cspHeadersFor, ENFORCE_PAGE_HASHES } = await import("./holding/_worker.js/lib/security.js");
  const csp = cspHeadersFor("/anything-unmapped")["content-security-policy"];

  // the fallback is exactly today's policy, so an unmapped page is never a regression
  assert.match(csp, /script-src 'self' 'unsafe-inline';/);
  assert.match(csp, /default-src 'self';/);
  assert.match(csp, /object-src 'none';/);
  // no report-only twin when there is nothing stricter to report against
  assert.equal(cspHeadersFor("/anything-unmapped")["content-security-policy-report-only"], undefined);

  // Rebuild the hashed arm against a stub map, so this asserts the SHAPE the
  // build's output will take rather than waiting on a staged tree.
  const mod = await import("./holding/_worker.js/lib/csp-hashes.js");
  const original = { ...mod.PAGE_SCRIPT_HASHES };
  try {
    mod.PAGE_SCRIPT_HASHES["/probe"] = ["AAAA", "BBBB"];
    const pair = cspHeadersFor("/probe");
    const hashed = pair[ENFORCE_PAGE_HASHES ? "content-security-policy" : "content-security-policy-report-only"];
    assert.match(hashed, /script-src 'self' 'sha256-AAAA' 'sha256-BBBB';/);
    // 'strict-dynamic' would make 'self' inert for scripts and break /a/nav.js,
    // /tooltip.js, /hoist.js and the homepage's dynamic import()s.
    assert.ok(!hashed.includes("strict-dynamic"));
    // 'unsafe-hashes' would re-permit event-handler attributes, which is the
    // thing the two refactors in this change exist to avoid.
    assert.ok(!hashed.includes("unsafe-hashes"));
    assert.ok(!/script-src[^;]*'unsafe-inline'/.test(hashed));

    // a document with no inline script at all earns the strictest form
    mod.PAGE_SCRIPT_HASHES["/empty"] = [];
    const bare = cspHeadersFor("/empty");
    const bareCsp = bare[ENFORCE_PAGE_HASHES ? "content-security-policy" : "content-security-policy-report-only"];
    assert.match(bareCsp, /script-src 'self';/);

    // while the flag is off, the ENFORCING header must still be the loose one:
    // that is the whole point of the report-only phase.
    if (!ENFORCE_PAGE_HASHES) {
      assert.match(pair["content-security-policy"], /script-src 'self' 'unsafe-inline';/);
      // A browser IGNORES upgrade-insecure-requests in a report-only policy and
      // files a security issue saying so, on every page load (found in DevTools
      // 2026-08-07, and in a Cloudflare URL Scanner run the same day).
      assert.doesNotMatch(hashed, /upgrade-insecure-requests/,
        "a report-only policy must omit directives the browser cannot report");
      // The other half, which absence alone cannot express: the ENFORCING policy
      // must still carry it. Asserting only the omission passes just as happily
      // if the directive falls out of both.
      assert.match(pair["content-security-policy"], /upgrade-insecure-requests/);
      // And everything else must still match, or the two tails have drifted into
      // being two policies rather than one policy minus an inert directive.
      assert.equal(
        pair["content-security-policy"].replace(/script-src [^;]*;/, ""),
        `${pair["content-security-policy-report-only"].replace(/script-src [^;]*;/, "")}; upgrade-insecure-requests`,
      );
    }
  } finally {
    for (const k of Object.keys(mod.PAGE_SCRIPT_HASHES)) delete mod.PAGE_SCRIPT_HASHES[k];
    Object.assign(mod.PAGE_SCRIPT_HASHES, original);
  }
});

test("every inline script in the STAGED tree is covered by the emitted hash map", async () => {
  // The build derives the map from the staged bytes; this re-derives it with a
  // deliberately different parser and compares. Same-code-twice would prove
  // nothing, and the failure this guards against (a blocked script leaves the
  // page rendering and merely dead) is invisible without it.
  if (!existsSync("./.build/holding/_worker.js/lib/csp-hashes.js")) return; // no staged tree; `pnpm run build` first
  const { createHash } = await import("node:crypto");
  const { readdir } = await import("node:fs/promises");

  const emitted = readFileSync("./.build/holding/_worker.js/lib/csp-hashes.js", "utf8")
    .match(/^export const PAGE_SCRIPT_HASHES = (.*); \/\/ build:csp-hashes$/m);
  assert.ok(emitted, "the build did not rewrite the build:csp-hashes marker");
  const map = JSON.parse(emitted[1]);

  const pages = (await readdir("./.build/holding", { recursive: true }))
    .filter((p) => p.endsWith(".html") && !p.endsWith(".src.html"));
  assert.ok(pages.length >= 40, `expected the full staged document set, saw ${pages.length}`);

  const EXECUTABLE = /^(|text\/javascript|application\/javascript|text\/ecmascript|application\/ecmascript|module|speculationrules)$/;

  // This scanner has to WALK tags, not string-search for "<script". /garage/horizon
  // holds two scripts inside other tags' attribute values:
  //
  //   <input value="&lt;img src=x onerror=alert(1)&gt;&lt;script&gt;bad()&lt;/script&gt;">
  //   <iframe srcdoc="...&lt;script&gt;let n=0;setInterval(...)&lt;/script&gt;...">
  //
  // Both are entity-escaped in the source. HTML5 lets a QUOTED attribute value carry
  // raw < and >, so minify-html decodes them (no option turns that off, and the DOM
  // value is identical either way), and from 2026-07-31 every page goes through the
  // minifier. A searcher then finds `<script>bad()</script>` in the middle of an
  // attribute and demands a CSP hash for something no browser will ever execute as
  // part of this document.
  //
  // Independence from build.mjs's collector is the point of this test, so this is a
  // separate implementation. Being different is not the goal though, and the earlier
  // regex here was different by being wrong. A correct walk is the only correct
  // answer: consume each tag whole so attribute text is never read as content, and
  // treat <script> as a script only when it opens in content position.
  const inlineScripts = function* (source) {
    const low = source.toLowerCase();
    let i = 0;
    while (i < source.length) {
      const lt = source.indexOf("<", i);
      if (lt === -1) return;
      if (low.startsWith("<!--", lt)) {
        const end = source.indexOf("-->", lt + 4);
        if (end === -1) return;
        i = end + 3;
        continue;
      }
      // find this tag's `>`, stepping over quoted attribute values
      let j = lt + 1, quote = "";
      while (j < source.length) {
        const ch = source[j];
        if (quote) { if (ch === quote) quote = ""; }
        else if (ch === '"' || ch === "'") quote = ch;
        else if (ch === ">") break;
        j++;
      }
      if (j >= source.length) return;
      const name = (low.slice(lt + 1, j).match(/^\/?\s*([a-z][^\s/>]*)/) || [])[1];
      if (name === "script") {
        const close = low.indexOf("</script", j + 1);
        if (close === -1) return;
        yield { attrs: source.slice(lt + 7, j), body: source.slice(j + 1, close) };
        i = close + 8;
        continue;
      }
      i = j + 1;   // consumed the whole tag, attributes included
    }
  };

  let checked = 0;
  for (const page of pages) {
    const html = readFileSync(`./.build/holding/${page}`, "utf8");
    const key = "/" + page.replace(/\.html$/, "").replace(/(^|\/)index$/, "") || "/";
    const path = key.length > 1 && key.endsWith("/") ? key.slice(0, -1) : key;
    assert.ok(map[path], `${page}: no entry at ${path} — it would silently fall back to 'unsafe-inline'`);

    for (const m of inlineScripts(html)) {
      const attrs = m.attrs;
      if (/\ssrc\s*=/i.test(attrs)) continue;
      // minify-html UNQUOTES attribute values wherever it legally can, so the
      // staged homepage carries `type=application/ld+json` bare. A quoted-only
      // match reads that as type="" and calls a JSON-LD data block executable,
      // then fails demanding a hash for something no browser ever runs. Same
      // don't-trust-the-quoting trap the inline favicon data-URIs hit.
      const t = attrs.match(/\btype\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>]+))/i);
      const type = (t ? (t[1] ?? t[2] ?? t[3] ?? "") : "").toLowerCase();
      if (!EXECUTABLE.test(type)) continue;
      const digest = createHash("sha256").update(m.body, "utf8").digest("base64");
      assert.ok(map[path].includes(digest),
        `${page}: an inline <script${type ? ` type="${type}"` : ""}> is not in the hash map — it would be BLOCKED once the flag flips`);
      checked++;
    }
  }
  // guard against the assertion loop quietly matching nothing, the failure mode
  // the md-twin quiz test shipped with and reported as a pass for weeks
  assert.ok(checked >= 60, `only ${checked} inline blocks verified; the extractor probably stopped matching`);
});

test("Workers Cache never answers a content-negotiated request from the stored representation", async () => {
  // The regression this exists for, live in production on 2026-07-31: `/` joined
  // WORKERS_CACHEABLE_PATHS and `Accept: text/markdown` on the homepage started
  // returning HTML. Nothing in the route was wrong. Workers Cache keys the URL, the
  // stored HTML carries `vary: accept-encoding, available-dictionary` and says
  // nothing about `accept`, so a cache HIT answered a request asking for a different
  // media type at the same URL.
  //
  // It shipped through a green CI because the predicate was a private function in
  // _worker.js/index.js, and that module imports `cloudflare:workers`, so no test
  // under plain node could reach it (gotcha 16). Moving it to lib/cache.js is what
  // makes this test possible, and the test is the point of the move.
  const { shouldUseWorkersCache } = await import("./holding/_worker.js/lib/cache.js");
  const PATHS = new Set(["/", "/bot", "/lens", "/reading"]);
  const req = (url, headers = {}) => new Request(url, { headers });

  // the whole reason `/` is in the set: a plain navigation should still be cacheable
  assert.equal(shouldUseWorkersCache(req("https://aadhar.sh/", {
    accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,*/*;q=0.8",
  }), PATHS), true, "an ordinary browser navigation must still reach Workers Cache");

  // ...and the bug: markdown at the same URL must bypass it
  for (const accept of ["text/markdown", "text/markdown, text/html;q=0.5", "text/markdown;q=1.0, text/html;q=0.9"]) {
    for (const path of ["/", "/bot", "/lens", "/reading"]) {
      assert.equal(shouldUseWorkersCache(req(`https://aadhar.sh${path}`, { accept }), PATHS), false,
        `${path} with "${accept}" must bypass Workers Cache or the stored HTML answers it`);
    }
  }

  // A lower-ranked markdown offer is NOT a negotiated request: wantsMarkdown does
  // real q-value comparison, so html-outranks-markdown stays cacheable. Pinning it
  // keeps a future over-broad "has an accept header" bail from silently disabling
  // the cache for every browser on the site.
  assert.equal(shouldUseWorkersCache(req("https://aadhar.sh/", {
    accept: "text/html, text/markdown;q=0.1",
  }), PATHS), true, "html outranking markdown is an ordinary request and must stay cacheable");

  // the bails that were already there, so a rewrite cannot quietly drop one
  assert.equal(shouldUseWorkersCache(req("https://aadhar.sh/?cb=1"), PATHS), false, "query strings bypass");
  assert.equal(shouldUseWorkersCache(req("https://aadhar.sh/", { "if-none-match": 'W/"x"' }), PATHS), false, "revalidation bypasses");
  assert.equal(shouldUseWorkersCache(req("https://aadhar.sh/", { range: "bytes=0-9" }), PATHS), false, "range bypasses");
  assert.equal(shouldUseWorkersCache(new Request("https://aadhar.sh/", { method: "POST" }), PATHS), false, "POST bypasses");
  assert.equal(shouldUseWorkersCache(req("https://aadhar.sh/nope"), PATHS), false, "an unlisted path bypasses");
  assert.equal(shouldUseWorkersCache(req("https://aadhar.sh/writing/colophon"), PATHS), true, "the /writing/ prefix is cacheable");
});

// The same class of bug on the other axis the key cannot see. A hit answers
// before the dispatcher, so every host-based decision in there is skipped:
// cal.aadhar.sh's 404 and a preview's noindex both live past this point.
//
// Reproduced on production 2026-08-08 rather than reasoned about. GET
// https://aadhar.sh/reading twice (MISS, then HIT at age 1), then
// https://cal.aadhar.sh/reading: 200, HIT, age 1, the same 91,980-byte page, on a
// host whose origin answers 404 for that path. /photos and /writing reported
// byte-identical `age` on both hostnames in the same second, so it is one object
// rather than two copies, and `?cb=` on any of them returned the real 404 through
// the query-string bail.
test("only the canonical hostname may be served from Workers Cache", async () => {
  const { shouldUseWorkersCache } = await import("./holding/_worker.js/lib/cache.js");
  const { isCanonicalHost } = await import("./holding/_worker.js/lib/const.js");
  const PATHS = new Set(["/", "/photos", "/reading", "/writing"]);
  const req = (url) => new Request(url, { headers: { accept: "text/html" } });

  for (const path of ["/", "/photos", "/reading", "/writing/colophon"]) {
    assert.equal(shouldUseWorkersCache(req(`https://aadhar.sh${path}`), PATHS), true, `aadhar.sh${path} is the site and stays cacheable`);
    for (const host of ["cal.aadhar.sh", "aadhar-sh.workers.dev", "a1b2c3-aadhar-sh.workers.dev", "aadhar-sh.pages.dev"]) {
      assert.equal(
        shouldUseWorkersCache(req(`https://${host}${path}`), PATHS), false,
        `${host}${path} must reach the dispatcher — a hit here publishes the canonical page on a second hostname`,
      );
    }
  }

  // Exact match. A near-miss treated as canonical is precisely how a duplicate
  // hostname gets published, and a subdomain suffix test would admit all of them.
  assert.equal(isCanonicalHost("aadhar.sh"), true);
  assert.equal(isCanonicalHost("AADHAR.SH"), true, "the Host header's case is not significant");
  for (const host of ["www.aadhar.sh", "cal.aadhar.sh", "aadhar.sh.evil.example", "notaadhar.sh", "", null, undefined]) {
    assert.equal(isCanonicalHost(host), false, `${host} is not the canonical host`);
  }
});

// ── Workers preview URLs ────────────────────────────────────────────
// A preview version runs PRODUCTION bindings and secrets (lib/preview.js says
// why at length), so these tests are the difference between a preview URL and
// an unaudited write path into the real site. They are cheap; the failure they
// prevent is a coffee booking emailed to a stranger from a branch.

test("the preview host test matches workers.dev and nothing that merely looks like it", async () => {
  const { isPreviewHost } = await import("./holding/_worker.js/lib/preview.js");

  for (const host of [
    "abc12345-aadhar-sh.oddharsh.workers.dev",
    "AADHAR-SH.ODDHARSH.WORKERS.DEV",          // hostnames are case-insensitive
    "aadhar-sh.workers.dev",
  ]) {
    assert.equal(isPreviewHost(host), true, `${host} is a preview host`);
  }

  for (const host of [
    "aadhar.sh",
    "cal.aadhar.sh",
    "aadhar-sh.workers.dev.evil.example",      // suffix match, not substring
    "notworkers.dev",                          // ".workers.dev" must not match "notworkers.dev"
    "workers.dev",                             // the bare apex is not a subdomain of itself
    undefined,
  ]) {
    assert.equal(isPreviewHost(host), false, `${host} is NOT a preview host`);
  }
});

test("previews refuse every unsafe method, and the GET-shaped writes too", async () => {
  const { previewDenial } = await import("./holding/_worker.js/lib/preview.js");

  // DEFAULT-DENY is the property worth pinning: the guard must not depend on
  // somebody remembering to list a new POST route. Paths here are deliberately
  // ones the guard has never heard of.
  for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS", "post"]) {
    for (const path of ["/book", "/webmention", "/ledger/rum", "/serendipity/sync", "/a-route-invented-tomorrow"]) {
      const denied = previewDenial(path, method);
      assert.ok(denied, `${method} ${path} must be refused on a preview`);
      assert.equal(denied.status, 403);
      assert.equal(denied.headers.get("cache-control"), "no-store", "a refusal must never be cached");
      assert.equal(denied.headers.get("x-robots-tag"), "noindex, nofollow");
    }
  }

  // /mcp is the one POST exception, and it is admitted so the MCP server can be
  // exercised on a preview, NOT because nothing behind it writes. Two vault
  // tools do; they are refused a layer down, by the next test.
  assert.equal(previewDenial("/mcp", "POST"), null, "JSON-RPC survives the method rule");

  // The other direction: writes that arrive as a plain GET, which the method
  // rule structurally cannot catch. Read the entries off the module rather than
  // restating them — a copy of the list here asserts only that the list equals
  // itself, which is how the stale coffee paths survived. What gives this teeth
  // is the pin in the next test.
  const { PREVIEW_GET_WRITES } = await import("./holding/_worker.js/lib/preview.js");
  assert.ok(PREVIEW_GET_WRITES.size >= 6, "the GET-write list must not quietly collapse");
  for (const path of PREVIEW_GET_WRITES) {
    const denied = previewDenial(path, "GET");
    assert.ok(denied, `GET ${path} mutates production state and must be refused`);
    assert.equal(denied.status, 403);
  }

  // ...and reads pass, or the preview is useless. /lens/* is on this list on
  // purpose: it fetches third parties and costs Browser Run, but it reads
  // only, and a /lens change you cannot exercise is a /lens change you cannot review.
  for (const path of ["/", "/garage/encoding", "/whoareyou.json", "/photos", "/lens/fetch", "/lens/shot", "/coffee", "/slots"]) {
    for (const method of ["GET", "HEAD"]) {
      assert.equal(previewDenial(path, method), null, `${method} ${path} must still serve on a preview`);
    }
  }
});

// The guard's own list is the half a test cannot check by reading the guard. An
// entry that names a path nothing routes reads as protection and protects
// nothing, which is what happened to the coffee pair: it sat here as bare
// /approve and /decline (the retired cal.aadhar.sh spellings) while the live
// routes arrived under /coffee/*, so a signed approve link opened against a
// preview confirmed a real booking and emailed a real person, on production's
// SIGNING_SECRET. So pin every entry against the route tables it claims to guard.
//
// The tables are read as SOURCE TEXT, not imported: index.js is the one module
// allowed to import "cloudflare:workers", and importing it here would kill the
// whole suite at link time (gotcha 16).
test("every preview-guarded GET write names a path the site really routes", async () => {
  const { PREVIEW_GET_WRITES } = await import("./holding/_worker.js/lib/preview.js");
  const dispatcher = readFileSync(new URL("./holding/_worker.js/index.js", import.meta.url), "utf8");
  const cal = readFileSync(new URL("./cal/src/index.js", import.meta.url), "utf8");

  // Exact ROUTES entries in the site dispatcher, plus cal's own matches, which
  // reach the visitor one prefix deeper: index.js hands /coffee/* to cal, and
  // cal strips that prefix before comparing.
  const routed = new Set();
  for (const [, path] of dispatcher.matchAll(/\[\s*"(\/[^"]*)"\s*,\s*[A-Za-z_$]/g)) routed.add(path);
  assert.ok(routed.has("/hit") && routed.has("/webmention/approve"), "the ROUTES scan must actually find routes");
  const coffeePrefixed = /pathname\.startsWith\("\/coffee\/"\)/.test(dispatcher);
  assert.ok(coffeePrefixed, "cal is reached through the /coffee/ prefix; this test's mapping assumes it");
  for (const [, path] of cal.matchAll(/path === "(\/[^"]*)"/g)) routed.add(`/coffee${path === "/" ? "" : path}`);
  assert.ok(routed.has("/coffee/approve"), "the cal scan must actually find cal's routes");

  for (const path of PREVIEW_GET_WRITES) {
    assert.ok(
      routed.has(path),
      `${path} is guarded as a GET-shaped write, but no route table serves it — the guard is protecting a dead path`,
    );
  }
});

// The other stale claim, and the more exposed one: /mcp needs no signature and
// no secret, so for as long as the guard admitted the endpoint on the grounds
// that nothing behind it wrote, any POST to a preview's /mcp could INSERT into
// the production representation vault. The refusal is derived from each tool's
// own readOnlyHint, so a new writing tool is covered on the day it declares
// itself. Swept over BOTH servers on this origin, which is what keeps the
// serendipity call site honest while it still has nothing to refuse.
test("MCP tools that write are refused on a preview host, and reads still run", async () => {
  const { handleMcp: handleSerendipityMcp, MCP_TOOLS: SERENDIPITY_TOOLS } = await import("./serendipity/serendipity.js");
  const servers = [
    { what: "/mcp", handle: (r) => handleSiteMcp(r, {}, context()), tools: SITE_MCP_TOOLS, path: "/mcp" },
    { what: "/serendipity/mcp", handle: (r) => handleSerendipityMcp(r, {}, null), tools: SERENDIPITY_TOOLS, path: "/serendipity/mcp" },
  ];

  let writesChecked = 0;
  for (const server of servers) {
    const call = (host, name) => server.handle(new Request(`https://${host}${server.path}`, {
      method: "POST",
      body: JSON.stringify({ jsonrpc: "2.0", id: "preview", method: "tools/call", params: { name, arguments: {}, ...MODERN_META } }),
      headers: { "content-type": "application/json" },
    }));

    for (const tool of server.tools) {
      if (tool.annotations.readOnlyHint !== false) continue;
      writesChecked += 1;
      const body = await (await call("v1-aadhar-sh.workers.dev", tool.name)).json();
      assert.equal(body.result?.isError, true, `${server.what} ${tool.name} writes and must be refused on a preview`);
      assert.match(body.result.content[0].text, /disabled on preview URLs/, `${tool.name}'s refusal must say why`);

      // ...and the same call off a preview must NOT be refused for this reason.
      // It may still fail on absent bindings here, which is a different answer.
      const live = await (await call("aadhar.sh", tool.name)).json();
      const liveText = live.result?.content?.[0]?.text || "";
      assert.ok(!/disabled on preview URLs/.test(liveText), `${tool.name} must run normally on production`);
    }

    // A read tool has to survive the guard, or the preview loses the surface the
    // /mcp exception exists to preserve.
    const read = server.tools.find((t) => t.annotations.readOnlyHint !== false);
    const readBody = await (await call("v1-aadhar-sh.workers.dev", read.name)).json();
    const readText = readBody.result?.content?.[0]?.text || "";
    assert.ok(!/disabled on preview URLs/.test(readText), `${server.what} ${read.name} reads and must still run on a preview`);
  }

  // The vault tools are the reason this test exists. If the count ever drops to
  // zero the sweep above is asserting nothing, and would say so silently.
  assert.equal(writesChecked, 2, "expected exactly the two representation-vault writers");
});

test("preview noindex reaches the responses the security wrapper otherwise skips", async () => {
  const { withSecurityHeaders } = await import("./holding/_worker.js/lib/security.js");

  // The wrapper bails early on redirects and images, which is correct for CSP
  // and wrong for robots: both are independently indexable, so a preview that
  // marked only its HTML would still publish a duplicate photo corpus.
  // Built fresh per pass, deliberately. `withSecurityHeaders` rebuilds every
  // response as `new Response(response.body, …)`, which per Fetch LOCKS the
  // body it was handed, so reusing one case object across both passes feeds the
  // second one a disturbed stream. Node's undici allows that and bun 1.4 throws
  // `Body object should not be disturbed or locked`, which is the spec-correct
  // read. The assertions here are about headers, so the leniency was never load
  // bearing; it just made the suite depend on which runtime ran it.
  const makeCases = () => [
    ["a redirect",  new Response(null, { status: 301, headers: { location: "https://aadhar.sh/photos" } })],
    ["an image",    new Response("jpegbytes", { headers: { "content-type": "image/jpeg" } })],
    ["a document",  new Response("<!doctype html><title>x</title>", { headers: { "content-type": "text/html; charset=utf-8" } })],
    ["a json feed", new Response("{}", { headers: { "content-type": "application/json" } })],
  ];
  for (const [what, response] of makeCases()) {
    const marked = withSecurityHeaders(response, "/photos", { noindex: true });
    assert.equal(marked.headers.get("x-robots-tag"), "noindex, nofollow", `${what} must carry noindex on a preview`);
  }

  // ...and production is untouched. This is the regression that would matter
  // most: a bug here deindexes the real site.
  for (const [what, response] of makeCases()) {
    const plain = withSecurityHeaders(response, "/photos");
    assert.equal(plain.headers.get("x-robots-tag"), null, `${what} must NOT be noindexed off a preview`);
  }

  // The wrapper is only half of it: what decides `noindex` is the dispatcher, and
  // that used to be `onPreview` alone, which left cal.aadhar.sh publishing
  // /coffee at a second hostname (cal's templates carry no rel=canonical). The
  // dispatcher cannot be imported here, since index.js is the one module allowed
  // to import "cloudflare:workers" (gotcha 16), so pin the decision as source.
  const dispatcher = readFileSync(new URL("./holding/_worker.js/index.js", import.meta.url), "utf8");
  assert.match(
    dispatcher,
    /noindex:\s*!isCanonicalHost\(url\.hostname\)/,
    "every hostname that is not the canonical site must be noindexed, not just previews",
  );

  // A route that already set its own x-robots-tag keeps it (/whoareyou.json and
  // /updates.json both do), so the guard can't weaken an existing directive.
  const own = new Response("{}", { headers: { "content-type": "application/json", "x-robots-tag": "noindex" } });
  assert.equal(withSecurityHeaders(own, "/whoareyou.json", { noindex: true }).headers.get("x-robots-tag"), "noindex");

  // Null-body statuses. The noindex path REBUILDS the response, and the Response
  // constructor throws if a null-body status is handed a body — so a 304 from
  // notModifiedIfFresh or a 204 from the /hit beacon is exactly the shape that
  // would turn a preview into a 500 on the revalidation path, where a browser
  // hits it constantly and a first look would not.
  for (const status of [204, 304]) {
    const empty = new Response(null, { status, headers: { etag: 'W/"x"' } });
    const marked = withSecurityHeaders(empty, "/", { noindex: true });
    assert.equal(marked.status, status, `${status} must survive the noindex rebuild`);
    assert.equal(marked.headers.get("x-robots-tag"), "noindex, nofollow");
    assert.equal(marked.headers.get("etag"), 'W/"x"', "existing headers survive the rebuild");
  }
});

// /access is a graph rendered from a table in its own bytes, and three of its
// authored invariants were verified once by hand in a browser rather than checked.
// Each one fails silently: a node with no downside still renders, a mis-ordered
// label still parses into something, and a dangling rival just draws no edge.
test("every /access device previews a cost, and the clause order its parser depends on holds", async () => {
  const html = await readFile(new URL("holding/access/index.html", import.meta.url), "utf8");
  const rows = [...html.matchAll(/<tr data-id="([^"]+)"([^>]*)>([\s\S]*?)<\/tr>/g)];
  // A collapsed roster would satisfy every assertion below, so pin the count too.
  assert.ok(rows.length >= 60, `expected the full device table, saw ${rows.length} rows`);

  const ids = new Set(rows.map(([, id]) => id));
  let withCost = 0, withBet = 0, rivalEnds = 0;

  for (const [, id, attrs, body] of rows) {
    const status = (attrs.match(/data-status="([^"]+)"/) || [])[1];
    // the prose cell is the last bare <td> before the examples cell
    const beforeEx = body.split('<td class="ex">')[0];
    const cells = [...beforeEx.matchAll(/<td>([\s\S]*?)<\/td>/g)];
    const prose = cells.length ? cells[cells.length - 1][1] : "";
    assert.ok(prose.length > 40, `${id}: no prose cell found`);

    // 1. no device previews as pure upside. A shipped node needs an authored
    //    Costs clause; an unfinished one falls back to whatever blocks it.
    const cost = /<b>Costs:<\/b>/.test(prose);
    const blocker = /<b>(In the way|Passed over because):<\/b>/.test(prose);
    assert.ok(cost || blocker, `${id}: previews no downside (needs Costs, In the way, or Passed over because)`);
    if (cost) withCost++;

    // 2. the page claims every unfinished device carries a dated bet
    if (status !== "shipped") {
      assert.match(prose, /<b>Bet:<\/b>/, `${id}: ${status} but carries no Bet`);
      withBet++;
    }

    // 3. the parser slices labels off in reverse prose order and takes Costs
    //    FIRST, so Costs must be authored last or `why` keeps a stray clause.
    if (cost) {
      const at = prose.indexOf("<b>Costs:</b>");
      for (const other of ["Bet:", "In the way:", "Passed over because:"]) {
        const o = prose.indexOf(`<b>${other}</b>`);
        assert.ok(o === -1 || o < at, `${id}: <b>${other}</b> is authored after Costs, which mis-slices the parse`);
      }
    }

    for (const r of ((attrs.match(/data-rivals="([^"]*)"/) || [])[1] || "").split(",").filter(Boolean)) {
      assert.ok(ids.has(r), `${id}: rivals "${r}", which is not a device id`);
      rivalEnds++;
    }
  }

  assert.ok(withCost >= 18, `expected an authored Costs clause on every installed device, saw ${withCost}`);
  assert.ok(withBet >= 40, `expected a Bet on every unfinished device, saw ${withBet}`);
  assert.ok(rivalEnds >= 8, `expected the zero-sum pairs to be declared, saw ${rivalEnds}`);
});

// ── /lens per-IP crawl budgets ──────────────────────────────────────
// These moved off KV counters and onto the Rate Limiting binding on 2026-08-04.
// The route they guard is the one that fetches third parties and spends Browser
// Run, so "fails open when the binding is missing" and "the 429 quotes the real
// ceiling" are both worth pinning.

test("every rate-limit ceiling matches the ratelimits declared in both wrangler configs", async () => {
  const { LENS_BUDGETS } = await import("./holding/_worker.js/lens.js");
  const { parseJsonc } = await import("./scripts/lib/jsonc.mjs");

  // EVERY per-IP budget on the site, not just Lens's. The orphan check at the
  // bottom is the reason this has to be exhaustive: it fails on any declared
  // limiter no code reads, which is what caught ASK_RL the moment it was
  // declared and would catch the next one too. A budget that lives in a module
  // this list forgets reads as an orphan and fails here, which is the correct
  // and cheap way to find out.
  const BUDGETS = { ...LENS_BUDGETS };

  // The number in LENS_BUDGETS is what the 429 message quotes; the number in
  // wrangler.jsonc is what actually limits. A message that disagrees with the
  // ceiling is worse than no message, and nothing else would catch the drift.
  for (const config of ["wrangler.jsonc", "wrangler.dev.jsonc"]) {
    const declared = parseJsonc(readFileSync(config, "utf8")).ratelimits;
    assert.ok(Array.isArray(declared) && declared.length, `${config} declares no ratelimits`);
    const byName = new Map(declared.map((r) => [r.name, r]));

    for (const [budget, { binding, max }] of Object.entries(BUDGETS)) {
      const rule = byName.get(binding);
      assert.ok(rule, `${config} has no ratelimit named ${binding} for budget ${budget}`);
      assert.equal(rule.simple?.limit, max,
        `${config} limits ${binding} to ${rule.simple?.limit} but the 429 message says ${max}`);
      // The binding supports 10 or 60 only, and every budget here is per-minute.
      assert.equal(rule.simple?.period, 60, `${binding} must use the 60s period`);
    }
    // No orphans: a declared limiter nothing reads is a limit nobody enforces.
    const used = new Set(Object.values(BUDGETS).map((b) => b.binding));
    for (const name of byName.keys()) {
      assert.ok(used.has(name), `${config} declares ${name} but no budget in this test uses it`);
    }
  }
});

test("overLensBudget fails open without a limiter and closes when one says no", async () => {
  const { LENS_BUDGETS, overLensBudget } = await import("./holding/_worker.js/lens.js");
  const req = new Request("https://aadhar.sh/lens/fetch?url=https://example.com", {
    headers: { "cf-connecting-ip": "203.0.113.7" },
  });

  // Fails OPEN with no binding at all. This is the local-dev and contract-test
  // shape, and it matches the KV version's behaviour without RN_KV: abuse
  // control, not authorization. validateLensTarget's SSRF guard has no fallback
  // and is what actually keeps this route safe.
  assert.equal(await overLensBudget(LENS_BUDGETS.inspect, req, {}), false);
  assert.equal(await overLensBudget(LENS_BUDGETS.inspect, req, { LENS_RL_INSPECT: {} }), false,
    "a binding without .limit() is not a limiter");

  // ...and open when the limiter throws. A limiter blip must cost the rate
  // limit, never the route: an unhandled throw here renders Cloudflare's HTML
  // 1101 page, which the caller then tries to JSON.parse.
  assert.equal(await overLensBudget(LENS_BUDGETS.inspect, req, {
    LENS_RL_INSPECT: { limit: () => { throw new Error("limiter down"); } },
  }), false);

  // Closes when the limiter says so, and keys on the caller's IP.
  let seen = null;
  const env = { LENS_RL_SHOT: { limit: (arg) => { seen = arg; return { success: false }; } } };
  assert.equal(await overLensBudget(LENS_BUDGETS.shot, req, env), true);
  assert.deepEqual(seen, { key: "203.0.113.7" });

  // Each budget reads its OWN binding, which is the property that stopped /mcp
  // from being a second unmetered door onto the same crawler.
  const names = Object.values(LENS_BUDGETS).map((b) => b.binding);
  assert.equal(new Set(names).size, names.length, "two budgets share one binding");
});

test("documentShape counts substance, not framework payload", async () => {
  const { documentShape } = await import("./holding/_worker.js/lens-render.js");

  // A client-rendered shell: almost all of its bytes are an inline script, and
  // none of that is anything a reader or a parser gets. This is why the shape
  // has no `bytes` field at all — bytes would score the framework payload as
  // content and call this page mostly-visible to a crawler.
  const raw = `<html><head><title>Shop</title></head><body><div id="root"></div>
    <script>${"var padding='x';".repeat(400)}</script></body></html>`;
  const shell = documentShape(raw);
  assert.equal(shell.words, 1, "the title counts, the 6KB script body does not");
  assert.equal(shell.headings, 0);
  assert.equal(shell.jsonld, 0);

  const rendered = documentShape(`<html><body><h1>Winter jackets</h1>
    <p>Forty two jackets, wool and down, in stock today.</p>
    <a href="/a">one</a><a href="/b">two</a><img src="/j.png">
    <script type="application/ld+json">{"@type":"Product"}</script></body></html>`);
  assert.ok(rendered.words > 10);
  assert.equal(rendered.headings, 1);
  assert.equal(rendered.links, 2);
  assert.equal(rendered.images, 1);
  assert.equal(rendered.jsonld, 1, "structured data that exists only after render");
});

test("the kitesurf selector is tried, and a rejection is remembered rather than reported", async () => {
  const { runBrowserAction, _resetKitesurfProbe, _kitesurfParamLive } =
    await import("./holding/_worker.js/lens-render.js");
  const env = { CF_ACCOUNT_ID: "acct", BROWSER_RUN_TOKEN: "tok" };
  const realFetch = globalThis.fetch;
  const calls = [];

  try {
    // `browser=kitesurf` is documented on Cloudflare's Kitesurf page and NOT in
    // the Quick Actions reference. A 400 on the attempt carrying it must not
    // surface as "the scanned site is broken", which is what hard-coding the
    // parameter would have produced on every single render.
    _resetKitesurfProbe();
    globalThis.fetch = async (url) => {
      calls.push(String(url));
      return new Response("{}", { status: String(url).includes("browser=kitesurf") ? 400 : 200 });
    };
    const first = await runBrowserAction("snapshot", { url: "https://example.com" }, env);
    assert.equal(calls.length, 2, "tried the selector, then retried without it");
    assert.ok(calls[0].includes("browser=kitesurf"));
    assert.ok(!calls[1].includes("browser=kitesurf"));
    assert.equal(first.engine, "chromium-rest", "the engine reported is the one that answered");
    assert.equal(_kitesurfParamLive(), false);

    // Remembered for the isolate: the second render must not pay the failed
    // attempt again, because every render would otherwise cost two REST calls.
    calls.length = 0;
    const second = await runBrowserAction("snapshot", { url: "https://example.com" }, env);
    assert.equal(calls.length, 1, "the known-dead selector is not retried");
    assert.equal(second.engine, "chromium-rest", "REST still serves, just without the dead selector");
  } finally {
    globalThis.fetch = realFetch;
    _resetKitesurfProbe();
  }
});

test("the selector rides the browser-run path, which is the only one it works on", async () => {
  const { restUrl, runBrowserAction, _resetKitesurfProbe } =
    await import("./holding/_worker.js/lens-render.js");

  // Both spellings ROUTE — probed unauthenticated against the real account id,
  // each answers error 10000 rather than 7003 "could not route to". So posting
  // to the wrong one costs no error and no log line; it costs the opt-in. This
  // is a one-word difference with no symptom, which is exactly the kind that
  // survives a review, so it gets an assertion of its own rather than riding
  // along inside a behavioural test.
  const url = restUrl("acct", "snapshot", "kitesurf");
  assert.ok(url.includes("/browser-run/snapshot"), "Kitesurf documents this path alone");
  assert.ok(!url.includes("/browser-rendering/"), "the alias silently drops the selector");
  assert.ok(url.endsWith("?browser=kitesurf"));
  assert.equal(restUrl("acct", "snapshot", ""), restUrl("acct", "snapshot"), "no engine, no query string");

  // And the shipped caller must use that builder rather than its own literal,
  // which is the drift this exists to prevent.
  const realFetch = globalThis.fetch;
  const calls = [];
  try {
    _resetKitesurfProbe();
    globalThis.fetch = async (u) => { calls.push(String(u)); return new Response("{}", { status: 200 }); };
    await runBrowserAction("snapshot", { url: "https://example.com" }, { CF_ACCOUNT_ID: "acct", BROWSER_RUN_TOKEN: "tok" });
    assert.ok(calls[0].includes("/browser-run/snapshot?browser=kitesurf"), calls[0]);
  } finally {
    globalThis.fetch = realFetch;
    _resetKitesurfProbe();
  }
});

test("a 200 is not evidence that kitesurf rendered, and is not reported as if it were", async () => {
  const { runBrowserAction, _resetKitesurfProbe } =
    await import("./holding/_worker.js/lens-render.js");
  const realFetch = globalThis.fetch;

  try {
    _resetKitesurfProbe();
    // An endpoint that IGNORES an unrecognised query parameter answers exactly
    // this: 200, with the documented envelope, which carries no engine field.
    // The old code read that as confirmation and labelled the render `kitesurf`,
    // so a Chromium render was reported as Kitesurf on the one page whose entire
    // premise is showing what a machine actually saw.
    globalThis.fetch = async () => new Response(
      JSON.stringify({ success: true, result: { content: "<html></html>" }, meta: { status: 200, title: "x" } }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
    const run = await runBrowserAction("snapshot", { url: "https://example.com" }, { CF_ACCOUNT_ID: "acct", BROWSER_RUN_TOKEN: "tok" });
    assert.equal(run.engine, "kitesurf-requested", "a 200 means the call worked, not that Kitesurf served it");
    assert.notEqual(run.engine, "kitesurf", "only pnpm run kitesurf:check can promote this label");
  } finally {
    globalThis.fetch = realFetch;
    _resetKitesurfProbe();
  }
});

test("the ramp guard asks whether it can authenticate, not whether it is CI", async () => {
  const { releaseCredentialError } = await import("./scripts/lib/release-guard.mjs");

  // Interactive: wrangler's stored OAuth login IS the credential. Demanding an
  // env var here would break every workstation ramp this repo has ever done.
  assert.equal(releaseCredentialError({}), null);
  assert.equal(releaseCredentialError({ CLOUDFLARE_API_TOKEN: "" }), null);

  // In CI there is no login to fall back on. This used to be a flat `if (CI)
  // die()`, which refused the case it was built to protect — a ramp with a real
  // token, gated by a human — while doing nothing about the case that actually
  // breaks: a ramp that starts unauthenticated and fails partway, possibly after
  // traffic already moved to 10%.
  assert.match(releaseCredentialError({ CI: "true" }) || "", /CLOUDFLARE_API_TOKEN/);

  // Two accounts on this login means a non-interactive wrangler call dies with
  // "More than one account available", which reads like a bad token and is a
  // missing line of config. Caught here, by name, rather than mid-ramp.
  assert.match(releaseCredentialError({ CI: "true", CLOUDFLARE_API_TOKEN: "t" }) || "", /CLOUDFLARE_ACCOUNT_ID/);

  // Fully configured CI is allowed through — the whole point of the change.
  assert.equal(releaseCredentialError({ CI: "true", CLOUDFLARE_API_TOKEN: "t", CLOUDFLARE_ACCOUNT_ID: "a" }), null);
});

test("the shared browser ceiling bills everyone to one bucket, not per caller", async () => {
  const { BROWSER_FREE_PLAN, LENS_BUDGETS, overLensBudget } = await import("./holding/_worker.js/lens.js");

  // A budget carrying a fixed key must IGNORE the caller's IP. Two different
  // visitors have to land in the same bucket, because the allowance they are
  // spending belongs to the account rather than to either of them.
  const keys = [];
  const env = { LENS_RL_BROWSER_ALL: { limit: (arg) => { keys.push(arg.key); return { success: true }; } } };
  for (const ip of ["203.0.113.7", "198.51.100.4"]) {
    const req = new Request("https://aadhar.sh/lens/shot?url=https://example.com", { headers: { "cf-connecting-ip": ip } });
    await overLensBudget(LENS_BUDGETS.browserAll, req, env);
  }
  assert.deepEqual(keys, ["browser-run", "browser-run"], "the shared ceiling must not key on the caller");

  // The per-caller ceilings on the browser routes have to stay UNDER the
  // account's own limit, or one visitor can spend everyone's minute. Measured
  // 2026-08-06: free plan is 1 Quick Action per 10s account-wide, and `shot`
  // used to allow 8/min to a single IP.
  for (const name of ["shot", "browser"]) {
    assert.ok(LENS_BUDGETS[name].max <= BROWSER_FREE_PLAN.perMinute,
      `${name} allows ${LENS_BUDGETS[name].max}/min to one caller, over the account's ${BROWSER_FREE_PLAN.perMinute}/min`);
  }
  assert.ok(LENS_BUDGETS.browserAll.max <= BROWSER_FREE_PLAN.perMinute,
    "the shared ceiling must sit under the account allowance it exists to protect");
});

// ── /mcp: the 2026-07-28 dual-era contract ──────────────────────────────
// 2026-07-28 deleted the initialize handshake and moved version, identity and
// capabilities into per-request `_meta`. This server answers BOTH eras on one
// endpoint, which the spec sanctions, so the tests have to pin both — and pin
// that neither one leaks into the other.

const mcpPost = (body, headers = {}) => new Request("https://aadhar.sh/mcp", {
  method: "POST",
  body: JSON.stringify(body),
  headers: { "content-type": "application/json", ...headers },
});
// A well-formed modern request. BOTH keys are required by 2026-07-28, and the
// server enforces the second one, so a fixture carrying only the version would
// now be testing the refusal path in every test that used it.
const MODERN_META = { _meta: {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientCapabilities": {},
} };

test("server/discover answers identity, versions and capabilities in one round trip", async () => {
  const res = await handleSiteMcp(mcpPost({
    jsonrpc: "2.0", id: "d1", method: "server/discover", params: { ...MODERN_META },
  }), {}, context());
  const { result } = await res.json();

  // MUST be implemented as of 2026-07-28 — a client may probe it before
  // sending anything else, and a dual-era client uses it to tell the eras apart.
  assert.equal(result.resultType, "complete");
  assert.ok(result.supportedVersions.includes("2026-07-28"), "must advertise the modern revision");
  assert.ok(result.supportedVersions.includes("2025-06-18"), "must keep advertising the legacy ones it still serves");
  assert.deepEqual(result.capabilities, { tools: {}, resources: {} });
  assert.equal(result._meta["io.modelcontextprotocol/serverInfo"].name, "aadhar.sh");
  assert.ok(result.instructions.length > 20);
  // server/discover is a cacheable result like the list methods.
  assert.equal(typeof result.ttlMs, "number");
  assert.equal(result.cacheScope, "public");
});

test("an unsupported protocol version is refused with the list the client can retry from", async () => {
  const res = await handleSiteMcp(mcpPost({
    jsonrpc: "2.0", id: 7, method: "tools/list",
    params: { _meta: { "io.modelcontextprotocol/protocolVersion": "1900-01-01" } },
  }), {}, context());
  const { error } = await res.json();

  assert.equal(error.code, -32022, "UnsupportedProtocolVersion, from the reserved -32020..-32099 range");
  assert.equal(error.message, "Unsupported protocol version");
  // The data payload is the whole point: without `supported` the client has
  // nothing to retry with, and this error is also how a dual-era client
  // RECOGNISES a modern server, so its shape is load-bearing.
  assert.equal(error.data.requested, "1900-01-01");
  assert.ok(error.data.supported.includes("2026-07-28"));

  // A version we do speak passes the gate.
  const ok = await handleSiteMcp(mcpPost({ jsonrpc: "2.0", id: 8, method: "tools/list", params: { ...MODERN_META } }), {}, context());
  assert.ok((await ok.json()).result.tools.length > 0);
});

test("a modern request without clientCapabilities is malformed, and a legacy one is not", async () => {
  // 2026-07-28 marks `clientCapabilities` required on every modern request and
  // pins the refusal to -32602 + HTTP 400. The interesting half is what must
  // NOT be refused: this server is dual-era, so absence of `_meta` entirely is
  // an era signal rather than a defect, and enforcing the version key the same
  // way would shut the legacy door this server exists to hold open.
  const bare = { "io.modelcontextprotocol/protocolVersion": "2026-07-28" };
  const res = await handleSiteMcp(mcpPost({
    jsonrpc: "2.0", id: 11, method: "tools/list", params: { _meta: bare },
  }), {}, context());
  const { error } = await res.json();
  assert.equal(error.code, -32602, "plain Invalid Params, not a reserved-range code");
  assert.match(error.message, /clientCapabilities/, "must name the field, which client authors have often never heard of");
  assert.deepEqual(error.data.missing, ["io.modelcontextprotocol/clientCapabilities"]);
  assert.equal(res.status, 400, "the spec pins this one to 400 on HTTP");

  // A legacy caller sends no `_meta` at all and MUST still be served at 200.
  const legacy = await handleSiteMcp(mcpPost({ jsonrpc: "2.0", id: 12, method: "tools/list" }), {}, context());
  assert.equal(legacy.status, 200);
  assert.ok((await legacy.json()).result.tools.length > 0, "no _meta is legacy, not malformed");

  // Empty is a valid declaration; a non-object is not. Accepting the key's mere
  // presence would make this a spelling check instead of a contract.
  for (const [caps, ok] of [[{}, true], [{ roots: {} }, true], [true, false], ["none", false], [[], false], [null, false]]) {
    const r = await handleSiteMcp(mcpPost({
      jsonrpc: "2.0", id: 13, method: "tools/list",
      params: { _meta: { ...bare, "io.modelcontextprotocol/clientCapabilities": caps } },
    }), {}, context());
    const body = await r.json();
    assert.equal(!body.error, ok, `clientCapabilities: ${JSON.stringify(caps)} should ${ok ? "pass" : "be refused"}`);
  }

  // Version first: a caller on a version we do not speak is told THAT, not that
  // its `_meta` is malformed under a revision it never claimed to follow.
  const both = await handleSiteMcp(mcpPost({
    jsonrpc: "2.0", id: 14, method: "tools/list",
    params: { _meta: { "io.modelcontextprotocol/protocolVersion": "1900-01-01" } },
  }), {}, context());
  assert.equal((await both.json()).error.code, -32022, "the unsupported version is the actionable refusal");

  // A batch with one bad message is not a bad batch: 200, with the error in the
  // array where JSON-RPC batching puts it.
  const batch = await handleSiteMcp(mcpPost([
    { jsonrpc: "2.0", id: 15, method: "tools/list", params: { ...MODERN_META } },
    { jsonrpc: "2.0", id: 16, method: "tools/list", params: { _meta: bare } },
  ]), {}, context());
  assert.equal(batch.status, 200, "a batch has no single request whose status a 400 could describe");
  const rows = await batch.json();
  assert.ok(rows.find((r) => r.id === 15).result, "the well-formed message is still answered");
  assert.equal(rows.find((r) => r.id === 16).error.code, -32602);
});

test("every result carries resultType and server identity, and lists carry cache hints", async () => {
  // tools/call needs a real binding to reach a tool; the list methods do not.
  const env = { ASSETS: staticAssets({
    "/search-index.json": { records: [{ url: "/writing/agents", title: "Agents", description: "Notes", text: "cloudflare", kind: "writing" }] },
  }) };
  const cases = [
    ["tools/list", {}, true],
    ["resources/list", {}, true],
    ["resources/templates/list", {}, true],
    ["prompts/list", {}, true],
    ["tools/call", { name: "search_site", arguments: { q: "cloudflare" } }, false],
  ];
  for (const [method, params, cacheable] of cases) {
    const res = await handleSiteMcp(mcpPost({
      jsonrpc: "2.0", id: method, method, params: { ...params, ...MODERN_META },
    }), env, context());
    const { result } = await res.json();
    assert.equal(result.resultType, "complete", `${method} must carry resultType`);
    assert.equal(result._meta["io.modelcontextprotocol/serverInfo"].name, "aadhar.sh", `${method} must identify the server`);
    if (cacheable) {
      // CacheableResult: a freshness hint so a client can cache instead of poll.
      assert.ok(result.ttlMs > 0, `${method} must carry ttlMs`);
      assert.ok(["public", "private"].includes(result.cacheScope), `${method} must carry cacheScope`);
    }
  }

  // tools/list order is deterministic, which the spec asks for so clients can
  // cache and so an LLM's prompt cache keeps hitting.
  const twice = await Promise.all([0, 1].map(() =>
    handleSiteMcp(mcpPost({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { ...MODERN_META } }), {}, context()).then((r) => r.json())));
  assert.deepEqual(twice[0].result.tools.map((t) => t.name), twice[1].result.tools.map((t) => t.name));
});

test("the legacy initialize handshake still works and never hands back a modern version", async () => {
  // Legacy clients have NO fall-forward mechanism: told 2026-07-28, they would
  // fail on the next request with no way to recover. So initialize answers in
  // the legacy era only, whatever it was asked for.
  for (const [asked, expected] of [
    ["2025-06-18", "2025-06-18"],
    ["2024-11-05", "2024-11-05"],
    ["2026-07-28", "2025-06-18"],   // modern version over the legacy door
    [undefined,    "2025-06-18"],
  ]) {
    const res = await handleSiteMcp(mcpPost({
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: asked ? { protocolVersion: asked } : {},
    }), {}, context());
    const { result } = await res.json();
    assert.equal(result.protocolVersion, expected, `initialize(${asked}) should negotiate ${expected}`);
    assert.equal(result.serverInfo.name, "aadhar.sh");
  }

  // A legacy client sends no _meta and must still be served, not version-gated.
  const legacy = await handleSiteMcp(mcpPost({ jsonrpc: "2.0", id: 2, method: "tools/list" }), {}, context());
  assert.ok((await legacy.json()).result.tools.length > 0, "a request with no _meta is legacy, not invalid");
});

test("the routing headers are checked when present and never required", async () => {
  const body = { jsonrpc: "2.0", id: 3, method: "tools/list", params: { ...MODERN_META } };

  // Absent: fine. Requiring them would reject every legacy client at the
  // transport layer, which is the row of the spec's compatibility matrix this
  // server exists to avoid.
  assert.ok((await (await handleSiteMcp(mcpPost(body), {}, context())).json()).result);
  // Agreeing: fine.
  assert.ok((await (await handleSiteMcp(mcpPost(body, { "mcp-method": "tools/list" }), {}, context())).json()).result);
  // Disagreeing: refused. This is the case the header exists to prevent — an
  // intermediary authorizing tools/list while the body calls a tool.
  const bad = await (await handleSiteMcp(mcpPost(body, { "mcp-method": "tools/call" }), {}, context())).json();
  assert.equal(bad.error.code, -32020, "HeaderMismatch");

  const named = { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "coffee_availability", arguments: {}, ...MODERN_META } };
  const mismatchedName = await (await handleSiteMcp(mcpPost(named, { "mcp-name": "search_site" }), {}, context())).json();
  assert.equal(mismatchedName.error.code, -32020, "Mcp-Name must agree with the tool being called");
});

// ── both MCP servers speak one protocol ─────────────────────────────
// This origin publishes TWO MCP servers, /mcp and /serendipity/mcp. They share
// no data and no tools; they DO share the wire rules, via
// holding/_worker.js/lib/mcp-protocol.js. Two servers on one origin speaking
// different dialects is the kind of bug a client author reports to you, so the
// conformance assertions run against both rather than against the site one.

test("the site and serendipity MCP servers agree on the 2026-07-28 wire rules", async () => {
  const { handleMcp } = await import("./serendipity/serendipity.js");
  const post = (body, headers = {}) => new Request("https://aadhar.sh/serendipity/mcp", {
    method: "POST", body: JSON.stringify(body),
    headers: { "content-type": "application/json", ...headers },
  });
  // The protocol-level methods touch no database, so a null `d` is enough.
  const call = async (body, headers) => (await handleMcp(post(body, headers), {}, null)).json();
  const modern = { _meta: {
    "io.modelcontextprotocol/protocolVersion": "2026-07-28",
    "io.modelcontextprotocol/clientCapabilities": {},
  } };

  // server/discover: MUST exist, and must advertise the same version set as the
  // site server — a client that trusts one origin's answer should not find the
  // second server disagreeing about what the origin speaks.
  const disc = (await call({ jsonrpc: "2.0", id: 1, method: "server/discover", params: { ...modern } })).result;
  assert.equal(disc.resultType, "complete");
  assert.equal(disc._meta["io.modelcontextprotocol/serverInfo"].name, "serendipity");
  assert.deepEqual(disc.supportedVersions, MCP_SUPPORTED_VERSIONS);
  assert.deepEqual(disc.capabilities, { tools: {} }, "serendipity exposes tools only, no resources");

  // The version gate, byte-identical to the site server's because it is the
  // same function.
  const refused = await call({
    jsonrpc: "2.0", id: 2, method: "tools/list",
    params: { _meta: { "io.modelcontextprotocol/protocolVersion": "1900-01-01" } },
  });
  assert.equal(refused.error.code, -32022);
  assert.deepEqual(refused.error.data.supported, MCP_SUPPORTED_VERSIONS);

  // Cache hints and resultType on every list surface.
  for (const method of ["tools/list", "resources/list", "resources/templates/list", "prompts/list"]) {
    const { result } = await call({ jsonrpc: "2.0", id: method, method, params: { ...modern } });
    assert.equal(result.resultType, "complete", `${method} must carry resultType`);
    assert.ok(result.ttlMs > 0, `${method} must carry ttlMs`);
    assert.equal(result.cacheScope, "public");
    assert.equal(result._meta["io.modelcontextprotocol/serverInfo"].name, "serendipity");
  }

  // The legacy door still opens, and still never hands back a modern version.
  for (const [asked, expected] of [["2025-06-18", "2025-06-18"], ["2026-07-28", "2025-06-18"]]) {
    const { result } = await call({ jsonrpc: "2.0", id: 3, method: "initialize", params: { protocolVersion: asked } });
    assert.equal(result.protocolVersion, expected);
    assert.equal(result.serverInfo.name, "serendipity");
  }

  // The required-`_meta` rule, same function and therefore same verdict: a
  // modern request without clientCapabilities is malformed at 400, a legacy one
  // with no `_meta` at all is served at 200.
  const malformed = await handleMcp(post({
    jsonrpc: "2.0", id: 6, method: "tools/list",
    params: { _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" } },
  }), {}, null);
  assert.equal(malformed.status, 400);
  assert.equal((await malformed.json()).error.code, -32602);
  const legacyOk = await handleMcp(post({ jsonrpc: "2.0", id: 7, method: "tools/list" }), {}, null);
  assert.equal(legacyOk.status, 200);
  assert.ok((await legacyOk.json()).result.tools.length > 0);

  // Routing headers: checked when present, never required.
  assert.ok((await call({ jsonrpc: "2.0", id: 4, method: "tools/list", params: { ...modern } })).result);
  const mismatch = await call({ jsonrpc: "2.0", id: 5, method: "tools/list", params: { ...modern } }, { "mcp-method": "tools/call" });
  assert.equal(mismatch.error.code, -32020);
});

test("neither MCP server keeps a private copy of the protocol constants", async () => {
  // The whole point of lib/mcp-protocol.js is that there is ONE answer to "what
  // does this origin speak". A server that re-declares MCP_SUPPORTED locally
  // would pass every test above on the day it was written and drift later.
  for (const file of ["holding/_worker.js/mcp.js", "serendipity/serendipity.js"]) {
    const src = readFileSync(file, "utf8");
    assert.ok(/from ".*lib\/mcp-protocol\.js"/.test(src), `${file} must import the shared protocol module`);
    assert.ok(!/^const MCP_SUPPORTED\s*=/m.test(src), `${file} re-declares MCP_SUPPORTED instead of importing it`);
    assert.ok(!/^const MCP_PROTOCOL\s*=/m.test(src), `${file} re-declares MCP_PROTOCOL instead of importing it`);
  }
});

// ── /terminal — the terminal programs ─────────────────────────────────────────
// The renderer is pure and the apps are readers, so these run with stub assets
// and no network. What they pin is the handful of properties a frame stops
// being a frame without.

const TERMINAL_ASSETS = {
  "/writing/posts.json": [
    { slug: "one", title: "The first note", date: "2026-01-02" },
    { slug: "two", title: "The second note", date: "2026-02-03" },
    { slug: "three", title: "The third note", date: "2026-03-04" },
  ],
  "/images/metadata.json": {
    A_1: { camera: "FUJIFILM X-T50", lens: "XF27mmF2.8", film: "Classic Chrome", date: "2026:01:02", iso: 640, recipe: { "Film Simulation": "Classic Chrome", "Dynamic Range": "DR400" } },
    A_2: { camera: "FUJIFILM X-T50", lens: "XF23mmF1.4", film: "Acros", date: "2025:05:06" },
    A_3: { camera: "LEICA M11", lens: "Summicron 35", film: "", date: "2025:07:08" },
  },
  "/images/alt.json": { A_1: "A quiet corner", A_2: "Rain on glass", A_3: "A doorway" },
  "/images/hashes.json": { A_1: { a: "1a1a1a1a", j: "2b2b2b2b", s: "3c3c3c3c" }, A_2: {}, A_3: {} },
  "/search-index.json": { records: [{ url: "/writing/one", title: "The first note", description: "d", text: "lattice", kind: "writing" }] },
};
const terminalEnv = () => ({ ASSETS: staticAssets(TERMINAL_ASSETS) });
const terminalReq = (path) => new Request(`https://aadhar.sh${path}`);
// /terminal stopped being a frame when the console became the wire view; it is
// an HTML page now and has its own tests below.
const terminalGet = (path) => handleTool(terminalReq(path), terminalEnv(), context());

// Every state worth drawing, so a width regression cannot hide in the one pane
// nobody exercised. Panes that need network (reading, listening, around,
// coffee) still render here — their loaders fail closed to an empty list, which
// is itself the case worth pinning.
const TERMINAL_STATES = [
  "/finger", "/finger?help=1", "/finger?keys=q",
  ...["overview", "writing", "reading", "listening", "photos", "around", "coffee", "deploys", "search"]
    .map((pane) => `/finger?pane=${pane}`),
  "/finger?pane=writing&keys=jj", "/finger?pane=writing&cursor=1&open=two",
  "/finger?pane=search&q=lattice", "/finger?pane=search&q=lattice&open=0",
  "/finger?pane=deploys&keys=G", "/finger?pane=photos",
  "/photos", "/photos?film=acros", "/photos?keys=j%3Ccr%3E", "/photos?open=A_1",
  "/photos?q=nothingmatchesthis", "/lens", "/lens?url=javascript%3Aalert(1)",
];

test("no frame line runs past 80 columns, and none of them draws a box", async () => {
  // What replaced "every row is EXACTLY 80 columns". That invariant existed to
  // keep a drawn border lining up; the border is gone (2026-08-06), because a
  // window drawn in ASCII — [_][#][X] and all — inside a real window that
  // already had those controls was chrome pretending to be content.
  //
  // The useful half survives: a line that overflows 80 wraps in a terminal and
  // silently destroys the alignment of everything a tool laid out in columns.
  for (const path of TERMINAL_STATES) {
    const res = await terminalGet(path);
    assert.equal(res.status, 200, path);
    const text = await res.text();
    const lines = text.split("\n").filter((line) => line.length);
    // Was `> 3`, which only held because five of those lines were border. A
    // rejected target legitimately answers in two lines now.
    assert.ok(lines.length >= 2, `${path} produced no output`);
    for (const line of lines) {
      assert.ok([...line].length <= 80, `${path} drew a ${[...line].length}-column row: ${line}`);
    }
    // The chrome, named so it cannot creep back one glyph at a time.
    for (const glyph of ["╔", "╚", "║", "╟", "[_][#][X]"]) {
      assert.ok(!text.includes(glyph), `${path} is drawing frame chrome again (${glyph})`);
    }
  }
});

test("a tool frame never emits an escape byte, in any mode", async () => {
  // There is no colour mode left to get wrong. The audience for these routes is
  // curl and a model, and an escape sequence in a context window is noise the
  // model then has to be robust to. `?plain=1` used to be the opt-OUT; plain is
  // now the only thing there is, and the parameter is inert rather than removed
  // so old links keep working.
  for (const path of ["/finger", "/finger?plain=1", "/finger?plain=0", "/dict", "/photos"]) {
    const text = await (await terminalGet(path)).text();
    assert.ok(!text.includes("\x1b"), `${path} leaked an escape sequence`);
  }
  const a = await (await terminalGet("/finger?plain=1")).text();
  const b = await (await terminalGet("/finger")).text();
  assert.equal(a, b, "plain=1 and the default must be the same bytes now");
});

test("a frame's printed state is a URL that reproduces it", async () => {
  // The whole session model rests on this. State is a link rather than a stored
  // object, so a frame that prints a URL which does NOT come back to the same
  // frame has broken resume, fork, and every "pass the url back" instruction in
  // the MCP tool descriptions — while still looking completely correct.
  for (const path of ["/finger?pane=writing&keys=jj", "/finger?pane=deploys&keys=G", "/photos?film=acros&keys=j"]) {
    const first = await (await terminalGet(`${path}&plain=1`)).text();
    const printed = first.match(/state (\/[a-z]+(?:\?[^\s│║]*)?)/)?.[1];
    assert.ok(printed, `${path} printed no state URL`);
    // Replay the printed state with NO keys: same frame, minus the keystrokes.
    const replayed = await (await terminalGet(printed + (printed.includes("?") ? "&" : "?") + "plain=1")).text();
    assert.equal(replayed, first, `${path} does not reproduce from the URL it printed`);
  }
});

test("key sequences are bounded and named keys parse", () => {
  assert.deepEqual(tokenizeKeys("2jj<cr>"), ["2", "j", "j", "\r"]);
  assert.deepEqual(tokenizeKeys("<esc><tab><sp>"), ["\x1b", "\t", " "]);
  // An unknown <name> is not a key — it falls through to its literal characters
  // rather than being silently dropped, so a typo shows up in the frame.
  assert.deepEqual(tokenizeKeys("<nope>"), ["<", "n", "o", "p", "e", ">"]);
  // The bound is what stops one request driving the pane loader indefinitely.
  assert.equal(tokenizeKeys("j".repeat(500)).length, 32);
  assert.deepEqual(tokenizeKeys(""), []);
  assert.deepEqual(tokenizeKeys(null), []);
});

test("the tui routes refuse to be cached or indexed", async () => {
  // A frame is per-query and several are live (playlist, calendar, lens). The
  // route also negotiates on Accept, which a URL-keyed edge cache cannot
  // represent — the same trap lib/cache.js documents for the markdown twins.
  for (const path of ["/finger", "/photos"]) {
    const res = await terminalGet(path);
    assert.equal(res.headers.get("cache-control"), "no-store", path);
    assert.equal(res.headers.get("x-robots-tag"), "noindex", path);
    assert.equal(res.headers.get("vary"), "accept", path);
  }
});

test("/terminal shows the wire, and renders it through the real MCP handler", async () => {
  // The page exists to show a VIEWER what an agent gets. That is only true if it
  // runs the actual handler: a second code path that merely agreed with /mcp
  // today is precisely the thing this page is supposed to not be.
  const res = await handleTerminal(new Request("https://aadhar.sh/terminal", {
    headers: { accept: "text/html" },
  }), terminalEnv(), context());
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") || "", /^text\/html/);
  const html = await res.text();

  // The exchange itself: both halves of the request, and a catalogue that came
  // back from tools/list rather than from a hand-written list in this file.
  assert.match(html, /tools\/list/);
  assert.match(html, /tools\/call/);
  assert.match(html, /jsonrpc/);
  for (const tool of ["finger", "dict", "encode", "lens_inspect"]) {
    assert.ok(html.includes(tool), `the catalogue is missing ${tool}`);
  }

  // And it is not the emulator again. Named glyph by glyph and class by class,
  // because this regressed once already by being rebuilt one layer down: the
  // frames drew [_][#][X] in ASCII inside a real window that had those buttons.
  for (const ghost of ["ps-line", "ps-console", "PowerShell", "[_][#][X]", "╔", "terminal.js"]) {
    assert.ok(!html.includes(ghost), `/terminal is drawing the old console again (${ghost})`);
  }
});

test("a browser gets the same text a terminal does, not a second layout", async () => {
  // The claim survived the console's deletion, in a simpler form. A tool route
  // asked for HTML wraps the SAME frameText a .txt request gets in a <pre>; if
  // the HTML arm ever grew its own layout, what a person sees and what an agent
  // reads would start to differ and the page would be claiming something untrue.
  //
  // This used to compare console scrollback rows and assert on <span class="c-*">
  // colouring. Both are gone: there is no console, and no colour to lose.
  const htmlReq = new Request("https://aadhar.sh/finger", { headers: { accept: "text/html" } });
  const html = await (await handleTool(htmlReq, terminalEnv(), context())).text();
  const text = await (await terminalGet("/finger")).text();

  const pre = /<pre class="tool-out">([\s\S]*?)<\/pre>/.exec(html);
  assert.ok(pre, "a tool asked for HTML must render the frame in a <pre>");
  const unescaped = pre[1]
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'").replace(/&amp;/g, "&");
  for (const line of text.split("\n").filter(Boolean)) {
    assert.ok(unescaped.includes(line), `the HTML view dropped or altered a row: ${line}`);
  }
});

test("an unknown program 404s and names the ones that exist", async () => {
  const res = await terminalGet("/terminal/nope");
  assert.equal(res.status, 404);
  assert.match(await res.text(), /\/terminal/);
  const post = await handleTool(new Request("https://aadhar.sh/finger", { method: "POST" }), terminalEnv(), context());
  assert.equal(post.status, 405);
  assert.equal(post.headers.get("allow"), "GET, HEAD");
});

test("every frame tool the MCP server lists is one the server can actually call", async () => {
  // tools/list is a promise. A tool advertised but not dispatched fails only
  // when a client believes the list and calls it — which is exactly the caller
  // this surface exists for.
  const env = terminalEnv();
  const listed = (await (await handleSiteMcp(mcpPost({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { ...MODERN_META } }), env, context())).json())
    .result.tools.map((tool) => tool.name);
  // The MCP tool name IS the route name. One vocabulary: what you type in the
  // console, what you curl, and what an agent calls are the same word.
  const FRAME_TOOLS = ["finger", "photos", "radar", "dict", "cache", "lens", "agent_ready"];
  for (const name of FRAME_TOOLS) assert.ok(listed.includes(name), `${name} has a route but is not an MCP tool`);
  assert.ok(!listed.some((n) => n.startsWith("terminal_")), "tool names must match their routes, not the console");

  for (const name of FRAME_TOOLS) {
    const args = name === "lens" ? { url: "https://example.com" }
      : name === "radar" ? { samples: [{ name: "AP", rssi: -58 }] }
      : {};
    const res = await handleSiteMcp(mcpPost({
      jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args, ...MODERN_META },
    }), env, context());
    const { result, error } = await res.json();
    assert.ok(!error, `${name} is listed but not dispatched: ${JSON.stringify(error)}`);
    // terminal_lens reaches a real fetch it cannot make here, so it is allowed to
    // come back as a rendered failure — what it may NOT do is come back unknown.
    const frame = result.structuredContent?.frame ?? "";
    // Was `frame.includes("╔")`. The box is gone; what still has to be true is
    // that a frame came back at all and that it names the tool that drew it.
    assert.ok(frame.length > 20, `${name} returned no frame`);
    assert.ok(frame.startsWith(name.replace("_", "-")) || frame.includes(name.replace("_", "-")),
      `${name}'s frame does not say which tool drew it: ${frame.slice(0, 60)}`);
    assert.ok(!frame.includes("\x1b"), `${name} returned ANSI escapes into a model context`);
  }
});

test("the tui frame never renders a photo field the public projection withholds", async () => {
  // photos.js keeps GPS and unlisted EXIF behind PHOTO_PUBLIC_FIELDS. The frame
  // renders `photo.metadata`, so it inherits that projection — but it renders
  // the RECIPE card by iterating keys, and an iteration is exactly the shape
  // that picks up a field somebody adds later without meaning to publish it.
  const env = { ASSETS: staticAssets({
    ...TERMINAL_ASSETS,
    "/images/metadata.json": {
      A_1: {
        camera: "FUJIFILM X-T50", film: "Classic Chrome", date: "2026:01:02",
        gps: "40.7128,-74.0060", gpsLatitude: 40.7128, serialNumber: "SECRET123",
        recipe: { "Film Simulation": "Classic Chrome" },
      },
    },
  }) };
  const text = await (await handleTool(terminalReq("/photos?open=A_1&plain=1"), env, context())).text();
  assert.ok(text.includes("Classic Chrome"), "the frame did not render at all");
  for (const secret of ["40.7128", "-74.0060", "SECRET123"]) {
    assert.ok(!text.includes(secret), `the frame leaked a withheld field: ${secret}`);
  }
});

// ── /ask — the natural-language door ────────────────────────────
// Every test here runs the ROUTER path (no AI binding), which is the mode CI
// and local dev get. That is deliberate rather than a limitation: the router is
// the fallback the whole route rests on when the model is unavailable, and it
// is the only half that can be asserted deterministically.






test("the ask loop and the MCP server call ONE tool registry", async () => {
  // lib/tools.js exists so a tool description cannot be reworded in one door and
  // not the other. If either side grows a private list, this fails.
  const env = terminalEnv();
  const listed = (await (await handleSiteMcp(mcpPost({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { ...MODERN_META } }), env, context())).json())
    .result.tools.map((t) => t.name);
  for (const tool of DATA_TOOLS) {
    assert.ok(listed.includes(tool.name), `${tool.name} is in the ask catalog but not in tools/list`);
    assert.ok(tool.description && tool.inputSchema, `${tool.name} must carry a description and a schema for function calling`);
  }
  const src = readFileSync("holding/_worker.js/mcp.js", "utf8");
  assert.match(src, /from "\.\/lib\/tools\.js"/, "mcp.js must import the shared registry");
  assert.ok(!/name: "search_site"/.test(src), "mcp.js re-declares a data tool instead of importing it");
});


// ── reading somebody else's site ─────────────────────────────────────────



test("a door that could not be read is never reported as a door that is shut", async () => {
  // The honesty invariant, asserted on the classifier directly. Locally every
  // external probe fails for want of the AadharshBot signing key, and reporting
  // that as "not served" would have this thing confidently announcing that
  // well-known origins have no llms.txt.
  const { classifyDoor } = await import("./holding/_worker.js/lib/doors.js");

  const failed = classifyDoor({ ok: false, error: "signing key is unavailable" }, "text/plain");
  assert.equal(failed.ok, false);
  assert.equal(failed.unreadable, true, "a failed check was reported as a negative result");

  // A real 404 IS a finding, and must not be confused with the above.
  const missing = classifyDoor({ ok: false, status: 404 }, "text/plain");
  assert.equal(missing.ok, false);
  assert.ok(!missing.unreadable, "a 404 is a shut door, not an unreadable one");
  assert.equal(missing.why, "HTTP 404");

  // A 200 that answers the wrong content-type is not an open door: SPA
  // catch-alls serve their shell for every unknown path, and counting that as
  // present would make this reader agree with every site that has no agent
  // surface at all.
  const spa = classifyDoor({ ok: true, status: 200, body: "<!doctype html>", contentType: "text/html; charset=utf-8" }, "text/plain");
  assert.equal(spa.ok, false);
  assert.equal(spa.wrongType, "text/html");

  // And the happy path still opens.
  const open = classifyDoor({ ok: true, status: 200, body: "# llms\nhello", contentType: "text/plain" }, "text/plain");
  assert.equal(open.ok, true);
  assert.equal(open.bytes, 12);
});

// ── /ask sessions — the one thing here with a Durable Object ────






// ── /radar — the instrument for somebody else's antenna ─────────

test("radar drops readings that are not dBm, and bounds the rest", async () => {
  // The caller is a shell script somebody wrote in five minutes, so a bad sample
  // is dropped rather than fatal. dBm is negative by definition: a positive
  // number is a unit mistake, not a very strong signal, and plotting it would
  // put a device inside the centre ring.
  const { readSamples, RADAR_LIMITS } = await import("./holding/_worker.js/radar.js");
  const parsed = readSamples({ samples: [
    { name: "ok", rssi: -58 },
    { name: "positive", rssi: 5 },
    { name: "absurd", rssi: -900 },
    { name: "nan", rssi: "loud" },
    { rssi: -70 },
  ] });
  assert.deepEqual(parsed.map((p) => p.name), ["ok", "unknown"]);
  assert.equal(parsed[0].rssi, -58);
  // Strongest first: the thing you are hunting belongs at the top.
  assert.ok(parsed[0].rssi > parsed[1].rssi);
  // Bounded on count and name length.
  const many = readSamples({ samples: Array.from({ length: 200 }, (_, i) => ({ name: "x".repeat(300), rssi: -50 - i % 40 })) });
  assert.equal(many.length, RADAR_LIMITS.samples);
  assert.equal(many[0].name.length, RADAR_LIMITS.name);
});

test("radar bands match findphone's field calibration", async () => {
  const { bandOf } = await import("./holding/_worker.js/radar.js");
  assert.equal(bandOf(-40).label, "arm's reach");
  assert.equal(bandOf(-45).label, "arm's reach");
  assert.equal(bandOf(-55).label, "same table");
  assert.equal(bandOf(-70).label, "same room");
  assert.equal(bandOf(-80).label, "next room");
  assert.equal(bandOf(-95).label, "far / noise");
});

test("the radar frame fits 80 columns and says its angles are meaningless", async () => {
  // The honesty line is load-bearing, not decoration: RSSI is a scalar and a
  // plot with angles invites a reader to infer a direction that is not there.
  const res = await handleTool(new Request("https://aadhar.sh/radar?plain=1", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ samples: [{ name: "AP", rssi: -58, kind: "wifi", history: [-70, -62, -58] }, { name: "Buds", rssi: -44 }] }),
  }), terminalEnv(), context());
  assert.equal(res.status, 200);
  const text = await res.text();
  for (const line of text.split("\n").filter(Boolean)) {
    assert.ok([...line].length <= 80, `radar drew a ${[...line].length}-column row`);
  }
  // The honesty line is the point of this test and survives the chrome strip
  // untouched — it was never part of the border.
  assert.match(text, /ANGLES ARE DECORATIVE/);
  assert.match(text, /-58 dBm/);
  assert.match(text, /arm's reach/);
  assert.equal(res.headers.get("cache-control"), "no-store");
});

test("radar is the only program that accepts a POST", async () => {
  // The surface stays read-only apart from the one route whose input this server
  // structurally cannot produce. A new POST-shaped program should have to argue
  // for itself here rather than arrive by accident.
  for (const app of ["finger", "photos", "lens", "dict"]) {
    const res = await handleTool(new Request(`https://aadhar.sh/${app}`, { method: "POST" }), terminalEnv(), context());
    assert.equal(res.status, 405, `${app} accepted a POST`);
    assert.equal(res.headers.get("allow"), "GET, HEAD");
  }
  const radar = await handleTool(new Request("https://aadhar.sh/radar", { method: "PUT" }), terminalEnv(), context());
  assert.equal(radar.status, 405);
  assert.equal(radar.headers.get("allow"), "GET, HEAD, POST");
});

test("an empty or malformed radar payload explains itself instead of 500ing", async () => {
  for (const body of ["", "not json", JSON.stringify({ samples: [] })]) {
    const res = await handleTool(new Request("https://aadhar.sh/radar?plain=1", {
      method: "POST", headers: { "content-type": "application/json" }, body,
    }), terminalEnv(), context());
    assert.equal(res.status, 200);
    assert.match(await res.text(), /no usable readings|needs a name and an rssi/i);
  }
});

// ── /dict — the registration lint ───────────────────────────────
// The rules ARE the product, and they are asserted as pure functions because
// every external fetch in this repo dies at signing in a test environment.

test("each Chromium veto is caught on its own, and a clean dictionary passes", async () => {
  const { auditDictionary } = await import("./holding/_worker.js/dict.js");
  const base = { "use-as-dictionary": 'match="/a/*"' };

  // must-revalidate and no-cache are the two that surprise people: neither means
  // "do not store" anywhere else in HTTP, and each kills registration outright.
  for (const [cc, expected] of [
    ["public, max-age=600, must-revalidate", "must-revalidate"],
    ["public, max-age=600, no-cache", "no-cache"],
    ["no-store", "no-store"],
  ]) {
    const audit = auditDictionary({ ...base, "cache-control": cc });
    assert.equal(audit.registers, false, `${cc} should not register`);
    assert.ok(audit.vetoes.some((v) => v.id === expected), `${cc} should be vetoed by ${expected}`);
  }

  // Missing the header at all is its own veto, not a pass by omission.
  assert.equal(auditDictionary({ "cache-control": "public, max-age=600" }).registers, false);

  const good = auditDictionary({ ...base, "cache-control": "public, max-age=600, stale-while-revalidate=86400" });
  assert.equal(good.registers, true);
  assert.equal(good.warns.length, 0);
  // Every rule reports, including the ones that passed — a lint that prints only
  // failures leaves you unsure whether it looked.
  assert.equal(good.results.length, 6);
  assert.ok(good.results.every((r) => r.detail));
});

test("the lint knows the dictionary's life is the SWR window, not max-age", async () => {
  // The non-obvious rule, and the one that reads as "it worked yesterday": a
  // dictionary with a year of max-age and no stale-while-revalidate is usable
  // for zero seconds past freshness.
  const { auditDictionary } = await import("./holding/_worker.js/dict.js");
  const noSwr = auditDictionary({ "use-as-dictionary": "match=\"/*\"", "cache-control": "public, max-age=31536000, immutable" });
  assert.equal(noSwr.registers, true, "no SWR is a warning, not a veto");
  assert.ok(noSwr.warns.some((w) => w.id === "lifetime"));

  // s-maxage is a shared-cache directive and buys a browser nothing here.
  const shared = auditDictionary({ "use-as-dictionary": "match=\"/*\"", "cache-control": "public, s-maxage=99999, stale-while-revalidate=600" });
  assert.ok(shared.warns.some((w) => w.id === "s-maxage"));
});

test("a delta served without vary: available-dictionary is flagged as a decode failure", async () => {
  // Not a slow page. A shared cache hands the delta to a client with no
  // dictionary and the navigation dies on ERR_CONTENT_DECODING_FAILED.
  const { auditConsumer } = await import("./holding/_worker.js/dict.js");
  const unsafe = auditConsumer({ "content-encoding": "dcz", vary: "accept-encoding" });
  assert.equal(unsafe.isDelta, true);
  assert.equal(unsafe.variesOnDictionary, false);

  const safe = auditConsumer({ "content-encoding": "dcz", vary: "accept-encoding, available-dictionary" });
  assert.equal(safe.variesOnDictionary, true);
  assert.equal(auditConsumer({ "content-encoding": "br", vary: "accept-encoding" }).isDelta, false);
});

test("dict refuses a private target before fetching, and explains itself with none", async () => {
  const idle = await (await terminalGet("/dict?plain=1")).text();
  assert.match(idle, /fail silently/);
  assert.match(idle, /SILENTLY IGNORES/);   // the node:zlib finding is on the page, not just in source
  const refused = await (await terminalGet("/dict?plain=1&url=http%3A%2F%2F169.254.169.254%2F")).text();
  assert.match(refused, /refused/);
});

// ── lens cost: origin-level discovery is cached ──────────────────────────

test("a second scan of the same origin reuses discovery instead of re-probing", async () => {
  // This is where lens's cost lived: a production trace put lens.discovery at
  // 656ms of a 685ms scan, re-asking one host the same 26 questions it had
  // already answered. The cache is keyed by ORIGIN, not URL, because not one of
  // those 26 depends on which page was scanned.
  const { originDiscovery } = await import("./holding/_worker.js/lens.js");
  const store = new Map();
  const realCaches = globalThis.caches;
  globalThis.caches = {
    default: {
      async match(req) { const hit = store.get(req.url); return hit ? new Response(hit) : undefined; },
      async put(req, res) { store.set(req.url, await res.text()); },
    },
  };
  try {
    const first = await originDiscovery("https://example.com", "example.com", {});
    assert.equal(first.cached, false, "a cold origin must actually probe");
    assert.equal(store.size, 1, "the result must be cached for the next scan");

    const second = await originDiscovery("https://example.com", "example.com", {});
    assert.equal(second.cached, true, "a warm origin must not re-probe");
    // Same answers, minus the flag — a cache that returned different data would
    // make two surfaces on this site disagree about the same host.
    const { cached: _a, ...firstBody } = first;
    const { cached: _b, ...secondBody } = second;
    assert.deepEqual(secondBody, firstBody);

    // A different origin is a different key, not a stale hit.
    const other = await originDiscovery("https://other.example", "other.example", {});
    assert.equal(other.cached, false);
    assert.equal(store.size, 2);

    // And `fresh` bypasses for a caller that needs the live answer.
    const forced = await originDiscovery("https://example.com", "example.com", {}, { fresh: true });
    assert.equal(forced.cached, false);
  } finally {
    if (realCaches === undefined) delete globalThis.caches; else globalThis.caches = realCaches;
  }
});

test("discovery still works with no cache at all", async () => {
  // Under plain node `caches` does not exist, and a scan must degrade to the
  // previous behaviour (a live fan-out every time) rather than throw.
  const { originDiscovery } = await import("./holding/_worker.js/lens.js");
  const realCaches = globalThis.caches;
  delete globalThis.caches;
  try {
    const out = await originDiscovery("https://example.com", "example.com", {});
    assert.equal(out.cached, false);
    assert.ok("robots" in out && "llms" in out && "mcp" in out);
  } finally { if (realCaches !== undefined) globalThis.caches = realCaches; }
});

test("readDoors reads lens's discovery rather than re-probing the same files", async () => {
  // doors.js originally fetched llms.txt, the agent card and the api-catalog
  // itself, duplicating four of lens's twenty-six probes. Worse than wasteful:
  // two surfaces on one site could disagree about the same origin.
  const src = readFileSync("holding/_worker.js/lib/doors.js", "utf8");
  assert.match(src, /originDiscovery/, "doors must consume the shared discovery");
  for (const dup of ["/llms.txt", "/.well-known/agent-card.json", "/.well-known/api-catalog"]) {
    assert.ok(!src.includes(`lensProbe(origin + "${dup}"`), `doors re-probes ${dup} instead of reusing discovery`);
  }
});

// ── lens phases: pay for what you asked for ──────────────────────────────

test("a page-only scan omits the discovery-derived fields rather than zeroing them", async () => {
  // The honesty rule of the split. A readiness score computed without discovery
  // is not a partial score, it is a WRONG one, and `doors: 0` would read as
  // "this site has no agent doors" when it means "nobody looked". So the fields
  // are ABSENT and `phases` says which ran.
  const { lensInspect, lensObservationSummary } = await import("./holding/_worker.js/lens.js");
  let out;
  try {
    out = await lensInspect("https://example.com/", {}, { phases: ["page"] });
  } catch { return; }   // no signing key here; the shape assertions below need a body

  assert.equal(out.phases.page, true);
  assert.equal(out.phases.discovery, false);
  // Absent, not empty. `in` rather than a truthiness check, because {} and 0
  // are exactly the values that would lie.
  assert.ok(!("readiness" in out), "readiness must be absent when discovery did not run");
  assert.ok(!("agent" in out), "agent doors must be absent when discovery did not run");
  assert.ok(!("discovery" in out));

  // And the summary carries the phase forward, so a caller downstream can still
  // tell a zero from an absence.
  const summary = lensObservationSummary(out);
  assert.equal(summary.phases.discovery, false);
});

test("the default scan is unchanged — every phase still runs", async () => {
  // The split must be opt-in. Existing callers (/lens/fetch, lens_inspect,
  // /lens, the census) pass no phases and must keep the full behaviour.
  const src = readFileSync("holding/_worker.js/lens.js", "utf8");
  assert.match(src, /if \(opts\.phases && !opts\.phases\.includes\("discovery"\)\) return out;/,
    "the early return must require an explicit phases opt-in");
  // A summary built from a full result reports every phase true by default, so
  // nothing downstream has to special-case the old shape.
  const { lensObservationSummary } = await import("./holding/_worker.js/lens.js");
  assert.deepEqual(lensObservationSummary({}).phases, { page: true, discovery: true, botViews: true });
});

// ── lens parse budget: the CPU-bound half ────────────────────────────────

test("the parse is capped, and a prefix parse says so instead of under-reporting", async () => {
  // lensText/lensMarkdown are regex chains costing ~32ms per MB (measured, node,
  // same V8). At the old 2MB fetch cap that is ~64ms of pure CPU — impossible on
  // the Workers free plan's 10ms ceiling and wasteful on paid. Capping the PARSE
  // bounds the worst case; the median page is nowhere near it and is untouched.
  const { LENS_PARSE_CAP, lensObservationSummary } = await import("./holding/_worker.js/lens.js");
  assert.ok(LENS_PARSE_CAP > 0 && LENS_PARSE_CAP <= 512 * 1024);

  // rawBytes must stay the TRUE size. We know it from the fetch even when we
  // decline to parse all of it, and reporting the prefix as the page's size
  // would be a plain lie about the thing being measured.
  const truncated = lensObservationSummary({
    anatomy: { rawBytes: 2_000_000, parsedBytes: 262_144, parseTruncated: true, wordCount: 400 },
  });
  assert.equal(truncated.bytes, 2_000_000, "bytes must report the whole document");
  assert.equal(truncated.parsedBytes, 262_144);
  assert.equal(truncated.parseTruncated, true);

  // An un-truncated scan reports no prefix and parsedBytes falls back to the size.
  const whole = lensObservationSummary({ anatomy: { rawBytes: 40_000, wordCount: 900 } });
  assert.equal(whole.parseTruncated, false);
  assert.equal(whole.parsedBytes, 40_000);
});

test("the parse cap is a deployment knob, not a code change", async () => {
  // "Move lens onto the free plan" should be a var flip. The floor keeps a
  // typo (LENS_PARSE_KB=0 or 1) from disabling parsing entirely.
  const src = readFileSync("holding/_worker.js/lens.js", "utf8");
  assert.match(src, /Number\(env\?\.LENS_PARSE_KB\)/, "the cap must be env-overridable");
  assert.match(src, /Math\.max\(8, Number\(env\?\.LENS_PARSE_KB\) \|\| 0\)/, "a floor must guard against a zero or tiny override");
});

// ── /cache — the behavioral revalidation lint ───────────────────
// judgeRevalidation is pure: the whole product is the rules, and the network
// half dies at signing under plain node anyway.

test("an ETag that changes between identical fetches is called what it is", async () => {
  // THE failure this tool exists for. Headers look perfect, and every
  // If-None-Match will 200 with a full body, forever.
  const { judgeRevalidation } = await import("./holding/_worker.js/cache-lint.js");
  const v = judgeRevalidation({
    first: { status: 200, headers: { etag: '"abc-gzip"', "cache-control": "max-age=600" } },
    second: { status: 200, headers: { etag: '"abc-br"' } },
    conditional: { status: 200, headers: {} },
  });
  assert.equal(v.healthy, false);
  assert.ok(v.vetoes.some((f) => f.id === "stability"), "an unstable validator must be a veto");
  // The 200 is consistent with the unstable ETag, so it is explained rather
  // than double-counted as a second independent failure.
  assert.ok(v.findings.some((f) => f.id === "revalidation" && f.verdict === "bad-but-explained"));
});

test("a stable ETag the origin then ignores is its own distinct failure", async () => {
  const { judgeRevalidation } = await import("./holding/_worker.js/cache-lint.js");
  const v = judgeRevalidation({
    first: { status: 200, headers: { etag: '"stable"' } },
    second: { status: 200, headers: { etag: '"stable"' } },
    conditional: { status: 200, headers: {} },
  });
  assert.ok(v.vetoes.some((f) => f.id === "revalidation"), "a stable validator answered 200 — the origin ignores conditionals");
  assert.ok(!v.vetoes.some((f) => f.id === "stability"), "stability itself passed and must say so");
});

test("the healthy path and the no-validator path both read correctly", async () => {
  const { judgeRevalidation } = await import("./holding/_worker.js/cache-lint.js");
  const healthy = judgeRevalidation({
    first: { status: 200, headers: { etag: '"v1"', "cache-control": "max-age=300" } },
    second: { status: 200, headers: { etag: '"v1"' } },
    conditional: { status: 304, headers: {} },
  });
  assert.equal(healthy.healthy, true);

  const none = judgeRevalidation({ first: { status: 200, headers: {} }, second: { status: 200, headers: {} }, conditional: null });
  assert.ok(none.vetoes.some((f) => f.id === "validator"), "no validator at all is a veto, not a silent pass");
});

test("negotiating on Accept without saying so in Vary is flagged — the #195 trap", async () => {
  // Hit in production on THIS site: markdown negotiation answered from a warm
  // URL-keyed cache as HTML, because the stored Vary named only accept-encoding.
  const { judgeRevalidation } = await import("./holding/_worker.js/cache-lint.js");
  const base = { status: 200, headers: { etag: '"x"', "content-type": "text/html", vary: "accept-encoding" } };
  const trapped = judgeRevalidation({
    first: base, second: base, conditional: { status: 304, headers: {} },
    negotiated: { status: 200, headers: { "content-type": "text/markdown" } },
  });
  assert.ok(trapped.vetoes.some((f) => f.id === "vary"));

  const honest = judgeRevalidation({
    first: { ...base, headers: { ...base.headers, vary: "accept-encoding, accept" } },
    second: base, conditional: { status: 304, headers: {} },
    negotiated: { status: 200, headers: { "content-type": "text/markdown" } },
  });
  assert.ok(!honest.vetoes.some((f) => f.id === "vary"), "declared negotiation is fine");
});

// ── the tools are SERVICES, the frame is a representation ────────────────

test("every tool is a top-level utility, not a subpage of a presentation", async () => {
  // The site's own manifest encodes the rule: utilities live at the root
  // (/lens, /photos, /coffee, /reading) and only CONTENT nests. Filing tools
  // under /terminal/* organised them by how they RENDER, which is the wrong
  // lesson for a site whose whole argument is how to expose services to agents.
  const manifest = JSON.parse(readFileSync("site-manifest.json", "utf8"));
  const utilities = manifest.surfaces.filter((s) => s.kind === "utility");

  // The rule is not "utilities never nest" — /lens/census legitimately belongs
  // to /lens, the way a dataset belongs to the tool that produces it. What is
  // forbidden is nesting a utility under a PRESENTATION: /terminal is a console
  // that drives these tools, not their parent, and filing them under it would
  // organise the site by rendering rather than by what things are.
  const underTerminal = utilities.filter((s) => s.path.startsWith("/terminal/"));
  assert.deepEqual(underTerminal, [], `a tool must not live under the console: ${underTerminal.map((s) => s.path).join(", ")}`);

  // Anything that does nest must nest under a utility that actually exists.
  const paths = new Set(manifest.surfaces.map((s) => s.path));
  for (const s of utilities.filter((s) => s.path.split("/").length > 2)) {
    const parent = s.path.slice(0, s.path.lastIndexOf("/"));
    assert.ok(paths.has(parent), `${s.path} nests under ${parent}, which is not a registered surface`);
  }

  for (const path of ["/finger", "/radar", "/dict", "/cache"]) {
    const entry = manifest.surfaces.find((s) => s.path === path);
    assert.ok(entry, `${path} must be registered as a surface`);
    assert.equal(entry.kind, "utility");
    assert.equal(entry.flags.agents, true, `${path} must be in the agent catalog`);
  }
});

test("a tool answers HTML to a browser and a frame to everything else", async () => {
  // The frame joins .md as a REPRESENTATION rather than a location: one URL,
  // negotiated, with an explicit .txt alongside. Same contract as the twins.
  const html = await handleTool(new Request("https://aadhar.sh/dict", { headers: { accept: "text/html" } }), terminalEnv(), context());
  assert.match(html.headers.get("content-type"), /text\/html/);

  const frame = await handleTool(new Request("https://aadhar.sh/dict"), terminalEnv(), context());
  assert.match(frame.headers.get("content-type"), /text\/plain/);

  // .txt is explicit and beats Accept, so a browser can still ask for the frame.
  const txt = await handleTool(new Request("https://aadhar.sh/dict.txt", { headers: { accept: "text/html" } }), terminalEnv(), context());
  assert.match(txt.headers.get("content-type"), /text\/plain/);
  const txtBody = await txt.text();
  assert.ok(txtBody.length > 20 && !txtBody.includes("<"), ".txt must return the frame itself, as text");
});

test("a frame's printed state is a root URL that resolves", async () => {
  // The state a caller sends back has to be the tool's real address. When the
  // tools moved, a stale /terminal/<tool> here would have kept working through
  // the redirect while teaching every agent the wrong URL.
  const text = await (await terminalGet("/finger?plain=1&pane=writing")).text();
  const printed = text.match(/state (\/[a-z]+[^\s│║]*)/)?.[1];
  assert.ok(printed, "no state URL printed");
  assert.ok(!printed.startsWith("/terminal/"), `state still points at the old namespace: ${printed}`);
  assert.match(printed, /^\/finger/);
});

test("every tool with a route is reachable over MCP, and vice versa", async () => {
  // THE dogfood invariant. The console, curl, and an agent must all reach the
  // same set — a tool with an HTTP route but no MCP entry is invisible to the
  // exact caller this whole surface is built for. dict and cache shipped that
  // way for two commits before this test existed.
  const { TOOL_NAMES } = await import("./holding/_worker.js/terminal.js");
  const listed = (await (await handleSiteMcp(mcpPost({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { ...MODERN_META } }), terminalEnv(), context())).json())
    .result.tools.map((t) => t.name);

  // ONE VOCABULARY, TWO SPELLINGS. A URL path uses hyphens (/agent-ready) and
  // an MCP tool name conventionally uses underscores (agent_ready). That is a
  // real convention clash rather than sloppiness, so the rule is a defined
  // transliteration instead of byte equality — and it is written down here so
  // the next tool with a two-word name does not get to invent its own answer.
  const asToolName = (route) => route.replace(/-/g, "_");
  for (const tool of TOOL_NAMES) {
    assert.ok(listed.includes(asToolName(tool)),
      `/${tool} has a route but no MCP tool (expected ${asToolName(tool)}) — an agent cannot reach it`);
  }
});

// ── /agent-ready — the scorecard that grades its author too ──────────────

test("the lift table is internally consistent and names its baseline", async () => {
  // The bill is hand-maintained with a checked date, the same contract lens's
  // census runs on. What a test CAN hold is that it adds up and that the
  // baseline is a real subset — a claim like "compatibility is a weekend" is
  // only worth making if the number behind it is derived from the table.
  const { LIFT, BASELINE, liftTotals, LIFT_CHECKED } = await import("./holding/_worker.js/agent-ready.js");
  assert.match(LIFT_CHECKED, /^\d{4}-\d{2}-\d{2}$/, "the bill must carry a checked date");

  const names = LIFT.map(([n]) => n);
  for (const b of BASELINE) assert.ok(names.includes(b), `baseline names ${b}, which is not in the table`);

  const totals = liftTotals();
  assert.equal(totals.lines, LIFT.reduce((n, [, , lines]) => n + lines, 0));
  assert.equal(totals.baseline, LIFT.filter(([n]) => BASELINE.includes(n)).reduce((n, [, , l]) => n + l, 0));
  // The headline claim: baseline is a small fraction of the whole.
  assert.ok(totals.baseline < totals.lines / 3, "baseline should be a minority of the total, or the claim is wrong");
  for (const [name, files, lines, buys] of LIFT) {
    assert.ok(files > 0 && lines > 0, `${name} must carry real counts`);
    assert.ok(buys && buys.length > 8, `${name} must say what it buys, not just what it cost`);
  }
});

test("doors are counted, and unreadable is never counted as either", async () => {
  // The rule this whole codebase keeps rediscovering. A check that could not run
  // is not a pass and not a failure, and a scorecard that collapses it into
  // either one is lying about a site it never reached.
  const { scoreDoors } = await import("./holding/_worker.js/agent-ready.js");
  const s = scoreDoors({
    llms: { ok: true }, markdown: { ok: false, why: "HTTP 404" },
    agentCard: { ok: false, unreadable: true, why: "no signing key" },
    apiCatalog: { ok: false }, mcp: { ok: false, unreadable: true },
  });
  assert.equal(s.total, 5);
  assert.equal(s.open, 1);
  assert.equal(s.unread, 2, "unreadable doors must be counted separately");
  // open + unread must never be conflated into a score.
  assert.ok(!("score" in s) && !("grade" in s), "no single number may stand in for the observation");
});

test("the scorecard grades other origins, and only bills its own", async () => {
  // A scorecard that can only flatter its author is marketing. And the bill is
  // meaningless for an origin whose source tree we do not have, so it is shown
  // for the self-audit alone.
  const self = await (await terminalGet("/agent-ready?plain=1")).text();
  assert.match(self, /what this cost to build/);
  assert.match(self, /aadhar\.sh/);

  const foreign = await (await terminalGet("/agent-ready?plain=1&url=https%3A%2F%2Fexample.com")).text();
  assert.ok(!/what this cost to build/.test(foreign), "the bill must not appear for a foreign origin");
  assert.match(foreign, /doors a machine can walk through/);

  const refused = await (await terminalGet("/agent-ready?plain=1&url=http%3A%2F%2F169.254.169.254%2F")).text();
  assert.match(refused, /refused/);
});

// ── /encode — read the container, decode nothing ─────────────────────────
// These parse the repo's OWN committed encodes, which is the strongest test
// available: 474 files this site's pipeline produced, with known properties.

test("the JPEG parser agrees with the pipeline that made the files", async () => {
  const { parseJpeg, sniff, estimateQuality } = await import("./holding/_worker.js/encode.js");
  const { readdirSync } = await import("node:fs");
  const files = readdirSync("holding/i").filter((f) => f.endsWith(".jpg")).slice(0, 12);
  assert.ok(files.length > 4, "expected committed thumbnails to test against");

  for (const f of files) {
    const bytes = new Uint8Array(readFileSync(`holding/i/${f}`));
    assert.equal(sniff(bytes), "jpeg", `${f} should sniff as jpeg`);
    const info = parseJpeg(bytes);
    // add-photos.sh emits 600px squares through zenc at 4:2:0, progressive.
    assert.equal(info.width, 600, `${f} width`);
    assert.equal(info.height, 600, `${f} height`);
    assert.equal(info.subsampling, "4:2:0", `${f} is the delivery tier, so 4:2:0`);
    assert.equal(info.progressive, true, `${f} should be progressive — zenc searches scan scripts`);
    assert.ok(info.scans > 1, `${f} progressive means multiple scans, got ${info.scans}`);

    // zenjpeg ships tuned tables, so they must NOT read as scaled Annex K.
    // If this ever flips, the encoder changed underneath the pipeline.
    const luma = info.tables.find((t) => t.id === 0);
    assert.ok(luma, `${f} must carry a luma quantization table`);
    assert.equal(estimateQuality(luma.values).standard, false,
      `${f} should read as a CUSTOM table — zenjpeg does not use scaled Annex K`);
  }
});

test("the AVIF parser reads bit depth and subsampling, and monochrome is real", async () => {
  // 10-bit is this site's documented choice (~6% smaller at equal quality).
  // The monochrome flag is the one I nearly "fixed" while it was correct: the
  // first files sampled were the two Leica black-and-white frames, so a broken
  // parser and a right one looked identical until the sample got bigger.
  const { parseAvif, sniff } = await import("./holding/_worker.js/encode.js");
  const { readdirSync } = await import("node:fs");
  const files = readdirSync("holding/i").filter((f) => f.endsWith(".avif")).slice(0, 30);
  let mono = 0, colour = 0;

  for (const f of files) {
    const bytes = new Uint8Array(readFileSync(`holding/i/${f}`));
    assert.equal(sniff(bytes), "avif", `${f} should sniff as avif`);
    const info = parseAvif(bytes);
    assert.ok(info, `${f} should parse`);
    assert.equal(info.bitDepth, 10, `${f} should be 10-bit — the measured free win`);
    if (info.monochrome) mono += 1; else colour += 1;
    assert.ok(["4:2:0", "grayscale"].includes(info.subsampling), `${f} unexpected subsampling ${info.subsampling}`);
  }
  // A parser that always answered "monochrome" would still pass every assertion
  // above on a small enough sample. This is the one that catches it.
  assert.ok(colour > mono, `most frames are colour; parsed ${colour} colour vs ${mono} mono`);
});

test("encode sniffs the container from magic bytes, not content-type", async () => {
  // A mislabelled response is common, and the parse has to match the actual
  // bytes or it reads garbage confidently.
  const { sniff } = await import("./holding/_worker.js/encode.js");
  assert.equal(sniff(new Uint8Array([0xFF, 0xD8, 0xFF, 0xE0, 0, 0])), "jpeg");
  assert.equal(sniff(new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0, 0, 0, 0, 0])), "png");
  assert.equal(sniff(new Uint8Array(4)), null);
});

test("encode judges chroma and depth against this site's own measurements", async () => {
  // The verdicts are where the site's encoding work stops being prose. 4:4:4 at
  // delivery size and 8-bit AVIF are the two it should always flag.
  const { judgeEncode } = await import("./holding/_worker.js/encode.js");
  const fat = judgeEncode({ format: "jpeg", subsampling: "4:4:4", progressive: false, scans: 1, tables: [], width: 600, height: 600, icc: true }, 90000);
  const ids = fat.warns.map((w) => w.id);
  assert.ok(ids.includes("chroma"), "4:4:4 at delivery size must be flagged");
  assert.ok(ids.includes("scan"), "baseline must be flagged — progressive is free bytes");
  assert.ok(ids.includes("metadata"), "ICC riding along on a thumbnail must be flagged");

  const lean = judgeEncode({ format: "jpeg", subsampling: "4:2:0", progressive: true, scans: 8, tables: [], width: 600, height: 600 }, 40000);
  assert.equal(lean.warns.length, 0, "a well-made delivery JPEG should draw no warnings");

  assert.ok(judgeEncode({ format: "avif", bitDepth: 8, subsampling: "4:2:0" }, 30000).warns.some((w) => w.id === "depth"),
    "8-bit AVIF must be flagged — 10-bit is free");
  assert.equal(judgeEncode({ format: "avif", bitDepth: 10, subsampling: "4:2:0" }, 30000).warns.length, 0);
});

test("the ramp never double-parses wrangler's already-parsed JSON", async () => {
  // A ramp writes its changelog row exactly once, at 100%, and a failure there
  // is caught and downgraded to a printed note on purpose — traffic has already
  // moved, and unwinding a good release over a missing log row would be worse.
  //
  // That tolerance is what made this bug invisible for three releases. The D1
  // read was written as JSON.parse(await wrangler(..., { json: true })), but the
  // helper ALREADY parses when json is set, so the second parse received an
  // object, stringified it to "[object Object]", and threw. Every ramp then
  // reported that D1 was unreachable and skipped its own write. D1 was answering
  // the whole time; `pnpm run checkpoints:check` queried it fine minutes later.
  //
  // Asserted as source text because the alternative is spawning wrangler against
  // production D1 from the test suite, which no contract test should ever do.
  const src = await readFile(new URL("./scripts/deploy-promote.mjs", import.meta.url), "utf8");

  assert.ok(/const rows = \(await wrangler\(/.test(src),
    "the D1 read must consume wrangler's parsed result directly");
  assert.equal(/JSON\.parse\(\s*await wrangler\(/.test(src), false,
    "wrangler(..., { json: true }) already returns parsed JSON — a second JSON.parse throws on the object");

  // The helper's contract is the other half: if it ever stops parsing, the call
  // site above silently starts handing a string to [0].results instead.
  assert.ok(/return json \? JSON\.parse\(stdout\) : stdout;/.test(src),
    "wrangler() must keep parsing when { json: true } — the call site depends on it");

  // FRESHNESS. Workers Builds uploads a couple of minutes after a merge, and a
  // ramp inside that window targets the PREVIOUS release while every downstream
  // check passes. It happened twice on 2026-08-10. The check compares the
  // target's created_on against HEAD's commit time, and the ONE thing worth
  // pinning is WHERE it is called: before the --dry-run exit, so it prints on
  // both paths. A warning that only appears in --dry-run is worth nothing on the
  // run that skips it, and skipping it is exactly what a hurry looks like.
  const freshnessAt = src.indexOf("await reportTargetFreshness(");
  const dryRunExitAt = src.indexOf('if (has("dry-run"))');
  assert.ok(freshnessAt > 0, "the ramp must report target freshness");
  assert.ok(dryRunExitAt > 0, "the --dry-run early exit must still exist");
  assert.ok(freshnessAt < dryRunExitAt,
    "reportTargetFreshness must run BEFORE the --dry-run exit, or a real ramp loses the warning");

  // It warns and does not refuse, on purpose: ramping something older than HEAD
  // is legitimate for a rollback and for re-ramping the serving version to write
  // a missed changelog row (gotcha 24). A die() there would block that repair.
  assert.equal(/STALE TARGET[\s\S]{0,700}?\bdie\(/.test(src), false,
    "a stale target must warn, never die — that would block the gotcha-24 repair path");

  // And the diagnostic must not name a cause. It covers a file read, a spawn and
  // a shape check; blaming D1 sent the reader to check a healthy database.
  assert.equal(/when D1 is reachable/.test(src), false,
    "the catch-all note must not assert D1 is the cause — it cannot know that");
});

test("no ramp sample can hang, and a stall is never reported as an origin error", async () => {
  // SECOND TIME the D1 changelog write has been silently skipped, by a different
  // mechanism than the double-parse above. The v177 ramp moved traffic through
  // 10/50/100 and then exited mid-sample with `Detected unsettled top-level
  // await`, before the write that runs after sampling. `fetch` has no default
  // request timeout, so one stalled socket wedges the step; the repair (`--to
  // 100`, which moves nothing and logs) is documented, and needing it is the bug.
  //
  // Source text for the same reason as the test above: the alternative is
  // spawning wrangler against production from the suite.
  const src = await readFile(new URL("./scripts/deploy-promote.mjs", import.meta.url), "utf8");

  // Counted rather than matched once, so a SECOND fetch added later without a
  // timeout fails this instead of riding the first one's signal.
  const fetches = (src.match(/await fetch\(/g) || []).length;
  const timeouts = (src.match(/signal: AbortSignal\.timeout\(/g) || []).length;
  assert.ok(fetches > 0, "the ramp samples over the network — if this hits zero the test is measuring nothing");
  assert.equal(timeouts, fetches,
    `every network call in the ramp needs a request timeout: ${fetches} fetch(es), ${timeouts} with a signal`);

  // A timeout is only safe to add because a stall is classified apart from an
  // origin error. Conflated, a laptop's flaky wifi would trigger the ramp's
  // roll-back advice against a healthy release.
  assert.ok(/stalls\+\+/.test(src), "a failed request must count as a stall, not an error");
  assert.ok(/errorVersions\.push/.test(src) && /stallReasons\.push/.test(src),
    "errors and stalls must be reported through separate channels");
  assert.ok(/not an origin fault/.test(src),
    "the stall note must say whose fault it is not");

  // And a step nobody could measure must not pass as a step that succeeded —
  // at 100% that is what stops an unverified run from writing the changelog.
  assert.ok(/if \(!s\.answered\)/.test(src),
    "a sample where nothing answered must stop the ramp rather than be read as success");
});

// ── webmention link verification ────────────────────────────────────
// The verify step is the ONLY thing standing between "someone sent a POST" and
// "someone's page appears on my site", so what counts as a link is the whole
// anti-forgery property. Every row below was measured against the previous
// string-matching implementation on 2026-08-07.
test("a link that is not really a link does not verify a mention", () => {
  const target = "https://aadhar.sh/writing/in-flux";
  const source = "https://mari.example/post";

  // CREDITED before. Markup the author removed, code, an inert template, and a
  // form field's value are not links, and each one let a stranger claim a
  // mention with markup that never renders.
  const notLinks = {
    "an HTML comment": `<p>hi</p><!-- <a href="${target}">x</a> -->`,
    "a commented-out draft": `<!--\n<a href="${target}">old draft</a>\n-->`,
    "a script body": `<script>var s = '<a href="${target}">x</a>';</script>`,
    "a textarea value": `<textarea><a href="${target}">x</a></textarea>`,
    "a template": `<template><a href="${target}">x</a></template>`,
    "an unterminated comment": `<!-- <a href="${target}">x</a>`,
  };
  for (const [what, html] of Object.entries(notLinks)) {
    assert.equal(linksTo(html, target, source), false, `${what} must not verify a mention`);
  }

  // REFUSED before, and both are ordinary HTML a real page writes.
  const realLinks = {
    "protocol-relative": `<a href="//aadhar.sh/writing/in-flux">x</a>`,
    "an uppercase host": `<a href="https://AADHAR.SH/writing/in-flux">x</a>`,
    "a tracking query": `<a href="https://aadhar.sh/writing/in-flux?utm_source=rss">x</a>`,
    "a fragment": `<a href="https://aadhar.sh/writing/in-flux#notes">x</a>`,
    "a trailing slash": `<a href="https://aadhar.sh/writing/in-flux/">x</a>`,
    "single quotes": `<a href='https://aadhar.sh/writing/in-flux'>x</a>`,
    "a link after a comment": `<!-- old --><a href="${target}">x</a>`,
  };
  for (const [what, html] of Object.entries(realLinks)) {
    assert.equal(linksTo(html, target, source), true, `${what} is a real link and must verify`);
  }

  // Still refused, and must stay refused: naming a URL is not linking to it.
  assert.equal(linksTo(`<p>I read https://aadhar.sh/writing/in-flux today</p>`, target, source), false);
  assert.equal(linksTo(`<a href="https://aadhar.sh/writing/other">x</a>`, target, source), false);
  assert.equal(linksTo(`<a href="https://aadhar.sh.evil.example/writing/in-flux">x</a>`, target, source),
    false, "a lookalike host must not verify");
});

// Stripping too much loses a link and refuses a real mention; stripping too
// little credits a fake one. The unterminated case above pins the safe
// direction, and this pins that ordinary content survives.
test("inert regions are removed without eating the document", () => {
  assert.equal(documentContent("<p>before</p><script>x</script><p>after</p>").includes("before"), true);
  assert.equal(documentContent("<p>before</p><script>x</script><p>after</p>").includes("after"), true);
  assert.equal(documentContent("<script>secret</script>").includes("secret"), false);
  assert.equal(documentContent("<!-- hidden -->visible").includes("hidden"), false);
  assert.equal(documentContent("<!-- hidden -->visible").includes("visible"), true);
});

// ── RSS feeds ────────────────────────────────────────────────────────
// Feeds are BUILD OUTPUT (scripts/gen-feeds.mjs), like the Markdown twins and
// the dcz deltas: a pure function of site-manifest.json, the sitemap's lastmod
// dates, and posts.json, so no committed copy can fall behind. These tests pin
// the properties a subscriber depends on, none of which the build's own count
// check can see.
test("every feed is well-formed, dated, and newest-first", async () => {
  const { buildFeeds, FEEDS, rfc822 } = await import("./scripts/gen-feeds.mjs");
  const feeds = buildFeeds(".");
  assert.equal(feeds.size, FEEDS.length);

  for (const [route, body] of feeds) {
    assert.match(body, /^<\?xml version="1\.0" encoding="UTF-8"\?>/, `${route} must open with the XML declaration`);
    assert.match(body, /<rss version="2\.0"/, `${route} must declare RSS 2.0`);
    // Plain substring, not a built regex: the value is a known path and
    // hand-escaping one into a pattern is how an escape gets missed.
    assert.ok(body.includes(`<atom:link href="https://aadhar.sh${route}" rel="self"`), `${route} must point at itself`);

    const items = [...body.matchAll(/<item>([\s\S]*?)<\/item>/g)].map(([, item]) => item);
    assert.ok(items.length, `${route} has no items`);

    const dates = items.map((item) => {
      const raw = item.match(/<pubDate>([^<]+)<\/pubDate>/)?.[1];
      assert.ok(raw, `${route} has an item with no pubDate`);
      const parsed = Date.parse(raw);
      assert.ok(Number.isFinite(parsed), `${route} has an unparseable pubDate: ${raw}`);
      return parsed;
    });
    // Newest first is the only order a reader respects.
    assert.deepEqual(dates, [...dates].sort((a, b) => b - a), `${route} is not newest-first`);

    for (const item of items) {
      const guid = item.match(/<guid isPermaLink="true">([^<]+)<\/guid>/)?.[1];
      const link = item.match(/<link>([^<]+)<\/link>/)?.[1];
      assert.equal(guid, link, `${route} has an item whose guid and link disagree`);
      assert.match(guid, /^https:\/\/aadhar\.sh\//, `${route} has a non-absolute guid`);
      // A bare & inside a text node makes the whole document unparseable, which
      // is the one authoring mistake that takes a feed offline silently.
      for (const field of ["title", "description"]) {
        const value = item.match(new RegExp(`<${field}>([\\s\\S]*?)</${field}>`))?.[1] ?? "";
        assert.doesNotMatch(value, /&(?!amp;|lt;|gt;|quot;|apos;|#\d+;)/, `${route} has an unescaped & in an item ${field}`);
        assert.doesNotMatch(value, /[<>]/, `${route} has a raw angle bracket in an item ${field}`);
      }
    }
  }

  // A date is a promise about when something changed, so an item with no
  // authored lastmod is dropped rather than stamped `now`, which would re-sort
  // every subscriber's timeline on each deploy.
  assert.equal(rfc822("not-a-date"), null);
  assert.equal(rfc822("2026-06-07"), "Sun, 07 Jun 2026 12:00:00 GMT");
});

// The feed's dates come from the sitemap, so the two cannot disagree about when
// a page changed. That is the reason for reading it rather than minting a second
// date source next to it.
test("feed dates come from the sitemap the crawler already reads", async () => {
  const { buildFeeds, sitemapDates } = await import("./scripts/gen-feeds.mjs");
  const dates = sitemapDates(readFileSync("holding/sitemap.xml", "utf8"));
  assert.ok(dates.size >= 40, `expected the sitemap to carry lastmod dates, found ${dates.size}`);

  const garage = buildFeeds(".").get("/garage/feed.xml");
  for (const [, item] of garage.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const path = item.match(/<link>https:\/\/aadhar\.sh([^<]+)<\/link>/)[1];
    const pubDate = item.match(/<pubDate>([^<]+)<\/pubDate>/)[1];
    assert.equal(pubDate, new Date(`${dates.get(path)}T12:00:00Z`).toUTCString(),
      `${path} is dated differently in the feed and the sitemap`);
  }
});

// Discovery is the half that makes a feed reachable: a reader's subscribe button
// looks for <link rel="alternate"> on the page, not for a URL somebody guessed.
test("each section advertises its feed", () => {
  for (const [file, feed] of [["holding/garage/index.html", "/garage/feed.xml"], ["holding/lwe/index.html", "/lwe/feed.xml"]]) {
    const html = readFileSync(file, "utf8");
    assert.ok(html.includes(`type="application/rss+xml"`) && html.includes(`href="${feed}"`),
      `${file} does not advertise ${feed}`);
  }
  // /writing is Worker-rendered, so its shell carries the link for the index and
  // every post at once.
  assert.match(readFileSync("holding/_worker.js/writing.js", "utf8"), /application\/rss\+xml[^"]*"[^"]*"\s*\+?[^"]*writing\/feed\.xml|writing\/feed\.xml/);
});

// ── Explorer chrome ──────────────────────────────────────────────────────────
// The address bar and task pane are markup, so the things worth pinning are the
// claims they make: that the pane's "Other places" is the site's own first-level
// list, and that nothing invents a row.
test("the task pane's places are the manifest's taskbar surfaces", async () => {
  const { PLACES } = await import("./holding/_worker.js/lib/explorer.js");
  const manifest = JSON.parse(readFileSync("site-manifest.json", "utf8"));
  const pinned = manifest.surfaces.filter((s) => s.flags && s.flags.taskbar).map((s) => s.path).sort();
  assert.deepEqual(PLACES.map((p) => p.path).sort(), pinned,
    "lib/explorer.js PLACES drifted from site-manifest.json — the pane would list a section the taskbar does not, or miss one");
});

test("the pane states only what it was given", async () => {
  const { taskPane, addressBar } = await import("./holding/_worker.js/lib/explorer.js");
  // A page with no tasks and no counted details gets the two rows that are true
  // of every object, and no Contains, Modified, or Status invented for it.
  const bare = taskPane({ path: "/garage/wire", name: "On the wire" });
  assert.match(bare, /<dt>Name<\/dt><dd>On the wire<\/dd>/);
  assert.match(bare, /<dt>Location<\/dt><dd>aadhar\.sh\/garage\/wire<\/dd>/);
  assert.doesNotMatch(bare, /Contains|Modified|Status/);
  // "Up to" is derived from the path, so a leaf offers its section and a section
  // offers the root.
  assert.match(bare, /href="\/garage">Up to Garage</);
  assert.match(taskPane({ path: "/garage" }), /href="\/">Up to aadhar\.sh</);
  // The current object is not a link to itself.
  const bar = addressBar({ path: "/garage/wire", name: "On the wire" });
  assert.match(bar, /<span aria-current="page" class="axp-here">On the wire<\/span>|<span class="axp-here" aria-current="page">On the wire<\/span>/);
  assert.match(bar, /<a href="\/garage">Garage<\/a>/);
  // Untrusted text is escaped, not interpolated.
  assert.match(taskPane({ path: "/garage/x", name: '<img src=x onerror=alert(1)>' }), /&lt;img src=x/);
});

// A twin may only be advertised where the build wrote one. The committed list is
// empty on purpose (dev serves a tree with no twins), so the guard is that the
// marker build.mjs rewrites is still there to be rewritten.
test("the twin list is generated, not committed", () => {
  const source = readFileSync("holding/_worker.js/lib/twins.js", "utf8");
  assert.match(source, /^export const TWIN_PATHS = \[\]; \/\/ build:twins$/m,
    "lib/twins.js must ship empty with its build:twins marker — a committed list would advertise twins that 404 in dev");
});

// ── /garage/dyno, the wire-size trend ───────────────────────────────────────
//
// The page is a pure function of its rows, which is what lets it be asserted
// here rather than only looked at. All three tests below came out of building
// it, and the middle one is a bug that shipped to a screenshot.

test("the dyno series merges hand-entered history under measured rows", async () => {
  const { mergeHistory } = await import("./holding/_worker.js/dyno.js");
  const seeded = mergeHistory([]);
  assert.ok(seeded.length >= 4, "the seeded baseline history must survive an empty fetch");
  assert.ok(seeded.every((r) => r.source === "baseline-note"));
  // Sorted by date, so the chart's x-scale never has to.
  assert.deepEqual([...seeded].sort((a, b) => (a.ts < b.ts ? -1 : 1)).map((r) => r.ts), seeded.map((r) => r.ts));

  // A measured row for a seeded day REPLACES it. Both describe the same day and
  // the measured one is the better fact; keeping both would draw two points on
  // one date and a vertical line between them.
  const clash = seeded[seeded.length - 1].ts;
  const merged = mergeHistory([{ ts: clash, sha: "abc1234", worker_gzip: 1, source: "nightly" }]);
  const hit = merged.filter((r) => r.ts === clash);
  assert.equal(hit.length, 1);
  assert.equal(hit[0].source, "nightly");
});

test("the dyno chart draws lines, not filled regions", async () => {
  const { mergeHistory, renderDyno } = await import("./holding/_worker.js/dyno.js");
  const rows = mergeHistory([
    { ts: "2026-08-10", sha: "aaa1111", worker_gzip: 264540, pages_br: 476528, assets_br: 58186, source: "nightly" },
    { ts: "2026-08-11", sha: "bbb2222", worker_gzip: 266000, pages_br: 476000, assets_br: 58200, source: "nightly" },
  ]);
  const html = await (await renderDyno(rows)).text();

  // The bug this pins: a bare `.s-worker { stroke; fill }` outranks
  // `polyline { fill: none }` on specificity, so every series filled down to the
  // axis and the chart rendered as three coloured blobs. It looked like a data
  // problem and was a cascade problem. Every series rule must be element-
  // qualified so a line can never inherit a fill.
  for (const series of ["s-worker", "s-pages", "s-assets"]) {
    assert.match(html, new RegExp(`polyline\\.${series}\\{[^}]*fill:none`),
      `${series} must set fill:none on the polyline, or the line fills into a blob`);
    assert.doesNotMatch(html, new RegExp(`\\.chart \\.${series}\\{`),
      `${series} must not be styled unqualified — that rule outranks polyline{fill:none}`);
  }
  assert.match(html, /<polyline class="s-worker"/);
});

test("the dyno page distinguishes measured points from hand-entered ones", async () => {
  const { mergeHistory, renderDyno } = await import("./holding/_worker.js/dyno.js");
  const html = await (await renderDyno(mergeHistory([
    { ts: "2026-08-10", sha: "aaa1111", worker_gzip: 264540, pages_br: 476528, assets_br: 58186, source: "nightly" },
  ]))).text();
  // Dashed for the seeded prefix, solid for the measured tail, and the legend
  // says which is which. A chart that renders a number somebody typed into a
  // code comment identically to one a runner measured is lying about its own
  // provenance, which on a page ABOUT measurement discipline is the one thing
  // it cannot do.
  assert.match(html, /<polyline class="s-worker dashed"/);
  assert.match(html, /dashed: recorded by hand before this series existed/);
  assert.match(html, /<td class="src">by hand<\/td>/);
  assert.match(html, /<td class="src">measured<\/td>/);
  // Zero client JS: the whole chart is server-rendered SVG.
  assert.doesNotMatch(html.split('<svg class="chart"')[1].split("</svg>")[0], /<script/);
});

// ── the Reader lens (/lens/read, lens-reader/) ───────────────────────────────
// The Reader lens is the one /lens surface that lives in a DIFFERENT Worker, so
// nothing about it is covered by the site Worker's own dry-run or route sweep.
// These tests stand in for that: they pin the numbers a message quotes, the
// single SSRF guard, and the two traps this feature actually hit.
//
// EVERY assertion below reads SOURCE TEXT and imports nothing from lens-reader/.
// That is a hard constraint, not a style: this suite runs under plain node with
// the ROOT workspace's dependencies, and lens-reader/src/reader.js imports
// defuddle, linkedom and turndown, which live only in that sub-project. Importing
// it here fails with ERR_MODULE_NOT_FOUND in CI while passing on any workstation
// that happens to have run `pnpm install` in lens-reader/ — which is exactly how
// this was caught (PR #299, first run). Same family as gotcha 16: what this file
// imports has to resolve under bare node, forever.
//
// The behavioural half lives in lens-reader/test/reader.test.mjs, run by the CI
// step that installs those dependencies.

test("the reader's rate-limit message quotes the ceiling wrangler declares", async () => {
  const src = readFileSync("./lens-reader/src/reader.js", "utf8");
  const constant = src.match(/export const READER_LIMIT_PER_MIN = (\d+)/);
  assert.ok(constant, "reader.js no longer exports READER_LIMIT_PER_MIN");
  const READER_LIMIT_PER_MIN = Number(constant[1]);
  const toml = readFileSync("./lens-reader/wrangler.toml", "utf8");
  const declared = toml.match(/\[\[ratelimits\]\][\s\S]*?simple\s*=\s*\{[^}]*limit\s*=\s*(\d+)/);
  assert.ok(declared, "lens-reader/wrangler.toml declares no ratelimit");
  // Same discipline as LENS_BUDGETS on the site Worker: the constant is what the
  // 429 message quotes, the toml is what actually throttles, and a message that
  // outlives its limit is worse than no message at all.
  assert.equal(READER_LIMIT_PER_MIN, Number(declared[1]),
    "the reader's 429 message would quote a limit the binding does not enforce");
});

test("the reader Worker shares the site's SSRF guard rather than copying it", async () => {
  const reader = readFileSync("./lens-reader/src/reader.js", "utf8");
  const entry = readFileSync("./lens-reader/src/index.js", "utf8");
  // A second Worker aiming a visitor-supplied URL at the public internet is the
  // same SSRF surface /lens/fetch has. Two copies of an allowlist pass review on
  // the day they are written and diverge quietly afterwards, so this asserts the
  // import exists AND that no local redefinition shadows it.
  for (const [name, src] of [["reader.js", reader], ["index.js", entry]]) {
    assert.match(src, /from "\.\.\/\.\.\/holding\/_worker\.js\/lib\/crawl\.js"/,
      `lens-reader/src/${name} must import the shared guard, not reimplement it`);
    assert.doesNotMatch(src, /function\s+validateLensTarget|function\s+privateHostBlocked/,
      `lens-reader/src/${name} redefines a guard it is supposed to be importing`);
  }
  // And the site's export is still the shared one, so moving it did not leave
  // lens.js with a stale private copy that only IT uses.
  const crawl = await import("./holding/_worker.js/lib/crawl.js");
  const lens = await import("./holding/_worker.js/lens.js");
  assert.equal(lens.validateLensTarget, crawl.validateLensTarget,
    "lens.js and lib/crawl.js must expose the same function object, not two copies");
});

test("the reader hands turndown a NODE, because a string throws in workerd", async () => {
  const src = readFileSync("./lens-reader/src/reader.js", "utf8");
  // THE trap this feature hit, and the assertion is STRUCTURAL on purpose —
  // read the next paragraph before "improving" it into a behavioural one.
  //
  // turndown ships two builds. The node build falls back to @mixmark-io/domino
  // and happily takes an HTML string; the browser build reaches for
  // document.implementation.createHTMLDocument. Wrangler resolves the BROWSER
  // condition, so `turndown(htmlString)` fails in a Worker while passing under
  // node. Measured 2026-08-10 against `wrangler dev`: the string form answers
  // {"ok":false,"error":"document is not defined"}, the node form returns real
  // markdown. Passing a node sidesteps it entirely, since turndown's RootNode
  // does input.cloneNode(true) for anything that is not a string.
  //
  // A behavioural test here is IMPOSSIBLE, not merely awkward: `node --test`
  // resolves the node build, so it exercises the one code path that cannot
  // fail. The first version of this test called toMarkdown() with the bug
  // deliberately reintroduced and still went green — a check that can only ever
  // agree with itself. So this asserts the call SHAPE, which is the thing a
  // future edit would actually change, and the runtime claim is carried by the
  // measurement recorded above rather than pretended at here.
  const fn = src.match(/export function toMarkdown\([\s\S]*?\n\}/)[0];
  assert.match(fn, /service\.turndown\(root\)/,
    "toMarkdown must pass turndown a NODE — a string resolves turndown's browser build and throws in workerd");
  assert.doesNotMatch(fn, /turndown\(contentHtml\)|turndown\(html\)/,
    "passing turndown an HTML string works under node and fails in the Worker");
  // The output assertions (headings convert, script bodies never reach the
  // markdown) need the real dependencies, so they live in
  // lens-reader/test/reader.test.mjs rather than here.
  assert.match(fn, /service\.remove\(\["script", "style"\]\)/,
    "toMarkdown must strip script and style before converting");
});

test("the reader reports what it dropped, never only what it kept", async () => {
  const reader = readFileSync("./lens-reader/src/reader.js", "utf8");
  const client = readFileSync("./holding/lens-reader.js", "utf8");
  // The whole point of this lens is the GAP. A payload that reported only the
  // extraction would read as "here is the page", which is the claim /lens exists
  // to complicate — an extractor is guessing, and on a landing page it guesses
  // badly (stripe.com, 2026-08-09: 55% of the words gone, hero headline first).
  assert.match(reader, /dropped:\s*\{/, "the payload must carry a dropped tally");
  assert.match(reader, /source[\s\S]{0,200}kept/, "the payload must carry both counts");
  assert.match(client, /What the extractor threw away/, "the pane must lead with the gap");
  // And it must never present itself as the served bytes.
  const note = reader.match(/export const READER_NOTE =([\s\S]*?);\n/);
  assert.ok(note, "reader.js no longer exports READER_NOTE");
  assert.match(note[1], /OPINION/, "the note must name the output as an opinion");
  assert.match(note[1], /never what the server sent/);
});

test("every machine lens tab has a label, and the reader is one of them", async () => {
  const { LENS_TAB_ORDER } = await import("./holding/_worker.js/lens.js");
  const server = readFileSync("./holding/_worker.js/lens.js", "utf8");
  const client = readFileSync("./holding/lens.js", "utf8");
  assert.ok(LENS_TAB_ORDER.includes("reader"), "the reader tab must be in the tab order");
  // The strip renders from LENS_TAB_ORDER, so a key with no label ships an empty
  // button rather than failing. The client keeps its own LENS_LABEL map (no
  // module graph on /lens), which is exactly the pair that can drift.
  const labels = server.match(/const LENS_TAB_LABELS = \{([\s\S]*?)\};/)[1];
  for (const key of LENS_TAB_ORDER) {
    assert.match(labels, new RegExp(`\\b${key}:`), `LENS_TAB_LABELS has no entry for "${key}"`);
    assert.match(client, new RegExp(`\\b${key}: "`), `the client LENS_LABEL map has no entry for "${key}"`);
    assert.match(client, new RegExp(`LENS_FN\\.${key} =`), `the client has no render function for "${key}"`);
  }
});

test("the reader never renders an unmeasurable phase as 0 ms", () => {
  const client = readFileSync("./holding/lens-reader.js", "utf8");
  // A Worker's clock advances across I/O and never during synchronous execution,
  // so `parse`, `extract` and `markdown` come back 0 from production while
  // `fetch` carries real time. Measured through the live route 2026-08-10:
  // stripe.com answered {fetch: 104, parse: 0, extract: 0, markdown: 0} where the
  // same run under wrangler dev had reported 30 / 347 / 10.
  //
  // Rendering those zeros would tell a visitor that parsing a 645 KB page is
  // free, on the one panel whose job is saying what the read cost. This is the
  // same class of claim the rest of the lens is built to avoid, so it is pinned.
  assert.match(client, /not measurable/,
    "a zero-valued timing phase must render as unmeasurable, never as 0 ms");
  assert.match(client, /never during synchronous execution/,
    "the panel must explain WHY those phases read zero");
  assert.doesNotMatch(client, /ms\.extract \+/,
    "the headline total must not sum phases the clock cannot see");
});

test("the cracker's scorer matches the quadgram table it ships", () => {
  // The /lwe/vigenere cracker fetches holding/lwe/quadgrams.txt and derives every
  // score from a gram's RANK in that file, so the file's SHAPE is part of the
  // scorer. Regenerating it at a different size, or with counts left in, changes
  // what the solver computes while both the page and the table still look fine.
  // Nothing else in the build reads this file, so this is the only thing that
  // would notice.
  const table = readFileSync("./holding/lwe/quadgrams.txt", "utf8");
  const page = readFileSync("./holding/lwe/vigenere.html", "utf8");

  assert.match(table, /^[A-Z]+$/, "the table must be bare A-Z with no counts, separators or trailing newline");
  assert.equal(table.length % 4, 0, "the table must be whole quadgrams");
  const grams = table.length / 4;
  assert.equal(grams, 4000, `the page's prose and gauge thresholds were measured at 4,000 grams, got ${grams}`);

  const seen = new Set();
  for (let i = 0; i < table.length; i += 4) seen.add(table.substr(i, 4));
  assert.equal(seen.size, grams, "a duplicated quadgram would give one gram two ranks");
  assert.equal(table.slice(0, 4), "THAT", "the table must stay in frequency order; TOP is calibrated to the first entry");

  // TOP is log10 of the most common quadgram's corpus share and FLOOR is an
  // unseen one. gen-quadgram-table.mjs prints both; the page hardcodes them,
  // and a table rebuilt from a different corpus moves them.
  const top = Number(page.match(/var TOP = (-[\d.]+)/)[1]);
  const floor = Number(page.match(/FLOOR = (-[\d.]+)/)[1]);
  assert.ok(top > floor, "an observed quadgram must outscore an unseen one");
  assert.ok(top > -3 && top < -2, `TOP looks recalibrated (${top}); rerun gen-quadgram-table.mjs and update the page`);
  assert.ok(floor > -10 && floor < -8, `FLOOR looks recalibrated (${floor})`);

  // The page states the wire cost as a fact. It is a fact about these bytes.
  const wire = brotliCompressSync(Buffer.from(table), {
    params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 11 },
  }).length;
  const claimed = Number(page.match(/<b>([\d.]+) KB<\/b> over the wire/)[1]);
  assert.ok(Math.abs(wire / 1024 - claimed) < 0.15,
    `the page claims ${claimed} KB over the wire, the table brotlis to ${(wire / 1024).toFixed(1)} KB`);
});

test("the cracker reports a verdict rather than always answering", () => {
  const page = readFileSync("./holding/lwe/vigenere.html", "utf8");
  // A solver that always returns its best guess is indistinguishable from one
  // that solved the cipher, which is the whole reason step 4 exists. The three
  // outcomes and the sample-size shrinkage are the load-bearing parts.
  assert.match(page, /<b>failed\.<\/b>/, "a run that did not solve must say so");
  assert.match(page, /confidence/, "the verdict must carry a confidence");
  assert.match(page, /PSEUDO/, "confidence must be shrunk toward random on short text");
  assert.match(page, /margin over runner-up/, "the verdict must report the margin to the next candidate");
  // The gauge predicts failure BEFORE the run, from letters per column, which is
  // the number that actually governs it. These thresholds were measured.
  assert.match(page, /letters per column/, "the gauge must be per column, not per message");
  assert.match(page, /per >= 20/, "the measured comfortable threshold is 20 letters per column");
});
