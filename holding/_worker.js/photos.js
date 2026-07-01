// photos.js — extracted from the worker (no-build reorg). Bundled by
// wrangler/Cloudflare at deploy; not served (inside _worker.js/).
import { THUMB_VERSION } from "./lib/const.js";
import { errorResp, escHtml, jsonResp } from "./lib/http.js";

// ── /images/full/<key> → R2 ─────────────────────────────────────────
// proxies an R2 GET through the worker. supports If-None-Match (304s on
// cache hit), Range requests, and emits long cache headers since each
// upload is content-addressed by its filename. originals retain their
// SOOC filenames (IMG_1234.jpg, DSCF5678.heic, etc.), so the validation
// is permissive on stem but strict on extension and forbids any path
// traversal characters.
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

  // edge-cache full (non-range, non-conditional) GETs in caches.default, so a
  // repeat view of a multi-MB original is served from the colo instead of a
  // fresh R2 round-trip. originals are content-addressed + immutable, so there
  // is zero staleness risk. range + conditional requests bypass this: they need
  // R2's range / onlyIf handling and must not populate the full-body entry.
  // x-photo-cache: hit|miss makes the layer observable (and was the gate check).
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

// ── 1990s-style directory listings ──────────────────────────────────
// the 1999 web had these everywhere — Apache's mod_autoindex was the
// canonical implementation. Cloudflare Pages doesn't auto-generate them
// (the request 404s without an index file), so we hand-render in that
// visual style: bracketed icons, DD-MMM-YYYY HH:MM dates, K/M sizes,
// parent directory link. honest about the source though — the signature
// at the bottom reads "handwritten worker at aadhar.sh" rather than
// pretending to be Apache.

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

// bump to bust all `/images/<stem>.{avif,jpg}` edge-cache entries at
// once. used as a `?v=<N>` suffix in the manifest's thumb URLs. Cloudflare
// includes the query string in the cache key by default, so changing this
// produces a fresh cache lookup that doesn't see prior stale 404s.
// (10 dropped WebP; 11 grid thumbs 1200px → 500px; 12 AVIF re-encoded at
// higher quality (CQ30 → -q63); 13 the 3 grayscale Leica thumbs re-encoded
// as true monochrome (yuv420 → yuv400). same filenames each time, so the
// ?v= bump is what busts the edge cache for the new bytes.)
// THUMB_VERSION now lives in ./lib/const.js (imported at the top) — the first
// extracted module proving the no-build directory bundle.
// stems removed from the pool — excluded from the rebuilt manifest even if their
// original still lingers in R2's eventually-consistent list(). prune once R2
// list() drops them (and the entry here is harmless to keep as a record).
export const REMOVED_STEMS = new Set(["XT509360"]);

// small mobile AVIF tier (stem-400.avif), served via <source media> at <=560px.
export const THUMB_SMALL_PX = 400;

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

export async function getImagesManifest(env, ctx) {
  // two-key stale-while-revalidate: the manifest itself is stored WITHOUT a
  // TTL (persistent), and a tiny sentinel key carries the 1h freshness TTL.
  // when the sentinel lapses, the visitor on the hot path gets the stale
  // manifest immediately and the R2 list() rebuild rides ctx.waitUntil in
  // the background — nobody pays the rebuild inline except the true first
  // run (or after `wrangler kv key delete "manifest:images"`, which is
  // still the documented manual cache-bust and still forces a rebuild).
  if (env.RN_KV) {
    let manifest = null, fresh = null;
    try {
      [manifest, fresh] = await Promise.all([
        env.RN_KV.get("manifest:images", "json"),
        env.RN_KV.get("manifest:images:fresh"),
      ]);
    } catch {}
    if (manifest) {
      if (!fresh && ctx) {
        ctx.waitUntil(
          buildImagesManifest(env)
            .then(m => m && storeImagesManifest(env, m))
            .catch(() => {})
        );
      }
      return manifest;
    }
  }
  // no cached manifest at all — build inline (first run / manual bust)
  const manifest = await buildImagesManifest(env);
  if (!manifest) return [];
  if (env.RN_KV && ctx) ctx.waitUntil(storeImagesManifest(env, manifest));
  return manifest;
}

export async function storeImagesManifest(env, manifest) {
  await Promise.all([
    env.RN_KV.put("manifest:images", JSON.stringify(manifest)),
    env.RN_KV.put("manifest:images:fresh", "1", { expirationTtl: 3600 }),
  ]);
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

    // EXIF metadata, keyed by stem. read once from the static asset
    // /images/metadata.json (generated by extract-photo-metadata.sh) and
    // bust stale edge-cached 404s. appending a `?v=N` to thumb URLs
    // forces a fresh cache lookup (CF includes the query in the cache
    // key by default). incrementing THUMB_VERSION is the supported way
    // to invalidate all thumbnail caches at once.
    //
    // dual-source: thumb_avif is the <picture> primary; thumb_jpg is
    // the universal <img src> fallback. NB: <picture> type-fallback only
    // catches "format not supported" — it does NOT catch DECODE failures.
    // AVIF decode failures historically caused broken images here; if
    // they recur, the fix is to demote AVIF entirely, not add fallbacks.
    // slim hot-path manifest: ONLY the fields the SSR slot-builder reads.
    // EXIF used to be merged in here (and shipped inline per slot) — the
    // manifest is read + JSON-parsed by the worker on EVERY no-store homepage
    // hit, and the EXIF was the bulk of the blob. the tooltip now lazy-fetches
    // /images/meta/<stem>.json per photo on first hover (histogram computed
    // client-side), so none of it needs to ride the hot path.
    const v = THUMB_VERSION;
    return [...byStem.entries()].map(([stem, o]) => ({
      full:       o.key,                     // R2 key, e.g. "XT507333.JPG"
      thumb_avif: `${stem}.avif?v=${v}`,     // Pages static AVIF (primary)
      thumb_jpg:  `${stem}.jpg?v=${v}`,      // Pages static JPG (fallback)
      stem,
      size:       o.size,                    // R2 object size in bytes
      uploaded:   o.uploaded ? new Date(o.uploaded).toISOString() : null,
    })).sort((a, b) => a.full.localeCompare(b.full));
  }
}

export async function handleImagesManifest(request, env, ctx) {
  const photos = await getImagesManifest(env, ctx);
  return jsonResp({ photos, count: photos.length });
}

export async function handleImagesIndex(request, env, ctx) {
  // probe the static asset layer for each known thumbnail. cache the
  // result in KV for an hour. uses GET (not HEAD) because env.ASSETS
  // doesn't reliably populate Content-Length, then reads the body via
  // arrayBuffer to count bytes.
  let entries = null;
  if (env.RN_KV) {
    try { entries = await env.RN_KV.get("idx:images", "json"); } catch {}
  }
  if (!entries) {
    // derive thumbnail filenames from the photo manifest. picks up new
    // uploads automatically (no POOL_COUNT bump needed). manifest stores
    // thumb URLs with a `?v=N` cache-bust suffix; strip it for the
    // human-readable directory listing (the probe still resolves the
    // underlying static asset regardless of the query string).
    const manifest = await getImagesManifest(env, ctx);
    const stripVer = (s) => String(s || "").replace(/\?.*$/, "");
    const names = manifest.flatMap(p => [
      stripVer(p.thumb_avif),
      stripVer(p.thumb_jpg),
    ]).filter(Boolean);
    entries = await Promise.all(names.map(async (name) => {
      try {
        const probeUrl = new URL(`/images/${name}`, request.url).toString();
        const res = await env.ASSETS.fetch(probeUrl);
        if (!res.ok) return null;
        // env.ASSETS doesn't populate Content-Length on its responses
        // (likely chunked internally), so read the body to count bytes.
        // expensive once per cache miss (~7MB across 68 files); harmless
        // since we cache the listing in KV for an hour afterward.
        let size = parseInt(res.headers.get("content-length") || "0", 10);
        if (!size && res.body) {
          const buf = await res.arrayBuffer();
          size = buf.byteLength;
        }
        return {
          name,
          size,
          lastModified: res.headers.get("last-modified") || null,
        };
      } catch {
        return null;
      }
    }));
    entries = entries.filter(Boolean);
    entries.sort((a, b) => a.name.localeCompare(b.name));
    // prepend the full/ subdirectory entry
    entries = [{ name: "full/", size: null, lastModified: null, isDir: true }, ...entries];
    if (env.RN_KV) {
      ctx.waitUntil(env.RN_KV.put("idx:images", JSON.stringify(entries), { expirationTtl: 3600 }));
    }
  }

  return apacheIndexResponse("/images", entries);
}

export async function handleImagesFullIndex(request, env, ctx) {
  if (!env.PHOTOS_R2) {
    return errorResp("R2 not bound", 503);
  }
  // R2 lists are cheap; cache 5 min so it's snappy without going too stale.
  let entries = null;
  if (env.RN_KV) {
    try { entries = await env.RN_KV.get("idx:imagesfull", "json"); } catch {}
  }
  if (!entries) {
    const list = await env.PHOTOS_R2.list({ limit: 1000 });
    entries = (list.objects || [])
      .map(o => ({
        name:         o.key,
        size:         o.size,
        lastModified: o.uploaded ? new Date(o.uploaded).toUTCString() : null,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
    if (env.RN_KV) {
      ctx.waitUntil(env.RN_KV.put("idx:imagesfull", JSON.stringify(entries), { expirationTtl: 300 }));
    }
  }

  return apacheIndexResponse("/images/full", entries);
}

export function apacheIndexResponse(path, entries) {
  const fmtSize = (b) => {
    if (b === null || b === undefined) return "-";
    if (b < 1024)            return String(b);
    if (b < 1024 * 1024)     return `${Math.round(b / 1024)}K`;
    if (b < 1024 * 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1)}M`;
    return `${(b / 1024 / 1024 / 1024).toFixed(1)}G`;
  };
  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const pad = (n) => String(n).padStart(2, "0");
  const fmtDate = (s) => {
    if (!s) return "                 -";
    const d = new Date(s);
    if (isNaN(d)) return "                 -";
    return `${pad(d.getUTCDate())}-${months[d.getUTCMonth()]}-${d.getUTCFullYear()} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
  };
  const iconFor = (e) => {
    if (e.isDir) return "[DIR]";
    const ext = e.name.split(".").pop().toLowerCase();
    if (["jpg","jpeg","png","gif","avif","webp","heic","heif","bmp","tiff"].includes(ext)) return "[IMG]";
    if (["txt","md","xml","json","csv"].includes(ext)) return "[TXT]";
    if (["mp3","wav","flac","ogg"].includes(ext)) return "[SND]";
    if (["mp4","mov","webm","avi"].includes(ext)) return "[VID]";
    return "[   ]";
  };

  // parent directory link — one level up. an empty join produces an
  // empty string, which would yield "//" if we naively appended "/". so:
  // build the path explicitly and reuse "/" as the root case.
  const parts = path.split("/").filter(Boolean);
  const parentParts = parts.slice(0, -1);
  const parentHref = parts.length === 0
    ? null
    : parentParts.length === 0 ? "/" : "/" + parentParts.join("/") + "/";

  const formatRow = (icon, nameHtml, dateStr, sizeStr) => {
    // padded to look like the classic Apache <pre>-formatted listing
    const namePart  = nameHtml.padEnd(31, " ");
    const datePart  = dateStr.padEnd(17, " ");
    const sizePart  = sizeStr.padStart(5, " ");
    return `${icon} <a href="${nameHtml.replace(/<[^>]+>/g, "")}">${nameHtml}</a>${" ".repeat(Math.max(0, 30 - nameHtml.replace(/<[^>]+>/g, "").length))}  ${datePart}  ${sizePart}`;
  };

  let rows = "";
  if (parentHref) {
    rows += `[DIR] <a href="${parentHref}">Parent Directory</a>                                   -\n`;
  }
  for (const e of entries) {
    const icon = iconFor(e);
    const displayName = e.isDir ? e.name : e.name;
    const linkHref = e.isDir ? displayName : encodeURIComponent(displayName).replace(/%2F/g, "/");
    const padded = displayName.length > 28 ? displayName.slice(0, 25) + ".." : displayName;
    const namePad = " ".repeat(Math.max(0, 30 - padded.length));
    rows += `${icon} <a href="${linkHref}">${escHtml(padded)}</a>${namePad}  ${fmtDate(e.lastModified)}  ${fmtSize(e.size).padStart(6, " ")}\n`;
  }

  const html = `<!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 3.2 Final//EN">
<html>
 <head>
  <title>Index of ${escHtml(path)}</title>
  <style>
    body { background: #ffffff; color: #000000; font-family: monospace; padding: 12px; }
    h1 { font-family: Helvetica, Arial, sans-serif; font-weight: bold; font-size: 14pt; margin: 0 0 12px; }
    pre { font-family: "Courier New", Courier, monospace; font-size: 10pt; line-height: 1.5; margin: 0; }
    a { color: #0000ee; text-decoration: underline; }
    a:visited { color: #551a8b; }
    hr { border: 0; border-top: 1px solid #000000; margin: 8px 0; }
    address { font-family: Helvetica, Arial, sans-serif; font-size: 9pt; font-style: italic; color: #000000; }
  </style>
 </head>
 <body>
<h1>Index of ${escHtml(path)}</h1>
<hr>
<pre>      Name                            Last modified      Size
<hr>${rows}<hr></pre>
<address>handwritten worker at aadhar.sh</address>
<script src="/nav.js" defer></script>
 </body>
</html>`;

  return new Response(html, {
    status: 200,
    headers: {
      "content-type":  "text/html; charset=utf-8",
      "cache-control": "public, max-age=60, s-maxage=300",
    },
  });
}
