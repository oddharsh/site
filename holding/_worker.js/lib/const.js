// lib/const.js — shared constants for the worker.
//
// First extracted module of the no-build reorg: proves wrangler/Cloudflare
// bundle the _worker.js/ directory's relative imports at deploy time, with no
// build step of our own. More constants (THUMB_SMALL_PX, BOT_UA, NEIGHBORS,
// CANONICAL_HOST, ...) move here in the Phase 3 lib extraction.

// the ?v=N appended to every thumbnail URL in pre-rendered HTML. bump on a full
// thumbnail re-encode or to route around edge 404 poisoning.
export const THUMB_VERSION = 19;
