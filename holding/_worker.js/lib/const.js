// lib/const.js — shared constants for the worker.
//
// First extracted module of the no-build reorg: proves wrangler/Cloudflare
// bundle the _worker.js/ directory's relative imports at deploy time, with no
// build step of our own.
//
// (THUMB_VERSION lived here until the content-hash migration finished: every
// thumbnail is now a /i/<stem>.<hash8> URL that names its own bytes, so the
// global ?v= bump ritual retired with the last legacy fallback.)

// canonical-host enforcement: any request that lands on the project's
// auto-generated pages.dev subdomain (aadhar-sh.pages.dev or any deploy-
// hash variant like 60bcf749.aadhar-sh.pages.dev) gets 301'd to the
// equivalent path on aadhar.sh. eliminates the duplicate public footprint
// while preserving the ability to deploy + serve as a Cloudflare Worker.
export const CANONICAL_HOST = "aadhar.sh";

// /images/full/<stem> originals are served from R2 under STABLE, non-content-
// addressed URLs (the SOOC filename names a slot, not its bytes) and cached hard
// on the convention that an original is never overwritten in place. When that
// convention is broken deliberately (the 2026-07 bulk re-encode of every HIF
// archive from sips 4:2:0 to zenc q100 4:2:2), Cloudflare's cache purge does NOT
// evict the worker's per-colo caches.default entries — they ride the 1-year
// immutable TTL. Folding this token into the Cache API KEY (never the public URL)
// orphans the stale entries so the next read falls through to fresh R2 bytes.
// Bump on any in-place overwrite of existing /images/full objects, then Purge
// Everything once to clear the CDN tier. Public URLs stay clean; this token never
// appears in a served path. (Same idea as the retired THUMB_VERSION, scoped to the
// non-content-addressed originals instead of the now-hashed thumbnails.)
export const ARCHIVE_VERSION = 2;
