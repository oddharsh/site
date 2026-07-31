// lib/security.js — extracted from the worker (no-build reorg). Bundled by
// wrangler/Cloudflare at deploy; not served (inside _worker.js/).
// security headers applied to every worker-generated response. mirrors
// what's set on static assets via _headers — without this wrapper, the
// worker-rendered pages (/whoareyou, /around, /bot, /rn/admin, etc.)
// would skip _headers entirely and ship without CSP / Permissions-Policy.
import { PAGE_DICTIONARY } from "./shell-assets.js";
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
// The remaining allowances are img-src for Spotify album/artist art and the two
// 'unsafe-inline' tokens the buildless inline CSS/JS design requires.
//
// Automatic (zone-side) beacon injection is NOT usable here, and this is the reason:
// the worker serves the homepage and the static pages as precompressed br/dcz bodies
// with `encodeBody: "manual"`, and the edge cannot rewrite HTML it did not compress.
// So the beacon is placed in source, which also keeps it visible in View Source.
export const SECURITY_HEADERS = {
  "content-security-policy":
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://i.scdn.co https://*.spotifycdn.com; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'; worker-src 'self'; manifest-src 'self'; upgrade-insecure-requests",
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


