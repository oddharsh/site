// photos.ts: everything photo-shaped the Worker serves. Originals out of R2 at
// /images/full, the curated and album pools, /photos and the album pages,
// /photos/query.json, and the image manifest and sitemap.

import { cachedRender } from "./lib/cache.ts";
import { PHOTO_QUERY_LIMITS, clampParam } from "./lib/api-limits.ts";
import { EMPTY, html, joinHtml, unsafeHtml, type Html } from "./lib/html.ts";
import { asScalarText } from "./lib/parse.ts";
import { lunaPage } from "./lib/chrome.ts";
import { ARCHIVE_VERSION } from "./lib/const.ts";
import { errorResp, escAttr, escHtml, jsonResponse, publicJsonHeaders } from "./lib/http.ts";
import { commonPairs, compareCodepoints, queryTerms, scoreFields } from "./lib/text.ts";
import { ALBUMS, albumPath, type Album } from "./albums.ts";
import photoIndex from "./photo-index.json" with { type: "json" };
import thumbHashes from "../../public/images/hashes.json" with { type: "json" };

type PhotoRecord = {
  full?: string;
  size?: number;
  uploaded?: string | null;
  album?: string | null;
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

const MOVED_JPEGS = new Map(Object.values(photoIndex as Record<string, { full?: string; jpeg?: string }>)
  .flatMap((p) => (p.jpeg && p.full ? [[p.jpeg, p.full] as const] : [])));

const movedTo = (url: URL, key: string) => new Response(null, {
  status: 301,
  headers: { location: `${url.origin}/images/full/${key}`, "cache-control": "public, max-age=86400" },
});

export async function servePhotoFromR2(request, env, ctx) {
  if (!env.PHOTOS_R2) {
    return errorResp("R2 bucket not bound", 503);
  }

  const url = new URL(request.url);
  const key = url.pathname.replace(/^\/images\/full\//, "");
  if (!/^[A-Za-z0-9_.-]+\.(?:jpe?g|png|heic|heif|hif|avif|gif|jxl)$/i.test(key)) {
    return errorResp("not found", 404);
  }

  const recorded = MOVED_JPEGS.get(key);
  if (recorded) return movedTo(url, recorded);
  const moved = /\.jpe?g$/i.test(key) ? key.replace(/\.jpe?g$/i, ".jxl") : null;

  const ifNoneMatch = request.headers.get("if-none-match");
  const range       = request.headers.get("range");

  const cacheable = request.method === "GET" && !range && !ifNoneMatch;
  const cache = caches.default;
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
  // matches, which becomes the 304 below.
  const getOpts: R2GetOptions = {};
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
  // null means the key doesn't exist. A failed precondition is a different
  // answer: an R2Object with metadata and no body, so a matching
  // If-None-Match lands here as an object, never as null.
  if (obj === null) {
    if (moved && await env.PHOTOS_R2.head(moved)) return movedTo(url, moved);
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
  headers.set("content-type",  obj.httpMetadata?.contentType || (/\.jxl$/i.test(key) ? "image/jxl" : "image/jpeg"));
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
    ctx.waitUntil(cache.put(cacheKey, resp.clone()));
    resp.headers.set("x-photo-cache", "miss");
  }
  return resp;
}

export function derivePhotoPool(index: PhotoIndexMap, hashes: ThumbHashMap) {
  return Object.entries(index || {}).flatMap(([stem, p]) => {
    const h = hashes?.[stem];
    if (!h || !h.a || !h.j || !h.s) {
      console.log(`photo pool: skipping ${stem} (no content-hash in hashes.json)`);
      return [];
    }
    return [{
      full:        p.full,
      thumb_avif:  `/i/${stem}.${h.a}.avif`,
      thumb_jpg:   `/i/${stem}.${h.j}.jpg`,
      thumb_small: `/i/${stem}-400.${h.s}.avif`,
      thumb_xs:    h.x ? `/i/${stem}-200.${h.x}.avif` : null,
      stem,
      size:       p.size,
      uploaded:   p.uploaded || null,
      album:      p.album || null,
      heif:       p.heif || null,
    }];
  }).sort((a, b) => (a.full < b.full ? -1 : a.full > b.full ? 1 : 0));
}

export const PHOTO_POOL = derivePhotoPool(photoIndex, thumbHashes);

export const curatedPool = (pool: ReturnType<typeof derivePhotoPool>) => pool.filter((p) => !p.album);
export const albumPool = (pool: ReturnType<typeof derivePhotoPool>, album: Album) => pool.filter((p) => p.album === album.slug);
export const CURATED_POOL = curatedPool(PHOTO_POOL);

export let _altMap;

export async function getAltMap(env) {
  if (_altMap) return _altMap;
  try {
    const r = await env.ASSETS.fetch("https://assets.local/images/alt.json");
    _altMap = r.ok ? await r.json() : {};
  } catch { _altMap = {}; }
  return _altMap;
}

export let _histograms;

export async function getHistogramMap(env) {
  if (_histograms) return _histograms;
  try {
    const r = await env.ASSETS.fetch("https://assets.local/images/histograms.json");
    _histograms = r.ok ? await r.json() : {};
  } catch { _histograms = {}; }
  return _histograms;
}

export let _thumbHashes;

export async function getThumbHashes(env) {
  if (_thumbHashes) return _thumbHashes;
  try {
    const r = await env.ASSETS.fetch("https://assets.local/images/hashes.json");
    _thumbHashes = r.ok ? await r.json() : {};
  } catch { _thumbHashes = {}; }
  return _thumbHashes;
}

export function _resetPhotoCaches() {
  _altMap = undefined;
  _thumbHashes = undefined;
  _histograms = undefined;
  _photoJson.clear();
  _preparedFields = undefined;
}

const PHOTO_PUBLIC_FIELDS = [
  "camera", "lens", "aperture", "shutter", "iso", "focal", "ev", "date",
  "width", "height", "color_space", "white_balance", "color_temp", "wb_shift",
  "flash", "exposure_mode", "meter", "focus_mode", "drive", "sharpness",
  "noise_reduction", "clarity", "film", "dr", "dr_value", "chrome", "chrome_blue",
  "grain", "grain_size", "highlight_tone", "shadow_tone", "saturation",
  "recipe",
];

const _photoJson = new Map<string, unknown>();

async function getStaticPhotoJson<T>(env, path, fallback: T): Promise<T> {
  if (_photoJson.has(path)) return _photoJson.get(path) as T;
  try {
    const r = await env.ASSETS.fetch(`https://assets.local/${path}`);
    if (!r.ok) return fallback;
    const value = await r.json() as T;
    _photoJson.set(path, value);
    return value;
  } catch { return fallback; }
}

function photoMetadata(record) {
  return Object.fromEntries(PHOTO_PUBLIC_FIELDS.filter((key) => record && record[key] !== undefined).map((key) => [key, record[key]]));
}

const PHOTO_FIELD_WEIGHTS = [
  ["film", 6],
  ["alt", 5],
  ["camera", 4],
  ["lens", 4],
  ["expansion", 3],
  ["year", 3],
  ["recipe", 2],
  ["stem", 1],
];

function photoFields(stem, record, alt, expansion): Record<string, string> {
  const date = String(record.date || "").slice(0, 10).replaceAll(":", "-");
  return {
    film: String(record.film || ""),
    alt: String(alt || ""),
    camera: String(record.camera || ""),
    lens: String(record.lens || ""),
    expansion: String(expansion || ""),
    year: date.slice(0, 4),
    recipe: Object.entries(record.recipe || {}).map(([k, v]) => `${k}: ${asScalarText(v)}`).join(" "),
    stem: String(stem),
  };
}

let _preparedFields: { metadata: object; altMap: unknown; semantics: unknown; byStem: Map<string, Record<string, string>> } | undefined;

function preparedFieldsFor(metadata: Record<string, PhotoRecord>, altMap, semantics) {
  const cached = _preparedFields;
  if (cached && cached.metadata === metadata && cached.altMap === altMap && cached.semantics === semantics) return cached.byStem;
  const byStem = new Map(Object.entries(metadata).map(([stem, record]) => [stem, Object.fromEntries(
    Object.entries(photoFields(stem, record, altMap?.[stem], semantics?.[stem]?.terms)).map(([name, text]) => [name, text.toLowerCase()]),
  )]));
  _preparedFields = { metadata, altMap, semantics, byStem };
  return byStem;
}

export async function queryPhotos(env, options: PhotoQueryOptions = {}, _ctx = null) {
  const { textMax, dateMax } = PHOTO_QUERY_LIMITS;
  const q = String(options.q || "").trim().slice(0, textMax).toLowerCase();
  const camera = String(options.camera || "").trim().slice(0, textMax).toLowerCase();
  const lens = String(options.lens || "").trim().slice(0, textMax).toLowerCase();
  const film = String(options.film || "").trim().slice(0, textMax).toLowerCase();
  const recipe = String(options.recipe || "").trim().slice(0, textMax).toLowerCase();
  const from = String(options.from || "").trim().slice(0, dateMax);
  const to = String(options.to || "").trim().slice(0, dateMax);
  const limit = clampParam(options.limit, PHOTO_QUERY_LIMITS.limitDefault, PHOTO_QUERY_LIMITS.limitMax);
  const offset = clampParam(options.offset, 0, PHOTO_QUERY_LIMITS.offsetMax, 0);
  const [metadata, altMap, hashes, semantics] = await Promise.all([
    getStaticPhotoJson<Record<string, PhotoRecord>>(env, "images/metadata.json", {}),
    getAltMap(env),
    getThumbHashes(env),
    getStaticPhotoJson<Record<string, { terms?: unknown }> | null>(env, "images/semantics.json", null),
  ]);
  const manifestByStem = new Map(PHOTO_POOL.map((photo) => [photo.stem, photo]));

  const kept = Object.entries(metadata || {}).filter(([, record]) => {
    if (camera && !String(record.camera || "").toLowerCase().includes(camera)) return false;
    if (lens && !String(record.lens || "").toLowerCase().includes(lens)) return false;
    if (film && !String(record.film || "").toLowerCase().includes(film)) return false;
    if (recipe) {
      const card = Object.entries(record.recipe || {}).map(([k, v]) => `${k}: ${asScalarText(v)}`).join("\n").toLowerCase();
      if (!card.includes(recipe)) return false;
    }
    const date = String(record.date || "").slice(0, 10).replaceAll(":", "-");
    if (from && date < from) return false;
    if (to && date > to) return false;
    return true;
  });

  const { terms: queryTermList, dropped } = queryTerms(q);
  let ranked = kept.map(([stem, record]) => ({ stem, record, scored: null }));
  let mode = "filters-only";
  let common = [];

  if (q) {
    const prepared = preparedFieldsFor(metadata || {}, altMap, semantics);
    const candidates = kept.map(([stem, record]) => ({ stem, record, fields: prepared.get(stem) }));
    const { skip, common: suppressed } = commonPairs(candidates.map((row) => row.fields), PHOTO_FIELD_WEIGHTS, queryTermList);
    common = suppressed;
    const scoredRows = candidates.map(({ stem, record, fields }) => ({
      stem,
      record,
      scored: scoreFields(fields, PHOTO_FIELD_WEIGHTS, queryTermList, skip),
    })).filter((row) => row.scored.hits > 0);
    const full = scoredRows.filter((row) => row.scored.hits === queryTermList.length);
    ranked = full.length ? full : scoredRows;
    mode = !queryTermList.length ? "no-terms"
      : full.length ? "all-terms"
        : scoredRows.length ? "partial" : "no-match";
  }

  const dateOf = (record) => String(record.date || "").slice(0, 10).replaceAll(":", "-");
  ranked.sort((a, b) =>
    (b.scored?.score || 0) - (a.scored?.score || 0)
    || compareCodepoints(dateOf(b.record), dateOf(a.record))
    || compareCodepoints(a.stem, b.stem));

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
    if (scored) {
      row.score = scored.score;
      row.matched = scored.matched;
    }
    return row;
  });

  const ranking: { mode: string; terms: string[]; dropped?: string[]; common?: string[]; semantic?: boolean } = { mode, terms: queryTermList };
  if (dropped.length) ranking.dropped = dropped;
  if (common.length) ranking.common = common;
  ranking.semantic = Boolean(semantics);

  return {
    query: { q, camera, lens, film, recipe, from, to },
    ranking,
    total: rows.length,
    offset,
    limit,
    photos: rows.slice(offset, offset + limit),
  };
}

export async function photoFacets(env) {
  const metadata = await getStaticPhotoJson<Record<string, PhotoRecord>>(env, "images/metadata.json", {});
  const tally = { camera: new Map(), lens: new Map(), film: new Map(), year: new Map() };
  const bump = (map, key) => { if (key) map.set(key, (map.get(key) || 0) + 1); };
  const records = Object.values(metadata || {});
  for (const record of records) {
    bump(tally.camera, record.camera);
    bump(tally.lens, record.lens);
    bump(tally.film, record.film);
    bump(tally.year, String(record.date || "").slice(0, 4) || null);
  }
  const rank = (map) => [...map.entries()].sort((a, b) => b[1] - a[1] || compareCodepoints(a[0], b[0])).map(([name, count]) => ({ name, count }));
  return { total: records.length, camera: rank(tally.camera), lens: rank(tally.lens), film: rank(tally.film), year: rank(tally.year) };
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
  return jsonResponse(payload, 200, { ...publicJsonHeaders(200), "x-robots-tag": "noindex" }, { pretty: false });
}

export function imagesManifestJson(photos: ReturnType<typeof derivePhotoPool>): string {
  return JSON.stringify({ _address: "handwritten worker at aadhar.sh", photos, count: photos.length });
}

export function imageSitemapXml(photos: ReturnType<typeof derivePhotoPool>, albums: Album[]): string {
  const xml = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const page = (path: string, members: ReturnType<typeof derivePhotoPool>) =>
    `  <url>\n    <loc>https://aadhar.sh${path}</loc>\n`
    + members.filter((p) => p.full).map((p) => `    <image:image><image:loc>${xml(`https://aadhar.sh${fullUrl(p.full)}`)}</image:loc></image:image>\n`).join("")
    + `  </url>\n`;
  return `<?xml version="1.0" encoding="UTF-8"?>\n`
    + `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">\n`
    + page("/photos", curatedPool(photos))
    + albums.map((album) => page(albumPath(album), albumPool(photos, album))).join("")
    + `</urlset>\n`;
}

export const IMAGES_MANIFEST_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "public, max-age=300, s-maxage=600",
  "access-control-allow-origin": "*",
};

export function handleImagesManifest() {
  return new Response(imagesManifestJson(PHOTO_POOL), { headers: IMAGES_MANIFEST_HEADERS });
}

const fullUrl = (key: string | undefined) => `/images/full/${encodeURIComponent(key ?? "").replace(/%2F/g, "/")}`;

// One tile: the 400px AVIF over the 600px JPG, opening the SOOC JPEG. `extra`
// is the album page's per-tile format links; it sits OUTSIDE the anchor because
// an <a> inside an <a> is invalid HTML and the parser hoists it out (gotcha 8).
// Built with the `html` tag, so every interpolation is escaped by construction
// and the album page below opens no unescaped door at all.
//
// This replaced loading="lazy" on 2026-10-07. Chrome resolves lazy images
// within about 1,250 px of the screen on a fast link, so a desktop visit to
// /photos fetched 47 tiles (563 KB) where 12 were meant to be eager.
const EAGER_TILES = 12;
function renderTile(p, altMap, i: number, extra: Html = EMPTY): Html {
  const alt = (altMap && altMap[p.stem]) || p.stem;
  const picture = i < EAGER_TILES
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

// The root is the sheet's scrolling ancestor. Luna pages scroll inside
// `.window > .content`, and a rootMargin only enlarges the root: with the
// viewport as root, the scroller still clips each tile to its visible area, and
// the quarter-screen lead would shrink to nothing. `body` and `html` are skipped,
// because their overflow can propagate to the viewport, and observing against
// them would count every tile as in view.
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

export function renderPhotosPage(photos, altMap) {
  const curated = curatedPool(photos);
  if (!curated.length) {
    return new Response("photo manifest unavailable", {
      status: 503,
      headers: { "content-type": "text/plain; charset=utf-8", "retry-after": "60" },
    });
  }

  const tiles = joinHtml(curated.map((p, i) => renderTile(p, altMap, i)), "\n").html;
  const albums = Object.values(ALBUMS)
    .map((a) => ({ album: a, count: albumPool(photos, a).length }))
    .filter(({ count }) => count > 0);
  const albumsLine = albums.length
    ? `\n    Albums: ${albums.map(({ album, count }) =>
        `<a href="${escAttr(albumPath(album))}">${escHtml(album.title)}</a> (${count})`).join(" &middot; ")}.`
    : "";

  return lunaPage({
    title: "aadhar.sh/photos",
    path: "aadhar.sh/photos",
    route: "/photos",
    width: 980,
    description: `All ${curated.length} photos, straight out of camera. FUJIFILM X-T50 + Leica M.`,
    ogImage: curated[0].thumb_jpg,
    ogImageAlt: (altMap && altMap[curated[0].stem]) || curated[0].stem,
    css: SHEET_CSS,
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

export function renderAlbumPage(album: Album, photos, altMap) {
  const members = albumPool(photos, album);
  if (!members.length) {
    return new Response("album unavailable", {
      status: 503,
      headers: { "content-type": "text/plain; charset=utf-8", "retry-after": "60" },
    });
  }
  const tiles = joinHtml(members.map((p, i) => {
    const links = [html`<a href="${fullUrl(p.full)}" download>${/\.jxl$/i.test(p.full ?? "") ? "JPEG XL" : "JPEG"}</a>`];
    if (p.heif) links.push(html`<a href="${fullUrl(p.heif)}" download>HEIF</a>`);
    return renderTile(p, altMap, i, html`
<span class="ph-fmt">${joinHtml(links, " &middot; ")}</span>`);
  }), "\n");

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
    ${joinHtml(album.lede.map((line) => html`${line}`), "<br>\n    ")}
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
  return cachedRender(request, ctx, render, albumPath(album), env);
}

export async function handlePhotos(request, env, ctx) {
  const render = async () => renderPhotosPage(PHOTO_POOL, await getAltMap(env));
  return cachedRender(request, ctx, render, "/photos", env);
}
