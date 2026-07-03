// lib/const.js — shared constants for the worker.
//
// First extracted module of the no-build reorg: proves wrangler/Cloudflare
// bundle the _worker.js/ directory's relative imports at deploy time, with no
// build step of our own. More constants (THUMB_SMALL_PX, BOT_UA, NEIGHBORS,
// CANONICAL_HOST, ...) move here in the Phase 3 lib extraction.

// the ?v=N appended to every thumbnail URL in pre-rendered HTML. bump on a full
// thumbnail re-encode or to route around edge 404 poisoning.
export const THUMB_VERSION = 19;

// canonical-host enforcement: any request that lands on the project's
// auto-generated pages.dev subdomain (aadhar-sh.pages.dev or any deploy-
// hash variant like 60bcf749.aadhar-sh.pages.dev) gets 301'd to the
// equivalent path on aadhar.sh. eliminates the duplicate public footprint
// while preserving the ability to deploy + serve as a Cloudflare Worker.
export const CANONICAL_HOST = "aadhar.sh";
