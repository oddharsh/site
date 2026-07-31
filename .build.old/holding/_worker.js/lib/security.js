// lib/security.js — extracted from the worker (no-build reorg). Bundled by
// wrangler/Cloudflare at deploy; not served (inside _worker.js/).
// security headers applied to every worker-generated response. mirrors
// what's set on static assets via _headers — without this wrapper, the
// worker-rendered pages (/whoareyou, /around, /bot, /rn/admin, etc.)
// would skip _headers entirely and ship without CSP / Permissions-Policy.
import { PAGE_DICTIONARY } from "./shell-assets.js";
import { scriptHashesFor } from "./csp-hashes.js";
import { prefetchActivationHeader } from "../speculation.js";

// There are NO external script or connect origins here, and that is a stronger
// claim than it was. Until 2026-07-29 this policy carried two cloudflareinsights.com
// entries for the Web Analytics (RUM) beacon. Both legs now run through the worker
// (/ledger/rum.js and /ledger/rum, see rum.js), so the browser speaks only to this
// origin and the policy went back to pure 'self'.
//
// Read that carefully before treating it as a privacy win: the REPORTING did not
// stop, it moved server-side. This server makes the Cloudflare call on the visitor's
// behalf. /whoareyou and /security both say so in those words, and a CSP that
// quietly disagrees with the page describing it is the failure this repo keeps
// designing against — so if the beacon ever goes cross-origin again, those two pages
// change in the same commit.
//
// img-src is 'self' data: as of #186, and that is now the whole story:
// every image on every page comes from this origin. Spotify's two hosts sat here
// for as long as album art was hotlinked from a hover; #182 re-hosted it behind
// /rn/art/, and a cold incognito capture on 2026-07-30 measured 133 requests to
// exactly one host. An allowance nothing uses is a standing permission to
// hotlink again by accident, so it leaves with the last request that needed it.
//
// This is enforced, not just asserted: rn.js emits NO image attribute for art it
// cannot re-host, precisely so a cover this policy would block renders as the
// tooltip's text card instead of a broken frame. The two changes are one change.
//
// The remaining allowance is the two 'unsafe-inline' tokens the buildless inline
// CSS/JS design requires, and script-src is working its way off its one (see the
// hash note below). The STYLE directive keeps its token and will: inline CSS is a
// hard rule here and the style-attribute surface is far larger, so this closes
// script injection and leaves style injection open. Describe it that way on
// /security rather than claiming a strict CSP.
//
// Automatic (zone-side) beacon injection is NOT usable here, and this is the reason:
// the worker serves the homepage and the static pages as precompressed br/dcz bodies
// with `encodeBody: "manual"`, and the edge cannot rewrite HTML it did not compress.
// So the beacon is placed in source, which also keeps it visible in View Source.

// ── script-src, and why it is hashes rather than a nonce ─────────────────────
// A nonce has to be unique per response and it lives in the BODY. Build step 8
// precompresses every staged document into brotli q11 twins plus dcz deltas, served
// `encodeBody: "manual"`, and the runtime ships no brotli encoder to recompress with
// (CLAUDE.md gotcha 14). You cannot write a per-request nonce into bytes you already
// compressed at build time, so for these 43 documents a nonce would mean giving up
// precompression on the render-blocking path to buy a marginally tidier policy.
// Hashes are computed from those same final bytes and cost nothing at request time.
//
// Verified 2026-07-30 in a real browser, because it is the one thing here worth not
// guessing at: under `script-src 'sha256-…'` with no 'unsafe-inline', a HASHED
// `<script type="speculationrules">` is allowed and an unhashed one raises exactly
// one script-src-elem violation. So the 25 speculation-rules blocks need no
// 'inline-speculation-rules' keyword, just an ordinary hash. `application/json`
// (the quiz data blocks) and `application/ld+json` are data blocks: never executed,
// never CSP-checked, never hashed.
const CSP_SCRIPT_SRC_LOOSE = "'self' 'unsafe-inline'";

// The rollout flag. FALSE ships the hashed policy as report-only alongside the
// loose enforcing one, so a miss shows up in DevTools instead of blanking a page;
// TRUE promotes it to the enforcing policy and drops the report-only twin.
// Flip it only after a deploy has run report-only in production and come back
// clean, the same way `SHELL_PRECOMPRESS_DEFAULT_ON` earned its default. The
// failure mode this guards against is silent: a blocked inline script leaves the
// page rendering and merely dead.
export const ENFORCE_PAGE_HASHES = false;

// Everything after script-src, held once so the loose and hashed policies cannot
// drift apart. img-src is 'self' data: per #186 — do NOT let a rebase quietly
// restore the two spotifycdn hosts that landed here before it.
const CSP_TAIL =
  "style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'; worker-src 'self'; manifest-src 'self'; upgrade-insecure-requests";

const cspWith = (scriptSrc) => `default-src 'self'; script-src ${scriptSrc}; ${CSP_TAIL}`;

const CSP_LOOSE = cspWith(CSP_SCRIPT_SRC_LOOSE);

// 'self' stays alongside the hashes: it covers the EXTERNAL scripts (/a/nav.js,
// /tooltip.js, /hoist.js, /ledger/rum.js) and the dynamic import()s the homepage
// makes. Deliberately no 'strict-dynamic', which would make 'self' inert for
// scripts and break exactly those loads.
// An EMPTY hash list is meaningful and is the best case: a document with no inline
// script at all gets a bare `script-src 'self'`, which is the strictest this policy
// can be. Do not confuse it with "no entry", which means the build could not speak
// for this document and falls back to the loose policy.
const cspHashed = (hashes) =>
  cspWith(["'self'", ...hashes.map((h) => `'sha256-${h}'`)].join(" "));

// Returns the CSP header pair for a document. A path with no hash entry (every
// live worker-rendered page, and everything in readable local dev) gets the loose
// policy with no report-only twin, which is exactly today's behaviour.
export function cspHeadersFor(pathname) {
  const hashes = scriptHashesFor(pathname);
  if (!hashes) return { "content-security-policy": CSP_LOOSE };
  if (ENFORCE_PAGE_HASHES) return { "content-security-policy": cspHashed(hashes) };
  return {
    "content-security-policy": CSP_LOOSE,
    "content-security-policy-report-only": cspHashed(hashes),
  };
}

export const SECURITY_HEADERS = {
  "content-security-policy": CSP_LOOSE,
  // keep every token one a shipping browser still knows — an unrecognized
  // feature is inert and logs a console error. `browsing-topics` was dropped
  // 2026-07 for that reason (Topics API deprecated in Chrome 144, feature
  // removed), same fate as `interest-cohort` before it.
  "permissions-policy":
    "camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), bluetooth=(), midi=(), accelerometer=(), gyroscope=(), magnetometer=(), screen-wake-lock=(), hid=(), idle-detection=()",
  "x-frame-options":         "DENY",
  "x-content-type-options":  "nosniff",
  "referrer-policy":         "strict-origin-when-cross-origin",
};

const HOMEPAGE_DISCOVERY_LINKS = [
  '</sitemap.xml>; rel="sitemap"; type="application/xml"',
  '</llms.txt>; rel="alternate"; type="text/plain"; title="llms.txt summary"',
  '</auth.md>; rel="service-doc"; type="text/markdown"; title="Auth.md agent registration"',
  '</.well-known/oauth-protected-resource>; rel="service-desc"; type="application/json"; title="OAuth protected resource metadata"',
  '</.well-known/oauth-authorization-server>; rel="service-desc"; type="application/json"; title="OAuth authorization server metadata"',
  '</rn/tracks>; rel="service-desc"; type="application/json"; title="current rn playlist as JSON"',
  '</.well-known/http-message-signatures-directory>; rel="http-message-signatures-directory"; type="application/jwk-set+json"',
  '</.well-known/security.txt>; rel="security-policy"; type="text/plain"',
  '</.well-known/api-catalog>; rel="api-catalog"; type="application/linkset+json"',
  '</.well-known/agent-card.json>; rel="service-desc"; type="application/json"; title="Aadharsh site agent card"',
];

export const HOMEPAGE_DISCOVERY_LINK = HOMEPAGE_DISCOVERY_LINKS.join(", ");

// (HOMEPAGE_LINK and withHomepageDiscoveryHeaders lived here and composed
// SHELL_PRELOAD_LINK ahead of the discovery links. Nothing imported them once
// `/` moved to serveStaticPage + HOMEPAGE_HEADERS, and the homepage quietly
// stopped emitting any rel=preload — so it stopped getting an Early Hints 103,
// on the one page shell-assets.js says a 103 buys the most. index.js composes
// that header at the route now, where the route can be seen using it.)

// `pathname` is optional and only used to name this document in the prefetch
// activation beacon. Callers that don't have one (the /lens self-fetch, which is
// an internal scan and not a navigable document) simply omit it and get no
// beacon header, which is the correct answer for a response no browser navigates to.
export function withSecurityHeaders(response, pathname) {
  // redirects don't need (and shouldn't carry) document-level headers
  if (response.status >= 300 && response.status < 400) return response;
  // R2 photo serves don't either — they're images, the policy doesn't apply
  const ct = response.headers.get("content-type") || "";
  if (ct.startsWith("image/")) return response;

  const headers = new Headers(response.headers);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) {
    if (!headers.has(k)) headers.set(k, v);
  }
  // Per-document script-src, for the staged documents the build could hash. Only
  // HTML gets it: a CSP on a JSON or text response is inert, and spending header
  // bytes there would be pure waste on a site that counts them. Anything already
  // carrying its own policy (lens.js sets one for the framed view) is left alone.
  if (ct.startsWith("text/html")) {
    for (const [k, v] of Object.entries(cspHeadersFor(pathname))) {
      if (k === "content-security-policy" && response.headers.has(k)) continue;
      headers.set(k, v);
    }
  }
  // Tell the browser where to report that a speculated copy of THIS document
  // was actually used for a navigation. See speculation.js for why the server
  // has to be the one counting, and for the origin-trial caveat that keeps this
  // header inert (and harmless: an unknown response header is ignored) until
  // Chrome enables the feature for this origin.
  if (pathname && ct.startsWith("text/html") && !headers.has("on-prefetch-activation")) {
    headers.set("on-prefetch-activation", prefetchActivationHeader(pathname));
  }
  // Every HTML surface—static, deterministically rendered, or live—teaches the
  // browser the same immutable page dictionary. Static/deterministic routes can
  // use it immediately on the next navigation; live pages still seed it for
  // their links without paying a blocking fetch (the relation is idle-loaded).
  if (PAGE_DICTIONARY && ct.startsWith("text/html")) {
    const dictionaryLink = `<${PAGE_DICTIONARY}>; rel="compression-dictionary"`;
    const current = headers.get("link");
    if (!current?.includes('rel="compression-dictionary"')) {
      headers.set("link", current ? `${current}, ${dictionaryLink}` : dictionaryLink);
    }
  }
  return new Response(response.body, {
    status:     response.status,
    statusText: response.statusText,
    headers,
    // `encodeBody` is write-only Response init, so rebuilding a response SILENTLY
    // drops it, and the runtime then compresses the body a second time to match the
    // content-encoding header it can still see. Because every worker response passes
    // through here, that made `encodeBody: "manual"` a no-op site-wide, which is what
    // produced brotli-in-brotli on both /a/ canaries AND on a worker-built body with
    // no asset fetch at all (34 bytes for a 30-byte payload, control arm identical).
    //
    // A content-encoding header means the body is ALREADY encoded, so carrying the
    // flag forward is the correct reading in every case: the alternative is a
    // double-encoded body no client can read. Responses with no content-encoding are
    // unaffected, which is nearly all of them.
    ...(response.headers.has("content-encoding") ? { encodeBody: "manual" } : {}),
  });
}


