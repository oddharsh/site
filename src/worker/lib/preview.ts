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
import { asText } from "./parse.ts";

export function isPreviewHost(hostname) {
  return asText(hostname, "").toLowerCase().endsWith(".workers.dev");
}

// Sent on every preview response. `nofollow` as well as `noindex` because the
// preview's own internal links are all same-host, and a crawler that followed
// them would discover the whole duplicate tree from one leaked URL.
export const PREVIEW_ROBOTS = "noindex, nofollow";

// POST routes that survive the method rule. /mcp is the only one, and it is
// here because refusing it outright would make the MCP server the one surface a
// preview cannot exercise, which is a surface worth reviewing before it ships.
//
// It is NOT here because nothing behind it writes. That WAS the bar, in this
// comment, until the representation vault landed: `representation_capture` and
// `representation_compare` each INSERT a D1 row, so for as long as the old text
// stood, any POST to a preview's /mcp could write the production vault with no
// signature and no secret. The endpoint is admitted and the WRITING TOOLS are
// refused one layer down, by previewToolRefusal() below.
const SAFE_UNSAFE_METHODS = new Set(["/mcp"]);

// The other direction: GET-shaped mutations, which the method rule cannot catch.
// Each of these changes durable state or sends something, from a plain GET.
//   /hit                  ticks the visit-counter Durable Object
//   /coffee/approve,      confirm or refuse a real coffee booking, and email a
//   /coffee/decline       real person about it (HMAC-signed links, but the
//                         signature is made with the production SIGNING_SECRET,
//                         which a preview also holds)
//   /webmention/*         the same construction for webmention moderation
//   /ledger/prefetch      writes the speculation ledger's numerator, so preview
//                         traffic would land in a series about the real site
//
// Every entry has to be a pathname the dispatcher really routes, because a stale
// one reads as protection while protecting nothing. The coffee pair spent its
// whole life here as bare /approve and /decline, which were the retired
// cal.aadhar.sh spellings; the live routes arrive under the /coffee prefix
// (index.js hands /coffee/* to cal, which strips it before matching), so the
// guard was open on exactly the two routes that email a real person. A contract
// test now pins each entry against both route tables.
const UNSAFE_READS = new Set([
  "/hit",
  "/coffee/approve",
  "/coffee/decline",
  "/webmention/approve",
  "/webmention/decline",
  "/ledger/prefetch",
]);

// The entries, for the contract test that pins them against the route tables.
export const PREVIEW_GET_WRITES = UNSAFE_READS;

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

// The tool-level half of the /mcp exception above. Returns the refusal text to
// hand back as an isError result, or null to let the call run.
//
// The predicate is the tool's OWN `readOnlyHint: false` annotation rather than a
// second list of names here, and that is the whole point: this repo's convention
// is that a tool which writes declares so on its definition, beside the code that
// makes it untrue (lib/mcp-tools.js says why). Deriving the guard from that
// declaration means the next writing tool is refused on previews the day it is
// written, which is the same argument default-deny wins on the method rule. A
// hand-kept name list here would rot exactly the way the coffee pair above did.
//
// Both MCP servers on this origin call it, so the guard is already in place if
// Serendipity ever grows a tool that writes.
export function previewToolRefusal(request, tools, name) {
  let hostname = "";
  try { hostname = new URL(request.url).hostname; } catch { return null; }
  if (!isPreviewHost(hostname)) return null;

  // An unknown name falls through to the dispatcher's own -32602, which is a
  // better answer than a refusal implying the tool exists.
  const tool = (tools || []).find((t) => t && t.name === name);
  if (!tool || tool.annotations?.readOnlyHint !== false) return null;

  return `${name} writes production state and is disabled on preview URLs. ` +
    "This is a Workers preview build of aadhar.sh, running against production " +
    "bindings and secrets. Read-only tools work.";
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
