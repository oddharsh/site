// rum.js — Cloudflare Web Analytics, served from this origin instead of theirs.
//
// WHAT THIS IS, plainly: the beacon still reports to Cloudflare. The only thing
// that changed is which host the BROWSER talks to. Both legs now run through the
// worker, so the visitor's browser makes two same-origin requests and this server
// makes the third-party call on their behalf. That is a real difference in who
// knows what, and it is stated in /whoareyou and /security rather than left for a
// reader to discover in a network panel.
//
// WHY, measured 2026-07-29: `static.cloudflareinsights.com` is on EasyPrivacy, so
// every visitor running a content blocker dropped out of the sample entirely — the
// script never loaded and nothing reported. That is not merely a smaller sample. The
// one thing this beacon uniquely buys is Navigation Type (Back-forward vs Back-forward
// Cache, Navigate vs Prerender), which is what turns the bfcache-preserving `no-cache`
// choice and the hand-tuned speculation rules into measurements instead of assertions.
// The visitors most likely to block are also the ones most likely to be on the engines
// where those two behave differently, so the sample was thinned exactly where the
// measurement lives.
//
// Second, smaller win: `static.cloudflareinsights.com` does NOT serve brotli. An
// `accept-encoding: br` request comes back gzip, so 11,364 B was the best a browser
// could get for a 31,612 B file. Proxied, the worker hands the edge identity bytes and
// the edge compresses with everything this zone already serves.
//
// HONEST LIMITS, both worth checking after this ships rather than assuming:
//   1. GEO. The collector sees this worker's request, not the visitor's, so
//      country/region attribution may collapse to wherever the subrequest egresses.
//      `cf-connecting-ip` is forwarded below, but whether the collector honours a
//      worker-supplied value is UNVERIFIED. If the country breakdown in the dashboard
//      goes flat after this deploys, that is this, and the honest fix is to say so on
//      /whoareyou rather than to pretend the dimension still works.
//   2. BLOCKING. A first-party path defeats a host-based rule, which is what
//      EasyPrivacy uses here. It does not defeat a path rule, and these paths are
//      named honestly (`/ledger/rum*`) rather than disguised. If a blocker starts
//      catching them on the name, that blocker is doing its job on a path this site
//      labelled truthfully, and this repo does not play whack-a-mole with it.
//
// The paths live under /ledger because that is already where this site keeps the
// "what did the machines do here" surface.
import { span } from "./lib/trace.js";

const BEACON_SRC = "https://static.cloudflareinsights.com/beacon.min.js";
const COLLECTOR = "https://cloudflareinsights.com/cdn-cgi/rum";

// The upstream ships `public, max-age=86400` with a version ETag (W/"2026.6.0").
// Browsers keep that, so a returning visitor is no more chatty than before. The
// worker's own copy expires sooner so a Cloudflare beacon update reaches new
// visitors within the hour instead of within the day.
const BROWSER_TTL = 86400;
const EDGE_TTL = 3600;

// GET /ledger/rum.js — the beacon script.
//
// The body is read as an ArrayBuffer on purpose: the runtime decompresses the
// upstream gzip and drops its content-encoding when the body is consumed, so what
// leaves here is identity and the edge is free to brotli it. Copying the upstream
// content-encoding header instead would ship gzip bytes labelled gzip and forfeit
// the entire compression half of this change. See CLAUDE.md gotcha 13 for the
// adjacent trap (a rebuilt Response silently drops `encodeBody`); this handler
// never sets one, so it is not exposed to that.
export async function handleRumScript(request, env, ctx) {
  const cache = caches.default;
  const cacheKey = new Request(new URL("/ledger/rum.js", request.url).toString(), { method: "GET" });
  const hit = await cache.match(cacheKey);
  if (hit) return hit;

  return span("rum.script", async (s) => {
    let upstream;
    try {
      upstream = await fetch(BEACON_SRC, { cf: { cacheTtl: EDGE_TTL, cacheEverything: true } });
    } catch {
      upstream = null;
    }
    if (!upstream || !upstream.ok) {
      s.setAttribute("rum.script.served", false);
      // Honest failure, uncached: the homepage loses its beacon for this visit and
      // the next request tries again. Serving a stub would hide an outage in the
      // one system whose job is telling us when something is wrong.
      return new Response("", {
        status: 502,
        headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" },
      });
    }
    const body = await upstream.arrayBuffer();
    s.setAttribute("rum.script.served", true);
    s.setAttribute("rum.script.bytes", body.byteLength);
    s.setAttribute("rum.script.version", upstream.headers.get("etag") || "");

    const res = new Response(body, {
      status: 200,
      headers: {
        "content-type": "text/javascript; charset=utf-8",
        "cache-control": `public, max-age=${BROWSER_TTL}`,
        "x-content-type-options": "nosniff",
        // Carried through so a beacon update is visible in a response header
        // without diffing 31KB of minified JavaScript.
        "x-rum-upstream-version": upstream.headers.get("etag") || "unknown",
      },
    });
    ctx?.waitUntil?.(cache.put(cacheKey, res.clone()));
    return res;
  });
}

// POST /ledger/rum — the report leg.
//
// The beacon picks this up from `send.to` in its data-cf-beacon config; the
// endpoint is otherwise hardcoded to COLLECTOR. Verified in a live browser on
// 2026-07-29: with `send: {to: "/ledger/rum"}` the beacon posts same-origin by
// both routes it uses (an XHR and a navigator.sendBeacon on visibility change).
//
// Pointing `send.to` at this zone's own /cdn-cgi/rum does NOT work and was tried
// first: /cdn-cgi/* is handled at the edge before any Worker sees it, and the zone
// does not host the collector, so both beacon posts came back 404.
export async function handleRumCollect(request, env, ctx) {
  if (request.method !== "POST") {
    return new Response("", { status: 405, headers: { allow: "POST", "cache-control": "no-store" } });
  }
  return span("rum.collect", async (s) => {
    const body = await request.arrayBuffer();
    s.setAttribute("rum.collect.bytes", body.byteLength);

    const headers = new Headers();
    const ct = request.headers.get("content-type");
    if (ct) headers.set("content-type", ct);
    // Best-effort visitor attribution. See HONEST LIMITS (1) above: whether the
    // collector honours this from a worker subrequest is unverified, and the geo
    // dimension is the thing that degrades if it does not.
    const ip = request.headers.get("cf-connecting-ip");
    if (ip) headers.set("cf-connecting-ip", ip);
    const ref = request.headers.get("referer");
    if (ref) headers.set("referer", ref);
    const ua = request.headers.get("user-agent");
    if (ua) headers.set("user-agent", ua);

    let status = 502;
    try {
      const upstream = await fetch(COLLECTOR, { method: "POST", headers, body });
      status = upstream.status;
    } catch {
      status = 502;
    }
    s.setAttribute("rum.collect.upstream_status", status);
    // The upstream status is passed through UNTRANSLATED, and that is deliberate.
    // Collapsing everything non-throwing to 204 would make a forwarder that
    // Cloudflare is rejecting — a bad token, a payload shape change, a moved
    // endpoint — look perfectly healthy from both the network panel and the logs.
    // This system's whole job is telling us when something is wrong, so it does not
    // get to lie about itself. The beacon ignores the response either way, so an
    // honest status costs the visitor nothing.
    return new Response("", { status, headers: { "cache-control": "no-store" } });
  });
}
