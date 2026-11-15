// photos.ts: everything photo-shaped the Worker serves. Originals out of R2 at
// /images/full, the curated and album pools, /photos and the album pages,
// /photos/query.json, and the image manifest and sitemap.

import { cachedRender, shouldUseWorkersCache } from "./lib/cache.ts";
import { PHOTO_QUERY_LIMITS, clampParam } from "./lib/api-limits.ts";
import { EMPTY, html, joinHtml, unsafeHtml, type Html } from "./lib/html.ts";
import { asScalarText } from "./lib/parse.ts";
import { lunaPage } from "./lib/chrome.ts";
import { ARCHIVE_VERSION } from "./lib/const.ts";
import { errorResp, esc, publicJsonResponse } from "./lib/http.ts";
import { compareCodepoints, queryTerms } from "./lib/text.ts";
import { buildPhotoSearchIndex, decodePhotoSearchIndex, rankPhotoRows, rowsOf, type PhotoSearchIndex } from "./lib/photo-search.ts";
import { ALBUMS, albumPath, type Album } from "./albums.ts";
import { CACHEABLE_PATHS } from "./routes.ts";
// the photo pool, as BUILD INPUTS: photo-index.json (which photos exist — full
// R2 key, byte size, upload date; written by add-photos.sh at upload time) and
// hashes.json (the content-hash map the /i/ URLs are minted from). esbuild
// inlines both into the bundle, so reading the pool is module memory: 0ms, no
// I/O, no cold-read class. This replaced the KV-cached R2-list manifest
// (2026-07-28): measured from a worker, R2 list() was 206ms median and the KV
// copy in front of it went 100-200ms whenever the colo's shared LRU evicted the
// key, which at this site's traffic was most real visits. The eviction is not
// tunable; a build input is. The trade is explicit: a photo becomes visible at
// DEPLOY, which was already true in practice because its /i/ tiles, hashes.json
// entry, and caption are committed files too.
// (`with { type: "json" }`: import attributes, understood by both esbuild and
// node ≥20.10 — contract-tests import this module under plain node.)
import photoIndex from "./photo-index.json" with { type: "json" };
import thumbHashes from "../../public/images/hashes.json" with { type: "json" };

type PhotoRecord = {
  full?: string;
  size?: number;
  uploaded?: string | null;
  /** album slug (albums.ts), or absent for the site-wide pool */
  album?: string | null;
  /** R2 key of the HEIF original, when one was uploaded beside the JPEG */
  heif?: string | null;
  camera?: string | number | null;
  lens?: string | number | null;
  film?: string | number | null;
  date?: string | number | null;
  recipe?: Record<string, string | number | boolean | null>;
  [field: string]: unknown;
};

type ThumbHash = { a?: string; j?: string; s?: string; x?: string };
type ThumbHashMap = Record<string, ThumbHash>;
type PhotoIndexMap = Record<string, PhotoRecord>;
type PhotoQueryValue = string | number | null;
type PhotoQueryOptions = {
  q?: PhotoQueryValue;
  camera?: PhotoQueryValue;
  lens?: PhotoQueryValue;
  film?: PhotoQueryValue;
  recipe?: PhotoQueryValue;
  from?: PhotoQueryValue;
  to?: PhotoQueryValue;
  limit?: PhotoQueryValue;
  offset?: PhotoQueryValue;
};

// ── /images/full/<key> → R2 ─────────────────────────────────────────
// proxies an R2 GET through the worker. supports If-None-Match (304s on
// cache hit) and Range requests. UNLIKE the /i/ thumbnails, these originals are
// NOT content-addressed: they keep their SOOC filenames (IMG_1234.jpg,
// DSCF5678.heic, etc.), so the URL names a SLOT, not exact bytes. The long cache
// header rides on the convention that an original is never overwritten in place
// (a new photo is a new filename), not on the URL naming its bytes. validation is
// permissive on stem but strict on extension and forbids any path traversal characters.
// A migrated entry records the JPEG key it retired (`jpeg`), so this maps the
// exact old URL, casing included, to the original that replaced it.
const MOVED_JPEGS = new Map(
  Object.values(photoIndex as Record<string, { full?: string; jpeg?: string }>).flatMap((p) => (p.jpeg && p.full ? [[p.jpeg, p.full] as const] : [])),
);

// A day rather than a year: a permanent redirect cached for a year is the one
// thing here a rollback couldn't take back.
const movedTo = (url: URL, key: string) =>
  new Response(null, {
    status: 301,
    headers: { location: `${url.origin}/images/full/${key}`, "cache-control": "public, max-age=86400" },
  });

export async function servePhotoFromR2(request, env, ctx) {
  if (!env.PHOTOS_R2) {
    return errorResp("R2 bucket not bound", 503);
  }

  const url = new URL(request.url);
  const key = url.pathname.replace(/^\/images\/full\//, "");
  // allow letters, digits, `_`, `-`, `.` in the stem; require a known
  // image extension. forbids `/`, `..`, and other escape characters.
  if (!/^[A-Za-z0-9_.-]+\.(?:jpe?g|png|heic|heif|hif|avif|gif|jxl)$/i.test(key)) {
    return errorResp("not found", 404);
  }

  // A JPEG original that moved to JPEG XL keeps its old URL as a redirect, so
  // links from before the move (search engines, the sitemap, other sites) land
  // on the same photo. The index answers from module memory; the head() below
  // covers the window when migrate-originals.ts has deleted a JPEG and the
  // deploy recording its .jxl hasn't shipped yet, and costs a subrequest only
  // on a miss.
  const recorded = MOVED_JPEGS.get(key);
  if (recorded) return movedTo(url, recorded);
  const moved = /\.jpe?g$/i.test(key) ? key.replace(/\.jpe?g$/i, ".jxl") : null;

  const ifNoneMatch = request.headers.get("if-none-match");
  const range = request.headers.get("range");

  // caches.default holds full GETs of the originals, so a repeat view serves
  // from the colo instead of re-pulling a 10MB object from R2. Safe to cache hard
  // because an original is never overwritten in place (a new upload is a new
  // filename), NOT because the URL is content-addressed. Range and conditional requests
  // bypass the cache because they need R2's range/onlyIf handling and must not
  // populate a full-body entry.
  //
  // x-photo-cache: hit|miss reports this tier, and only on a response Workers
  // Cache won't keep (gotcha 100). Workers Cache sits in front of the Worker and
  // stores this route's whole response, so a header stamped on a clean-URL GET
  // repeats on every front-tier HIT until eviction: on 2026-10-24, 4 of 13
  // sampled originals answered `miss` from a HIT with age 500+ s. Audit this
  // tier with a query string (`?probe=1`), which skips Workers Cache and maps to
  // the same caches.default key below.
  const cacheable = request.method === "GET" && !range && !ifNoneMatch;
  const marksTier = cacheable && !shouldUseWorkersCache(request, CACHEABLE_PATHS, url);
  const cache = caches.default;
  // Version-scoped Cache API key. The public URL stays clean (/images/full/<stem>),
  // but the caches.default entry is stored under ?av=ARCHIVE_VERSION. Cloudflare's
  // purge does not evict these per-colo Cache API entries, so an in-place R2
  // overwrite (e.g. re-encoding an existing original) is busted by bumping
  // ARCHIVE_VERSION in lib/const.ts: the new key misses, falling through to fresh
  // R2 bytes. The token never rides the served URL, only this internal lookup.
  const cacheKey = new Request(`${url.origin}${url.pathname}?av=${ARCHIVE_VERSION}`, request);
  if (cacheable) {
    const hit = await cache.match(cacheKey);
    if (hit) {
      const r = new Response(hit.body, hit);
      if (marksTier) r.headers.set("x-photo-cache", "hit");
      return r;
    }
  }

  // R2's onlyIf conditional GET returns a body-less object when the etag
  // matches, which becomes the 304 below.
  const getOpts: R2GetOptions = {};
  if (ifNoneMatch) getOpts.onlyIf = { etagDoesNotMatch: ifNoneMatch.replace(/^W\//, "").replace(/"/g, "") };
  if (range) {
    const m = range.match(/^bytes=(\d+)-(\d*)$/);
    if (m) {
      const offset = parseInt(m[1], 10);
      const end = m[2] ? parseInt(m[2], 10) : undefined;
      getOpts.range = end !== undefined ? { offset, length: end - offset + 1 } : { offset };
    }
  }

  const obj = await env.PHOTOS_R2.get(key, Object.keys(getOpts).length ? getOpts : undefined);
  // null means the key doesn't exist. A failed precondition is a different
  // answer: an R2Object with metadata and no body, so a matching
  // If-None-Match lands here as an object, never as null.
  if (obj === null) {
    if (moved && (await env.PHOTOS_R2.head(moved))) return movedTo(url, moved);
    return errorResp("not found", 404);
  }
  if (!("body" in obj)) {
    // A 304 repeats the 200's cache-control, since a cache merges these
    // headers into the copy it already holds.
    return new Response(null, {
      status: 304,
      headers: { etag: obj.httpEtag, "cache-control": "public, max-age=31536000, immutable" },
    });
  }

  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  // A JPEG XL original goes up as image/jxl; the extension covers a put that
  // set no type.
  headers.set("content-type", obj.httpMetadata?.contentType || (/\.jxl$/i.test(key) ? "image/jxl" : "image/jpeg"));
  headers.set("etag", obj.httpEtag);
  headers.set("cache-control", "public, max-age=31536000, immutable");
  headers.set("accept-ranges", "bytes");

  const isRange = !!getOpts.range && obj.range;
  if (isRange) {
    const start = obj.range.offset;
    const len = obj.range.length;
    const end = start + len - 1;
    headers.set("content-range", `bytes ${start}-${end}/${obj.size}`);
    headers.set("content-length", String(len));
    return new Response(obj.body, { status: 206, headers });
  }
  headers.set("content-length", String(obj.size));
  const resp = new Response(obj.body, { status: 200, headers });
  if (cacheable && ctx) {
    // store a clean clone (no x-photo-cache marker) for future hits, then mark
    // this response a miss where the mark can't go stale. resp.clone() tees the
    // R2 stream to both consumers.
    ctx.waitUntil(cache.put(cacheKey, resp.clone()));
    if (marksTier) resp.headers.set("x-photo-cache", "miss");
  }
  return resp;
}

// ── the photo pool ──────────────────────────────────────────────────
// photo-index.json is the single source of truth for which photos exist:
// one entry per published stem, written by add-photos.sh when it uploads the
// original. Deleting a photo = deleting its entry (plus the R2 object and /i/
// tiles); the old REMOVED_STEMS tombstone set retired with the R2 list() it
// was compensating for, since a committed index has no eventual consistency
// to tolerate.
//
// derivePhotoPool joins the index with hashes.json into the render-ready rows
// the SSR slot-builder reads. A stem with an incomplete hash entry is a
// half-run pipeline: SKIP it rather than bake a broken /i/undefined tile
// (check-photo-pipeline.ts fails CI on the same condition, so this guard is
// belt on top of braces). Exported for contract-tests, which run it over the
// real committed files.
//
// The sort is a plain codepoint compare, NOT localeCompare, and that is a
// startup fix rather than a style preference. `wrangler check startup` put 12
// of 19 module-eval samples inside this one comparator: the first
// localeCompare call constructs an ICU collator, and this sort runs at module
// scope, so every cold isolate paid for it before serving a byte. Dropping it
// took local active startup from 11.6ms to 3.6ms (3 runs each, 4.118.0).
// Order is UNCHANGED: R2 keys are camera filenames, verified all-ASCII
// [A-Za-z0-9._-] across the committed index, where collation and codepoint
// order coincide. If a filename ever carries an accent or a non-Latin script,
// this comparator changes the order rather than breaking -- and the ordering
// is only the pool's stable enumeration, which nothing user-visible pins.
//
// FOUR TIERS, and none of them is a <picture> fallback any more. That markup was
// removed in #156 because the losing candidate kept being instantiated on hover,
// so the grid emits ONE format and selects a SIZE through srcset:
//
//   thumb_xs     200px AVIF, the DPR-1 candidate
//   thumb_small  400px AVIF, DPR-2, and the plain src every tile carries
//   thumb_avif   600px AVIF, DPR-3
//   thumb_jpg    600px JPG, which the grid never emits — it is what /photos
//                renders, and the target of index.html's AVIF decode repair
//
// AVIF decode failures are still real (Kitesurf, 2026-08-12) and are handled by
// the recovery listener in index.html rather than by a second candidate here.
//
// slim hot-path rows: ONLY the fields the SSR slot-builder reads
// (EXIF rides /images/meta/<stem>.json, fetched per photo on hover).
export function derivePhotoPool(index: PhotoIndexMap, hashes: ThumbHashMap) {
  return Object.entries(index || {})
    .flatMap(([stem, p]) => {
      const h = hashes?.[stem];
      if (!h || !h.a || !h.j || !h.s) {
        console.log(`photo pool: skipping ${stem} (no content-hash in hashes.json)`);
        return [];
      }
      return [
        {
          full: p.full, // R2 key, e.g. "XT507333.JPG"
          thumb_avif: `/i/${stem}.${h.a}.avif`,
          thumb_jpg: `/i/${stem}.${h.j}.jpg`,
          thumb_small: `/i/${stem}-400.${h.s}.avif`,
          // The DPR-1 candidate. Optional on purpose: a stem hashed before the 200px
          // tier existed still serves, it just has one fewer srcset candidate, so a
          // half-run pipeline degrades to the old behaviour rather than dropping the
          // photo. derivePhotoPool already skips a stem missing a, j or s.
          thumb_xs: h.x ? `/i/${stem}-200.${h.x}.avif` : null,
          stem,
          size: p.size, // R2 object size in bytes
          uploaded: p.uploaded || null,
          // Album membership and the HEIF original are both OPTIONAL and both null
          // for the whole pre-2026-09-12 library, so every consumer of a row has to
          // read null as "the site-wide pool, JPEG only" rather than as a gap.
          album: p.album || null,
          heif: p.heif || null, // R2 key, like `full`; the URL is built at render
        },
      ];
    })
    .sort((a, b) => (a.full < b.full ? -1 : a.full > b.full ? 1 : 0));
}

export const PHOTO_POOL = derivePhotoPool(photoIndex, thumbHashes);

// The pool the homepage draws from and /photos lists: everything that is NOT in
// an album. Album photos stay in PHOTO_POOL (the manifest, the query utility and
// the Run palette see them) and are listed at their album's own page. Filtering
// here rather than at each call site is what keeps the homepage bake in
// build.ts and the live /photos/grid.html fragment on the same set.
export const curatedPool = (pool: ReturnType<typeof derivePhotoPool>) => pool.filter((p) => !p.album);
export const albumPool = (pool: ReturnType<typeof derivePhotoPool>, album: Album) => pool.filter((p) => p.album === album.slug);
export const CURATED_POOL = curatedPool(PHOTO_POOL);

// AI alt text (tools/photos/gen-alt-text.ts) generated offline into the static
// asset /images/alt.json {stem: alt}, loaded once per isolate and cached in a
// module var rather than bundled with the pool. Only the alt strings for the
// rendered slots ship per page.
export let _altMap;

export async function getAltMap(env) {
  if (_altMap) return _altMap;
  try {
    const r = await env.ASSETS.fetch("https://assets.local/images/alt.json");
    _altMap = r.ok ? await r.json() : {};
  } catch {
    _altMap = {};
  }
  return _altMap;
}

// Packed histograms {stem: four modulo-delta channels x 64 bins}, written
// by tools/photos/build-histogram-index.ts. Module-cached like _altMap, and that memo
// is the whole reason this is an ASSETS read rather than a bundled import: the
// fragment draws a random twelve per request so every photo must be reachable, and
// bundling them costs 22.9 KiB gzip (83% of the bundle's remaining headroom)
// while reading twelve files per request costs twelve subrequests against a 50
// cap. One memoised read costs neither.
//
// Only the prioritised six reach the client, as data-hist on the topmost tiles.
// That is what keeps this from being the download tools/lib/photo-indexes.ts
// declined: all 165 would be 24 KiB brotli of bars most visitors never see. The
// other six drawn tiles keep the existing per-photo metadata fetch if hovered.
export let _histograms;

export async function getHistogramMap(env) {
  if (_histograms) return _histograms;
  try {
    const r = await env.ASSETS.fetch("https://assets.local/images/histograms.json");
    _histograms = r.ok ? await r.json() : {};
  } catch {
    _histograms = {};
  }
  return _histograms;
}

// content-hash map {stem: {a,j,s}} written by tools/photos/hash-thumbnails.sh at
// photo-add time. The pool bakes these into /i/ URLs, so a thumbnail URL
// is born with its bytes: no global ?v= bump, and a cached 404 can never
// shadow real bytes (a new encode IS a new URL). Module-cached like _altMap.
//
// Deliberately still an ASSETS read even though the same file is imported
// above for the pool: the pool is the render-critical path and wants module
// memory; these callers (the legacy /images/<thumb> 301 mapper in index.ts,
// lib/not-found.ts, queryPhotos) are not hot, and keeping them on ASSETS keeps
// them stubbable in contract-tests. Both readers see the same committed file
// per deploy.
export let _thumbHashes;

export async function getThumbHashes(env) {
  if (_thumbHashes) return _thumbHashes;
  try {
    const r = await env.ASSETS.fetch("https://assets.local/images/hashes.json");
    _thumbHashes = r.ok ? await r.json() : {};
  } catch {
    _thumbHashes = {};
  }
  return _thumbHashes;
}

// Test seam, never called by the worker. These memos are cached per ISOLATE,
// which is right in production and becomes per-PROCESS under the contract
// suite: the first fixture to load one pins it for every later test in
// the file. That was invisible until the ranking tests started asserting on
// caption text, at which point they silently scored against an earlier test's
// alt map and failed for a reason that had nothing to do with ranking.
export function _resetPhotoCaches() {
  _altMap = undefined;
  _thumbHashes = undefined;
  _histograms = undefined;
  _photoJson.clear();
  _photoSearch = undefined;
}

const PHOTO_PUBLIC_FIELDS = [
  "camera",
  "lens",
  "aperture",
  "shutter",
  "iso",
  "focal",
  "ev",
  "date",
  "width",
  "height",
  "color_space",
  "white_balance",
  "color_temp",
  "wb_shift",
  "flash",
  "exposure_mode",
  "meter",
  "focus_mode",
  "drive",
  "sharpness",
  "noise_reduction",
  "clarity",
  "film",
  "dr",
  "dr_value",
  "chrome",
  "chrome_blue",
  "grain",
  "grain_size",
  "highlight_tone",
  "shadow_tone",
  "saturation",
  // the derived film-recipe card (exif-sooc --keyed): the same knobs, spelled the
  // way a recipe is written down, so a reader can re-shoot the look directly.
  "recipe",
];

// metadata.json (219 KB on 2026-10-16) and semantics.json (34 KB) are
// immutable for a Worker version, and queryPhotos used to fetch and parse both
// on every request. Memoised per isolate like _altMap, with one difference: only a
// successful read is kept, so a transient ASSETS failure costs one request its
// answer instead of pinning an empty archive to the isolate.
const _photoJson = new Map<string, unknown>();

async function getStaticPhotoJson<T>(env, path, fallback: T): Promise<T> {
  if (_photoJson.has(path)) return _photoJson.get(path) as T;
  try {
    const r = await env.ASSETS.fetch(`https://assets.local/${path}`);
    if (!r.ok) return fallback;
    const value = (await r.json()) as T;
    _photoJson.set(path, value);
    return value;
  } catch {
    return fallback;
  }
}

function photoMetadata(record) {
  return Object.fromEntries(PHOTO_PUBLIC_FIELDS.filter((key) => record && record[key] !== undefined).map((key) => [key, record[key]]));
}

// ── ranking ───────────────────────────────────────────────────────────────
// The ranker and its index live in lib/photo-search.ts. build.ts bakes the
// index into /images/photo-search.bin; this decodes it once per isolate and,
// like _photoJson, keeps only a successful read. null where no baked file
// exists (local dev, the contract fixtures), and queryPhotos then builds the
// same index from the JSON it read.
let _photoSearch: PhotoSearchIndex | undefined;

async function getPhotoSearchIndex(env): Promise<PhotoSearchIndex | null> {
  if (_photoSearch) return _photoSearch;
  try {
    const r = await env.ASSETS.fetch("https://assets.local/images/photo-search.bin");
    if (!r.ok) return null;
    _photoSearch = decodePhotoSearchIndex(await r.arrayBuffer());
    return _photoSearch;
  } catch {
    return null;
  }
}

// Shared photo query used by /photos/query.json and the site MCP tool. GPS and
// other unlisted EXIF fields never cross this boundary, even if the source
// metadata grows later.
export async function queryPhotos(env, options: PhotoQueryOptions = {}, _ctx = null) {
  const { textMax, dateMax } = PHOTO_QUERY_LIMITS;
  const q = String(options.q || "")
    .trim()
    .slice(0, textMax)
    .toLowerCase();
  const camera = String(options.camera || "")
    .trim()
    .slice(0, textMax)
    .toLowerCase();
  const lens = String(options.lens || "")
    .trim()
    .slice(0, textMax)
    .toLowerCase();
  const film = String(options.film || "")
    .trim()
    .slice(0, textMax)
    .toLowerCase();
  // `recipe` matches anywhere in the derived card ("DR400", "Acros", "+2 Red"),
  // so one param answers "which shots used this look?" without a client-side scan.
  const recipe = String(options.recipe || "")
    .trim()
    .slice(0, textMax)
    .toLowerCase();
  const from = String(options.from || "")
    .trim()
    .slice(0, dateMax);
  const to = String(options.to || "")
    .trim()
    .slice(0, dateMax);
  const limit = clampParam(options.limit, PHOTO_QUERY_LIMITS.limitDefault, PHOTO_QUERY_LIMITS.limitMax);
  const offset = clampParam(options.offset, 0, PHOTO_QUERY_LIMITS.offsetMax, 0);
  const [metadata, altMap, hashes, semantics, bakedIndex] = await Promise.all([
    getStaticPhotoJson<Record<string, PhotoRecord>>(env, "images/metadata.json", {}),
    getAltMap(env),
    getThumbHashes(env),
    getStaticPhotoJson<Record<string, { terms?: unknown }> | null>(env, "images/semantics.json", null),
    q ? getPhotoSearchIndex(env) : null,
  ]);
  const manifestByStem = new Map(PHOTO_POOL.map((photo) => [photo.stem, photo]));

  // The structured parameters are FILTERS and stay exact — a caller asking for
  // lens "XF27mm" wants that lens, not the closest thing to it. Only `q` is
  // ranked. Mixing the two would make a filter negotiable, which is the one
  // property a filter has.
  const kept = Object.entries(metadata || {}).filter(([, record]) => {
    if (
      camera &&
      !String(record.camera || "")
        .toLowerCase()
        .includes(camera)
    )
      return false;
    if (
      lens &&
      !String(record.lens || "")
        .toLowerCase()
        .includes(lens)
    )
      return false;
    if (
      film &&
      !String(record.film || "")
        .toLowerCase()
        .includes(film)
    )
      return false;
    if (recipe) {
      const card = Object.entries(record.recipe || {})
        .map(([k, v]) => `${k}: ${asScalarText(v)}`)
        .join("\n")
        .toLowerCase();
      if (!card.includes(recipe)) return false;
    }
    const date = String(record.date || "")
      .slice(0, 10)
      .replaceAll(":", "-");
    if (from && date < from) return false;
    if (to && date > to) return false;
    return true;
  });

  const { terms: queryTermList, dropped } = queryTerms(q);
  let ranked = kept.map(([stem, record]) => ({ stem, record, scored: null }));
  let mode = "filters-only";
  let common = [];

  if (q) {
    const index = bakedIndex ?? buildPhotoSearchIndex(metadata || {}, altMap, semantics);
    // Measured against the set that survived the filters, not the whole archive:
    // inside `film=Classic Chrome` the word "chrome" IS in every candidate and
    // genuinely stops discriminating, which is the right answer there.
    const { scored, common: suppressed } = rankPhotoRows(
      index,
      queryTermList,
      rowsOf(
        index,
        kept.map(([stem]) => stem),
      ),
    );
    common = suppressed;
    const scoredRows = scored.map(({ stem, ...score }) => ({ stem, record: metadata[stem], scored: score }));
    // Prefer photos that answer the WHOLE query. Falling straight to a bag of
    // terms would let one strong field on one term outrank a photo that matched
    // every term, which is how "classic chrome bridge" returns chrome bumpers.
    // If nothing covers every term the partial set is still the best available
    // answer, so it is returned — labelled, never silently.
    const full = scoredRows.filter((row) => row.scored.hits === queryTermList.length);
    ranked = full.length ? full : scoredRows;
    // "partial" has to mean "found something, short of everything". Reporting it
    // for an empty result set says a search happened and nearly worked, when in
    // fact nothing matched at all — a caller deciding whether to broaden its
    // query needs those two apart.
    mode = !queryTermList.length ? "no-terms" : full.length ? "all-terms" : scoredRows.length ? "partial" : "no-match";
  }

  // Score first, then newest, then stem. The old ordering was stem-alphabetical,
  // which is filename order — stable, and meaningless to a reader.
  const dateOf = (record) =>
    String(record.date || "")
      .slice(0, 10)
      .replaceAll(":", "-");
  ranked.sort(
    (a, b) => (b.scored?.score || 0) - (a.scored?.score || 0) || compareCodepoints(dateOf(b.record), dateOf(a.record)) || compareCodepoints(a.stem, b.stem),
  );

  const rows = ranked.map(({ stem, record, scored }) => {
    const manifestPhoto = manifestByStem.get(stem);
    const hash = hashes?.[stem] || {};
    const row: {
      stem: string;
      alt: string;
      full: string | null;
      thumb: { avif: string | null; jpg: string | null; small: string | null; xs: string | null };
      metadata: Record<string, unknown>;
      score?: number;
      matched?: string[];
    } = {
      stem,
      alt: String(altMap?.[stem] || "").slice(0, 240),
      full: manifestPhoto?.full ? `/images/full/${encodeURIComponent(manifestPhoto.full).replace(/%2F/g, "/")}` : null,
      thumb: {
        avif: hash.a ? `/i/${stem}.${hash.a}.avif` : null,
        jpg: hash.j ? `/i/${stem}.${hash.j}.jpg` : null,
        small: hash.s ? `/i/${stem}-400.${hash.s}.avif` : null,
        xs: hash.x ? `/i/${stem}-200.${hash.x}.avif` : null,
      },
      metadata: photoMetadata(record),
    };
    // Absent rather than zero when nothing was ranked, the same rule lens
    // follows for an unrun phase. A `score: 0` on a filter-only query would
    // read as "scored and found wanting" when nothing was scored at all.
    if (scored) {
      row.score = scored.score;
      row.matched = scored.matched;
    }
    return row;
  });

  // `dropped` and `common` are omitted rather than sent empty, so a caller can
  // tell "no terms were dropped" from "this build does not report drops". Built
  // in order so the JSON reads exactly as it always did.
  const ranking: { mode: string; terms: string[]; dropped?: string[]; common?: string[]; semantic?: boolean } = { mode, terms: queryTermList };
  if (dropped.length) ranking.dropped = dropped;
  if (common.length) ranking.common = common;
  ranking.semantic = Boolean(semantics);

  return {
    query: { q, camera, lens, film, recipe, from, to },
    // How the result set was arrived at, so a caller can tell a precise answer
    // from a best-effort one without guessing from the scores.
    ranking,
    total: rows.length,
    offset,
    limit,
    photos: rows.slice(offset, offset + limit),
  };
}

// The archive's shape rather than its contents: how many shots per camera, lens,
// film simulation, and year. The /photos frame renders these as meters, where the
// DISTRIBUTION is the answer ("mostly Classic Chrome on the 27mm") and the exact
// count is a footnote.
//
// It reads metadata.json once and folds, rather than paging queryPhotos. That
// query caps `limit` at 100 against a 165-photo archive (2026-10-16), so a
// facet count built on top of it would need two passes and would silently under-report the day the
// archive outgrows the second one. Facets are also the one question where the
// public-field projection doesn't apply: these are counts, not records.
export async function photoFacets(env) {
  const metadata = await getStaticPhotoJson<Record<string, PhotoRecord>>(env, "images/metadata.json", {});
  const tally = { camera: new Map(), lens: new Map(), film: new Map(), year: new Map() };
  const bump = (map, key) => {
    if (key) map.set(key, (map.get(key) || 0) + 1);
  };
  const records = Object.values(metadata || {});
  for (const record of records) {
    bump(tally.camera, record.camera);
    bump(tally.lens, record.lens);
    bump(tally.film, record.film);
    bump(tally.year, String(record.date || "").slice(0, 4) || null);
  }
  // Counts descending, then name, so a redraw of the same archive is byte-identical.
  const rank = (map) => [...map.entries()].sort((a, b) => b[1] - a[1] || compareCodepoints(a[0], b[0])).map(([name, count]) => ({ name, count }));
  return { total: records.length, camera: rank(tally.camera), lens: rank(tally.lens), film: rank(tally.film), year: rank(tally.year) };
}

export async function handlePhotoQuery(request, env, ctx, url = new URL(request.url)) {
  const payload = await queryPhotos(
    env,
    {
      q: url.searchParams.get("q"),
      camera: url.searchParams.get("camera"),
      lens: url.searchParams.get("lens"),
      film: url.searchParams.get("film"),
      recipe: url.searchParams.get("recipe"),
      from: url.searchParams.get("from"),
      to: url.searchParams.get("to"),
      limit: url.searchParams.get("limit"),
      offset: url.searchParams.get("offset"),
    },
    ctx,
  );
  return publicJsonResponse(payload, 200, { noindex: true });
}

// /images/manifest.json is BUILD OUTPUT since 2026-09-26: build.ts step 1e stages
// these bytes and the text-twin step writes their q11 twin, so the route serves
// them through servePrecompressedText. Rendered per request, the edge compressed
// them on the fly: 13,082 B on the wire against 9,803 at q11 (+33.4%), measured
// in production the day this moved. The inputs are the bundled pool alone, which
// only a deploy can change, so nothing about the body was ever per-request.
//
// ONE serializer and ONE header set for both doors. The build writes this string
// and the Worker falls back to it on a 404 (bun run dev stages nothing), so the
// two cannot drift, and a contract test holds the staged file to it byte for byte.
export function imagesManifestJson(photos: ReturnType<typeof derivePhotoPool>): string {
  // _address: the doctrinal signature that lived in the retired Apache listings;
  // the machine surface keeps it now that the human one is /photos.
  return JSON.stringify({ _address: "handwritten worker at aadhar.sh", photos, count: photos.length });
}

// /sitemap-images.xml: every published photo, under the page that shows it, so
// Google Images can find the library at all. /photos and each album are their
// own <url>, matching how the pages split the pool. The image is the full
// JPEG the tile opens (`fullUrl`), the best copy Google can be handed; the
// tiles' alt text lives on the pages, since Google stopped reading
// image:caption and image:title from sitemaps in 2022. Build output only
// (build.ts step 1e), from the same bundled pool as the pages beside it.
export function imageSitemapXml(photos: ReturnType<typeof derivePhotoPool>, albums: Album[]): string {
  const xml = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const page = (path: string, members: ReturnType<typeof derivePhotoPool>) =>
    `  <url>\n    <loc>https://aadhar.sh${path}</loc>\n` +
    members
      .filter((p) => p.full)
      .map((p) => `    <image:image><image:loc>${xml(`https://aadhar.sh${fullUrl(p.full)}`)}</image:loc></image:image>\n`)
      .join("") +
    `  </url>\n`;
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">\n` +
    page("/photos", curatedPool(photos)) +
    albums.map((album) => page(albumPath(album), albumPool(photos, album))).join("") +
    `</urlset>\n`
  );
}

// cache-control is load-bearing on the STATIC path rather than a restatement.
// _headers gives /images/* a one-year immutable cache for the old thumbnail
// URLs, and a staged file under /images/ inherits it, so a manifest that must
// move on every photo add would otherwise pin in browsers for a year.
export const IMAGES_MANIFEST_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "public, max-age=300, s-maxage=600",
  "access-control-allow-origin": "*",
};

export function handleImagesManifest() {
  return new Response(imagesManifestJson(PHOTO_POOL), { headers: IMAGES_MANIFEST_HEADERS });
}

// ── /photos — the archive, Explorer's Thumbnails view ───────────────────────
// Supersedes the two mod_autoindex listings (/images/, /images/full/ → 301
// here): one uniform square contact sheet of every published photo, anchor-
// walkable for no-JS visitors and dumb crawlers, each tile opening its SOOC
// original. Tiles use the 400px AVIF tier (plenty at ~160-250px rendered,
// even 2x) with the 600px JPG as the universal fallback. First 12 eager
// (above the fold), the rest lazy; content-visibility skips below-fold work.
// The /photos contact sheet, as a PURE renderer over the committed pool.
//
// Extracted from the closure inside handlePhotos so build.ts can call it in Node
// and emit photos.html at deploy time (step 1e), which buys the page the same q11
// twin + dcz delta tier the authored pages get. It is the largest page on the
// site (60KB), and it was the largest one still taking Cloudflare's on-the-fly
// zstd-3 with no twin and no delta.
//
// Pure by construction: every input is a build-time artifact. `photos` is the
// bundled pool (derivePhotoPool over photo-index.json + hashes.json) and `altMap`
// is the committed alt.json, so the same inputs give the same bytes in Node and in
// the Worker. That equality is the whole precondition for a precomputed twin, and
// contract-tests asserts it rather than trusting it.
// `full` is optional on the record type (an index row can be malformed until
// check-photo-pipeline.ts says otherwise), so the URL builder takes what the row
// has; derivePhotoPool never emits a row without one.
const fullUrl = (key: string | undefined) => `/images/full/${encodeURIComponent(key ?? "").replace(/%2F/g, "/")}`;

// One tile: the 400px AVIF over the 600px JPG, opening the SOOC JPEG. `extra`
// is the album page's per-tile format links; it sits OUTSIDE the anchor because
// an <a> inside an <a> is invalid HTML and the parser hoists it out (gotcha 8).
// Built with the `html` tag, so every interpolation is escaped by construction
// and the album page below opens no unescaped door at all.
//
// The first EAGER_TILES load with the page. Every later tile names its URLs in
// data-srcset and data-src, so the browser has nothing to fetch until
// GALLERY_DEFER swaps them in as the tile nears the screen. Both halves of the
// <picture> are deferred: with only the <img> deferred, the browser still picks
// the AVIF <source> and fetches it at once. A <noscript> twin keeps every photo
// for a reader without JavaScript.
//
// This replaced loading="lazy" on 2026-10-07. Chrome resolves lazy images
// within about 1,250 px of the screen on a fast link, so a desktop visit to
// /photos fetched 47 tiles (563 KB) where 12 were meant to be eager.
const EAGER_TILES = 12;
function renderTile(p, altMap, i: number, extra: Html = EMPTY): Html {
  const alt = (altMap && altMap[p.stem]) || p.stem;
  const picture =
    i < EAGER_TILES
      ? html`<picture>
<source type="image/avif" srcset="${p.thumb_small}">
<img src="${p.thumb_jpg}" alt="${alt}" width="400" height="400" decoding="async">
</picture>`
      : html`<picture data-defer>
<source type="image/avif" data-srcset="${p.thumb_small}">
<img data-src="${p.thumb_jpg}" alt="${alt}" width="400" height="400" decoding="async">
</picture><noscript><picture>
<source type="image/avif" srcset="${p.thumb_small}">
<img src="${p.thumb_jpg}" alt="${alt}" width="400" height="400" loading="lazy" decoding="async">
</picture></noscript>`;
  return html`<div class="ph">
<a class="ph-open" href="${fullUrl(p.full)}">
${picture}
</a>
<span class="ph-name">${p.stem}</span>${extra}
</div>`;
}

// Swaps a deferred tile's URLs in once it comes within a quarter of a screen of
// view. It starts one frame after first paint, so it never delays it.
//
// The root is the sheet's scrolling ancestor. Luna pages scroll inside
// `.window > .content`, and a rootMargin only enlarges the root: with the
// viewport as root, the scroller still clips each tile to its visible area, and
// the quarter-screen lead would shrink to nothing. `body` and `html` are skipped,
// because their overflow can propagate to the viewport, and observing against
// them would count every tile as in view.
//
// Without JavaScript the deferred <picture> is hidden and its <noscript> twin
// shows. The 25% margin is the cheapest that left no tile empty while scrolling
// at 1,000 and 2,000 px/s, measured across 0, 25, 50 and 100% in the build-off
// merge (buildoff/merge, 44e6c344) and again on this sheet.
// A static `html` literal: it interpolates nothing, so it opens no unescaped door.
const GALLERY_DEFER = html`<noscript><style>picture[data-defer]{display:none}</style></noscript><script>requestAnimationFrame(()=>setTimeout(()=>{let r=document.querySelector(".sheet");while((r=r.parentElement)&&r!==document.body&&!/auto|scroll/.test(getComputedStyle(r).overflowY));if(r===document.body)r=null;const o=new IntersectionObserver(es=>{for(const e of es)if(e.isIntersecting){const p=e.target;for(const s of p.querySelectorAll("[data-srcset]"))s.srcset=s.dataset.srcset;const i=p.querySelector("img");i.src=i.dataset.src;o.unobserve(p)}},{root:r,rootMargin:"25%"});for(const p of document.querySelectorAll("picture[data-defer]"))o.observe(p)}))</script>`;

const SHEET_CSS = `/*min*/
  h1 { font-size: 18pt; }
  .lede { margin: 0 0 14px; color: var(--ink-soft); font-size: var(--text-body); }
  .sheet {
  display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
  gap: 12px; margin: 8px 0 16px;
  }
  .ph {
  display: block; text-align: center;
  content-visibility: auto; contain-intrinsic-size: auto 190px;
  }
  .ph-open { display: block; text-decoration: none; }
  .ph picture, .ph img {
  display: block; width: 100%; height: auto; aspect-ratio: 1;
  border: 1px solid var(--slate-80); background: oklch(96.72% 0 0);
  box-sizing: border-box;
  }
  .ph:hover img { border-color: oklch(41.92% 0.13 250.51); }
  .ph-name {
  display: block; margin-top: 3px; font-size: var(--text-3xs); color: var(--ink-quiet);
  font-family: var(--font-ui); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .ph:hover .ph-name { color: var(--link); }
  .ph-fmt { display: block; font-size: var(--text-3xs); font-family: var(--font-ui); color: var(--ink-quiet); }
  .ph-fmt a { margin: 0 2px; }
  footer { text-align: center; font-size: var(--text-xs); color: var(--ink-quiet); margin-top: 14px; padding-top: 10px; border-top: 1px solid var(--rule); }
  footer address { font-style: italic; margin-top: 4px; }
  a { color: var(--link); }
`;

// ── the View menu: Filmstrip, Thumbnails, Details ───────────────────────────
// Explorer's View menu, the top idea from the 2026-10-29 gallery review (three
// of its four survey batches reached it on their own). The sheet above stays
// the page: every tile is still a link to its original, with or without
// JavaScript. photos-view.js adds the two other views over the same tiles and
// fetches the data they show (manifest.json, exif.json) on first use, so a
// visitor who never opens the menu pays for the script and nothing else.
//
// The menu is static markup so the row has its height at first paint and a
// late script never pushes the sheet down. It stays invisible until the script
// marks it .on: without JavaScript, or without the Popover API the menu opens
// through, a View button that changed nothing would be UI the page doesn't have.
//
// The window grid in luna.css has rows for caption, address and workspace. The
// menu bar takes a row between caption and address, as in Explorer, so this
// page alone moves the workspace to row 4. Each selector here carries one more
// :has() than the luna.css rule it overrides, so it wins on specificity
// whichever order the sheets load in.
const VIEW_MENUBAR = html`
  <div class="ph-menubar" role="menubar" aria-label="Photos">
<button type="button" role="menuitem" id="ph-view" aria-haspopup="menu" aria-expanded="false" popovertarget="ph-views">View</button>
<div class="ph-drop" id="ph-views" role="menu" aria-label="View" popover>
<button type="button" role="menuitemradio" tabindex="-1" aria-checked="false" data-view="filmstrip">Filmstrip</button>
<button type="button" role="menuitemradio" tabindex="-1" aria-checked="true" data-view="thumbnails">Thumbnails</button>
<button type="button" role="menuitemradio" tabindex="-1" aria-checked="false" data-view="details">Details</button>
</div>
  </div>`;

const VIEW_CSS = `/*min*/
  .ph-menubar { display: flex; padding: 1px 2px; background: var(--face); border-bottom: 1px solid var(--shadow); font: 11px/1.5 var(--font-ui); }
  .ph-menubar:not(.on) > * { visibility: hidden; }
  .window:has(>.axp-tasks):has(>.ph-menubar) { grid-template-rows: auto auto auto minmax(0, 1fr); }
  .window:has(>.axp-tasks):has(>.ph-menubar) > .ph-menubar { grid-column: 1 / -1; }
  .window:has(>.axp-tasks):has(>.ph-menubar) > .axp-tasks,
  .window:has(>.axp-tasks):has(>.ph-menubar) > .content,
  .window:has(>.axp-tasks):has(>.ph-menubar) > .axp-resize { grid-row: 4; }
  #ph-view { border: 0; background: none; font: inherit; color: var(--ink); padding: 1px 7px; cursor: default; }
  #ph-view:hover, #ph-view:focus-visible, #ph-view[aria-expanded="true"] { background: var(--selection); color: var(--selection-text); outline: 0; }
  .ph-drop { position: fixed; inset: auto; margin: 0; padding: 2px; min-width: 140px; background: var(--face-light); border: 1px solid var(--darkshadow); box-shadow: var(--shadow-tip); font: 11px/1.5 var(--font-ui); }
  .ph-drop button { display: flex; align-items: center; width: 100%; padding: 2px 20px 2px 0; border: 0; background: none; font: inherit; color: var(--ink); text-align: left; cursor: default; }
  .ph-drop button::before { content: ""; flex: 0 0 20px; text-align: center; font-size: 7px; }
  .ph-drop button[aria-checked="true"]::before { content: "●"; }
  .ph-drop button:hover, .ph-drop button:focus { background: var(--selection); color: var(--selection-text); outline: 0; }

  [data-view="details"] .sheet { display: none; }
  [data-view="filmstrip"] .sheet { display: flex; gap: 6px; overflow-x: auto; margin: 0 0 16px; padding: 3px 3px 8px; }
  [data-view="filmstrip"] .ph { flex: 0 0 84px; contain-intrinsic-size: auto 84px; }
  [data-view="filmstrip"] .ph-name { display: none; }
  [data-view="filmstrip"] .ph-open[aria-current="true"] img { border: 2px solid var(--selection); }

  /* The frame shrinks with the window so the strip stays on the first screen:
     370px is the chrome, heading, lede, buttons and strip around it at 800x600. */
  .ph-film { display: grid; grid-template-columns: minmax(0, min(480px, max(220px, 100dvh - 370px))) minmax(0, 1fr); gap: 16px; align-items: start; margin: 8px 0 10px; }
  .ph-film[hidden] { display: none; }
  .ph-frame { margin: 0; }
  .ph-frame a { display: block; }
  .ph-frame img { display: block; width: 100%; height: auto; aspect-ratio: 1; border: 1px solid var(--slate-80); background: var(--paper); box-sizing: border-box; }
  .ph-steps { display: flex; justify-content: center; gap: 6px; margin-top: 8px; }
  .ph-info h2 { margin: 0 0 6px; font: 700 var(--text-ui) var(--font-ui); color: var(--ink); overflow-wrap: anywhere; }
  .ph-info dl { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 2px 10px; margin: 0; font: 11px/1.45 var(--font-ui); }
  .ph-info dt { color: var(--ink-soft); white-space: nowrap; }
  .ph-info dd { margin: 0; color: var(--ink); overflow-wrap: anywhere; }
  .ph-hist { display: block; width: 100%; height: 56px; margin-top: 10px; border: 1px solid var(--slate-80); background: var(--paper); box-sizing: border-box; }
  .ph-hist .luma { fill: var(--grey-35); opacity: 0.35; }
  .ph-hist polyline { fill: none; stroke-width: 1; vector-effect: non-scaling-stroke; mix-blend-mode: multiply; }
  .ph-hist .r { stroke: oklch(45% 0.22 25); }
  .ph-hist .g { stroke: oklch(50% 0.20 145); }
  .ph-hist .b { stroke: oklch(45% 0.22 260); }
  @media (max-width: 640px) { .ph-film { grid-template-columns: minmax(0, 1fr); } }

  .ph-list { overflow-x: auto; margin: 8px 0 16px; border: 1px solid var(--slate-80); background: var(--paper); }
  .ph-list table { width: 100%; border-collapse: collapse; font: 11px/1.4 var(--font-ui); white-space: nowrap; }
  .ph-list th { padding: 0; font-weight: 400; text-align: left; }
  .ph-list th button { display: block; width: 100%; box-sizing: border-box; padding: 3px 6px 1px; border: 0; border-right: 1px solid var(--shadow); border-bottom: 3px solid var(--face); background: var(--grad-button); font: inherit; color: var(--ink); text-align: inherit; cursor: default; }
  .ph-list th button:hover { border-bottom-color: var(--amber-70); }
  .ph-list th button:focus-visible { outline: 1px dotted var(--ink); outline-offset: -3px; }
  .ph-list th[aria-sort="ascending"] button::after { content: " ▴"; }
  .ph-list th[aria-sort="descending"] button::after { content: " ▾"; }
  .ph-list th.num, .ph-list td.num { text-align: right; }
  .ph-list td { padding: 2px 6px; color: var(--ink); }
  .ph-list td.sorted { background: var(--row-alt); }
  .ph-list tbody tr:hover td { background: var(--row-hover); }
`;

// `photos` is the WHOLE pool. The sheet lists the curated part and the lede
// links each album with its count, so the two halves are derived from one input
// and cannot disagree about which photo went where.
export function renderPhotosPage(photos, altMap) {
  const curated = curatedPool(photos);
  if (!curated.length) {
    return new Response("photo manifest unavailable", {
      status: 503,
      headers: { "content-type": "text/plain; charset=utf-8", "retry-after": "60" },
    });
  }

  // .html rather than the Html value itself: this body is still the pre-`html`
  // literal form, and an object in a plain template literal is what
  // restrict-template-expressions exists to catch.
  const tiles = joinHtml(
    curated.map((p, i) => renderTile(p, altMap, i)),
    "\n",
  ).html;
  const albums = Object.values(ALBUMS)
    .map((a) => ({ album: a, count: albumPool(photos, a).length }))
    .filter(({ count }) => count > 0);
  const albumsLine = albums.length
    ? `\n    Albums: ${albums.map(({ album, count }) => `<a href="${esc(albumPath(album))}">${esc(album.title)}</a> (${count})`).join(" &middot; ")}.`
    : "";

  return lunaPage({
    title: "aadhar.sh/photos",
    path: "aadhar.sh/photos",
    route: "/photos",
    width: 980,
    description: `All ${curated.length} photos, straight out of camera. FUJIFILM X-T50 + Leica M.`,
    menubar: VIEW_MENUBAR,
    scripts: html`<script src="/photos-view.js" defer></script>`,
    // The unfurl card shows the sheet's first photo, the same one the page opens on.
    ogImage: curated[0].thumb_jpg,
    ogImageAlt: (altMap && altMap[curated[0].stem]) || curated[0].stem,
    css: SHEET_CSS + VIEW_CSS,
    body: unsafeHtml(`
  <h1>Photos</h1>
  <p class="lede">
    All ${curated.length}, straight out of camera (FUJIFILM X-T50, Leica M).
    Click any tile for the full-resolution original. Machine-readable index:
    <a href="/images/manifest.json">manifest.json</a> &middot;
    <a href="/images/alt.json">alt.json</a> &middot;
    <a href="/images/metadata.json">metadata.json</a>.${albumsLine}
  </p>
  <div class="sheet">
${tiles}
  </div>${GALLERY_DEFER.html}
  <footer>
    &larr; <a href="/">aadhar.sh</a> &middot; press <b>&#8984;K</b> anywhere to search these by name
    <address>handwritten worker at aadhar.sh</address>
  </footer>
`),
    cache: "public, max-age=300",
  });
}

// ── /<album> — one album, the same contact sheet, every format named ────────
// Same purity contract as renderPhotosPage: `photos` is the whole pool and the
// album's members are selected here, so build.ts step 1e and the live handler
// render identical bytes from identical inputs. Each tile names the formats
// the pipeline actually uploaded: JPEG always (the click-through), HEIF when
// add-photos.sh ran with HEIF=1 and put the original beside it. A tile never
// advertises a format the index does not record, which is the same rule the
// tooltip follows for EXIF: never fabricate a line. The lede is the owner's
// copy verbatim (albums.ts); it carried counts and a how-to line for a day and
// the owner cut both, so nothing here computes prose from the pool.
export function renderAlbumPage(album: Album, photos, altMap) {
  const members = albumPool(photos, album);
  if (!members.length) {
    return new Response("album unavailable", {
      status: 503,
      headers: { "content-type": "text/plain; charset=utf-8", "retry-after": "60" },
    });
  }
  const tiles = joinHtml(
    members.map((p, i) => {
      // `download`: the tile opens the original in the browser, the format links
      // save it. Same-origin, so the attribute is honoured; the filename is the R2
      // key. An original is a JPEG until migrate-originals.ts moves it to JPEG XL.
      const links = [html`<a href="${fullUrl(p.full)}" download>${/\.jxl$/i.test(p.full ?? "") ? "JPEG XL" : "JPEG"}</a>`];
      if (p.heif) links.push(html`<a href="${fullUrl(p.heif)}" download>HEIF</a>`);
      return renderTile(
        p,
        altMap,
        i,
        html`
<span class="ph-fmt">${joinHtml(links, " &middot; ")}</span>`,
      );
    }),
    "\n",
  );

  return lunaPage({
    title: `aadhar.sh${albumPath(album)}`,
    path: `aadhar.sh${albumPath(album)}`,
    route: albumPath(album),
    width: 980,
    description: album.description,
    ogImage: members[0].thumb_jpg,
    ogImageAlt: (altMap && altMap[members[0].stem]) || members[0].stem,
    css: SHEET_CSS,
    body: html`
  <h1>${album.title}</h1>
  <p class="lede">
    ${joinHtml(
      album.lede.map((line) => html`${line}`),
      "<br>\n    ",
    )}
  </p>
  <div class="sheet">
${tiles}
  </div>${GALLERY_DEFER}
  <footer>
    &larr; <a href="/photos">all photos</a> &middot; <a href="/">aadhar.sh</a>
    <address>handwritten worker at aadhar.sh</address>
  </footer>
`,
    cache: "public, max-age=300",
  });
}

export async function handleAlbum(album: Album, request, env, ctx) {
  const render = async () => renderAlbumPage(album, PHOTO_POOL, await getAltMap(env));
  return cachedRender(request, env, ctx, albumPath(album), render);
}

export async function handlePhotos(request, env, ctx) {
  const render = async () => renderPhotosPage(PHOTO_POOL, await getAltMap(env));
  return cachedRender(request, env, ctx, "/photos", render);
}
