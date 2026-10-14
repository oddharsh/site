import { PAGE_DICTIONARY, SPECULATION_RULES } from "./shell-assets.ts";
import { scriptHashesFor } from "./csp-hashes.ts";
import { CSP_LOOSE, cspHashed } from "./csp-policy.ts";
import { prefetchActivationHeader } from "../speculation.ts";
import { PREVIEW_ROBOTS } from "./preview.ts";

// A nonce has to be unique per response and it lives in the BODY. Build step 8
// precompresses every staged document into brotli q11 twins plus dcz deltas, served
// `encodeBody: "manual"`, and the runtime ships no brotli encoder to recompress with
// (docs/GOTCHAS.md gotcha 14). You cannot write a per-request nonce into bytes you already
// compressed at build time, so for these 43 documents a nonce would mean giving up
// precompression on the render-blocking path to buy a marginally tidier policy.
// Hashes are computed from those same final bytes and cost nothing at request time.

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
  '</rn/tracks>; rel="service-desc"; type="application/json"; title="current rn playlist as JSON"',
  '</.well-known/http-message-signatures-directory>; rel="http-message-signatures-directory"; type="application/http-message-signatures-directory+json"',
  '</.well-known/security.txt>; rel="security-policy"; type="text/plain"',
  '</.well-known/api-catalog>; rel="api-catalog"; type="application/linkset+json"',
  '</.well-known/mcp/server-card.json>; rel="service-desc"; type="application/json"; title="Aadharsh site MCP server card"',
  '</.well-known/agent-card.json>; rel="service-desc"; type="application/json"; title="Aadharsh site agent card"',
  '</.well-known/ard.json>; rel="ard"; type="application/json"; title="ARD manifest"',
  '</webmention>; rel="webmention"',
];

export const HOMEPAGE_DISCOVERY_LINK = HOMEPAGE_DISCOVERY_LINKS.join(", ");

export function withSecurityHeaders(response, pathname?, opts?) {
  const noindex = !!(opts && opts.noindex);

  if (noindex && !response.headers.has("x-robots-tag")) {
    const h = new Headers(response.headers);
    h.set("x-robots-tag", PREVIEW_ROBOTS);
    const init: ResponseInit = { status: response.status, statusText: response.statusText, headers: h };
    if (response.headers.has("content-encoding")) init.encodeBody = "manual";
    response = new Response(response.body, init);
  }

  if (response.status >= 300 && response.status < 400) return response;
  const ct = response.headers.get("content-type") || "";
  if (ct.startsWith("image/")) return response;

  const headers = new Headers(response.headers);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) {
    if (!headers.has(k)) headers.set(k, v);
  }
  if (ct.startsWith("text/html")) {
    const stamped = headers.get("content-security-policy");
    const bespoke = stamped !== null && stamped !== CSP_LOOSE;
    if (!bespoke) headers.set("content-security-policy", cspHeadersFor(pathname)["content-security-policy"]);
  }
  if (pathname && ct.startsWith("text/html") && !headers.has("on-prefetch-activation")) {
    headers.set("on-prefetch-activation", prefetchActivationHeader(pathname));
  }
  if (SPECULATION_RULES && ct.startsWith("text/html") && !headers.has("speculation-rules")) {
    headers.set("speculation-rules", `"${SPECULATION_RULES}"`);
  }
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
  if (response.headers.has("content-encoding")) init.encodeBody = "manual";
  return new Response(response.body, init);
}
