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
//
// scripts/check-routes-harness.mjs points this same file at a Worker booted
// in-process by wrangler's test harness, which is how the oracle runs BEFORE a
// merge instead of only after a deploy. A local base drops the rows tagged
// `remote` (see below); everything else is asserted identically.

import { readFileSync, writeFileSync } from "node:fs";

const base = (process.argv[2] || "https://aadhar.sh").replace(/\/$/, "");

// No request may hang the sweep. probe() has always been unbounded, which is
// survivable against the edge but not against a local Worker holding a socket
// open on a binding it cannot reach (the BROWSER one does exactly that).
const TIMEOUT_MS = Number(process.env.VERIFY_TIMEOUT_MS || 20000);

// Build-output assertions (minified shells + luna.css + the .src twins) only hold
// against a real deploy. Local `wrangler dev` serves the readable holding/ tree
// (unminified, no .src twins), so those checks are gated to non-localhost bases.
// VERIFY_BUILT=1 forces them back on for a local base pointed at .build/holding,
// which is what check-routes-harness.mjs does: there the built tree IS the tree
// under test, so the "deploy bypassed build.mjs" tripwire can fire pre-merge.
const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])/.test(base);
const isProd = !isLocal;
const builtOutput = isProd || process.env.VERIFY_BUILT === "1";

// VERIFY_REMOTE=1 keeps the `remote` rows on a LOCAL base. Same shape as
// VERIFY_BUILT above and for the same reason: the rows are skipped locally
// because a local Worker has empty KV/R2 and no Browser Run, and remote bindings
// (scripts/gen-remote-config.mjs) remove exactly that limitation. Set only by
// `npm run routes:check:remote`, which boots the harness on a generated config
// whose KV/R2/Browser bindings reach production. Never set in CI, because remote
// bindings need a token that can write and CI holds a read-only one.
const remoteRows = isProd || process.env.VERIFY_REMOTE === "1";

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
// remote: true = skipped entirely against a local base. Reserve this for rows
//     whose assertion depends on something a local Worker structurally cannot
//     have: production R2/KV/D1 CONTENT, a secret, or a third-party host. A row
//     that merely serves a fallback locally is NOT remote — that fallback is
//     worth asserting, and losing the row would be losing coverage.
const ROUTES = [
  { path: "/", status: 200, ct: "text/html", marker: "Aadharsh" },
  // The front door answers agents in Markdown at its own URL. Two checks cover that
  // and they are not redundant: this row exercises the worker's own negotiation,
  // while infra.json's markdown-for-agents-off reads production and so covers
  // whether anything ANSWERS IN FRONT of the worker. #195 was entirely the second
  // kind — the negotiation was correct throughout — and neither check alone can
  // tell the two apart.
  { path: "/", status: 200, ct: "text/markdown", headers: { accept: "text/markdown" } },
  { path: "/index.html", status: 301 },
  { path: "/favicon.ico", status: 200, ct: "image/svg+xml" },
  // ?peek=1 so the oracle never advances the visitor count
  { path: "/hit?peek=1", status: 200, ct: "image/svg+xml", marker: "<svg" },
  { path: "/auth.md", status: 200, ct: "text/markdown" },
  { path: "/.well-known/api-catalog", status: 200, ct: "application/linkset+json" },
  { path: "/.well-known/agent-card.json", status: 200, ct: "application/json", marker: "discovery-only" },
  { path: "/.well-known/oauth-protected-resource", status: 200, ct: "application/json" },
  { path: "/.well-known/oauth-authorization-server", status: 200, ct: "application/json" },
  { path: "/whoareyou", status: 200, ct: "text/html" },
  { path: "/whoareyou.json", status: 200, ct: "application/json" },
  { path: "/security", status: 200, ct: "text/html" },
  // /security is static prose about the headers, so it earns a hand twin
  // (holding/md/security.md). Both halves asserted for the same reason the
  // generated ones below are: the .md URL proves the build staged it, the
  // negotiated form proves handleSecurityCenter reaches it.
  { path: "/security.md", status: 200, ct: "text/markdown", marker: "Security Center" },
  { path: "/security", status: 200, ct: "text/markdown", headers: { accept: "text/markdown" },
    marker: "http-message-signatures-directory" },
  { path: "/reading", status: 200, ct: "text/html" },
  { path: "/updates", status: 200, ct: "text/html" },
  // The twins the generated tier earned. Both halves are asserted because they
  // fail independently: the .md URL proves the build staged a twin at all, and the
  // negotiated form proves serveStaticPage found it at the page's own URL. These
  // pages carried `flags.agents: true` while answering HTML to both.
  { path: "/updates.md", status: 200, ct: "text/markdown", marker: "Recently installed" },
  { path: "/restore.md", status: 200, ct: "text/markdown", marker: "Restore point" },
  { path: "/photos.md", status: 200, ct: "text/markdown" },
  { path: "/updates", status: 200, ct: "text/markdown", headers: { accept: "text/markdown" } },
  { path: "/restore", status: 200, ct: "text/markdown", headers: { accept: "text/markdown" } },
  { path: "/updates.json", status: 200, ct: "application/json" },
  { path: "/restore", status: 200, ct: "text/html" },
  { path: "/lens", status: 200, ct: "text/html", marker: "The Other Web", fullPage: true },
  { path: "/lens/", status: 301 },   // slashless canonical: routeDropSlash 301s to /lens
  { path: "/lens.js", status: 200, ct: ["text/javascript", "application/javascript"], marker: "replaceState" },
  { path: "/lens-browser.js", status: 200, ct: ["text/javascript", "application/javascript"], marker: "LensBrowser" },
  { path: "/luna.css", status: 200, ct: "text/css", marker: "axp-desktop", maxBytes: builtOutput ? 45000 : undefined },
  // the retired SW's unregister stub: must keep serving 200 for a year+
  { path: "/sw.js", status: 200, ct: ["text/javascript", "application/javascript"], marker: "unregister" },
  // build-output oracle (prod only — dev serves the readable holding/ tree): a
  // deploy that skipped build.mjs ships the 78KB readable nav.js with no banner
  // and 404s every .src twin. These are the tripwire for that exact bypass.
  ...(builtOutput ? [
    { path: "/nav.js", status: 200, ct: ["text/javascript", "application/javascript"], marker: "minified at deploy", maxBytes: 50000 },
    { path: "/nav.src.js", status: 200, ct: ["text/javascript", "application/javascript"], marker: "axp-histnav" },
    { path: "/notepad.src.js", status: 200, ct: ["text/javascript", "application/javascript"], marker: "np-window" },
    { path: "/lens.src.js", status: 200, ct: ["text/javascript", "application/javascript"], marker: "replaceState" },
    { path: "/lens-browser.src.js", status: 200, ct: ["text/javascript", "application/javascript"], marker: "LensBrowser" },
    { path: "/tooltip.js", status: 200, ct: ["text/javascript", "application/javascript"], marker: "minified at deploy", maxBytes: 18000 },
    { path: "/tooltip.src.js", status: 200, ct: ["text/javascript", "application/javascript"], marker: "tooltip.js" },
    // the PowerShell console. It is the only client script whose absence is
    // INVISIBLE on the page it serves: /terminal server-renders its frame, so a
    // missing terminal.js leaves a console that looks right and cannot be typed
    // into. Asserted here because nothing on the page itself would notice.
    { path: "/terminal.js", status: 200, ct: ["text/javascript", "application/javascript"], marker: "ps-console" },
    { path: "/terminal.src.js", status: 200, ct: ["text/javascript", "application/javascript"], marker: "PowerShell" },
    { path: "/luna.src.css", status: 200, ct: "text/css", marker: "axp-desktop" },
  ] : []),
  // Representation contracts: the machine paths stay fixed even if a caller
  // sends a browser Accept header; the HTML paths are explicit fragments.
  // both reach a third party as AadharshBot, so both need RN_SIGNING_KEY_JWK.
  // Locally that secret is absent and /lens/fetch answers its own 502 with
  // "AadharshBot signing key is unavailable" — honest, but not this assertion.
  { path: "/lens/fetch?url=https://example.com", status: 200, ct: "application/json", headers: { accept: "text/html" }, remote: true },
  { path: "/lens/shot?url=https://example.com", status: [200, 503], flaky: true, remote: true },
  { path: "/lens/browser?url=javascript%3Aalert(1)", status: 400, ct: "application/json", headers: { accept: "text/html" } },
  { path: "/lens/compare.json?left=javascript%3Aalert(1)&right=https%3A%2F%2Fexample.com", status: 400, ct: "application/json" },
  { path: "/mcp", status: 405, ct: "application/json" },

  // ── the terminal programs ──────────────────────────────────────────────
  // The first marker is a BOX-DRAWING character rather than prose, and that is
  // deliberate: the failure these rows exist to catch is width math breaking,
  // and a bottom-left corner only reaches the body if a complete frame was
  // drawn. A row asserting a word would pass on a frame with no border at all.
  // `plain=1` keeps every assertion off the ANSI escapes.
  { path: "/terminal?plain=1", status: 200, ct: "text/plain", marker: "╚" },
  { path: "/terminal/", status: 301 },   // routeDropSlash 301s to /terminal
  { path: "/terminal/finger?plain=1", status: 200, ct: "text/plain", marker: "finger — aadharsh@aadhar.sh" },
  // Driving. Two keys switch to the writing pane and open its first note, and
  // the frame prints the state that produced it. If the key loop silently stops
  // applying, every other row here still passes — the frame renders fine, it
  // just renders the wrong one.
  { path: "/terminal/finger?plain=1&keys=2%3Ccr%3E", status: 200, ct: "text/plain", marker: "pane=writing" },
  { path: "/terminal/finger?plain=1&help=1", status: 200, ct: "text/plain", marker: "driving this thing" },
  { path: "/terminal/photos?plain=1", status: 200, ct: "text/plain", marker: "photos — the archive" },
  { path: "/terminal/lens?plain=1", status: 200, ct: "text/plain", marker: "the other web" },
  // A refused target must be refused BEFORE anything is fetched, and must come
  // back as a frame rather than a stack trace.
  { path: "/terminal/lens?plain=1&url=javascript%3Aalert(1)", status: 200, ct: "text/plain", marker: "refused" },
  // ask: the natural-language door. Asserted on the ROUTER path, which is what
  // answers when no model is bound — CI has none, and that is the point of the
  // fallback existing. The bare form must explain itself rather than 503.
  { path: "/terminal/ask?plain=1", status: 200, ct: "text/plain", marker: "plain language" },
  { path: "/terminal/ask?plain=1&q=what+does+he+write+about", status: 200, ct: "text/plain", marker: "what the agent did" },
  // The mode line is load-bearing: it is how a reader knows whether a model or a
  // keyword picked the tool. A frame that stopped saying so would still look right.
  { path: "/terminal/ask?plain=1&q=photos+on+acros", status: 200, ct: "text/plain", marker: "mode " },
  // Reading somebody else's origin. `at=` alone reads the doors and stops.
  // Marked remote: every external probe needs the AadharshBot signing key, which
  // a local Worker does not have — so locally each door reports "unread", which
  // is the honest answer and not the one worth asserting.
  { path: "/terminal/ask?plain=1&at=https%3A%2F%2Fexample.com", status: 200, ct: "text/plain", marker: "doors at", remote: true },
  // A refused target must be refused BEFORE any fetch, and come back as a frame.
  { path: "/terminal/ask?plain=1&at=http%3A%2F%2F169.254.169.254%2F&q=what+is+here", status: 200, ct: "text/plain", marker: "mode " },
  { path: "/terminal/ask?plain=1&at=javascript%3Aalert(1)", status: 200, ct: "text/plain", marker: "mode " },
  // The instrument's idle frame. The POST path that actually draws readings is
  // covered by contract tests, since the oracle only issues GETs.
  { path: "/terminal/radar?plain=1", status: 200, ct: "text/plain", marker: "no antenna" },
  { path: "/terminal/nope", status: 404, ct: "text/plain" },
  { path: "/terminal.md", status: 200, ct: "text/markdown", marker: "State is a URL, not a session" },
  // The browser arm of the same route. One renderer feeds both, so this asserts
  // the HTML wrapper is there — not that a second layout exists.
  { path: "/terminal", status: 200, ct: "text/html", headers: { accept: "text/html" }, marker: "Courier New", fullPage: true },

  { path: "/search", status: 200, ct: "text/html", marker: "Search aadhar.sh", fullPage: true },
  { path: "/search.json?q=photo", status: 200, ct: "application/json" },
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
  // /rn has no page to twin, so its Markdown is rendered live. The negotiated
  // form is the one that matters: it is the arm that stops an agent following
  // `agents: true` off-site into Spotify's HTML. Neither row is `remote`,
  // because an empty local KV still produces a valid document (the payload's
  // error state is prose, not a failure).
  { path: "/rn.md", status: 200, ct: "text/markdown", marker: "https://aadhar.sh/rn/tracks" },
  { path: "/rn", status: 200, ct: "text/markdown", headers: { accept: "text/markdown" },
    marker: "https://aadhar.sh/rn/tracks" },
  { path: "/rn/tracks", status: 200, ct: "application/json", headers: { accept: "text/html" } },
  { path: "/rn/tracks.html", status: 200, ct: "text/html", fragment: true },
  { path: "/rn/admin", status: 403 },
  { path: "/bot", status: 200, ct: "text/html" },
  { path: "/around", status: 200, ct: "text/html" },
  // serves the KV snapshot the */30 cron writes; a local KV has none, and the
  // route says so ("no snapshot yet; the cron crawl hasn't run") with a 503.
  { path: "/around/json", status: 200, ct: "application/json", remote: true },
  { path: "/around/changes.json", status: 200, ct: "application/json" },
  { path: "/photos/query.json?q=XT", status: 200, ct: "application/json" },
  { path: "/coffee/availability.json", status: [200, 503], ct: "application/json", flaky: true },
  // the listings are retired: every listing URL 301s to the /photos archive
  { path: "/images", status: 301 },
  { path: "/images/", status: 301 },
  { path: "/images/full", status: 301 },
  { path: "/images/full/", status: 301 },
  // the archive page builds its manifest by LISTING the R2 bucket, so an empty
  // local bucket is a 503 ("photo manifest unavailable"). /images/manifest.json
  // stays local-checkable because it can fall back to the committed hashes.json.
  { path: "/photos", status: 200, ct: "text/html", marker: "handwritten worker", remote: true },
  { path: "/photos/", status: 301 },
  { path: "/run", status: 200, ct: "text/html", marker: "datalist" },
  { path: "/run?cmd=garage", status: 302 },
  { path: "/run?cmd=xyzzy-not-a-page", status: 200, ct: "text/html", marker: "cannot find" },
  { path: "/images/manifest.json", status: 200, ct: "application/json" },
  { path: "/images/metadata.json", status: 200, ct: "application/json" },
  { path: `/images/meta/${META}.json`, status: 200, ct: "application/json" },
  // the SOOC original: ~3GB of R2 that is deliberately not in the repo.
  { path: `/images/full/${FULL}`, status: 200, ct: "image/jpeg", remote: true },
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
  { path: "/garage/enc/z-zc90.jpg", status: 200, ct: "image/jpeg" },   // the JPEG cell /lwe/encoding actually loads (was z-jl90 until zenjpeg replaced jpegli in the ladder)
  { path: "/lwe", status: 200, ct: "text/html" },
  { path: "/lwe/", status: [301, 307, 308] },   // drop-trailing-slash
  { path: "/lwe/utf8", status: 200, ct: "text/html" },
  { path: "/pixel-peeper", status: 200, ct: "text/html", marker: "compression eye exam" },
  { path: "/pixel-peeper/manifest.json", status: 200, ct: "application/json" },
  // /access is registered with every manifest flag false until its talk has
  // happened, so nothing else in the gate covers it. This is the only assertion
  // that the route resolves at all. The marker is the table the graph is a view
  // over: if that table stops shipping, the page silently becomes a blank canvas.
  { path: "/access", status: 200, ct: "text/html", marker: "Device list, flat" },
  { path: "/access.md", status: 200, ct: "text/markdown", marker: "Device list, flat" },
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
    const res = await fetch(url, {
      redirect: "manual",
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { accept: "*/*", ...(r.headers || {}) },
    });
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
    // The doctype leads the document, but build.mjs stamps a one-line banner
    // pointing at the readable .src.html twin ahead of it. That banner reached
    // /lens on 2026-07-31, when minification stopped being homepage-only; the
    // homepage had carried it for a while without tripping this, because only
    // /lens and /search assert fullPage and /search is rendered per request.
    //
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
  const routes = ROUTES.filter(r => !(r.remote && !remoteRows));
  const skipped = ROUTES.length - routes.length;
  console.log(`\nRoute oracle vs ${base}` +
    (skipped ? `  (${skipped} remote-only route(s) skipped)` : "") +
    (isLocal && remoteRows ? "  (remote bindings: production KV/R2/Browser)" : "") +
    "\n" + "=".repeat(60));
  const results = [];
  // small concurrency to be quick without hammering the edge
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
      r.okMarker === false ? `missing marker "${r.marker}"` : "",
      r.okBytes === false ? `size ${r.bytes}B > ${r.maxBytes}B (unminified? build bypassed?)` : "",
      r.okFullPage === false ? "full-page contract missing document wrapper" : "",
      r.okFragment === false ? "fragment contract returned a document wrapper" : "",
      r.error ? `err ${r.error}` : "",
    ].filter(Boolean).join(", ");
    console.log(`${tag.padEnd(5)} ${String(r.status).padEnd(4)} ${r.path}${why ? "   <- " + why : ""}`);
  }

  // The baseline is a record of a DEPLOYMENT's shape, so only a real deploy
  // produces one. A local harness run would otherwise drop an ephemeral
  // verify-baseline.127.0.0.1.json (a different port every boot) into the repo.
  let outFile = null;
  if (isProd) {
    const host = base.replace(/^https?:\/\//, "").replace(/[^a-z0-9.-]/gi, "_");
    outFile = `verify-baseline.${host}.json`;
    writeFileSync(outFile, JSON.stringify({ base, routes: results.map(({ path, status, ct }) => ({ path, status, ct })) }, null, 2) + "\n");
  }

  console.log("=".repeat(60));
  console.log(`${results.length} routes, ${hardFails} hard failure(s).` + (outFile ? ` Baseline -> ${outFile}` : ""));
  process.exit(hardFails ? 1 : 0);
}

main();
