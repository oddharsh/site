// lib/const.ts — shared constants for the worker.

export const CANONICAL_HOST = "aadhar.sh";

export function isCanonicalHost(hostname) {
  return String(hostname || "").toLowerCase() === CANONICAL_HOST;
}

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
//                   full policy table is in lib/assets.js.
//
// It must also survive canRegisterAsDictionary (lib/assets.ts): no-store and no-cache
// each veto dictionary registration outright, which is what kept `/` out of the
// per-page tier while it carried `private, no-cache, must-revalidate`. must-revalidate
// is the quieter trap here: it cancels the swr window, and with max-age=0 that leaves
// the dictionary no lifetime at all.
export const PAGE_CACHE_CONTROL = "public, max-age=0, s-maxage=86400, stale-while-revalidate=604800";
