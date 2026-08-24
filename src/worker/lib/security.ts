// lib/security.js — extracted from the worker (no-build reorg). Bundled by
// wrangler/Cloudflare at deploy; not served (inside _worker.js/).
// security headers applied to every worker-generated response. mirrors
// what's set on static assets via _headers — without this wrapper, the
// worker-rendered pages (/whoareyou, /around, /bot, /rn/admin, etc.)
// would skip _headers entirely and ship without CSP / Permissions-Policy.
import { PAGE_DICTIONARY } from "./shell-assets.ts";
import { scriptHashesFor } from "./csp-hashes.ts";
import { prefetchActivationHeader } from "../speculation.ts";
import { PREVIEW_ROBOTS } from "./preview.ts";

// There are NO external script or connect origins here. Browser-facing resources
// and connections are self-only; server-side route handlers document their own
// outbound calls separately.
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

// The hashed policy is ENFORCED, and there is no report-only twin.
//
// It shipped behind an ENFORCE_PAGE_HASHES rollout flag, pinned TRUE from
// 2026-08-16 and deleted 2026-08-23, so for a week the false arm was dead code
// that still cost a second header name, a second tail constant, and a `tail`
// parameter threaded through both policy builders to feed it. The rollout story
// is worth keeping and is not worth keeping HERE: what the DevTools sweep found
// on /garage/horizon, and why the enforcing half had never actually been applied
// to a single document, are gotcha 17 in CLAUDE.md. Rolling back is `git revert`
// rather than a flag, which is the honest cost given nothing flipped it in
// either direction after the day it went true.

// Everything after script-src, held once so the loose and hashed policies cannot
// drift apart. img-src is 'self' data: per #186 — do NOT let a rebase quietly
// restore the two spotifycdn hosts that landed here before it.
//
// `upgrade-insecure-requests` sits at the END, and that position used to matter:
// it is a NAVIGATION directive, so a browser ignores it in a report-only policy
// and Chrome logged a security issue on every page load until #249 built the
// twin without it (DevTools → Security violations, 2026-08-07). #249 COMPOSED
// the short tail rather than subtracting the directive with an end-anchored
// replace, because appending one more directive would have made that replace
// match nothing and silently hand the twin its directive back. With the twin
// gone there is nothing to subtract and one constant says it all. Keep the
// general rule: a directive the spec ignores in report-only (`sandbox` is the
// other) belongs in the enforcing policy alone, never behind a suppression.
const CSP_TAIL =
  "style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'; worker-src 'self'; manifest-src 'self'; upgrade-insecure-requests";

const cspWith = (scriptSrc) =>
  `default-src 'self'; script-src ${scriptSrc}; ${CSP_TAIL}`;

const CSP_LOOSE = cspWith(CSP_SCRIPT_SRC_LOOSE);

// 'self' stays alongside the hashes: it covers the EXTERNAL scripts (/a/nav.js,
// /tooltip.js, /hoist.js) and the dynamic import()s the homepage
// makes. Deliberately no 'strict-dynamic', which would make 'self' inert for
// scripts and break exactly those loads.
// An EMPTY hash list is meaningful and is the best case: a document with no inline
// script at all gets a bare `script-src 'self'`, which is the strictest this policy
// can be. Do not confuse it with "no entry", which means the build could not speak
// for this document and falls back to the loose policy.
const cspHashed = (hashes) =>
  cspWith(["'self'", ...hashes.map((h) => `'sha256-${h}'`)].join(" "));

// Returns the CSP header for a document, ALWAYS exactly one. A path with no hash
// entry (every live worker-rendered page, and everything in readable local dev)
// gets the loose policy. An EMPTY hash list is not that, and is the best case: a
// document with no inline script at all earns a bare `script-src 'self'`, the
// strictest this policy can be.
export function cspHeadersFor(pathname) {
  const hashes = scriptHashesFor(pathname);
  return { "content-security-policy": hashes ? cspHashed(hashes) : CSP_LOOSE };
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
  '</.well-known/mcp/server-card.json>; rel="service-desc"; type="application/json"; title="Aadharsh site MCP server card"',
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
// `opts.noindex` marks the whole response as unindexable. Set by the dispatcher
// for Workers preview URLs, which serve a byte-identical copy of the site from a
// *.workers.dev host (lib/preview.js explains why that must never be indexed).
// pathname and opts are OPTIONAL, which describes what the body already did
// rather than loosening anything: opts is read as `opts && opts.noindex`, and an
// absent pathname falls through cspHeadersFor to CSP_LOOSE and skips the
// prefetch-activation header. index.ts's self-fetch wrapper has always called it
// with the response alone.
export function withSecurityHeaders(response, pathname?, opts?) {
  const noindex = !!(opts && opts.noindex);

  // The two early returns below skip document headers, which is right for a
  // redirect and an image but WRONG for noindex: a 301 chain and an R2 photo are
  // both indexable on their own, so a preview that only marked its HTML would
  // still leak a duplicate image corpus and a set of redirect targets. Handle it
  // before the bails, and rebuild carrying encodeBody for the same reason the
  // main path does (a dropped flag is a double-encoded body).
  if (noindex && !response.headers.has("x-robots-tag")) {
    const h = new Headers(response.headers);
    h.set("x-robots-tag", PREVIEW_ROBOTS);
    const init: ResponseInit = { status: response.status, statusText: response.statusText, headers: h };
    if (response.headers.has("content-encoding")) init.encodeBody = "manual";
    response = new Response(response.body, init);
  }

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
    // A route that composed its OWN policy keeps it (lens.js does, for the framed
    // view). The generic stamp is not that. Every staged document arrives from the
    // ASSETS binding with `_headers`' copy of CSP_LOOSE already on it, so a bare
    // `.has()` bail treats the asset layer's default as a deliberate choice and
    // skips the hashed policy for exactly the 48 documents the hashes were built
    // for. That is invisible: the loose policy still ships, the page still works,
    // and nothing reports. It hid here through the whole report-only era because
    // the twin lands on a DIFFERENT header name, so the reporting half looked
    // perfect while the enforcing half was never applied at all. Compare against
    // the known stamp instead, which distinguishes "no opinion" from "an opinion".
    // A plain set rather than a loop over the returned entries. That loop existed
    // to carry a second header (the report-only twin) past this bail, and
    // cspHeadersFor has returned exactly one header since the rollout flag went.
    const stamped = headers.get("content-security-policy");
    const bespoke = stamped !== null && stamped !== CSP_LOOSE;
    if (!bespoke) headers.set("content-security-policy", cspHeadersFor(pathname)["content-security-policy"]);
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
  const init: ResponseInit = { status: response.status, statusText: response.statusText, headers };
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
  if (response.headers.has("content-encoding")) init.encodeBody = "manual";
  return new Response(response.body, init);
}
