// lib/const.ts — shared constants for the worker.

// The one hostname the public site is published at. dispatch.ts 301s any
// `*.pages.dev` request (the retired Pages project's names) to the same path here.
export const CANONICAL_HOST = "aadhar.sh";

// Is this request on the one hostname the public site is published at?
//
// Three other hostnames reach this Worker, and none of them may be treated as
// the canonical site: `cal.aadhar.sh` (a declared zone route, which 404s every
// path but /coffee* by design), any `*.workers.dev` version preview, and the
// retired `*.pages.dev` names dispatch.ts 301s away. Two things key off this:
// responses off the canonical host are noindexed, and they are kept out of the
// Workers Cache entrypoint, whose key cannot see the Host at all.
//
// Exact match, deliberately. `www.aadhar.sh` is redirected at the zone and never
// arrives here; if it ever did, noindexing its 301 costs nothing, while treating
// a near-match as canonical is how a duplicate hostname gets published.
export function isCanonicalHost(hostname) {
  return String(hostname || "").toLowerCase() === CANONICAL_HOST;
}

// /images/full/<stem> originals are served from R2 under STABLE, non-content-
// addressed URLs (the SOOC filename names a slot, not its bytes) and cached hard
// on the convention that an original is never overwritten in place. When that
// convention is broken deliberately (the 2026-07 bulk re-encode of every HIF
// archive from sips 4:2:0 to zenc q100 4:2:2), Cloudflare's cache purge does NOT
// evict the worker's per-colo caches.default entries: they ride the 1-year
// immutable TTL. Folding this token into the Cache API KEY (never the public URL)
// orphans the stale entries so the next read falls through to fresh R2 bytes.
// Bump on any in-place overwrite of existing /images/full objects, then Purge
// Everything once to clear the CDN tier. Public URLs stay clean; this token never
// appears in a served path (photos.ts folds it into the key).
//
// 3 (2026-09-27): 208 archives rewritten losslessly by `jpegtran -progressive`,
// same coefficients and metadata, new scan order: all 207 HIF re-encodes (53 of
// which sent all of luma before any chroma, so Chromium painted nothing until
// 66-99% of the file) and XT508887, the camera's own baseline JPEG.
// /garage/encoding.
export const ARCHIVE_VERSION = 3;

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
//                   full policy table is in lib/assets.ts.
//
// It must also survive canRegisterAsDictionary (lib/assets.ts): no-store and no-cache
// each veto dictionary registration outright, which is what kept `/` out of the
// per-page tier while it carried `private, no-cache, must-revalidate`. must-revalidate
// is the quieter trap here: it cancels the swr window, and with max-age=0 that leaves
// the dictionary no lifetime at all.
//
// Lives here so every module that serves one of these documents (index.ts,
// inbox.ts, reading.ts) ships the identical string, HEAD answers included. A HEAD
// advertising a different freshness contract than the GET it stands in for is a
// lie a cache is entitled to act on.
export const PAGE_CACHE_CONTROL = "public, max-age=0, s-maxage=86400, stale-while-revalidate=604800";
