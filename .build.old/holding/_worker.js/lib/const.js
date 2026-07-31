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

// The freshness contract every deploy-time HTML document ships, `/` included as of
// 2026-07-31. Each clause is load-bearing and none of them is a default:
//
//   public          a shared cache may hold it. These documents are byte-identical
//                   for every visitor; the per-visit parts are separate no-store
//                   fragments. This is what lets a Workers Cache hit answer without
//                   invoking the worker at all.
//   max-age=0       the BROWSER revalidates on every navigation, so a visitor never
//                   paints stale bytes without asking, and the ETag answers 304.
//   s-maxage=86400  the shared-cache window. A deploy purges the edge, so the real
//                   staleness bound is the next deploy rather than this number.
//   swr=604800      RFC 5861's permission to serve stale, and the reason this is not
//                   shorter: Chromium sizes a REGISTERED DICTIONARY's lifetime from
//                   exactly this window, so trimming it silently shortens how long
//                   the per-page dcz tier keeps working. Measured 2026-07-29; the
//                   full policy table is in lib/assets.js.
//
// It must also survive canRegisterAsDictionary (same file): no-store, no-cache, and
// must-revalidate each veto dictionary registration outright, which is what kept `/`
// out of the per-page tier while it carried `private, no-cache, must-revalidate`.
//
// Lives here rather than in index.js because home.js's HEAD path has to ship the
// identical string. A HEAD advertising a different freshness contract than the GET
// it stands in for is a lie a cache is entitled to act on.
export const PAGE_CACHE_CONTROL = "public, max-age=0, s-maxage=86400, stale-while-revalidate=604800";
