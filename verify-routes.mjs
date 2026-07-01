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

import { writeFileSync } from "node:fs";

const base = (process.argv[2] || "https://aadhar.sh").replace(/\/$/, "");

// Real identifiers that exist in the repo today (see writing/posts.json + images/).
const SLUG = "in-flux";
const THUMB = "L1000069_3-400.avif";   // /images/<stem>.avif thumbnail
const META = "L1000069_3";             // /images/meta/<stem>.json
const FULL = "L1000069_3.jpg";         // /images/full/<key>

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
  { path: "/auth.md", status: 200, ct: "text/markdown" },
  { path: "/.well-known/api-catalog", status: 200, ct: "application/linkset+json" },
  { path: "/.well-known/oauth-protected-resource", status: 200, ct: "application/json" },
  { path: "/.well-known/oauth-authorization-server", status: 200, ct: "application/json" },
  { path: "/whoareyou", status: 200, ct: "text/html" },
  { path: "/whoareyou.json", status: 200, ct: "application/json" },
  { path: "/security", status: 200, ct: "text/html" },
  { path: "/reading", status: 200, ct: "text/html" },
  { path: "/updates", status: 200, ct: "text/html" },
  { path: "/updates.json", status: 200, ct: "application/json" },
  { path: "/restore", status: 200, ct: "text/html" },
  { path: "/lens", status: 200, ct: "text/html", marker: "The Other Web" },
  { path: "/lens/", status: 200, ct: "text/html" },
  { path: "/lens.js", status: 200, ct: ["text/javascript", "application/javascript"], marker: "replaceState" },
  { path: "/lens/fetch?url=https://example.com", status: 200, ct: "application/json" },
  { path: "/lens/shot?url=https://example.com", status: [200, 503], flaky: true },
  { path: "/writing", status: 200, ct: "text/html" },
  { path: `/writing/${SLUG}`, status: 200, ct: "text/html" },
  { path: `/writing/${SLUG}.txt`, status: 200, ct: "text/plain" },
  { path: "/writing/posts.json", status: 200, ct: "application/json" },
  { path: "/rn", status: 302 },
  { path: "/rn/tracks", status: 200, ct: "application/json" },
  { path: "/rn/admin", status: 403 },
  { path: "/bot", status: 200, ct: "text/html" },
  { path: "/around", status: 200, ct: "text/html" },
  { path: "/around/json", status: 200, ct: "application/json" },
  { path: "/images", status: 301 },
  { path: "/images/", status: 200, ct: "text/html" },
  { path: "/images/manifest.json", status: 200, ct: "application/json" },
  { path: "/images/metadata.json", status: 200, ct: "application/json" },
  { path: `/images/meta/${META}.json`, status: 200, ct: "application/json" },
  { path: `/images/full/${FULL}`, status: 200, ct: "image/jpeg" },
  { path: `/images/${THUMB}`, status: 200, ct: "image/avif" },
  // static section pages that are already URL-skeuomorphic (must not regress)
  { path: "/garage/", status: 200, ct: "text/html" },
  { path: "/garage/scroll", status: 200, ct: "text/html" },
  { path: "/garage/workers", status: 200, ct: "text/html", marker: "run_worker_first" },
  { path: "/garage/wire", status: 200, ct: "text/html", marker: "x-edge-cache" },
  { path: "/garage/enc/z-jl90.jpg", status: 200, ct: "image/jpeg" },
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
    const res = await fetch(url, { redirect: "manual", headers: { accept: "*/*" } });
    const ct = res.headers.get("content-type") || "";
    let body = "";
    // only read the body when we need a marker and it's a text response
    if (r.marker && /text|json|javascript|markdown/.test(ct)) {
      body = (await res.text()).slice(0, 200000);
    }
    const okStatus = statusOk(r.status, res.status);
    const okCt = !r.ct || (Array.isArray(r.ct) ? r.ct.some(c => ct.startsWith(c)) : ct.startsWith(r.ct));
    const okMarker = !r.marker || body.includes(r.marker);
    const pass = okStatus && okCt && okMarker;
    return { path: r.path, status: res.status, ct, pass, flaky: !!r.flaky, okStatus, okCt, okMarker, want: r.status, wantCt: r.ct, marker: r.marker };
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
