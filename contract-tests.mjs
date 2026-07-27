#!/usr/bin/env node
// contract-tests.mjs — representation-boundary tests for the homepage Worker.
//
// These are deliberately dependency-free and deterministic. They test the
// public shape of the page/fragment and JSON/HTML handlers without starting a
// local Worker or making third-party network requests. verify-routes.mjs adds
// the same assertions against a deployed or local HTTP surface.

import assert from "node:assert/strict";
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
import { sign } from "./cal/src/sign.js";
import { AGENT_SURFACES } from "./holding/_worker.js/lib/site-manifest.js";
import { readManifest, workerModule, navFenceBody, readFenceBody } from "./scripts/gen-manifest.mjs";
import { MCP_TOOLS } from "./serendipity/serendipity.js";
import { handlePhotoQuery, queryPhotos } from "./holding/_worker.js/photos.js";
import { handleSearchJson, searchSite } from "./holding/_worker.js/search.js";
import { getPublicAvailability } from "./cal/src/slots.js";
import { botHeaders } from "./holding/_worker.js/lib/botauth.js";
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

function kvForTracks() {
  return {
    async get(key, type) {
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
      async get(key, type) { if (key === "cal:busy" && type === "json") return snapshot; return null; },
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
