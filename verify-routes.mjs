#!/usr/bin/env node

// Acceptance sweep for the compiled documents and the bounded Worker surface.
// It runs against an in-process Wrangler harness in CI and can also audit a
// preview or production origin without changing the assertions.

import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const base = new URL((process.argv[2] || "https://aadhar.sh").replace(/\/?$/, "/"));
const manifest = JSON.parse(await readFile(path.join(root, "dist/build-manifest.json"), "utf8"));
let passed = 0;
let failed = 0;

function ok(label) { passed += 1; console.log(`PASS ${label}`); }
function bad(label, detail) { failed += 1; console.error(`FAIL ${label}${detail ? ` — ${detail}` : ""}`); }

async function request(route, init = {}) {
  return fetch(new URL(route.replace(/^\//, ""), base), { redirect: "manual", signal: AbortSignal.timeout(10_000), ...init });
}

function typeIs(response, prefix) {
  return (response.headers.get("content-type") || "").toLowerCase().startsWith(prefix);
}

function secureHtml(route, response) {
  const checks = [
    ["content-security-policy", "frame-ancestors 'none'"],
    ["x-content-type-options", "nosniff"],
    ["referrer-policy", "strict-origin-when-cross-origin"],
  ];
  for (const [header, token] of checks) {
    if (!(response.headers.get(header) || "").includes(token)) bad(`${route} ${header}`, `missing ${token}`);
  }
}

for (const route of manifest.pages) {
  try {
    const response = await request(route, { headers: { accept: "text/html" } });
    const body = await response.text();
    if (response.status !== 200) bad(`${route} HTML`, `HTTP ${response.status}`);
    else if (!typeIs(response, "text/html")) bad(`${route} HTML`, response.headers.get("content-type"));
    else if (!/^<!doctype html>/i.test(body) || !body.includes('<main class="document" id="content">')) bad(`${route} HTML`, "not a complete document");
    else if ((body.match(/<h1\b/gi) ?? []).length !== 1) bad(`${route} HTML`, "expected one h1");
    else { secureHtml(route, response); ok(`${route} HTML`); }
  } catch (error) { bad(`${route} HTML`, error.message); }

  const relative = route === "/" ? "index.md" : `${route.slice(1)}.md`;
  let hasMarkdown = false;
  try { hasMarkdown = (await stat(path.join(root, "dist", relative))).isFile(); } catch { /* no twin by design */ }
  if (hasMarkdown && route !== "/terminal") {
    try {
      const response = await request(route, { headers: { accept: "text/markdown, text/html;q=0.5" } });
      const body = await response.text();
      if (response.status !== 200) bad(`${route} negotiation`, `HTTP ${response.status}`);
      else if (!typeIs(response, "text/markdown") && !typeIs(response, "text/x-markdown")) bad(`${route} negotiation`, response.headers.get("content-type"));
      else if (!body.trim()) bad(`${route} negotiation`, "representation is empty");
      else ok(`${route} Markdown negotiation`);
    } catch (error) { bad(`${route} negotiation`, error.message); }
  }
}

const dynamic = [
  ["/whoareyou.json", [200], "application/json"],
  ["/hit?peek=1", [200], "image/svg+xml"],
  ["/terminal.txt", [200], "text/plain"],
  ["/finger.txt", [200], "text/plain"],
  ["/photos.txt", [200], "text/plain"],
  ["/lens/fetch", [400], "application/json"],
  ["/lens/browser", [400], "application/json"],
  ["/lens/shot", [400], "application/json"],
  ["/lens/compare.json", [400], "application/json"],
  ["/lens/census.json", [200], "application/json"],
  ["/coffee/availability.json", [200, 503], "application/json"],
  ["/coffee/slots", [200, 503], "application/json"],
  ["/coffee/approve", [401], "text/html"],
  ["/coffee/decline", [401], "text/html"],
  ["/serendipity/events.json", [200], "application/json"],
  ["/serendipity/event/does-not-exist", [404], "text/html"],
  ["/around/json", [200, 503], "application/json"],
  ["/around/changes.json", [200, 503], "application/json"],
  ["/ledger.json", [200], "application/json"],
  ["/photos/query.json?q=night&limit=2", [200], "application/json"],
  ["/rn/tracks", [200], "application/json"],
  ["/rn/tracks.html", [200], "text/html"],
  ["/rn.md", [200], "text/markdown"],
  ["/search.json?q=photos", [200], "application/json"],
  ["/run?cmd=photos", [302], null],
  ["/images/full/does-not-exist.jpg", [404], "text/plain"],
  ["/.well-known/api-catalog", [200], "application/linkset+json"],
];

for (const [route, statuses, type] of dynamic) {
  try {
    const response = await request(route, { headers: { accept: "text/html,application/json;q=0.9,*/*;q=0.1" } });
    await response.arrayBuffer();
    if (!statuses.includes(response.status)) bad(route, `HTTP ${response.status}; wanted ${statuses.join("/")}`);
    else if (type && !typeIs(response, type)) bad(route, response.headers.get("content-type"));
    else ok(`${route} ${response.status}`);
  } catch (error) { bad(route, error.message); }
}

const posts = [
  ["/mcp", { jsonrpc: "2.0", id: 1, method: "tools/list" }, 200],
  ["/serendipity/mcp", { jsonrpc: "2.0", id: 1, method: "tools/list" }, 200],
  ["/webmention", { source: "invalid", target: "invalid" }, 400],
];
for (const [route, payload, status] of posts) {
  try {
    const response = await request(route, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
    const body = await response.text();
    if (response.status !== status) bad(`${route} POST`, `HTTP ${response.status}; wanted ${status}`);
    else if (!typeIs(response, "application/json")) bad(`${route} POST`, response.headers.get("content-type"));
    else if (status === 200 && !body.includes('"jsonrpc":"2.0"')) bad(`${route} POST`, "invalid JSON-RPC envelope");
    else ok(`${route} POST ${status}`);
  } catch (error) { bad(`${route} POST`, error.message); }
}

for (const route of ["/serendipity/sync", "/serendipity/cookies", "/serendipity/add-event"]) {
  const response = await request(route, { method: "POST" });
  if (response.status === 410) ok(`${route} retired with 410`); else bad(route, `HTTP ${response.status}; wanted 410`);
  await response.arrayBuffer();
}

for (const [route, statuses, location] of [["/index.html", [301], "/"], ["/photos/", [301, 307], "/photos"], ["/images", [301], "/photos"]]) {
  const response = await request(route);
  const actual = response.headers.get("location") ? new URL(response.headers.get("location"), base).pathname : null;
  if (statuses.includes(response.status) && actual === location) ok(`${route} redirects to ${location}`);
  else bad(route, `HTTP ${response.status}, location ${actual}`);
  await response.arrayBuffer();
}

const missing = await request("/definitely-not-a-page", { headers: { accept: "text/html" } });
if (missing.status === 404) ok("unknown route is 404"); else bad("unknown route", `HTTP ${missing.status}`);
await missing.arrayBuffer();

const method = await request("/whoareyou.json", { method: "PUT" });
if (method.status === 405 && (method.headers.get("allow") || "").includes("GET")) ok("unsafe unknown method is 405");
else bad("unsafe unknown method", `HTTP ${method.status}`);
await method.arrayBuffer();

console.log(`\nroute oracle: ${passed} passed, ${failed} failed against ${base.origin}`);
process.exit(failed ? 1 : 0);
