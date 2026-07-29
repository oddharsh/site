#!/usr/bin/env node
// contract-tests.mjs — representation-boundary tests for the homepage Worker.
//
// These are deliberately dependency-free and deterministic. They test the
// public shape of the page/fragment and JSON/HTML handlers without starting a
// local Worker or making third-party network requests. verify-routes.mjs adds
// the same assertions against a deployed or local HTTP surface.

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  handleLensBrowser,
  handleLensCompare,
  handleLensFetch,
  handleLensShot,
  renderLensShell,
} from "./holding/_worker.js/lens.js";
import { handleCoffeeAvailability, readCoffeeAvailability } from "./holding/_worker.js/coffee.js";
import { handleSiteMcp } from "./holding/_worker.js/mcp.js";
import { handleWebmention, handleWebmentionDecision } from "./holding/_worker.js/webmention.js";
import { handleInbox } from "./holding/_worker.js/inbox.js";
import { citationsIn, findEndpointIn, SELF_LINK_HOSTS } from "./holding/_worker.js/webmention-send.js";
import { sign } from "./cal/src/sign.js";
import { AGENT_SURFACES, WEBMENTION_PATHS } from "./holding/_worker.js/lib/site-manifest.js";
import { handleWritingIndex } from "./holding/_worker.js/writing.js";
import { serveStaticPage } from "./holding/_worker.js/lib/assets.js";
import { readManifest, workerModule, navFenceBody, readFenceBody } from "./scripts/gen-manifest.mjs";
import { INDEXED_SECTIONS, TWIN_FACTS, buildTwins, checkTwinFacts, htmlFileFor, twinPath } from "./scripts/gen-md-twins.mjs";
import { MCP_TOOLS } from "./serendipity/serendipity.js";
import { derivePhotoPool, getImagesManifest, handlePhotoQuery, queryPhotos } from "./holding/_worker.js/photos.js";
import { cachedRender, deadline } from "./holding/_worker.js/lib/cache.js";
import { ifNoneMatchMatches, notModifiedIfFresh, withWeakEtag } from "./holding/_worker.js/lib/cache.js";
import { privateHostBlocked } from "./holding/_worker.js/lib/crawl.js";
import { handleHit } from "./holding/_worker.js/counter.js";
import { cronHomeProbe, parseServerTiming } from "./holding/_worker.js/perf-probe.js";
import { handleSearchJson, searchSite } from "./holding/_worker.js/search.js";
import { getPublicAvailability } from "./cal/src/slots.js";
import { botHeaders } from "./holding/_worker.js/lib/botauth.js";
import { ml_dsa44 } from "@noble/post-quantum/ml-dsa.js";
import { mapWithConcurrency, readResponseCapped } from "./holding/_worker.js/lib/crawl.js";
import { diffAroundRows, handleAroundChangesJson, readAroundChanges } from "./holding/_worker.js/around.js";
import {
  handleRnTracks,
  handleRnTracksHtml,
  renderTrackListHtml,
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


test("track HTML renderer emits rows only", () => {
  const html = renderTrackListHtml(TRACKS);
  assert.match(html, /^<li\b/);
  assert.match(html, /np-title/);
  assert.match(html, /A &lt;song&gt;/);
  assert.doesNotMatch(html, /<(?:!doctype|html|head|body)\b/i);
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
  // `npm run gen:manifest` — the same drift build.mjs #8 blocks, checked here too.
  const { surfaces } = readManifest();
  const mod = await readFile("holding/_worker.js/lib/site-manifest.js", "utf8");
  assert.equal(mod.trim(), workerModule(surfaces).trim(), "lib/site-manifest.js is stale — run npm run gen:manifest");
  const nav = await readFile("holding/nav.js", "utf8");
  for (const [section, marker] of [["garage", "garage-pages"], ["lwe", "lwe-pages"]]) {
    assert.equal(readFenceBody(nav, marker), navFenceBody(surfaces, section), `nav.js generated:${marker} is stale — run npm run gen:manifest`);
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

// The Serendipity server card is published twice, at /.well-known/mcp.json (the
// api-catalog's service-desc) and /.well-known/mcp/server-card.json (the path
// Lens probes on any origin). Both are hand-written transcriptions of MCP_TOOLS,
// so they drift the moment a tool is added or renamed. A third copy,
// mcp/server-cards.json, sat unreferenced for weeks carrying a stale
// list_events description; this test is why it cannot come back unnoticed.
test("published MCP server cards enumerate the live Serendipity tool catalog", async () => {
  const live = MCP_TOOLS.map((tool) => tool.name).sort();
  for (const file of ["holding/.well-known/mcp.json", "holding/.well-known/mcp/server-card.json"]) {
    const card = JSON.parse(await readFile(new URL(file, import.meta.url), "utf8"));
    assert.deepEqual(card.tools.map((tool) => tool.name).sort(), live, `${file} tool set drifted from MCP_TOOLS`);
    assert.equal(card.transport.url, "https://aadhar.sh/serendipity/mcp", `${file} points at the wrong transport`);
    for (const tool of card.tools) {
      assert.ok((tool.description || "").trim(), `${file}: ${tool.name} needs a description`);
    }
  }
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

test("homepage selects 12 photos and hydrates only the current scrollport", async () => {
  const worker = await readFile(new URL("holding/_worker.js/home.js", import.meta.url), "utf8");
  const page = await readFile(new URL("holding/index.html", import.meta.url), "utf8");
  const luna = await readFile(new URL("holding/luna.css", import.meta.url), "utf8");
  const nav = await readFile(new URL("holding/nav.js", import.meta.url), "utf8");

  const grid = await readFile(new URL("holding/_worker.js/lib/photo-grid.js", import.meta.url), "utf8");
  const build = await readFile(new URL("build.mjs", import.meta.url), "utf8");
  assert.match(worker, /pickRandom\(pool,\s*12\)/, "the per-request random draw must remain 12");
  assert.match(build, /deterministicTwelve/, "the document must carry a baked fallback grid, or `/` stops being crawlable without JS");
  assert.match(grid, /data-photo-deferred/, "photo URLs must stay in data-* for viewport-aware hydration");
  assert.match(grid, /<noscript><picture>/, "every baked tile needs its script-off twin");
  // A real src may appear ONLY inside the <noscript> twin. In the live tile it
  // would fetch a baked thumbnail that hydration discards milliseconds later.
  const liveTile = grid.slice(0, grid.indexOf("const noScript"));
  assert.doesNotMatch(liveTile, /\ssrc="/, "the live tile must defer every URL; a real src is a discarded download");
  assert.match(grid, /data-src="\$\{escAttr\(jpg\)\}"/, "the live tile carries its jpg in data-src");
  assert.doesNotMatch(worker, /rel="preload" as="image"/, "a non-LCP random photo must not consume the preload lane");
  assert.match(page, /fetch\("\/photos\/grid\.html"\)/, "the homepage must hydrate its random twelve");
  assert.match(page, /\.catch\(\(\) => \{\}\)\s*\.then\(boot\)/, "a failed grid fetch must still hydrate the baked tiles");
  assert.match(page, /IntersectionObserver/);
  assert.match(page, /threshold:\s*0\.05/, "a sliver of the next tile must not trigger a transfer");
  assert.match(page, /rootMargin:\s*"190px 0px"/,
    "tiles must pre-warm one row (190px pitch) ahead of the scrollport; with no rootMargin a tile starts its fetch only after it is already on screen, so the row below the fold arrives as a white square");
  assert.match(page, /overlap >= rect\.height \* 0\.05/, "desktop must synchronously hydrate its visible photo rows");
  assert.match(page, /else requestAnimationFrame\(\(\) => requestAnimationFrame\(start\)\)/, "mobile hydration must yield through the text paint");
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
    "private, no-cache, must-revalidate",                      // the homepage
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
