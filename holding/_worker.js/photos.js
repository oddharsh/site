// photos.js — extracted from the worker (no-build reorg). Bundled by
// wrangler/Cloudflare at deploy; not served (inside _worker.js/).
import { cachedRender, swrKV } from "./lib/cache.js";
import { lunaPage } from "./lib/chrome.js";
import { errorResp, escAttr, escHtml, jsonResp } from "./lib/http.js";

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
  if (cacheable) {
    const hit = await cache.match(request);
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
    ctx.waitUntil(cache.put(request, resp.clone()));
    resp.headers.set("x-photo-cache", "miss");
  }
  return resp;
}

// (the Apache-styled /images listings lived here until 2026-07-03; /photos
// superseded them and their signature line moved with it.)

// the photo manifest is the single source of truth for which photos
// exist. derived from R2 keys (each upload preserves its SOOC filename;
// thumbnails share that filename stem with .avif as the primary modern
// format and .jpg as the universal fallback). cached in KV for an hour.
//
// dedup: when a stem has multiple R2 objects (e.g. HIF + JPG sibling
// because we generated a JPG export of a HIF original), pick the one
// most browser-friendly for click-through. JPG/JPEG > PNG/WebP/GIF >
// HEIF/HEIC/HIF. HIFs trigger Chrome's download dialog instead of
// rendering, so we always prefer a JPG counterpart when one exists.
export const R2_EXT_PRIORITY = {
  jpg: 5, jpeg: 5,
  png: 3, webp: 3, gif: 3,
  heif: 1, heic: 1, hif: 1,
};

// stems removed from the pool — excluded from the rebuilt manifest even if their
// original still lingers in R2's eventually-consistent list(). prune once R2
// list() drops them (and the entry here is harmless to keep as a record).
export const REMOVED_STEMS = new Set(["XT509360"]);

// normalize a manifest thumb URL: new manifests bake absolute /i/ URLs, but a
// stale KV manifest (pre-cutover) still carries the relative legacy shape.
// Tolerating both makes the deploy/bust order irrelevant during the hash
// migration; the legacy /images/ URLs it produces 301 into /i/ at the worker.
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
// photo-add time. The manifest bakes these into /i/ URLs, so a thumbnail URL
// is born with its bytes: no global ?v= bump, and a cached 404 can never
// shadow real bytes (a new encode IS a new URL). Module-cached like _altMap.
export let _thumbHashes;

export async function getThumbHashes(env) {
  if (_thumbHashes) return _thumbHashes;
  try {
    const r = await env.ASSETS.fetch("https://assets.local/images/hashes.json");
    _thumbHashes = r.ok ? await r.json() : {};
  } catch { _thumbHashes = {}; }
  return _thumbHashes;
}

export async function getImagesManifest(env, ctx) {
  // two-key stale-while-revalidate via lib/cache.js: the manifest is the
  // persistent value, and `manifest:images:fresh` carries the 1h freshness TTL.
  // stale serves instantly; only a true first run / manual bust rebuilds inline.
  const manifest = await swrKV(env, ctx, "manifest:images", 3600, () => buildImagesManifest(env), {
    isValid: Array.isArray,
    shouldStore: (m) => Array.isArray(m) && m.length > 0,
  });
  return Array.isArray(manifest) ? manifest : [];
}

export async function buildImagesManifest(env) {
  {
    if (!env.PHOTOS_R2) return null;
    const list = await env.PHOTOS_R2.list({ limit: 1000 });

    // collapse R2 objects to one-per-stem, prefer browser-renderable extensions
    const byStem = new Map();
    for (const o of list.objects || []) {
      const stem = o.key.replace(/\.[^.]+$/, "");
      if (REMOVED_STEMS.has(stem)) continue;  // tombstoned (R2 list() is eventually
                                              // consistent, so a deleted original can
                                              // linger in list() for a while)
      const ext  = (o.key.split(".").pop() || "").toLowerCase();
      const prio = R2_EXT_PRIORITY[ext] || 0;
      const existing = byStem.get(stem);
      if (!existing || prio > existing._prio) {
        byStem.set(stem, { ...o, _prio: prio });
      }
    }

    // thumb URLs are ABSOLUTE and content-addressed (/i/<stem>.<hash8>.<ext>,
    // from hashes.json via getThumbHashes): a URL names exact bytes, served
    // immutable for a year, so there is no global version to bump and no way
    // for a cached 404 to shadow a real file. hashes.json is complete for every
    // live photo (add-photos.sh runs hash-thumbnails.sh), so a stem with no hash
    // is a half-run pipeline: SKIP it rather than bake a broken /i/undefined
    // tile, and log so the gap surfaces. (The old ?v= legacy fallback retired
    // once hashes.json went 100% complete; the /images/<thumb> 301 layer still
    // catches old external links independently of this builder.)
    //
    // dual-source: thumb_avif is the <picture> primary; thumb_jpg is
    // the universal <img src> fallback (thumb_small is the 400px mobile AVIF).
    // NB: <picture> type-fallback only catches "format not supported" — it
    // does NOT catch DECODE failures. AVIF decode failures historically caused
    // broken images here; if they recur, the fix is to demote AVIF entirely.
    // slim hot-path manifest: ONLY the fields the SSR slot-builder reads
    // (EXIF rides /images/meta/<stem>.json, fetched per photo on hover).
    const hashes = await getThumbHashes(env);
    return [...byStem.entries()].flatMap(([stem, o]) => {
      const h = hashes[stem];
      if (!h || !h.a || !h.j || !h.s) {
        console.log(`manifest: skipping ${stem} (no content-hash in hashes.json)`);
        return [];
      }
      return [{
        full:        o.key,                   // R2 key, e.g. "XT507333.JPG"
        thumb_avif:  `/i/${stem}.${h.a}.avif`,
        thumb_jpg:   `/i/${stem}.${h.j}.jpg`,
        thumb_small: `/i/${stem}-400.${h.s}.avif`,
        stem,
        size:       o.size,                   // R2 object size in bytes
        uploaded:   o.uploaded ? new Date(o.uploaded).toISOString() : null,
      }];
    }).sort((a, b) => a.full.localeCompare(b.full));
  }
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
  };

  return cachedRender(request, ctx, render, "/photos", env);
}
