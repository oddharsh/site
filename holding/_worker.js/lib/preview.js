// lib/preview.js — the guard that makes a Workers preview URL safe to hand out.
//
// Preview URLs are how a branch gets a real, servable address before it is
// production (`preview_urls: true` in wrangler.jsonc). The thing to understand
// about them, because it is not obvious and it is the whole reason this file
// exists: a preview version runs the SAME BINDINGS AND SECRETS as production.
// Not a copy, not a staging tier. The same RN_KV, the same BOOKINGS namespace,
// the same aadhar-photos bucket, the same three D1 databases, the same
// RESEND_API_KEY. Cloudflare offers no per-version binding override.
//
// So an unguarded preview URL is a live write path into production data that
// happens to live at a URL nobody audits, and the site's own release discipline
// (GitHub cannot hold a token that writes; infra:apply refuses to run in CI)
// would be undone by a link pasted into a PR comment. Two mitigations, both here:
//
//   1. noindex. A preview is a byte-identical duplicate of aadhar.sh on a
//      different host. Left indexable it competes with the canonical site for
//      the same queries, which is the opposite of what every rel=canonical tag,
//      the sitemap, and nav.js's slashless normalization are for.
//   2. Deny writes. Default-deny on unsafe METHODS rather than an enumerated
//      path list, because a list is a thing you forget to update: the next POST
//      route somebody adds is blocked on previews the day it is written, with
//      no edit here. The two explicit lists below are the exceptions the method
//      rule cannot express in either direction.
//
// What this deliberately does NOT do: gate reads. A preview whose pages you
// cannot read is not a preview. Every GET page, every JSON feed, and both /lens
// scan endpoints answer normally, which is the entire point of the surface.
//
// Crons need no guard. A scheduled event fires against the ACTIVE DEPLOYMENT
// only, so a version that has never been deployed never runs the /around crawl,
// the census sweep, or the webmention pass, whatever this file says.

// Preview and *.workers.dev URLs share a suffix, and production deliberately has
// no workers.dev URL at all (`workers_dev: false`), so the suffix alone is an
// exact test for "not the canonical host". Checked on hostname, never on the Host
// header directly, because a spoofed Host must not be able to turn the guard OFF.
export function isPreviewHost(hostname) {
  return typeof hostname === "string" && hostname.toLowerCase().endsWith(".workers.dev");
}

// Sent on every preview response. `nofollow` as well as `noindex` because the
// preview's own internal links are all same-host, and a crawler that followed
// them would discover the whole duplicate tree from one leaked URL.
export const PREVIEW_ROBOTS = "noindex, nofollow";

// POST routes that provably mutate NOTHING, and so survive the method rule.
// /mcp is JSON-RPC over POST whose only side effect is reading this same origin
// back through an allowlist (MCP_RESOURCE_PATHS in mcp.js). The bar for adding
// to this set is that the handler writes no binding and sends no message.
const SAFE_UNSAFE_METHODS = new Set(["/mcp"]);

// The other direction: GET-shaped mutations, which the method rule cannot catch.
// Each of these changes durable state or sends something, from a plain GET.
//   /hit                  ticks the visit-counter Durable Object
//   /approve, /decline    confirm or refuse a real coffee booking, and email a
//                         real person about it (HMAC-signed links, but the
//                         signature is made with the production SIGNING_SECRET,
//                         which a preview also holds)
//   /webmention/*         the same construction for webmention moderation
//   /ledger/prefetch      writes the speculation ledger's numerator, so preview
//                         traffic would land in a series about the real site
const UNSAFE_READS = new Set([
  "/hit",
  "/approve",
  "/decline",
  "/webmention/approve",
  "/webmention/decline",
  "/ledger/prefetch",
]);

// Returns a 403 to serve, or null to let the request through. Pure over
// (pathname, method) so the contract tests can sweep the whole route table
// against it without booting a worker.
export function previewDenial(pathname, method) {
  const m = (method || "GET").toUpperCase();
  const safeMethod = m === "GET" || m === "HEAD";

  if (!safeMethod && !SAFE_UNSAFE_METHODS.has(pathname)) {
    return denial(`${m} is disabled on preview URLs.`);
  }
  if (safeMethod && UNSAFE_READS.has(pathname)) {
    return denial(`${pathname} writes production state and is disabled on preview URLs.`);
  }
  return null;
}

function denial(reason) {
  return new Response(
    `${reason}\n\n` +
    "This is a Workers preview build of aadhar.sh. It runs against production\n" +
    "bindings and secrets, so writes are refused here. Read-only routes work.\n",
    {
      status: 403,
      headers: {
        "content-type":  "text/plain; charset=utf-8",
        "cache-control": "no-store",
        "x-robots-tag":  PREVIEW_ROBOTS,
      },
    },
  );
}
