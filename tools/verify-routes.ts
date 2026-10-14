#!/usr/bin/env node
// verify-routes.mjs — the route oracle for aadhar.sh.

import { readFileSync } from "node:fs";
import { agentRepresentation, agentSurfaces, needsBuiltTwin } from "./lib/agent-representation.ts";
import { twinOracleRows } from "./lib/client-assets.ts";

const ROOT = new URL("../", import.meta.url);


const base = (process.argv[2] || "https://aadhar.sh").replace(/\/$/, "");

const TIMEOUT_MS = Number(process.env.VERIFY_TIMEOUT_MS || 20000);

const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])/.test(base);
const isProd = !isLocal;
const builtOutput = isProd || process.env.VERIFY_BUILT === "1";

const remoteRows = isProd || process.env.VERIFY_REMOTE === "1";

const SLUG = "in-flux";
const THUMB = "L1000069_3-400.avif";
const META = "L1000069_3";
const FULL = "L1000069_3.jxl";
const FULL_JPEG = "L1000069_3.jpg";

let HASHED = null;
try {
  const hashes = JSON.parse(readFileSync(new URL("./public/images/hashes.json", ROOT), "utf8"));
  if (hashes[META] && hashes[META].a) HASHED = `/i/${META}.${hashes[META].a}.avif`;
} catch {}

const ROUTES = [
  { path: "/.well-known/http-message-signatures-directory", status: 200,
    ct: "application/http-message-signatures-directory+json", marker: '"keys"', remote: true },
  { path: "/", status: 200, ct: "text/html", marker: "Aadharsh" },
  { path: "/", status: 200, ct: "text/html", marker: "data-island=/photos/grid.html", fullPage: true },
  { path: "/", status: 200, ct: "text/html", marker: "data-island=/rn/tracks.html", fullPage: true },
  { path: "/photos/grid.html", status: 200, ct: "text/html", marker: "/images/full/", fragment: true },
  { path: "/", status: 200, ct: "text/markdown", headers: { accept: "text/markdown" } },
  { path: "/garage/horizon", status: 200, ct: "text/markdown",
    headers: { accept: "text/markdown, text/html, */*" } },
  { path: "/garage/horizon", status: 200, ct: "text/html",
    headers: { accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8" } },
  { path: "/garage/horizon", status: 200, ct: "text/html",
    headers: { accept: "text/html, text/markdown;q=0" } },
  { path: "/garage/horizon", status: 200, ct: "text/html",
    headers: { accept: "text/markdown;q=0, */*;q=1" } },
  { path: "/garage/horizon", status: 200, ct: "text/html",
    headers: { accept: "text/markdown;q=0.2, text/html;q=0.8, */*;q=1" } },
  { path: "/index.html", status: 301 },
  { path: "/favicon.ico", status: 200, ct: "image/svg+xml" },
  { path: "/hit?peek=1", status: 200, ct: "image/svg+xml", marker: "<svg" },
  { path: "/.well-known/api-catalog", status: 200, ct: "application/linkset+json" },
  { path: "/.well-known/agent-card.json", status: 200, ct: "application/json", marker: "discovery-only" },
  { path: "/.well-known/ard.json", status: 200, ct: "application/json", marker: "urn:air:aadhar.sh:mcp:site", cors: "*" },
  { path: "/.well-known/ai-catalog.json", status: 301 },
  { path: "/.well-known/mcp.json", status: 301 },
  { path: "/.well-known/tdmrep.json", status: 200, ct: "application/json", marker: '"tdm-reservation"', cors: "*" },
  { path: "/whoareyou", status: 200, ct: "text/html", marker: "data-island=/whoareyou/values.html", fullPage: true },
  { path: "/whoareyou.json", status: 200, ct: "application/json" },
  { path: "/whoareyou/values.html", status: 200, ct: "text/html", marker: "Cloudflare colo", fragment: true },
  { path: "/whoareyou", status: 200, ct: "text/markdown", headers: { accept: "text/markdown" }, marker: "System Properties" },
  { path: "/security", status: 200, ct: "text/html", marker: "data-sc=colo", fullPage: true },
  { path: "/security.json", status: 200, ct: "application/json", marker: '"httpProtocol"' },
  { path: "/security.md", status: 200, ct: "text/markdown", marker: "Security Center" },
  { path: "/security", status: 200, ct: "text/markdown", headers: { accept: "text/markdown" },
    marker: "http-message-signatures-directory" },
  { path: "/reading", status: 200, ct: "text/html", marker: "data-island=/reading/list.html", fullPage: true },
  { path: "/reading/list.html", status: 200, ct: "text/html", marker: "fetched by", fragment: true },
  { path: "/updates", status: 200, ct: "text/html" },
  { path: "/updates.md", status: 200, ct: "text/markdown", marker: "Recently installed" },
  { path: "/restore.md", status: 200, ct: "text/markdown", marker: "Restore point" },
  { path: "/photos.md", status: 200, ct: "text/markdown" },
  { path: "/writing.md", status: 200, ct: "text/markdown", marker: "plain text file" },
  { path: "/lens.md", status: 200, ct: "text/markdown", marker: "Execution checks stay neutral" },
  { path: "/coffee.md", status: 200, ct: "text/markdown", marker: "Booking fails closed" },
  { path: "/coffee", status: 200, ct: "text/html", marker: "data-island=/coffee/slots.html", fullPage: true },
  { path: "/coffee/slots.html", status: 200, ct: "text/html", marker: "xp-day-label", fragment: true },
  { path: "/coffee/pick", status: 200, ct: "text/html", marker: 'id="bookform"' },
  { path: "/around.md", status: 200, ct: "text/markdown", marker: "Nothing here is an endorsement" },
  { path: "/updates", status: 200, ct: "text/markdown", headers: { accept: "text/markdown" } },
  { path: "/restore", status: 200, ct: "text/markdown", headers: { accept: "text/markdown" } },
  { path: "/updates.json", status: 200, ct: "application/json" },
  { path: "/garage/dyno", status: 200, ct: "text/html", marker: "data-island=/garage/dyno/pulls.html", fullPage: true },
  { path: "/garage/dyno/pulls.html", status: 200, ct: "text/html", marker: "Recent pulls", fragment: true },
  { path: "/garage/dyno", status: 200, ct: "text/markdown", headers: { accept: "text/markdown" }, marker: "on the rollers" },
  { path: "/garage/dyno.json", status: 200, ct: "application/json" },
  { path: "/perf", status: 301 },
  { path: "/perf.json", status: 301 },
  { path: "/restore", status: 200, ct: "text/html" },
  { path: "/lens", status: 200, ct: "text/html", marker: "The Other Web", fullPage: true },
  { path: "/lens/", status: 301 },
  { path: "/lens-boot.js", status: 200, ct: ["text/javascript", "application/javascript"], marker: "requestSubmit" },
  { path: "/lens-webmcp.js", status: 200, ct: ["text/javascript", "application/javascript"], marker: "LensWebMcp" },
  { path: "/lens.js", status: 200, ct: ["text/javascript", "application/javascript"], marker: "replaceState" },
  { path: "/lens-browser.js", status: 200, ct: ["text/javascript", "application/javascript"], marker: "LensBrowser" },
  { path: "/luna.css", status: 200, ct: "text/css", marker: "axp-desktop", maxBytes: builtOutput ? 50000 : undefined },
  { path: "/sw.js", status: 200, ct: ["text/javascript", "application/javascript"], marker: "unregister" },
  ...(builtOutput ? [
    { path: "/nav.js", status: 200, ct: ["text/javascript", "application/javascript"], marker: "minified at deploy", maxBytes: 65000 },
    { path: "/nav-run.js", status: 200, ct: ["text/javascript", "application/javascript"], marker: "minified at deploy", maxBytes: 25000 },
    { path: "/nav-tray.js", status: 200, ct: ["text/javascript", "application/javascript"], marker: "minified at deploy", maxBytes: 10000 },
    { path: "/nav-pipes.js", status: 200, ct: ["text/javascript", "application/javascript"], marker: "minified at deploy", maxBytes: 20000 },
    { path: "/nav-tips.js", status: 200, ct: ["text/javascript", "application/javascript"], marker: "minified at deploy", maxBytes: 10000 },
    { path: "/tooltip.js", status: 200, ct: ["text/javascript", "application/javascript"], marker: "minified at deploy", maxBytes: 18000 },
    ...twinOracleRows().filter((row) => row.path !== "/lwe/ask.src.js").map((row) => ({ ...row })),
    { path: "/luna.src.css", status: 200, ct: "text/css", marker: "axp-desktop" },
  ] : []),
  { path: "/lens/fetch?url=https://example.com", status: 200, ct: "application/json", headers: { accept: "text/html" }, remote: true },
  { path: "/lens/shot?url=https://example.com", status: [200, 503], flaky: true, remote: true },
  { path: "/lens/browser?url=javascript%3Aalert(1)", status: 400, ct: "application/json", headers: { accept: "text/html" } },
  { path: "/lens/browser?url=https%3A%2F%2Fexample.com&do=notarecipe", status: 400, ct: "application/json" },
  { path: "/lens/browser?recipes=1", status: 200, ct: "application/json" },
  { path: "/lens/compare.json?left=javascript%3Aalert(1)&right=https%3A%2F%2Fexample.com", status: 400, ct: "application/json" },
  { path: "/lens/wire?url=javascript%3Aalert(1)", status: 400, ct: "application/json" },
  { path: "/lens/wire", status: 400, ct: "application/json" },
  { path: "/mcp", status: 405, ct: "application/json" },
  { path: "/mcp", method: "POST", status: 200, ct: "application/json",
    headers: { "content-type": "application/json" }, marker: "<h1>Horizon",
    body: JSON.stringify({ jsonrpc: "2.0", id: "resource", method: "resources/read", params: { uri: base + "/garage/horizon" } }) },
  { path: "/mcp", method: "POST", status: 200, ct: "application/json",
    headers: { "content-type": "application/json" }, marker: "# Right now",
    body: JSON.stringify({ jsonrpc: "2.0", id: "music-resource", method: "resources/read", params: { uri: base + "/rn" } }) },
  { path: "/serendipity", status: 200, ct: "text/html", marker: "data-island=/serendipity/events.html", fullPage: true },
  { path: "/serendipity/events.html", status: [200, 503], ct: "text/html" },
  { path: "/serendipity/mcp-info", status: 200, ct: "text/html", marker: "list_events", fullPage: true },
  ...["/mcp", "/serendipity/mcp"].map((path) => ({ path, method: "POST", status: 200, ct: "application/json",
    headers: { "content-type": "application/json" }, body: "[]", marker: "Invalid Request" })),

  { path: "/terminal", status: 410, ct: "text/plain", marker: "POST https://aadhar.sh/mcp" },
  { path: "/terminal/", status: 410, ct: "text/plain", marker: "POST https://aadhar.sh/mcp" },
  { path: "/finger?plain=1", status: 200, ct: "text/plain", marker: "finger — aadharsh@aadhar.sh" },
  { path: "/finger?plain=1&keys=2%3Ccr%3E", status: 200, ct: "text/plain", marker: "pane=writing" },
  { path: "/finger?plain=1&help=1", status: 200, ct: "text/plain", marker: "driving this thing" },
  { path: "/photos.txt?plain=1", status: 200, ct: "text/plain", marker: "photos — the archive" },
  { path: "/lens.txt?plain=1", status: 200, ct: "text/plain", marker: "the other web" },
  { path: "/lens.txt?plain=1&url=javascript%3Aalert(1)", status: 200, ct: "text/plain", marker: "refused" },
  { path: "/radar?plain=1", status: 200, ct: "text/plain", marker: "no antenna" },
  { path: "/dict?plain=1", status: 200, ct: "text/plain", marker: "fail silently" },
  { path: "/dict?plain=1&url=javascript%3Aalert(1)", status: 200, ct: "text/plain", marker: "refused" },
  { path: "/cache?plain=1", status: 200, ct: "text/plain", marker: "behavioral revalidation" },
  { path: "/cache?plain=1&url=javascript%3Aalert(1)", status: 200, ct: "text/plain", marker: "refused" },
  { path: "/agent-ready?plain=1", status: 200, ct: "text/plain", marker: "what this cost to build" },
  { path: "/agent-ready.txt", status: 200, ct: "text/plain", marker: "doors a machine can walk through" },
  { path: "/encode?plain=1", status: 200, ct: "text/plain", marker: "what did your encoder" },
  { path: "/encode?plain=1&url=javascript%3Aalert(1)", status: 200, ct: "text/plain", marker: "refused" },
  { path: "/nope-not-a-tool", status: 404 },
  { path: "/terminal/dict", status: 410 },
  { path: "/dict.txt", status: 200, ct: "text/plain", marker: "fail silently" },
  { path: "/finger.txt", status: 200, ct: "text/plain", marker: "aadharsh@aadhar.sh" },
  { path: "/lens.txt", status: 200, ct: "text/plain", marker: "the other web" },
  { path: "/photos.txt", status: 200, ct: "text/plain", marker: "the archive" },
  { path: "/dict", status: 200, ct: "text/html", headers: { accept: "text/html" }, marker: "tool-out", fullPage: true },

  { path: "/search", status: 200, ct: "text/html", marker: "Search aadhar.sh", fullPage: true },
  { path: "/search.json?q=photo", status: 200, ct: "application/json" },
  { path: "/search.json?q=scheduler.yield", status: 200, ct: "application/json", marker: '"url":"/garage/horizon"' },

  { path: "/ask?query=photos&streaming=0", status: 200, ct: "application/json", marker: "schema_object" },
  { path: "/ask?query=photos", status: 200, ct: "text/event-stream", marker: "message_type" },
  { path: "/ask", status: 400, ct: "application/json", marker: "query is required" },
  { path: "/ask?query=photos&mode=generate&streaming=0", status: 501, ct: "application/json", marker: "supported_modes" },

  { path: "/lens/nlweb?url=https://aadhar.sh&q=photos", status: 200, ct: "application/json", marker: "schema_object" },
  { path: "/lens/nlweb?url=http://localhost", status: 400, ct: "application/json", marker: "no-fetch list" },
  { path: "/lens/markdown?url=https://aadhar.sh/bot", status: 200, ct: "application/json", marker: "claude-code" },
  { path: "/lens/markdown?url=http://localhost", status: 400, ct: "application/json", marker: "no-fetch list" },
  // NO `encoding` pin here, deliberately, and the reason generalises to the
  // text/plain rows further down. Measured 2026-09-26 by booting the harness and
  // probing this route while the Worker served NO twin: it still answered
  // `content-encoding: br`, because miniflare re-encodes the types it deems
  // compressible and production's edge compresses them on the fly too. So an
  // encoding pin on a text/plain row passes whether or not a twin was served,
  // which is the one thing it exists to catch. What does discriminate is the
  // `vary` and the weakened `-br` etag servePrecompressedText adds, and
  // contract-llms-full-ships-its-q11-twin asserts those against a fake asset
  // layer instead.
  { path: "/llms-full.txt", status: [200, 402], ct: ["text/plain", "application/json"] },
  { path: "/ledger", status: 200, ct: "text/html", marker: "data-island=/ledger/lines.html", fullPage: true },
  { path: "/ledger/lines.html", status: 200, ct: "text/html", marker: "Total due", fragment: true },
  { path: "/inbox", status: 200, ct: "text/html", marker: "data-island=/inbox/mail.html", fullPage: true },
  { path: "/inbox/mail.html", status: 200, ct: "text/html", marker: "Local Folders", fragment: true },
  { path: "/lens/census", status: 200, ct: "text/html", marker: "data-island=/lens/census/table.html", fullPage: true },
  { path: "/lens/census/table.html", status: 200, ct: "text/html", fragment: true },
  { path: "/ledger.json", status: [200, 503], ct: "application/json" },
  { path: "/ledger/rum.js", status: 404 },
  { path: "/ledger/rum", status: 404 },
  { path: "/writing", status: 200, ct: "text/html" },
  { path: "/writing/", status: 301 },
  { path: `/writing/${SLUG}`, status: 200, ct: "text/html" },
  { path: `/writing/${SLUG}.txt`, status: 200, ct: "text/plain" },
  { path: "/writing/posts.json", status: 200, ct: "application/json", encoding: "br" },
  { path: "/rn", status: 302 },
  { path: "/rn.md", status: 200, ct: "text/markdown", marker: "https://aadhar.sh/rn/tracks" },
  { path: "/rn", status: 200, ct: "text/markdown", headers: { accept: "text/markdown" },
    marker: "https://aadhar.sh/rn/tracks" },
  { path: "/rn/tracks", status: [200, 503], ct: "application/json", headers: { accept: "text/html" } },
  { path: "/rn/tracks.html", status: 200, ct: "text/html", fragment: true },
  { path: "/rn/admin", status: 403 },
  { path: "/bot", status: 200, ct: "text/html" },
  { path: "/about", status: 200, ct: "text/html", marker: "Archetype" },
  { path: "/contact", status: 200, ct: "text/html", marker: "coffee@aadhar.sh" },
  { path: "/privacy", status: 200, ct: "text/html", marker: "serendipity-uid" },
  { path: "/developers", status: 200, ct: "text/html", marker: "/openapi.json" },
  { path: "/developers", status: 200, ct: "text/markdown", headers: { accept: "text/markdown" }, marker: "# Developers" },
  { path: "/privacy.md", status: 200, ct: "text/markdown", marker: "# Privacy" },
  { path: "/around", status: 200, ct: "text/html", marker: "data-island=/around/snapshot.html", fullPage: true },
  { path: "/around/snapshot.html", status: 200, ct: "text/html", marker: "snapshot isn", fragment: true },
  { path: "/around", status: 200, ct: "text/markdown", headers: { accept: "text/markdown" }, marker: "neighbourhood" },
  { path: "/around/json", status: 200, ct: "application/json", remote: true },
  { path: "/around/changes.json", status: 200, ct: "application/json" },
  { path: "/photos/query.json?q=XT", status: 200, ct: "application/json" },
  { path: "/coffee/availability.json", status: [200, 503], ct: "application/json", flaky: true },
  { path: "/a/icons.00000000.svg", status: 301 },
  { path: "/og/garage-pqc.png", status: 301 },
  { path: "/finger.md", status: 301 },
  { path: "/.well-known/mcp", status: 301 },
  { path: "/garage/resampe", status: 404, ct: "text/plain", marker: "/garage/resample" },
  { path: "/.well-known/ai-plugin.json", status: 404, ct: "application/json", marker: "/sitemap.xml" },
  { path: "/.well-known/ai-plugin.json", status: 404, ct: "text/plain", headers: { accept: "text/html,*/*;q=0.8" }, marker: "/sitemap.xml" },
  { path: "/v1/nope", status: 404, ct: "application/json", marker: "\"code\": \"not_found\"" },
  { path: "/search.json?q=fhe", method: "DELETE", status: 405, ct: "application/json", marker: "method_not_allowed" },
  { path: "/search.json?q=fhe", status: 200, ct: "application/json", headers: { "api-version": "1999-01-01" }, marker: "\"results\"" },
  { path: "/.well-known/oauth-protected-resource", status: 404 },
  { path: "/.well-known/oauth-authorization-server", status: 404 },
  { path: "/oauth2/token", status: 404 },
  { path: "/garage/resampe", status: 404, ct: "text/markdown", headers: { accept: "text/markdown" }, marker: "# 404 Not Found" },
  { path: "/garage/resampe", status: 404, ct: "application/json", headers: { accept: "application/json" }, marker: "\"code\": \"not_found\"" },
  { path: "/openapi.json", status: 200, ct: "application/json", marker: "\"operationId\"" },
  { path: "/swagger.json", status: 301 },
  { path: "/docs", status: 301 },
  { path: "/api-docs", status: 301 },
  { path: "/images", status: 301 },
  { path: "/images/", status: 301 },
  { path: "/images/full", status: 301 },
  { path: "/images/full/", status: 301 },
  { path: "/photos", status: 200, ct: "text/html", marker: "handwritten worker", remote: true },
  { path: "/photos/", status: 301 },
  { path: "/cota-wec", status: 404 },
  { path: "/run", status: 200, ct: "text/html", marker: "datalist" },
  { path: "/run?cmd=garage", status: 302 },
  { path: "/run?cmd=xyzzy-not-a-page", status: 200, ct: "text/html", marker: "cannot find" },
  { path: "/images/manifest.json", status: 200, ct: "application/json", encoding: "br" },
  { path: "/images/metadata.json", status: 200, ct: "application/json", encoding: "br" },
  { path: `/images/meta/${META}.json`, status: 200, ct: "application/json" },
  { path: `/images/full/${FULL}`, status: 200, ct: "image/jxl", remote: true },
  { path: `/images/full/${FULL_JPEG}`, status: 301 },
  { path: `/images/${THUMB}`, status: 301 },
  ...(HASHED ? [{ path: HASHED, status: 200, ct: "image/avif" }] : []),
  { path: "/garage", status: 200, ct: "text/html" },
  { path: "/garage/", status: [301, 307, 308] },
  { path: "/garage/scroll", status: 200, ct: "text/html" },
  { path: "/garage/workers", status: 200, ct: "text/html", marker: "run_worker_first" },
  { path: "/garage/wire", status: 200, ct: "text/html", marker: "x-edge-cache" },
  { path: "/garage/blueprint", status: 200, ct: "text/html", marker: "run_worker_first" },
  { path: "/garage/gpt56", status: 200, ct: "text/html", marker: "5.6 Sol" },
  { path: "/garage/enc/z-zc90.jpg", status: 200, ct: "image/jpeg" },
  { path: "/lwe", status: 200, ct: "text/html" },
  { path: "/lwe/", status: [301, 307, 308] },
  { path: "/lwe/utf8", status: 200, ct: "text/html" },
  { path: "/pixel-peeper", status: 200, ct: "text/html", marker: "compression eye exam" },
  { path: "/pixel-peeper/manifest.json", status: 200, ct: "application/json" },
  { path: "/access", status: 200, ct: "text/html", marker: "Device list, flat" },
  { path: "/access.md", status: 200, ct: "text/markdown", marker: "Device list, flat", encoding: "br" },
  { path: "/dotfiles", status: 200, ct: "text/html", marker: "Advanced settings:" },
  { path: "/dotfiles.md", status: 200, ct: "text/markdown", marker: "How this list was made", encoding: "br" },
  { path: "/dotfiles/macos.sh", status: 200, ct: "text/plain", marker: "log out and back in for the rest" },
  { path: "/garage/horizon.md", status: 200, ct: "text/markdown", encoding: "br" },
  { path: "/lwe/llms.txt", status: 200, ct: "text/plain", encoding: "br" },
  { path: "/garage/feed.xml", status: 200, ct: "application/rss+xml", encoding: "br" },
  { path: "/images/exif.json", status: 200, ct: "application/json", encoding: "br" },
  { path: "/images/meta/L1000069_3.json", status: 200, ct: "application/json", encoding: "br" },
  { path: "/search-index.json", status: 200, ct: "application/json", encoding: "br" },
  { path: "/llms.txt", status: 200, ct: "text/plain", encoding: "br" },
  { path: "/sitemap.xml", status: 200, ct: "application/xml", encoding: "br" },
  { path: "/lwe/ask.js", status: 200, ct: ["text/javascript", "application/javascript"], marker: "minified at deploy", encoding: "br" },
  { path: "/lwe/ask.src.js", status: 200, ct: ["text/javascript", "application/javascript"], marker: "generated:concepts:start", encoding: "br" },
  { path: "/garage/pretext.lib.js", status: 200, ct: ["text/javascript", "application/javascript"], encoding: "br" },
  { path: "/garage/horizon.src.html", status: 200, ct: "text/html", marker: "<!-- axp:desktop -->", encoding: "br" },
  { path: "/index.src.html", status: 200, ct: "text/html", marker: "<!-- axp:desktop -->", encoding: "br" },
  { path: "/.well-known/mcp/server-card.json", status: 200, ct: "application/json", marker: '"tools"', encoding: "br" },
  { path: "/.well-known/ard.json", status: 200, ct: "application/json", encoding: "br", cors: "*" },
  { path: "/section-icons/lens.svg", status: 200, ct: "image/svg+xml", encoding: "br" },
  { path: "/resume.json", status: 200, ct: "application/json", encoding: "br" },
  { path: "/writing/in-flux.src.html", status: 200, ct: "text/html", marker: "<html lang", encoding: "br" },
  { path: "/serendipity/mcp-info.src.html", status: 200, ct: "text/html", marker: "<html lang", encoding: "br" },
  { path: "/dotfiles/index.src.html", status: 200, ct: "text/html", marker: "<html lang", encoding: "br" },
  { path: "/57f3182c72aa0d0075d7128bf27cb016.txt", status: 200, ct: "text/plain", marker: "57f3182c72aa0d0075d7128bf27cb016" },
];

const AGENT_ROWS = (() => {
  if (!builtOutput) return [];
  const { surfaces } = JSON.parse(readFileSync(new URL("config/site-manifest.json", ROOT), "utf8"));
  const covered = new Set(ROUTES
    .filter((r) => /text\/markdown/.test(r.headers?.accept ?? "") && !/q=0(?![.\d])/.test(r.headers?.accept ?? ""))
    .map((r) => r.path));
  const rows = agentSurfaces(surfaces)
    .filter((s) => !covered.has(s.path))
    .map((s) => ({ path: s.path, status: 200, ct: agentRepresentation(s), headers: { accept: "text/markdown" }, remote: false }));
  const listed = new Set(ROUTES.map((r) => r.path));
  for (const s of agentSurfaces(surfaces).filter(needsBuiltTwin)) {
    const md = s.path === "/" ? "/index.md" : `${s.path}.md`;
    if (!listed.has(md)) rows.push({ path: md, status: 200, ct: "text/markdown", headers: { accept: "*/*" }, remote: false });
  }
  if (agentSurfaces(surfaces).length < 40) throw new Error("verify-routes: read fewer than 40 agents:true surfaces from site-manifest.json");
  return rows;
})();

function cacheBust(path) {
  const sep = path.includes("?") ? "&" : "?";
  return base + path + sep + "cb=" + Math.floor(Math.random() * 1e9);
}

function statusOk(want, got) {
  return Array.isArray(want) ? want.includes(got) : want === got;
}

function probeHeaders(r) {
  const headers: Record<string, string> = { accept: "*/*" };
  if (r.encoding) headers["accept-encoding"] = r.encoding;
  return { ...headers, ...r.headers };
}

async function probe(r) {
  const url = cacheBust(r.path);
  try {
    const res = await fetch(url, {
      method: r.method,
      body: r.body,
      redirect: "manual",
      signal: AbortSignal.timeout(TIMEOUT_MS),
      // An `encoding` row offers br explicitly. Node's fetch does not by default,
      // and the LOCAL asset layer then re-encodes any MIME type it deems
      // compressible to what the client did offer: measured 2026-08-31, the
      // same Worker response that arrives as br on /access.md (text/markdown,
      // not on its list) arrived as gzip on /llms.txt, /search-index.json and
      // /garage/feed.xml when br was not offered, and as br on all four when it
      // was. Production passes origin brotli through untouched (every /a/ asset
      // lands at exactly its q11 size), so this is the harness, and the row's
      // claim is the one a real client makes: offer br, get the q11 twin.
      headers: probeHeaders(r),
    });
    const ct = res.headers.get("content-type") || "";
    let body = "", bytes = null;
    if ((r.marker || r.maxBytes || r.fullPage || r.fragment) && /text|json|javascript|markdown|svg|css/.test(ct)) {
      const full = await res.text();
      bytes = Buffer.byteLength(full);
      body = full.slice(0, 200000);
    }
    const okStatus = statusOk(r.status, res.status);
    const okCt = !r.ct || (Array.isArray(r.ct) ? r.ct.some(c => ct.startsWith(c)) : ct.startsWith(r.ct));
    const enc = (res.headers.get("content-encoding") || "").toLowerCase();
    const okEnc = !r.encoding || enc === r.encoding;
    const okMarker = !r.marker || body.includes(r.marker);
    const cors = res.headers.get("access-control-allow-origin");
    const okCors = !r.cors || cors === r.cors;
    const okBytes = !r.maxBytes || (bytes !== null && bytes <= r.maxBytes);
    // Allowing a leading comment is safe rather than a loosened contract. Per the
    // HTML5 "initial" insertion mode a comment before DOCTYPE is legal and does
    // not force quirks mode, and that is verified rather than assumed: on live
    // production the homepage reports document.childNodes[0].nodeType === 8,
    // document.doctype.name === "html", and document.compatMode === "CSS1Compat".
    // Still anchored, so a document that merely mentions a doctype later fails.
    const okFullPage = !r.fullPage || (
      /^(?:<!--[\s\S]*?-->\s*)?<!doctype html[\s>]/i.test(body) &&
      /<html\b/i.test(body) &&
      /<head\b/i.test(body) &&
      /<body\b/i.test(body)
    );
    const okFragment = !r.fragment || (
      !/<(?:!doctype|html|head|body)\b/i.test(body) &&
      (!r.fragmentRoot || body.includes(r.fragmentRoot))
    );
    const pass = okStatus && okCt && okEnc && okMarker && okCors && okBytes && okFullPage && okFragment;
    return { path: r.path, status: res.status, ct, enc, wantEnc: r.encoding, cors, wantCors: r.cors, pass, flaky: !!r.flaky, okStatus, okCt, okEnc, okMarker, okCors, okBytes, okFullPage, okFragment, bytes, want: r.status, wantCt: r.ct, marker: r.marker, maxBytes: r.maxBytes };
  } catch (e) {
    return { path: r.path, status: 0, ct: "", pass: false, flaky: !!r.flaky, error: String(e && e.message || e), want: r.status };
  }
}

async function main() {
  const all = [...ROUTES, ...AGENT_ROWS];
  const routes = all.filter(r => !(r.remote && !remoteRows));
  const skipped = all.length - routes.length;
  console.log(`\nRoute oracle vs ${base}` +
    (skipped ? `  (${skipped} remote-only route(s) skipped)` : "") +
    (isLocal && remoteRows ? "  (remote bindings: production KV/R2/Browser)" : "") +
    "\n" + "=".repeat(60));
  const results: Awaited<ReturnType<typeof probe>>[] = [];
  const queue = [...routes];
  const workers = Array.from({ length: 6 }, async () => {
    while (queue.length) {
      const r = queue.shift();
      results.push(await probe(r));
    }
  });
  await Promise.all(workers);
  results.sort((a, b) => routes.findIndex(x => x.path === a.path) - routes.findIndex(x => x.path === b.path));

  let hardFails = 0;
  for (const r of results) {
    const tag = r.pass ? "PASS" : (r.flaky ? "flaky" : "FAIL");
    if (!r.pass && !r.flaky) hardFails++;
    const why = r.pass ? "" : [
      r.okStatus === false ? `status ${r.status}!=${JSON.stringify(r.want)}` : "",
      r.okCt === false ? `ct "${r.ct}"!^"${r.wantCt}"` : "",
      r.okEnc === false ? `content-encoding "${r.enc || "none"}" != "${r.wantEnc}" (twin built but not served?)` : "",
      r.okMarker === false ? `missing marker "${r.marker}"` : "",
      r.okCors === false ? `access-control-allow-origin "${r.cors || "none"}" != "${r.wantCors}"` : "",
      r.okBytes === false ? `size ${r.bytes}B > ${r.maxBytes}B (unminified? build bypassed?)` : "",
      r.okFullPage === false ? "full-page contract missing document wrapper" : "",
      r.okFragment === false ? "fragment contract returned a document wrapper" : "",
      r.error ? `err ${r.error}` : "",
    ].filter(Boolean).join(", ");
    console.log(`${tag.padEnd(5)} ${String(r.status).padEnd(4)} ${r.path}${why ? "   <- " + why : ""}`);
  }

  console.log("=".repeat(60));
  console.log(`${results.length} routes, ${hardFails} hard failure(s).`);
  process.exit(hardFails ? 1 : 0);
}

await main();
