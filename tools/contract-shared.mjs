// contract-shared.mjs — the suite's imports and its cross-section helpers.
//
// Split out of the single 8720-line contract-tests.test.mjs on 2026-08-20.
//
// The test files sit in tools/ rather than a tools/test/ subdirectory ON
// PURPOSE. The suite carries 111 dynamic relative imports plus 6
// `new URL("../…", import.meta.url)` reads, and every one keeps working
// untouched at this depth. A tidier subdirectory would have meant rewriting all
// 117 on a refactor whose whole point is making a lost test harder to miss.
//
// Only helpers used by MORE THAN ONE section live here, plus whatever those
// helpers themselves reference. That transitive step is not optional: the first
// attempt moved terminalEnv without TERMINAL_ASSETS and 44 tests failed on a
// helper that had been left behind.

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
} from "../src/worker/lens.ts";
import { EXECUTION_META, EXECUTION_PROBE, executionChecks } from "../src/worker/lib/agent-execution.ts";
import { httpWords } from "./check-agent.mjs";
import { lensReadiness, lensSitemapVerdict, lensSitemapDeclared, lensAgentDoors } from "../src/worker/lens.ts";
import { lensRecipe, lensRecipeIds, lensRecipeScript } from "../src/worker/lens-recipes.ts";
import { handleCoffeeAvailability } from "../src/worker/coffee.ts";
import { reservationName } from "../cal/src/reservation.js";
import { handleSiteMcp, MCP_TOOLS as SITE_MCP_TOOLS, SITE_MCP_SERVER_INFO } from "../src/worker/mcp.ts";
import { documentContent, handleWebmention, handleWebmentionDecision, linksTo } from "../src/worker/webmention.ts";
import { handleInbox } from "../src/worker/inbox.ts";
import { citationsIn, findEndpointIn, SELF_LINK_HOSTS } from "../src/worker/webmention-send.ts";
import { sign } from "../cal/src/sign.js";
import { AGENT_SURFACES, WEBMENTION_PATHS } from "../src/worker/lib/site-manifest.ts";
import { handleWritingIndex } from "../src/worker/writing.ts";
import { handleTool, tokenizeKeys } from "../src/worker/terminal.ts";
import { handleTerminal } from "../src/worker/wire.ts";
import { DATA_TOOLS } from "../src/worker/lib/tools.ts";
import { cronJob } from "../src/worker/lib/cron.ts";
import { BASELINE_HEADING, FLOOR_CLAIMS, auditDependencyDocs, baselineSection, checkDependencyDocs, findClaims, parseCargoDeps } from "./lib/dependency-docs.mjs";
import { PAGE_FAMILY_MATCH, serveStaticPage } from "../src/worker/lib/assets.ts";
import { serveMarkdown } from "../src/worker/home.ts";
import { readManifest, workerModule, navFenceBody, readFenceBody, runProfilesBody } from "./gen-manifest.mjs";
import { PROFILES } from "../tools/photos/shell-data.mjs";
import { faviconHref, sectionFavicons, speculationHtml } from "../tools/photos/gen-desktop-partial.mjs";
import { TASKBAR } from "../tools/photos/shell-data.mjs";
import { SECTION_FAVICONS } from "../src/worker/lib/desktop.ts";
import { collectBlockClasses, readDocument } from "./lib/html-to-md.mjs";
import { remainderHolder } from "./lib/ramp-split.mjs";
import {
  SERENDIPITY_MCP_SERVER_INFO,
  SERENDIPITY_SYNC_LIMITS,
  cookieJar,
  parseCookies,
  staleGuestIds,
} from "../serendipity/serendipity.js";
import { MCP_SUPPORTED as MCP_SUPPORTED_VERSIONS } from "../src/worker/lib/mcp-protocol.ts";
import { derivePhotoPool, renderPhotosPage, getImagesManifest, handlePhotoQuery, queryPhotos, _resetPhotoCaches } from "../src/worker/photos.ts";
import { renderPhotoSlots } from "../src/worker/lib/photo-grid.ts";
import { cachedRender, deadline } from "../src/worker/lib/cache.ts";
import { ifNoneMatchMatches, notModifiedIfFresh, withWeakEtag } from "../src/worker/lib/cache.ts";
import { fetchFollowingPublicRedirects, privateHostBlocked } from "../src/worker/lib/crawl.ts";
import { handleHit } from "../src/worker/counter.ts";
import { cronHomeProbe, parseServerTiming } from "../src/worker/perf-probe.ts";
import { gatherWhoareyou } from "../src/worker/whoareyou.ts";
import { handleSearchJson, renderSearchPage, searchSite } from "../src/worker/search.ts";
import { renderRun } from "../src/worker/run.ts";
import { getPublicAvailability } from "../cal/src/slots.js";
import { botHeaders } from "../src/worker/lib/botauth.ts";
import { mapWithConcurrency, readResponseCapped } from "../src/worker/lib/crawl.ts";
import { NEIGHBORS, diffAroundRows, handleAroundChangesJson, readAroundChanges, renderAroundHtml } from "../src/worker/around.ts";
import * as tui from "../src/worker/lib/tui.ts";
import {
  ART_VERSION,
  WARM_MAX_URLS,
  artUrls,
  artWarmList,
  canonicalArtUrl,
  cronEnrichTracks,
  handleRnArt,
  handleRnTracks,
  handleRnTracksHtml,
  renderTrackListHtml,
  spotifyArtHash,
  warmArtCache,
} from "../src/worker/rn.ts";

const ROOT = new URL("../", import.meta.url);


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

function labels(headers) {
  return (headers.get("signature-input").match(/(^|, )(sig\d+)=/g) || [])
    .map((m) => m.replace(/^, /, "").replace(/=$/, ""));
}

function staticAssets(files) {
  return {
    async fetch(input) {
      const path = new URL(input).pathname;
      if (!(path in files)) return new Response("not found", { status: 404 });
      return Response.json(files[path]);
    },
  };
}

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

function deferredContext() {
  const pending = [];
  return { waitUntil: (p) => pending.push(p), settle: () => Promise.all(pending) };
}

const wmPost = (source, target) => new Request("https://aadhar.sh/webmention", {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ source, target }).toString(),
});

const mcpPost = (body, headers = {}) => new Request("https://aadhar.sh/mcp", {
  method: "POST",
  body: JSON.stringify(body),
  headers: { "content-type": "application/json", ...headers },
});

const MODERN_META = { _meta: {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientCapabilities": {},
} };

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

const terminalGet = (path) => handleTool(terminalReq(path), terminalEnv(), context());


// The globals, typed loosely for TEST DOUBLES, and this is the only cast in the
// suite that exists for typing rather than for behaviour.
//
// bun types `globalThis.fetch` as `typeof fetch`, which carries a `preconnect`
// method. A double that answers three URLs has no business implementing it, and
// adding a stub `preconnect` to sixteen arrow functions would be inventing
// conformance rather than testing anything. Assigning through here says what is
// happening once: a partial stand-in is being installed on the global.
//
// It is deliberately NOT a general escape hatch. Reach for it to install a
// double; anything else wants a real type.
const testGlobals = /** @type {any} */ (globalThis);

export {
  testGlobals,
  AGENT_SURFACES,
  ART_VERSION,
  BASELINE_HEADING,
  DATA_TOOLS,
  EXECUTION_META,
  EXECUTION_PROBE,
  FLOOR_CLAIMS,
  MCP_SUPPORTED_VERSIONS,
  MODERN_META,
  NEIGHBORS,
  PAGE_FAMILY_MATCH,
  PLAYLIST_ID,
  PROFILES,
  ROOT,
  SECTION_FAVICONS,
  SELF_LINK_HOSTS,
  SERENDIPITY_MCP_SERVER_INFO,
  SERENDIPITY_SYNC_LIMITS,
  SITE_MCP_SERVER_INFO,
  SITE_MCP_TOOLS,
  TASKBAR,
  TERMINAL_ASSETS,
  TRACKS,
  WARM_MAX_URLS,
  WEBMENTION_PATHS,
  WM_SECRET,
  _resetPhotoCaches,
  artUrls,
  artWarmList,
  assert,
  assertFullDocument,
  auditDependencyDocs,
  baselineSection,
  botHeaders,
  brotliCompressSync,
  cachedRender,
  canonicalArtUrl,
  checkDependencyDocs,
  citationsIn,
  collectBlockClasses,
  context,
  cookieJar,
  cronEnrichTracks,
  cronHomeProbe,
  cronJob,
  deadline,
  deferredContext,
  derivePhotoPool,
  diffAroundRows,
  documentContent,
  executionChecks,
  existsSync,
  fakeD1,
  fakeImages,
  faviconHref,
  fetchFollowingPublicRedirects,
  findClaims,
  findEndpointIn,
  gatherWhoareyou,
  getImagesManifest,
  getPublicAvailability,
  handleAroundChangesJson,
  handleCoffeeAvailability,
  handleHit,
  handleInbox,
  handleLensBrowser,
  handleLensCompare,
  handleLensFetch,
  handleLensShot,
  handlePhotoQuery,
  handleRnArt,
  handleRnTracks,
  handleRnTracksHtml,
  handleSearchJson,
  handleSiteMcp,
  handleTerminal,
  handleTool,
  handleWebmention,
  handleWebmentionDecision,
  handleWritingIndex,
  httpWords,
  ifNoneMatchMatches,
  kvForTracks,
  kvType,
  labels,
  lensAgentDoors,
  lensDetectWebmcp,
  lensFieldEvidence,
  lensParseCloudflareAgentScore,
  lensReadiness,
  lensRecipe,
  lensRecipeIds,
  lensRecipeScript,
  lensSitemapDeclared,
  lensSitemapVerdict,
  linksTo,
  mapWithConcurrency,
  mcpPost,
  navFenceBody,
  notModifiedIfFresh,
  parseCargoDeps,
  parseCookies,
  parseServerTiming,
  privateHostBlocked,
  queryPhotos,
  readAroundChanges,
  readDocument,
  readFenceBody,
  readFile,
  readFileSync,
  readManifest,
  readResponseCapped,
  readdir,
  remainderHolder,
  renderAroundHtml,
  renderLensShell,
  renderPhotoSlots,
  renderPhotosPage,
  renderRun,
  renderSearchPage,
  renderTrackListHtml,
  representationD1,
  reservationName,
  runProfilesBody,
  searchSite,
  sectionFavicons,
  serveMarkdown,
  serveStaticPage,
  sign,
  speculationHtml,
  spotifyArtHash,
  staleGuestIds,
  staticAssets,
  terminalEnv,
  terminalGet,
  terminalReq,
  test,
  tokenizeKeys,
  tui,
  validateLensTarget,
  warmArtCache,
  withWeakEtag,
  wmEnv,
  wmPost,
  workerModule,
  zlibConstants,
};
