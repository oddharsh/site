#!/usr/bin/env node
// verify-routes.mjs — the route oracle for aadhar.sh.
//
// Curls every known route and asserts status + content-type (+ a body marker
// where it's cheap and stable). This is the regression tripwire for the repo
// reorg: capture a golden baseline against production, then re-run after every
// phase. If a route's status or content-type drifts, the reorg broke something.
//
//   node verify-routes.mjs [baseUrl]      # default https://aadhar.sh
//   node verify-routes.mjs http://localhost:8788
//
// Exit code is non-zero if any non-flaky route fails its assertion, so it can
// gate a deploy. Writes the observed results to verify-baseline.<host>.json.
//
// Cache-busted per request so we measure the deployment, not the edge cache.

import { readFileSync, writeFileSync } from "node:fs";

const base = (process.argv[2] || "https://aadhar.sh").replace(/\/$/, "");

// Build-output assertions (minified shells + luna.css + the .src twins) only hold
// against a real deploy. Local `wrangler dev` serves the readable holding/ tree
// (unminified, no .src twins), so those checks are gated to non-localhost bases.
const isProd = !/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])/.test(base);

// Real identifiers that exist in the repo today (see writing/posts.json + images/).
const SLUG = "in-flux";
const THUMB = "L1000069_3-400.avif";   // legacy thumb shape (now a 301 into /i/)
const META = "L1000069_3";             // /images/meta/<stem>.json
const FULL = "L1000069_3.jpg";         // /images/full/<key>

// the content-addressed twin of META's main avif, read from the same
// hashes.json the worker bakes manifests from, so this row tracks re-encodes.
let HASHED = null;
try {
  const hashes = JSON.parse(readFileSync(new URL("./holding/images/hashes.json", import.meta.url), "utf8"));
  if (hashes[META] && hashes[META].a) HASHED = `/i/${META}.${hashes[META].a}.avif`;
} catch {}

// status: a number, or an array of acceptable numbers.
// ct: a content-type prefix the response must start with (skipped for redirects).
//     may be an array of acceptable prefixes (e.g. Pages says application/javascript,
//     Workers-assets says text/javascript for the same .js file — both are valid).
// marker: a substring that must appear in the body (text routes only).
// flaky: true = record the result but never fail the run (external/rate-limited).
const ROUTES = [
  { path: "/", status: 200, ct: "text/html", marker: "Aadharsh" },
  { path: "/index.html", status: 301 },
  { path: "/favicon.ico", status: 200, ct: "image/svg+xml" },
  // ?peek=1 so the oracle never advances the visitor count
  { path: "/hit.svg?peek=1", status: 200, ct: "image/svg+xml", marker: "<svg" },
  { path: "/auth.md", status: 200, ct: "text/markdown" },
  { path: "/.well-known/api-catalog", status: 200, ct: "application/linkset+json" },
  { path: "/.well-known/agent-card.json", status: 200, ct: "application/json", marker: "discovery-only" },
  { path: "/.well-known/oauth-protected-resource", status: 200, ct: "application/json" },
  { path: "/.well-known/oauth-authorization-server", status: 200, ct: "application/json" },
  { path: "/whoareyou", status: 200, ct: "text/html" },
  { path: "/whoareyou.json", status: 200, ct: "application/json" },
  { path: "/security", status: 200, ct: "text/html" },
  { path: "/reading", status: 200, ct: "text/html" },
  { path: "/updates", status: 200, ct: "text/html" },
  { path: "/updates.json", status: 200, ct: "application/json" },
  { path: "/restore", status: 200, ct: "text/html" },
  { path: "/lens", status: 200, ct: "text/html", marker: "The Other Web", fullPage: true },
  { path: "/lens/", status: 301 },   // slashless canonical: routeDropSlash 301s to /lens
  { path: "/lens.js", status: 200, ct: ["text/javascript", "application/javascript"], marker: "replaceState" },
  { path: "/luna.css", status: 200, ct: "text/css", marker: "axp-desktop", maxBytes: isProd ? 45000 : undefined },
  // the retired SW's unregister stub: must keep serving 200 for a year+
  { path: "/sw.js", status: 200, ct: ["text/javascript", "application/javascript"], marker: "unregister" },
  // build-output oracle (prod only — dev serves the readable holding/ tree): a
  // deploy that skipped build.mjs ships the 78KB readable nav.js with no banner
  // and 404s every .src twin. These are the tripwire for that exact bypass.
  ...(isProd ? [
    { path: "/nav.js", status: 200, ct: ["text/javascript", "application/javascript"], marker: "minified at deploy", maxBytes: 50000 },
    { path: "/nav.src.js", status: 200, ct: ["text/javascript", "application/javascript"], marker: "axp-histnav" },
    { path: "/notepad.src.js", status: 200, ct: ["text/javascript", "application/javascript"], marker: "np-window" },
    { path: "/lens.src.js", status: 200, ct: ["text/javascript", "application/javascript"], marker: "replaceState" },
    { path: "/luna.src.css", status: 200, ct: "text/css", marker: "axp-desktop" },
  ] : []),
  // Representation contracts: the machine paths stay fixed even if a caller
  // sends a browser Accept header; the HTML paths are explicit fragments.
  { path: "/lens/fetch?url=https://example.com", status: 200, ct: "application/json", headers: { accept: "text/html" } },
  { path: "/lens/shot?url=https://example.com", status: [200, 503], flaky: true },
  // 200 text/plain when the x402 gate is unconfigured; 402 json once X402_PAY_TO is set
  { path: "/llms-full.txt", status: [200, 402], ct: ["text/plain", "application/json"] },
  { path: "/ledger", status: 200, ct: "text/html", marker: "Crawl Ledger" },
  { path: "/ledger.json", status: 200, ct: "application/json" },
  { path: "/writing", status: 200, ct: "text/html" },
  { path: "/writing/", status: 301 },   // routeDropSlash 301s to /writing
  { path: `/writing/${SLUG}`, status: 200, ct: "text/html" },
  { path: `/writing/${SLUG}.txt`, status: 200, ct: "text/plain" },
  { path: "/writing/posts.json", status: 200, ct: "application/json" },
  { path: "/rn", status: 302 },
  { path: "/rn/tracks", status: 200, ct: "application/json", headers: { accept: "text/html" } },
  { path: "/rn/tracks.html", status: 200, ct: "text/html", fragment: true },
  { path: "/rn/admin", status: 403 },
  { path: "/bot", status: 200, ct: "text/html" },
  { path: "/around", status: 200, ct: "text/html" },
  { path: "/around/json", status: 200, ct: "application/json" },
  // the listings are retired: every listing URL 301s to the /photos archive
  { path: "/images", status: 301 },
  { path: "/images/", status: 301 },
  { path: "/images/full", status: 301 },
  { path: "/images/full/", status: 301 },
  { path: "/photos", status: 200, ct: "text/html", marker: "handwritten worker" },
  { path: "/photos/", status: 301 },
  { path: "/run", status: 200, ct: "text/html", marker: "datalist" },
  { path: "/run?cmd=garage", status: 302 },
  { path: "/run?cmd=xyzzy-not-a-page", status: 200, ct: "text/html", marker: "cannot find" },
  { path: "/images/manifest.json", status: 200, ct: "application/json" },
  { path: "/images/metadata.json", status: 200, ct: "application/json" },
  { path: `/images/meta/${META}.json`, status: 200, ct: "application/json" },
  { path: `/images/full/${FULL}`, status: 200, ct: "image/jpeg" },
  // legacy thumb URL 301s into /i/; the hashed twin serves immutable bytes
  { path: `/images/${THUMB}`, status: 301 },
  ...(HASHED ? [{ path: HASHED, status: 200, ct: "image/avif" }] : []),
  // static section pages that are already URL-skeuomorphic (must not regress)
  { path: "/garage", status: 200, ct: "text/html" },
  { path: "/garage/", status: [301, 307, 308] },   // drop-trailing-slash: /garage serves, /garage/ redirects
  { path: "/garage/scroll", status: 200, ct: "text/html" },
  { path: "/garage/workers", status: 200, ct: "text/html", marker: "run_worker_first" },
  { path: "/garage/wire", status: 200, ct: "text/html", marker: "x-edge-cache" },
  { path: "/garage/blueprint", status: 200, ct: "text/html", marker: "run_worker_first" },
  { path: "/garage/gpt56", status: 200, ct: "text/html", marker: "5.6 Sol" },
  { path: "/garage/enc/z-jl90.jpg", status: 200, ct: "image/jpeg" },
  { path: "/lwe", status: 200, ct: "text/html" },
  { path: "/lwe/", status: [301, 307, 308] },   // drop-trailing-slash
  { path: "/lwe/utf8", status: 200, ct: "text/html" },
];

function cacheBust(path) {
  const sep = path.includes("?") ? "&" : "?";
  return base + path + sep + "cb=" + Math.floor(Math.random() * 1e9);
}

function statusOk(want, got) {
  return Array.isArray(want) ? want.includes(got) : want === got;
}

async function probe(r) {
  const url = cacheBust(r.path);
  try {
    const res = await fetch(url, { redirect: "manual", headers: { accept: "*/*", ...(r.headers || {}) } });
    const ct = res.headers.get("content-type") || "";
    let body = "", bytes = null;
    // read the body when we need a marker or a size assertion on a text response
    if ((r.marker || r.maxBytes || r.fullPage || r.fragment) && /text|json|javascript|markdown|svg|css/.test(ct)) {
      const full = await res.text();
      bytes = Buffer.byteLength(full);
      body = full.slice(0, 200000);
    }
    const okStatus = statusOk(r.status, res.status);
    const okCt = !r.ct || (Array.isArray(r.ct) ? r.ct.some(c => ct.startsWith(c)) : ct.startsWith(r.ct));
    const okMarker = !r.marker || body.includes(r.marker);
    const okBytes = !r.maxBytes || (bytes !== null && bytes <= r.maxBytes);
    const okFullPage = !r.fullPage || (
      /^<!doctype html[\s>]/i.test(body) &&
      /<html\b/i.test(body) &&
      /<head\b/i.test(body) &&
      /<body\b/i.test(body) &&
      /<\/html>/i.test(body)
    );
    const okFragment = !r.fragment || (
      !/<(?:!doctype|html|head|body)\b/i.test(body) &&
      (!r.fragmentRoot || body.includes(r.fragmentRoot))
    );
    const pass = okStatus && okCt && okMarker && okBytes && okFullPage && okFragment;
    return { path: r.path, status: res.status, ct, pass, flaky: !!r.flaky, okStatus, okCt, okMarker, okBytes, okFullPage, okFragment, bytes, want: r.status, wantCt: r.ct, marker: r.marker, maxBytes: r.maxBytes };
  } catch (e) {
    return { path: r.path, status: 0, ct: "", pass: false, flaky: !!r.flaky, error: String(e && e.message || e), want: r.status };
  }
}

async function main() {
  console.log(`\nRoute oracle vs ${base}\n` + "=".repeat(60));
  const results = [];
  // small concurrency to be quick without hammering the edge
  const queue = [...ROUTES];
  const workers = Array.from({ length: 6 }, async () => {
    while (queue.length) {
      const r = queue.shift();
      results.push(await probe(r));
    }
  });
  await Promise.all(workers);
  results.sort((a, b) => ROUTES.findIndex(x => x.path === a.path) - ROUTES.findIndex(x => x.path === b.path));

  let hardFails = 0;
  for (const r of results) {
    const tag = r.pass ? "PASS" : (r.flaky ? "flaky" : "FAIL");
    if (!r.pass && !r.flaky) hardFails++;
    const why = r.pass ? "" : [
      r.okStatus === false ? `status ${r.status}!=${JSON.stringify(r.want)}` : "",
      r.okCt === false ? `ct "${r.ct}"!^"${r.wantCt}"` : "",
      r.okMarker === false ? `missing marker "${r.marker}"` : "",
      r.okBytes === false ? `size ${r.bytes}B > ${r.maxBytes}B (unminified? build bypassed?)` : "",
      r.okFullPage === false ? "full-page contract missing document wrapper" : "",
      r.okFragment === false ? "fragment contract returned a document wrapper" : "",
      r.error ? `err ${r.error}` : "",
    ].filter(Boolean).join(", ");
    console.log(`${tag.padEnd(5)} ${String(r.status).padEnd(4)} ${r.path}${why ? "   <- " + why : ""}`);
  }

  const host = base.replace(/^https?:\/\//, "").replace(/[^a-z0-9.-]/gi, "_");
  const outFile = `verify-baseline.${host}.json`;
  writeFileSync(outFile, JSON.stringify({ base, routes: results.map(({ path, status, ct }) => ({ path, status, ct })) }, null, 2) + "\n");

  console.log("=".repeat(60));
  console.log(`${results.length} routes, ${hardFails} hard failure(s). Baseline -> ${outFile}`);
  process.exit(hardFails ? 1 : 0);
}

main();
