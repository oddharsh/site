// photos.js — extracted from the worker (no-build reorg). Bundled by
// wrangler/Cloudflare at deploy; not served (inside _worker.js/).
import { cachedRender } from "./lib/cache.js";
import { lunaPage } from "./lib/chrome.js";
import { ARCHIVE_VERSION } from "./lib/const.js";
import { errorResp, escAttr, escHtml, jsonResp } from "./lib/http.js";
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
import thumbHashes from "../images/hashes.json" with { type: "json" };

// ── /images/full/<key> → R2 ─────────────────────────────────────────
// proxies an R2 GET through the worker. supports If-None-Match (304s on
// cache hit) and Range requests. UNLIKE the /i/ thumbnails, these originals are
// NOT content-addressed: they keep their SOOC filenames (IMG_1234.jpg,
// DSCF5678.heic, etc.), so the URL names a SLOT, not exact bytes. The long cache
// header rides on the convention that an original is never overwritten in place
// (a new photo is a new filename), not on the URL naming its bytes. validation is
// permissive on stem but strict on extension and forbids any path traversal characters.
export async function servePhotoFromR2(request, env, ctx) {
  if (!env.PHOTOS_R2) {
    return errorResp("R2 bucket not bound", 503);
  }

  const url = new URL(request.url);
  const key = url.pathname.replace(/^\/images\/full\//, "");
  // allow letters, digits, `_`, `-`, `.` in the stem; require a known
  // image extension. forbids `/`, `..`, and other escape characters.
  if (!/^[A-Za-z0-9_.-]+\.(?:jpe?g|png|heic|heif|hif|avif|gif)$/i.test(key)) {
    return errorResp("not found", 404);
  }

  const ifNoneMatch = request.headers.get("if-none-match");
  const range       = request.headers.get("range");

  // caches.default holds full GETs of the originals, so a repeat view serves
  // from the colo instead of re-pulling a 10MB object from R2. Safe to cache hard
  // because an original is never overwritten in place (a new upload is a new
  // filename), NOT because the URL is content-addressed. Range and conditional requests
  // bypass the cache because they need R2's range/onlyIf handling and must not
  // populate a full-body entry. x-photo-cache: hit|miss proved this layer works
  // and keeps proving it on every request.
  const cacheable = request.method === "GET" && !range && !ifNoneMatch;
  const cache = caches.default;
  // Version-scoped Cache API key. The public URL stays clean (/images/full/<stem>),
  // but the caches.default entry is stored under ?av=ARCHIVE_VERSION. Cloudflare's
  // purge does not evict these per-colo Cache API entries, so an in-place R2
  // overwrite (e.g. re-encoding an existing original) is busted by bumping
  // ARCHIVE_VERSION in lib/const.js: the new key misses, falling through to fresh
  // R2 bytes. The token never rides the served URL, only this internal lookup.
  const cacheKey = new Request(`${url.origin}${url.pathname}?av=${ARCHIVE_VERSION}`, request);
  if (cacheable) {
    const hit = await cache.match(cacheKey);
    if (hit) {
      const r = new Response(hit.body, hit);
      r.headers.set("x-photo-cache", "hit");
      return r;
    }
  }

  // R2's onlyIf conditional GET returns a body-less object when the etag
  // matches — translates directly to a 304 response.
  const getOpts = {};
  if (ifNoneMatch) getOpts.onlyIf = { etagDoesNotMatch: ifNoneMatch.replace(/^W\//, "").replace(/"/g, "") };
  if (range) {
    const m = range.match(/^bytes=(\d+)-(\d*)$/);
    if (m) {
      const offset = parseInt(m[1], 10);
      const end = m[2] ? parseInt(m[2], 10) : undefined;
      getOpts.range = end !== undefined
        ? { offset, length: end - offset + 1 }
        : { offset };
    }
  }

  const obj = await env.PHOTOS_R2.get(key, Object.keys(getOpts).length ? getOpts : undefined);
  if (obj === null) {
    // either the key doesn't exist, or onlyIf matched (so the response is
    // a 304). R2 returns the object metadata in both cases via head() —
    // we treat null as the 304-or-404 boundary by re-checking metadata.
    if (ifNoneMatch) {
      const head = await env.PHOTOS_R2.head(key);
      if (head) {
        return new Response(null, {
          status: 304,
          headers: { etag: head.httpEtag, "cache-control": "public, max-age=86400, immutable" },
        });
      }
    }
    return errorResp("not found", 404);
  }

  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set("content-type",  obj.httpMetadata?.contentType || "image/jpeg");
  headers.set("etag",          obj.httpEtag);
  headers.set("cache-control", "public, max-age=31536000, immutable");
  headers.set("accept-ranges", "bytes");

  const isRange = !!getOpts.range && obj.range;
  if (isRange) {
    const start = obj.range.offset;
    const len   = obj.range.length;
    const end   = start + len - 1;
    headers.set("content-range",  `bytes ${start}-${end}/${obj.size}`);
    headers.set("content-length", String(len));
    return new Response(obj.body, { status: 206, headers });
  }
  headers.set("content-length", String(obj.size));
  const resp = new Response(obj.body, { status: 200, headers });
  if (cacheable && ctx) {
    // store a clean clone (no x-photo-cache marker) for future hits, then mark
    // THIS response a miss. resp.clone() tees the R2 stream to both consumers.
    ctx.waitUntil(cache.put(cacheKey, resp.clone()));
    resp.headers.set("x-photo-cache", "miss");
  }
  return resp;
}

// (the Apache-styled /images listings lived here until 2026-07-03; /photos
// superseded them and their signature line moved with it.)

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
// (check-photo-pipeline.mjs fails CI on the same condition, so this guard is
// belt on top of braces). Exported for contract-tests, which run it over the
// real committed files.
//
// dual-source: thumb_avif is the <picture> primary; thumb_jpg is
// the universal <img src> fallback (thumb_small is the 400px mobile AVIF).
// NB: <picture> type-fallback only catches "format not supported" — it
// does NOT catch DECODE failures. AVIF decode failures historically caused
// broken images here; if they recur, the fix is to demote AVIF entirely.
// slim hot-path rows: ONLY the fields the SSR slot-builder reads
// (EXIF rides /images/meta/<stem>.json, fetched per photo on hover).
export function derivePhotoPool(index, hashes) {
  return Object.entries(index || {}).flatMap(([stem, p]) => {
    const h = hashes?.[stem];
    if (!h || !h.a || !h.j || !h.s) {
      console.log(`photo pool: skipping ${stem} (no content-hash in hashes.json)`);
      return [];
    }
    return [{
      full:        p.full,                  // R2 key, e.g. "XT507333.JPG"
      thumb_avif:  `/i/${stem}.${h.a}.avif`,
      thumb_jpg:   `/i/${stem}.${h.j}.jpg`,
      thumb_small: `/i/${stem}-400.${h.s}.avif`,
      stem,
      size:       p.size,                   // R2 object size in bytes
      uploaded:   p.uploaded || null,
    }];
  }).sort((a, b) => a.full.localeCompare(b.full));
}

const PHOTO_POOL = derivePhotoPool(photoIndex, thumbHashes);

// normalize a pool thumb URL. The pool always bakes absolute /i/ URLs now, so
// this is a passthrough kept for shape-compat with its callers (home.js SSR);
// the legacy-relative arm survives only as paranoia, not a live path.
export const absThumb = (u) => (u && u.startsWith("/") ? u : `/images/${u}`);

// AI alt text (cf-garage Workers AI, ?mode=alt) generated offline into the static
// asset /images/alt.json {stem: alt}. loaded once per isolate and cached in a module
// var — deliberately NOT folded into the hot-path manifest (which is JSON-parsed on
// every no-store homepage hit; alt would bloat it). only the alt strings for the ~12
// rendered slots ship per page. strippable: delete alt.json + these lookups to revert.
export let _altMap;

export async function getAltMap(env) {
  if (_altMap) return _altMap;
  try {
    const r = await env.ASSETS.fetch("https://assets.local/images/alt.json");
    _altMap = r.ok ? await r.json() : {};
  } catch { _altMap = {}; }
  return _altMap;
}

// content-hash map {stem: {a,j,s}} written by scripts/hash-thumbnails.sh at
// photo-add time. The pool bakes these into /i/ URLs, so a thumbnail URL
// is born with its bytes: no global ?v= bump, and a cached 404 can never
// shadow real bytes (a new encode IS a new URL). Module-cached like _altMap.
//
// Deliberately still an ASSETS read even though the same file is imported
// above for the pool: the pool is the render-critical path and wants module
// memory; these callers (the legacy /images/<thumb> 301 mapper, queryPhotos)
// are not hot, and keeping them on ASSETS keeps them stubbable in
// contract-tests. Both readers see the same committed file per deploy.
export let _thumbHashes;

export async function getThumbHashes(env) {
  if (_thumbHashes) return _thumbHashes;
  try {
    const r = await env.ASSETS.fetch("https://assets.local/images/hashes.json");
    _thumbHashes = r.ok ? await r.json() : {};
  } catch { _thumbHashes = {}; }
  return _thumbHashes;
}

const PHOTO_PUBLIC_FIELDS = [
  "camera", "lens", "aperture", "shutter", "iso", "focal", "ev", "date",
  "width", "height", "color_space", "white_balance", "color_temp", "wb_shift",
  "flash", "exposure_mode", "meter", "focus_mode", "drive", "sharpness",
  "noise_reduction", "clarity", "film", "dr", "dr_value", "chrome", "chrome_blue",
  "grain", "grain_size", "highlight_tone", "shadow_tone", "saturation",
  // the derived film-recipe card (build-recipes.py): the same knobs, spelled the
  // way a recipe is written down, so a reader can re-shoot the look directly.
  "recipe",
];

async function getStaticPhotoJson(env, path, fallback) {
  try {
    const r = await env.ASSETS.fetch(`https://assets.local/${path}`);
    return r.ok ? await r.json() : fallback;
  } catch { return fallback; }
}

function photoMetadata(record) {
  return Object.fromEntries(PHOTO_PUBLIC_FIELDS.filter((key) => record && record[key] !== undefined).map((key) => [key, record[key]]));
}

// Shared photo query used by /photos/query.json and the site MCP tool. GPS and
// other unlisted EXIF fields never cross this boundary, even if the source
// metadata grows later.
export async function queryPhotos(env, options = {}, ctx = null) {
  const q = String(options.q || "").trim().slice(0, 120).toLowerCase();
  const camera = String(options.camera || "").trim().slice(0, 120).toLowerCase();
  const lens = String(options.lens || "").trim().slice(0, 120).toLowerCase();
  const film = String(options.film || "").trim().slice(0, 120).toLowerCase();
  // `recipe` matches anywhere in the derived card ("DR400", "Acros", "+2 Red"),
  // so one param answers "which shots used this look?" without a client-side scan.
  const recipe = String(options.recipe || "").trim().slice(0, 120).toLowerCase();
  const from = String(options.from || "").trim().slice(0, 32);
  const to = String(options.to || "").trim().slice(0, 32);
  const limit = Math.min(100, Math.max(1, Number(options.limit) || 25));
  const offset = Math.min(10000, Math.max(0, Number(options.offset) || 0));
  const [metadata, altMap, hashes] = await Promise.all([
    getStaticPhotoJson(env, "images/metadata.json", {}),
    getAltMap(env),
    getThumbHashes(env),
  ]);
  let manifest = [];
  try { manifest = await getImagesManifest(env, ctx); } catch { manifest = []; }
  const manifestByStem = new Map((manifest || []).map((photo) => [photo.stem, photo]));
  const rows = Object.entries(metadata || {}).filter(([stem, record]) => {
    const haystack = [stem, altMap?.[stem], record.camera, record.lens, record.film].filter(Boolean).join(" ").toLowerCase();
    if (q && !haystack.includes(q)) return false;
    if (camera && !String(record.camera || "").toLowerCase().includes(camera)) return false;
    if (lens && !String(record.lens || "").toLowerCase().includes(lens)) return false;
    if (film && !String(record.film || "").toLowerCase().includes(film)) return false;
    if (recipe) {
      const card = Object.entries(record.recipe || {}).map(([k, v]) => `${k}: ${v}`).join("\n").toLowerCase();
      if (!card.includes(recipe)) return false;
    }
    const date = String(record.date || "").slice(0, 10).replaceAll(":", "-");
    if (from && date < from) return false;
    if (to && date > to) return false;
    return true;
  }).sort(([a], [b]) => a.localeCompare(b)).map(([stem, record]) => {
    const manifestPhoto = manifestByStem.get(stem);
    const hash = hashes?.[stem] || {};
    return {
      stem,
      alt: String(altMap?.[stem] || "").slice(0, 240),
      full: manifestPhoto?.full ? `/images/full/${encodeURIComponent(manifestPhoto.full).replace(/%2F/g, "/")}` : null,
      thumb: {
        avif: hash.a ? `/i/${stem}.${hash.a}.avif` : null,
        jpg: hash.j ? `/i/${stem}.${hash.j}.jpg` : null,
        small: hash.s ? `/i/${stem}-400.${hash.s}.avif` : null,
      },
      metadata: photoMetadata(record),
    };
  });
  return {
    query: { q, camera, lens, film, recipe, from, to },
    total: rows.length,
    offset,
    limit,
    photos: rows.slice(offset, offset + limit),
  };
}

export async function handlePhotoQuery(request, env, ctx) {
  const url = new URL(request.url);
  const payload = await queryPhotos(env, {
    q: url.searchParams.get("q"), camera: url.searchParams.get("camera"),
    lens: url.searchParams.get("lens"), film: url.searchParams.get("film"),
    recipe: url.searchParams.get("recipe"),
    from: url.searchParams.get("from"), to: url.searchParams.get("to"),
    limit: url.searchParams.get("limit"), offset: url.searchParams.get("offset"),
  }, ctx);
  const response = jsonResp(payload);
  response.headers.set("x-robots-tag", "noindex");
  return response;
}

export async function getImagesManifest(_env, _ctx) {
  // the pool is module memory (see derivePhotoPool above). The async (env, ctx)
  // signature survives from the KV/SWR era so the callers (home.js SSR, run.js
  // palette, /photos, queryPhotos) didn't have to move; the awaits they do on
  // this resolve on the microtask queue, no I/O behind them.
  return PHOTO_POOL;
}

export async function handleImagesManifest(request, env, ctx) {
  const photos = await getImagesManifest(env, ctx);
  // _address: the doctrinal signature that lived in the retired Apache listings;
  // the machine surface keeps it now that the human one is /photos.
  return jsonResp({ _address: "handwritten worker at aadhar.sh", photos, count: photos.length });
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
// Extracted from the closure inside handlePhotos so build.mjs can call it in Node
// and emit photos.html at deploy time (step 1e), which buys the page the same q11
// twin + dcz delta tier the 40 authored pages get. It is the largest page on the
// site (60KB), and it was the largest one still taking Cloudflare's on-the-fly
// zstd-3 with no twin and no delta.
//
// Pure by construction: every input is a build-time artifact. `photos` is the
// bundled pool (derivePhotoPool over photo-index.json + hashes.json) and `altMap`
// is the committed alt.json, so the same inputs give the same bytes in Node and in
// the Worker. That equality is the whole precondition for a precomputed twin, and
// contract-tests asserts it rather than trusting it.
export function renderPhotosPage(photos, altMap) {
  if (!photos.length) {
    return new Response("photo manifest unavailable", {
      status: 503,
      headers: { "content-type": "text/plain; charset=utf-8", "retry-after": "60" },
    });
  }

  const tiles = photos.map((p, i) => {
    const eager = i < 12;
    const alt = escAttr((altMap && altMap[p.stem]) || p.stem);
    const small = absThumb(p.thumb_small);   // manifest guarantees thumb_small (unhashed stems are skipped)
    return `<a class="ph" href="/images/full/${escAttr(encodeURIComponent(p.full).replace(/%2F/g, "/"))}">
<picture>
<source type="image/avif" srcset="${escAttr(small)}">
<img src="${escAttr(absThumb(p.thumb_jpg))}" alt="${alt}" width="400" height="400"${eager ? "" : ` loading="lazy"`} decoding="async">
</picture>
<span class="ph-name">${escHtml(p.stem)}</span>
</a>`;
  }).join("\n");

  return lunaPage({
    title: "aadhar.sh/photos",
    path: "aadhar.sh/photos",
    width: 980,
    description: `All ${photos.length} photos, straight out of camera. FUJIFILM X-T5 + Leica M.`,
    css: `
  h1 { font-family: var(--font-caption); color: oklch(41.92% 0.0962 250.51); font-size: 18pt; margin: 0 0 4px; font-weight: bold; }
  .lede { margin: 0 0 14px; color: oklch(38.67% 0 0); font-size: 10.5pt; }
  .sheet {
  display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
  gap: 12px; margin: 8px 0 16px;
  }
  .ph {
  display: block; text-decoration: none; text-align: center;
  content-visibility: auto; contain-intrinsic-size: auto 190px;
  }
  .ph picture, .ph img {
  display: block; width: 100%; height: auto; aspect-ratio: 1;
  border: 1px solid oklch(80% 0.02 250); background: oklch(96.72% 0 0);
  box-sizing: border-box;
  }
  .ph:hover img { border-color: oklch(41.92% 0.13 250.51); }
  .ph-name {
  display: block; margin-top: 3px; font-size: 7.5pt; color: oklch(44.95% 0 0);
  font-family: var(--font-ui); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .ph:hover .ph-name { color: oklch(42.61% 0.2353 263.74); }
  footer { text-align: center; font-size: 9pt; color: oklch(44.95% 0 0); margin-top: 14px; padding-top: 10px; border-top: 1px solid oklch(86.67% 0.0294 259.59); }
  footer address { font-style: italic; margin-top: 4px; }
  a { color: oklch(42.61% 0.2353 263.74); }
`,
    body: `
  <h1>Photos</h1>
  <p class="lede">
    All ${photos.length}, straight out of camera (FUJIFILM X-T5, Leica M).
    Click any tile for the full-resolution original. Machine-readable index:
    <a href="/images/manifest.json">manifest.json</a> &middot;
    <a href="/images/alt.json">alt.json</a> &middot;
    <a href="/images/metadata.json">metadata.json</a>.
  </p>
  <div class="sheet">
${tiles}
  </div>
  <footer>
    &larr; <a href="/">aadhar.sh</a> &middot; press <b>&#8984;K</b> anywhere to search these by name
    <address>handwritten worker at aadhar.sh</address>
  </footer>
`,
    cache: "public, max-age=300",
  });
}

export async function handlePhotos(request, env, ctx) {
  const render = async () => {
    const [photos, altMap] = await Promise.all([
      getImagesManifest(env, ctx),
      getAltMap(env),
    ]);
    if (!photos.length) {
      return new Response("photo manifest unavailable", {
        status: 503,
        headers: { "content-type": "text/plain; charset=utf-8", "retry-after": "60" },
      });
    }
    return renderPhotosPage(photos, altMap);
  };

  return cachedRender(request, ctx, render, "/photos", env);
}
