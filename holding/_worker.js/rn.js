// rn.js — extracted from the worker (no-build reorg). Bundled by
// wrangler/Cloudflare at deploy; not served (inside _worker.js/).
import { signedFetch } from "./lib/botauth.js";
import { deleteSWRKV, swrKV } from "./lib/cache.js";
import { lunaPage } from "./lib/chrome.js";
import { esc, escAttr, escHtml, jsonResp, timingSafeEqual, wantsMarkdown } from "./lib/http.js";
import { span } from "./lib/trace.js";

// ── /rn redirect target ─────────────────────────────────────────────
// the link on the site is static (/rn). the redirect target lives in KV
// under the key "playlist-id" (just the 22-char spotify id).
//
// updating after a rollover (desktop-friendly):
//   bookmark https://aadhar.sh/rn/admin?secret=<RN_BUST_SECRET>
//   click bookmark → paste new playlist URL → submit.
// updating from a shortcut / curl:
//   https://aadhar.sh/rn/set?secret=<RN_BUST_SECRET>&url=<new playlist url>
//
// required binding:  RN_KV (wrangler.jsonc kv_namespaces)
// required env:      RN_BUST_SECRET (Worker secret)
//
// if KV is empty (first deploy, or you deliberately cleared it), the
// redirect falls back to the playlist URL hardcoded below.
export const RN_FALLBACK = "https://open.spotify.com/playlist/4IRq9W1N2tOWHhH0O3vXiF";

// ── /rn handler ─────────────────────────────────────────────────────
// This route has NO page of its own: it is a 302 to Spotify, and a browser that
// follows it lands on a JS application. That is fine for a human and useless to
// an agent, which is why site-manifest's `agents: true` on /rn was advertising a
// bounce off-site. It also fooled check-infra, whose probe follows redirects and
// so reported /rn's content-type as text/html when the text/html was Spotify's.
//
// So /rn answers Markdown instead of redirecting, and the answer is RENDERED
// from the same live payload /rn/tracks serves rather than described in a twin
// under holding/md/. There is nothing fixed here to hand-author: the playlist
// changes, and a file claiming otherwise would be wrong within a rollover. This
// also cannot drift by construction, which is the property the twin machinery
// buys with checkTwinFacts.
export async function handleRn(request, env, ctx) {
  if (wantsMarkdown(request)) return handleRnMarkdown(request, env, ctx);

  return new Response(null, {
    status: 302,
    headers: {
      "location":        await playlistUrl(env),
      "cache-control":   "no-store, must-revalidate",
      "referrer-policy": "no-referrer",
    },
  });
}

// The playlist the redirect points at, resolved the same way for both
// representations so the Markdown one cannot cite a different playlist than the
// one a browser is sent to.
async function playlistUrl(env) {
  let playlistId = null;
  if (env?.RN_KV) {
    try { playlistId = await env.RN_KV.get("playlist-id"); } catch {}
  }
  return (playlistId && /^[0-9A-Za-z]{22}$/.test(playlistId))
    ? `https://open.spotify.com/playlist/${playlistId}`
    : RN_FALLBACK;
}

// ── /rn/tracks handlers ─────────────────────────────────────────────
// returns the current "rn" playlist's track list as JSON. data is pulled
// from spotify's public embed pages — three tiers of scrape:
//
//   1. playlist embed → gives the ordered track list (IDs, titles, durations,
//      explicit flag, audio preview URLs)
//   2. track embed    → gives the album cover URL + the artist list with
//      stable Spotify URIs (the playlist embed only has a joined "Artist A,
//      Artist B" subtitle string with no IDs)
//   3. artist embed   → gives the artist's profile picture
//
// the artist payload is cached in KV under `artist:<id>` with a long TTL
// since artist photos rarely change; subsequent playlist refreshes don't
// re-scrape known artists. tracks themselves are cached under
// `tracks:<playlist-id>` for 1 hour so per-page-load cost is zero.
//
// shape returned:
//   { playlist_id, playlist_name,
//     tracks: [{ id, title, artists_text, artists: [{id, name, spotify_url,
//                image_url}], image_url, song_link_url, spotify_url,
//                duration_ms, preview_url, is_explicit }] }
//
// force-refresh with /rn/tracks?bust=<RN_BUST_SECRET>.
// Spotify scrape goes through signedFetch (lib/botauth.js): the AadharshBot UA
// plus a required Web Bot Auth signature (RFC 9421). If the signing key is not
// available, the scrape fails closed instead of making an unsigned request.
// The embed pages are public + cacheable, so neither the UA nor the signature
// affects what Spotify serves.
export const RN_TRACKS_TTL  = 3600;

            // 1h: playlist tracks payload
export const ARTIST_KV_TTL  = 30 * 86400;

      // 30d: artist profile (rarely changes)

// Spotify serves the same art under several interchangeable CDN aliases, and
// this file asks for art in two independent places: the per-track embed (tier 2)
// and the per-artist embed (tier 3). Nothing makes those two scrapes agree on a
// hostname, so one album cover can come back as image-cdn-fa under one track and
// image-cdn-ak under another. Browsers cache by origin, so identical bytes then
// download twice, over two TLS handshakes to two origins.
//
// Measured on a cold incognito load, 2026-07-30: ab67616d…3ba2c arrived from
// both hosts at 50,045 and 50,043 bytes, decoding to an identical 49,727. That
// is 48.9 KB and a whole extra connection spent on bytes already in cache, out
// of 849.9 KB of album art on that page.
//
// i.scdn.co is Spotify's canonical image host and is ALREADY in the CSP, so
// this narrows what the page talks to rather than widening it. Verified the same
// day that all three hosts return byte-identical objects: sha256 matched across
// three different image hashes, i.scdn.co included.
//
// Applied where the URL is EMITTED rather than only where it is scraped. Artist
// records live in KV for ARTIST_KV_TTL (30 days) and the tracks payload for
// RN_TRACKS_TTL, so normalizing at the scrape alone would leave a month-long
// tail of already-cached aliases. The emit path is the one choke point every
// source flows through, cache included.
//
// Deliberately narrow: only a /image/ path on a recognized alias is rewritten.
// Anything else (mosaic.scdn.co, a shape Spotify has not shipped yet, a value
// that will not even parse) passes through exactly as found, because a wrong
// rewrite here is a broken image and the fallback is a URL that already works.
const SPOTIFY_ART_ALIAS = /^image-cdn-[a-z0-9]+\.spotifycdn\.com$/i;
export function canonicalArtUrl(raw) {
  if (!raw) return raw;
  try {
    const u = new URL(raw);
    if (SPOTIFY_ART_ALIAS.test(u.hostname) && u.pathname.startsWith("/image/")) {
      u.hostname = "i.scdn.co";
      return u.toString();
    }
  } catch { /* not parseable as a URL: leave it alone rather than guess */ }
  return raw;
}

// ── /rn/art/<hash>-<width>-<v> — album + artist art, re-hosted and resized ────
//
// WHY this exists. Measured on a cold incognito load, 2026-07-30: 849.9 KB of
// Spotify art against 148.5 KB of first-party transfer, 18 unique covers at
// ~47 KB each. The art is hover-gated, so a visitor who never touches the track
// list pays none of it, but it was still the largest thing on the page by a wide
// margin AND the last cross-origin asset class the site served. Both problems
// have the same fix.
//
// Spotify's hash IS a content address, which is what makes this cheap to run.
// A playlist change mints new hashes, which miss the cache and fetch on demand,
// so the scrape gains NO new responsibility and there is no sync job. Nothing
// ever needs purging either: an unreferenced hash is simply never requested
// again and caches.default evicts it on its own. That is the same property that
// let THUMB_VERSION retire once /i/<stem>.<hash8> shipped, and the reason this
// needs none of the ARCHIVE_VERSION machinery /images/full does — those URLs get
// overwritten in place, and a Spotify hash never is.
//
// ART_VERSION rides the PUBLIC path rather than a private cache key, because a
// 1-year immutable response cannot be corrected any other way. Bump it to
// re-tune width or quality; old URLs keep serving whatever they already cached,
// which is why the handler does not validate the version beyond its shape.
export const ART_VERSION = 1;

// Two tiers for one 120px box: luna.css pins .xp-tooltip .cover.album to
// 120x120, so 1x wants 120 and 2x wants 240, and srcset lets the browser take
// only the one it needs. Billing is per UNIQUE transformation per calendar
// month, so two tiers across ~20 covers is ~40 against the Images Free plan's
// 5,000 — and the Free plan has no overage charge at all, it errors instead.
const ART_WIDTHS = new Set([120, 240]);

// AVIF primary with a JPEG universal fallback, chosen in the MARKUP by
// <picture>, exactly like the photo grid. The tempting alternative was
// format:auto with Vary: accept, and it was rejected: one URL would then answer
// with different bytes per browser, which puts the whole design at the mercy of
// how faithfully three cache layers honour Vary — including caches.default,
// where that behaviour cannot be verified from `wrangler dev`. Getting it wrong
// serves an AVIF to a client that cannot decode one, and the symptom would be a
// broken image for a minority of visitors. Pinning the format per URL means one
// URL names exactly one byte string, needs no Vary, and lets the BROWSER choose,
// which is the arrangement the site already trusts everywhere else.
// (Gotcha 7 still applies: <picture> catches "format unsupported", never a
// decode failure. If broken-image reports appear, demote AVIF here.)
const ART_EXT = { avif: "image/avif", jpg: "image/jpeg" };

// 40 lowercase hex, which is every Spotify image id observed (16-char kind
// prefix + 24-char digest). This regex is the ONLY thing standing between this
// route and an open image proxy anyone could aim at any host, so it is an
// allowlist of shape, not a sanitizer — nothing is stripped or repaired, a
// non-match is a 404.
const ART_HASH = /^[0-9a-f]{40}$/;
const ART_PATH = /^\/rn\/art\/([0-9a-f]{40})-(\d{2,4})-(\d{1,4})\.(avif|jpg)$/;

// Pull the content address out of any Spotify image URL we recognize. Returns
// null for everything else (mosaic.scdn.co, a shape Spotify has not shipped
// yet, a non-URL), and every caller treats null as "emit the original URL
// untouched" — degrading to the cross-origin fetch that works today beats
// serving a 404 through our own origin.
export function spotifyArtHash(raw) {
  if (!raw) return null;
  try {
    const u = new URL(canonicalArtUrl(raw));
    if (u.hostname !== "i.scdn.co") return null;
    const id = u.pathname.slice("/image/".length);
    return u.pathname.startsWith("/image/") && ART_HASH.test(id) ? id : null;
  } catch { return null; }
}

// What a hover surface needs to build one <picture>: an AVIF srcset carrying
// both density tiers, and a single JPEG the <img> can always fall back to. Only
// three transformations per cover, because the fallback is the rare path and
// does not need its own 1x tier.
//
// Built server-side and handed over as attributes rather than derived in
// tooltip.js, so the URL scheme and ART_VERSION live in exactly one file and a
// re-tune never needs the client and the worker to ship together.
export function artUrls(raw) {
  const hash = spotifyArtHash(raw);
  if (!hash) return null;
  const at = (w, ext) => `/rn/art/${hash}-${w}-${ART_VERSION}.${ext}`;
  const avif2x = at(240, "avif");
  // `warm` names the ONE tier a 2x display picks, so warmArtCache does not have
  // to parse it back out of the srcset this function just built. A field rather
  // than a second exported builder, because the whole reason the URL scheme sits
  // in this function is that it sits in exactly one place.
  return { src: at(240, "jpg"), srcset: `${at(120, "avif")} 120w, ${avif2x} 240w`, warm: avif2x };
}

// The hover attributes for one art URL — and NOTHING when the art cannot be
// re-hosted, which is the half that lets the CSP be honest.
//
// Until #182 this fell back to the original Spotify URL, which was right while
// img-src still allowed those hosts. It no longer does: img-src is 'self' data:,
// so emitting a spotifycdn URL here would produce a frame the browser refuses to
// load, and a broken image is a worse answer than no image. Dropping the
// attribute lands the row on paths that already exist and already read well —
// a track falls through to buildTrackContent's text card (title, artists,
// duration), an artist to no tooltip at all, which is exactly what a cover-less
// track has always done.
//
// So the shapes that reach here are the shapes that were always possible:
// mosaic.scdn.co collage covers, and anything Spotify ships that this file has
// not learned yet. Loud enough to find in the logs, quiet enough not to break a
// page over.
function artAttrs(kind, rawUrl) {
  if (!rawUrl) return "";
  const art = artUrls(rawUrl);
  if (!art) return "";
  return ` data-${kind}-image="${escAttr(art.src)}"` +
         ` data-${kind}-imageset="${escAttr(art.srcset)}"`;
}

export async function handleRnArt(request, env, ctx) {
  const url = new URL(request.url);
  const m = ART_PATH.exec(url.pathname);
  if (!m) return new Response("not found", { status: 404, headers: { "cache-control": "no-store" } });
  const [, hash, widthRaw, , ext] = m;
  const width = Number(widthRaw);
  // An unknown width would otherwise be a free transformation anyone could mint
  // by hand, 5,000 times, against an allowance that is meant to last the month.
  if (!ART_WIDTHS.has(width)) {
    return new Response("not found", { status: 404, headers: { "cache-control": "no-store" } });
  }

  // The public URL already carries hash + width + version, so it IS the cache
  // key; none of the ?av= indirection photos.js needs applies to an address that
  // names its own bytes.
  const cache = caches.default;
  const cacheable = request.method === "GET";
  if (cacheable) {
    const hit = await cache.match(request);
    if (hit) {
      const r = new Response(hit.body, hit);
      r.headers.set("x-art-cache", "hit");
      return r;
    }
  }

  const upstream = `https://i.scdn.co/image/${hash}`;
  // fit:scale-down never enlarges, so a source already smaller than the tier is
  // passed through at its own size instead of being upscaled into a bigger file
  // than the original. q82 mirrors the neighbourhood the photo pipeline settled
  // on rather than Cloudflare's default 85, on art that is a 120px hover
  // affordance rather than something anyone will pixel-peep.
  let res = null;
  try {
    res = await fetch(upstream, {
      cf: { image: { width, fit: "scale-down", format: ext === "jpg" ? "jpeg" : "avif", quality: 82 } },
    });
  } catch { res = null; }

  // Every way the transform can fail lands here, and they are not exotic: the
  // Images Free plan returns 9422 once 5,000 unique transformations are used up
  // in a month, and whether cf.image needs a zone toggle at all is UNVERIFIED on
  // this zone (the docs say any zone hosting a Worker, another page implies a
  // toggle). Falling back to the untransformed original makes the worst case a
  // bigger image rather than a broken tooltip, and makes the toggle question
  // something to confirm from production rather than a launch blocker.
  let transformed = true;
  if (!res || !res.ok) {
    transformed = false;
    try { res = await fetch(upstream); } catch { res = null; }
  }
  if (!res || !res.ok) {
    return new Response("upstream unavailable", { status: 502, headers: { "cache-control": "no-store" } });
  }

  const headers = new Headers();
  // The URL declared a format, so trust it over an upstream content-type only
  // when the transform actually ran. A fallback body is Spotify's original JPEG
  // whatever the path claims, and labelling that as AVIF would break the one
  // path that exists to keep things working.
  headers.set("content-type", transformed ? ART_EXT[ext] : (res.headers.get("content-type") || "image/jpeg"));
  // Only a TRANSFORMED response earns a year. An untransformed fallback is the
  // symptom of a temporary condition (a monthly allowance, a zone toggle), and
  // pinning it immutable would outlive the cause by eleven months.
  headers.set("cache-control", transformed
    ? "public, max-age=31536000, immutable"
    : "public, max-age=300");
  headers.set("x-content-type-options", "nosniff");
  headers.set("x-art-transformed", transformed ? "1" : "0");
  const out = new Response(res.body, { status: 200, headers });
  if (cacheable && ctx && transformed) {
    // store a clean clone, then mark THIS response a miss — same tee as
    // photos.js, so the cached copy never carries the marker.
    ctx.waitUntil(cache.put(request, out.clone()));
    out.headers.set("x-art-cache", "miss");
  }
  return out;
}

// ── warming that cache, which is the whole reason the hover felt slow ─────────
//
// WHY. Re-hosting the art first-party (#182) traded a globally warm CDN for a
// cache nobody had populated yet, and `caches.default` is PER-COLO. Measured in
// production 2026-08-10 against the live playlist, 15 unique covers: 11 answered
// `x-art-cache: miss` at 390-840ms (~600ms median) while the 4 warm ones came
// back in 180-270ms. Spotify's own CDN served the same image in 98-232ms and was
// warm essentially everywhere. So the tooltip sat on its grey placeholder
// (luna.css, `.xp-tooltip .cover.album`) for over half a second on first hover.
//
// The miss rate is not evenly spread, either. A playlist change mints new hashes
// (that content-addressing is what makes the whole scheme cheap to run), so the
// person who changed the playlist is reliably the first to hover every fresh
// cover, in whichever colo they are sitting in. The owner sees the cold path far
// more often than a visitor does, which is exactly how this got noticed.
//
// WHAT THIS COSTS A VISITOR: nothing. It runs in `ctx.waitUntil` after the
// fragment response has already been sent, so the browser issues no extra
// request and downloads no extra byte. What it spends is worker subrequests and
// Cloudflare Images transformations, and it spends them in the colo that is
// about to serve the hover.
//
// The transformation budget survives this because Images bills per UNIQUE
// transformation per calendar month, so warming the same URL in twenty colos
// still counts once. One tier across ~35 images is ~35 a playlist against the
// Free plan's 5,000, and the plan errors rather than charging an overage.
export const WARM_MAX_URLS = 40;

// The URL set one warm may touch, as a PURE function so it is testable without
// a `caches` global (contract-tests.mjs runs under plain node, gotcha 16).
//
// Covers first, then artist pictures. Both are hover surfaces, but a track row
// is the whole row while an artist link is a few words inside it, so covers earn
// the head of the list for when the cap bites.
export function artWarmList(payload, origin) {
  const tracks = Array.isArray(payload?.tracks) ? payload.tracks : [];
  const seen = new Set();
  const add = (raw) => {
    const art = artUrls(raw);
    // No hash means no re-hosted URL to warm: a mosaic collage cover, or a shape
    // rn.js has not learned yet. artAttrs already emits nothing for those, so no
    // request is coming and there is nothing to prepare for.
    if (art && seen.size < WARM_MAX_URLS) seen.add(origin + art.warm);
  };
  for (const t of tracks) add(t.image_url);
  for (const t of tracks) for (const a of t.artists || []) add(a.image_url);
  return [...seen];
}

export async function warmArtCache(payload, request, env, ctx) {
  if (!ctx || typeof caches === "undefined") return 0;
  const urls = artWarmList(payload, new URL(request.url).origin);
  if (!urls.length) return 0;

  // ONE probe stands in for the whole set. These URLs are minted together and
  // warmed together, so the first one being present means this colo has already
  // paid for this playlist. Guessing wrong costs one `cache.match` and never a
  // stale image: every URL is content-addressed and immutable, so a warm entry
  // can only ever be the right bytes.
  const cache = caches.default;
  if (await cache.match(new Request(urls[0]))) return 0;

  await Promise.all(urls.map(async (u) => {
    try {
      // Call the handler directly instead of fetching our own origin. A self
      // fetch would cost a second worker invocation per cover to reach this
      // same function, and `handleRnArt` already does its own cache.put.
      const res = await handleRnArt(new Request(u), env, ctx);
      // DRAIN the body. handleRnArt caches `out.clone()`, which tees the stream,
      // and a tee branch nobody reads can back-pressure the branch being written
      // to the cache. These are 5-19KB images, so buffering them is free.
      if (res.body) await res.arrayBuffer();
    } catch { /* a cover that will not warm is a cover that loads on hover */ }
  }));
  return urls.length;
}

// Both representations carry `x-robots-tag: noindex`, which is what robots.txt
// used to try to say with `Disallow: /rn/tracks` and could not. The playlist is a
// live JSON feed and an HTML fragment: worth FETCHING (the homepage Link header,
// the api-catalog, auth.md and llms.txt all point agents at it) and worthless in
// a search index. Disallow blocks the fetch and so blocks its own noindex; this
// header is the one that expresses the actual intent.
function trackResponse(payload, status = 200, format = "json") {
  if (format === "html") {
    return new Response(renderTrackListHtml(payload), {
      status,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": status >= 400 ? "public, max-age=30, must-revalidate" : "public, max-age=300, s-maxage=600",
        "x-content-type-options": "nosniff",
        "x-robots-tag": "noindex",
        // positive proof this body is OUR fragment. A 500/522/1101 from the edge is
        // also text/html and also resolves fine, so the homepage requires this marker
        // before injecting the response into the track list.
        "x-rn-fragment": "1",
      },
    });
  }
  const res = jsonResp(payload, status);
  res.headers.set("x-robots-tag", "noindex");
  return res;
}

// Traced as `rn.tracks.load` with the OUTCOME on the span, because this handler
// has four quite different ways to answer and three of them are 200s carrying an
// error object. A status code alone cannot tell "played from a warm SWR hit"
// apart from "no playlist configured" apart from "Spotify refused the scrape",
// and the second homepage fragment going quiet is exactly the kind of thing that
// otherwise gets noticed by eye, weeks later.
async function loadRnTracks(request, env, ctx) {
  return span("rn.tracks.load", (s) => loadRnTracksInner(request, env, ctx, s));
}

async function loadRnTracksInner(request, env, ctx, s) {
  const url = new URL(request.url);

  if (!env.RN_KV) {
    s.setAttribute("rn.outcome", "no_kv_binding");
    return { payload: { error: "no kv binding", tracks: [] }, status: 500 };
  }
  const playlistId = await span("rn.tracks.playlist_id", () => env.RN_KV.get("playlist-id"));
  if (!playlistId || !/^[0-9A-Za-z]{22}$/.test(playlistId)) {
    s.setAttribute("rn.outcome", "no_playlist_set");
    return { payload: { error: "no playlist set", tracks: [] }, status: 200 };
  }
  s.setAttribute("rn.playlist_id", playlistId);

  const cacheKey = `tracks:${playlistId}`;

  // optional bust — drop both the value and its freshness sentinel.
  // constant-time compare, same as the admin/set gate (a plain === leaks the
  // secret's length + prefix through timing).
  if (env.RN_BUST_SECRET && timingSafeEqual(url.searchParams.get("bust") || "", env.RN_BUST_SECRET)) {
    s.setAttribute("rn.busted", true);
    await span("rn.tracks.bust", () => deleteSWRKV(env, cacheKey));
  }

  // two-key SWR (same shape as the photo manifest): stale serves instantly,
  // a lapsed sentinel refreshes in the background. only a true cold start
  // (or a bust) pays the 3-tier Spotify scrape inline.
  let payload;
  try {
    payload = await span("rn.tracks.swr", () => getTracksSWR(env, ctx, playlistId, { buildOnMiss: true }));
  } catch (e) {
    // the reason is otherwise swallowed entirely — the 502 body says only
    // "scrape failed", and this catch is the last place the actual error exists.
    s.setAttribute("rn.outcome", "scrape_failed");
    s.setAttribute("rn.error", (e && e.message) || String(e));
    return { payload: { error: "scrape failed", tracks: [] }, status: 502 };
  }
  s.setAttribute("rn.outcome", "ok");
  s.setAttribute("rn.track_count", Array.isArray(payload?.tracks) ? payload.tracks.length : 0);
  return { payload, status: 200 };
}

// `/rn/tracks` is the stable machine contract. Keep its representation fixed
// so callers do not need to negotiate against a browser-oriented HTML shape.
export async function handleRnTracks(request, env, ctx) {
  const result = await loadRnTracks(request, env, ctx);
  return trackResponse(result.payload, result.status, "json");
}

// `/rn/tracks.html` is the browser fragment contract the homepage hydrates from.
// It intentionally returns `<li>` rows, not a full document.
//
// It is also the one request that reliably precedes a hover, in the colo that
// will serve it, which is what makes it the right place to hang the art warm.
// The JSON twin deliberately does NOT warm: `/rn/tracks` is the machine-facing
// contract, and an agent reading it is never going to hover an album cover.
//
// The warm cannot delay the fragment — waitUntil runs after this response is
// already on the wire — and it fires far less often than it looks. The fragment
// is `s-maxage=600`, so the edge answers most requests without waking the worker
// at all, and after the first warm the cache probe inside short-circuits.
export async function handleRnTracksHtml(request, env, ctx) {
  const result = await loadRnTracks(request, env, ctx);
  const res = trackResponse(result.payload, result.status, "html");
  if (ctx && result.status === 200) {
    ctx.waitUntil(span("rn.art.warm", async (s) => {
      const warmed = await warmArtCache(result.payload, request, env, ctx);
      // 0 is the common and healthy answer (this colo was already warm), so the
      // count is what separates "the warm is working" from "the warm never ran".
      s.setAttribute("rn.art.warmed", warmed);
    }).catch(() => {}));
  }
  return res;
}

// The HTML representation is intentionally the same row shape used by the
// homepage rewriter. JSON remains the machine-facing contract; HTML is the
// browser-facing hypermedia representation.
export function renderTrackListHtml(payload) {
  const tracks = Array.isArray(payload?.tracks) ? payload.tracks : [];
  // A failure and an empty playlist are different stories. The JSON twin keeps them
  // apart via payload.error; without this branch all three states (scrape failed,
  // no KV binding, no playlist set) serialized to a byte-identical "No tracks yet",
  // so the two representations disagreed and a client reading the fragment alone
  // was told the playlist is empty when the scrape actually broke.
  if (payload?.error) return '<li class="np-empty">Couldn&#39;t load tracks right now. <a href="/rn">Open on Spotify</a>.</li>';
  if (!tracks.length) return '<li class="np-empty">No tracks yet. <a href="/rn">Open on Spotify</a>.</li>';
  return tracks.map(t => {
    const dur = t.duration_ms ? fmtDuration(t.duration_ms) : "";
    const artistsText = t.artists_text || (t.artists || []).map(a => a.name).join(", ");
    const dataAttrs =
      ` data-track-title="${escAttr(t.title)}"` +
      ` data-track-artists="${escAttr(artistsText)}"` +
      artAttrs("track", t.image_url) +
      (t.duration_ms ? ` data-track-duration="${dur}"`               : "") +
      (t.is_explicit ? ` data-track-explicit="1"`                    : "");
    return `<li${dataAttrs}>
      <a href="${escAttr(t.song_link_url)}" target="_blank" rel="noopener">${
        dur ? `<span class="np-duration">${dur}</span>` : ""
      }<span class="np-title">${escHtml(t.title)}</span><span class="np-sep">&mdash;</span><span class="np-artist">${linkifyArtists(t.artists, artistsText)}</span>${
        t.is_explicit ? '<span class="np-explicit">E</span>' : ""
      }</a>
    </li>`;
  }).join("");
}

// The Markdown representation, served at /rn.md and at /rn under
// `Accept: text/markdown`. Same three states renderTrackListHtml keeps apart,
// for the same reason: a failed scrape and an empty playlist are different
// stories, and collapsing them tells a reader the playlist is empty when it is
// the scrape that broke.
//
// No artist links. The HTML rows carry one anchor per artist because the tooltip
// island reads them; in prose that is a wall of Spotify search URLs around the
// names, which are the actual content.
export function renderTrackListMarkdown(payload, target) {
  const tracks = Array.isArray(payload?.tracks) ? payload.tracks : [];
  const name = payload?.playlist_name;
  const head = [
    `# ${name ? `Right now: ${name}` : "Right now"}`,
    "",
    "> The playlist aadhar.sh/rn redirects a browser to, scraped live from the",
    "> Spotify embed. It moves; there is no stable snapshot of it to cite.",
    "> The same payload as JSON: https://aadhar.sh/rn/tracks",
    "",
    `Playlist: <${target}>`,
    "",
  ];

  let body;
  if (payload?.error) {
    body = [`Could not load the track list right now (\`${payload.error}\`). The playlist itself is still at the URL above.`];
  } else if (!tracks.length) {
    body = ["No tracks yet."];
  } else {
    body = [`## ${tracks.length} track${tracks.length === 1 ? "" : "s"}`, ""];
    tracks.forEach((t, i) => {
      const artists = t.artists_text || (t.artists || []).map(a => a.name).join(", ");
      const dur = t.duration_ms ? ` (${fmtDuration(t.duration_ms)})` : "";
      const explicit = t.is_explicit ? " [E]" : "";
      const link = t.song_link_url || t.spotify_url;
      const title = link ? `[${mdText(t.title)}](${link})` : mdText(t.title);
      body.push(`${i + 1}. ${title}${artists ? ` · ${mdText(artists)}` : ""}${dur}${explicit}`);
    });
  }

  return [...head, ...body, "", "Source: https://aadhar.sh/rn"].join("\n") + "\n";
}

// Titles and artist names are arbitrary third-party strings, so the four
// characters that would otherwise turn one into emphasis, a link, or a heading
// are escaped. Not esc()/escHtml(): this is not HTML, and entity-encoding here
// would put `&amp;` in front of a reader.
const mdText = (s) => String(s ?? "").replace(/([\\`*_[\]])/g, "\\$1");

// `/rn.md` is the URL form, for a client that cannot set an Accept header. It is
// the cacheable representation of the pair (the negotiated /rn response is
// no-store, because the edge keys on URL and not on Accept), and it rides the
// same SWR payload, so answering it costs a KV read.
export async function handleRnMarkdown(request, env, ctx) {
  const [result, target] = await Promise.all([loadRnTracks(request, env, ctx), playlistUrl(env)]);
  const negotiated = wantsMarkdown(request) && !new URL(request.url).pathname.endsWith(".md");
  return new Response(renderTrackListMarkdown(result.payload, target), {
    // 200 even on a failed scrape: the response says so in prose, and the useful
    // half of it (which playlist, where to open it) is still true. /rn/tracks
    // keeps the 502 for machines reading the status.
    status: 200,
    headers: {
      "content-type":           "text/markdown; charset=utf-8",
      "cache-control":          negotiated ? "no-store, must-revalidate" : "public, max-age=300, s-maxage=600",
      ...(negotiated ? { vary: "accept" } : {}),
      "x-content-type-options": "nosniff",
    },
  });
}

function linkifyArtists(artists, fallbackText) {
  if (Array.isArray(artists) && artists.length) {
    return artists.map(a => {
      const href = a.spotify_url || `https://open.spotify.com/search/${encodeURIComponent(a.name)}/artists`;
      const img = artAttrs("artist", a.image_url);
      return `<span class="np-artist-link" data-href="${escAttr(href)}" data-artist-name="${escAttr(a.name)}"${img} role="link" tabindex="0">${escHtml(a.name)}</span>`;
    }).join(", ");
  }
  const raw = fallbackText || (typeof artists === "string" ? artists : "");
  if (!raw) return "";
  return String(raw).split(/,\s*/).filter(Boolean).map(name => {
    const href = `https://open.spotify.com/search/${encodeURIComponent(name)}/artists`;
    return `<span class="np-artist-link" data-href="${escAttr(href)}" data-artist-name="${escAttr(name)}" role="link" tabindex="0">${escHtml(name)}</span>`;
  }).join(", ");
}

function fmtDuration(ms) {
  const total = Math.round(ms / 1000);
  const m = Math.floor(total / 60);
  const s = String(total % 60).padStart(2, "0");
  return `${m}:${s}`;
}

// two-key stale-while-revalidate for the playlist payload, mirroring
// getImagesManifest: `tracks:<pid>` persists with NO TTL (a visitor never
// catches an empty hole when the hour lapses), and `tracks:<pid>:fresh`
// carries the freshness window. lapsed sentinel → serve stale now, rescrape
// on ctx.waitUntil. used by both /rn/tracks and the homepage prerender, so
// whichever gets hit keeps the payload warm.
export async function getTracksSWR(env, ctx, pid, opts = {}) {
  // cacheTtl 1800: this is the homepage's slowest TTFB-gating read (204ms cold on
  // 2026-07-27), and the key is write-rarely by construction. A playlist swap
  // mints a whole new `tracks:<pid>` key, so a rollover never waits on this one
  // going stale. The half hour is only spendable because the one manual bust
  // (/rn/tracks?bust=) is a convenience: it clears the colo that served it right
  // away, and every other colo catches up as its own cacheTtl lapses.
  return swrKV(env, ctx, `tracks:${pid}`, RN_TRACKS_TTL, () => scrapePlaylistTracks(pid, env, ctx), {
    cacheTtl: 1800,
    buildOnMiss: opts.buildOnMiss === true,
    isValid: (p) => p && Array.isArray(p.tracks),
    shouldStore: (p) => p && Array.isArray(p.tracks) && p.tracks.length > 0,
  });
}

// Traced tier by tier. This function is the single most expensive thing the
// worker can do — one embed fetch for the playlist, then ONE PER TRACK, then one
// per uncached artist — and it runs only on a cold SWR miss or a manual bust, so
// it is both rare and the thing you want the receipt for when a homepage
// fragment takes seconds. Each tier's fetches are auto-instrumented as children;
// the tier spans are what make 30 sibling fetches legible as three phases.
export async function scrapePlaylistTracks(playlistId, env, ctx) {
  // tier 1: playlist embed → ordered track list
  const playlistEntity = await span(
    "rn.scrape.playlist",
    () => scrapeSpotifyEmbed(`playlist/${playlistId}`, env),
    { "rn.playlist_id": playlistId },
  );
  const trackList = Array.isArray(playlistEntity.trackList) ? playlistEntity.trackList : [];

  const baseTracks = trackList
    .filter(t => t && typeof t.uri === "string" && t.uri.startsWith("spotify:track:"))
    .map(t => {
      const id = t.uri.slice("spotify:track:".length);
      return {
        id,
        title:         t.title    || "",
        artists_text:  t.subtitle || "",   // raw "A, B" string kept for back-compat
        spotify_url:   `https://open.spotify.com/track/${id}`,
        song_link_url: `https://song.link/s/${id}`,
        duration_ms:   typeof t.duration === "number" ? t.duration : null,
        preview_url:   t.audioPreview?.url || null,
        is_explicit:   !!t.isExplicit,
      };
    });

  // tier 2: per-track embed → cover image URL + structured artist list.
  // ONE fetch per track replaces the prior playlist-embed + oEmbed pair
  // (oEmbed only returned the cover; the track embed returns cover + the
  // artist URIs we need for the artist-hover feature).
  const enriched = await span("rn.scrape.tracks", async (s) => {
    s.setAttribute("rn.track_count", baseTracks.length);
    // a per-track embed that throws degrades that ONE track to no cover and no
    // artists (the catch below), which is invisible in the rendered list. The
    // count makes partial degradation a number instead of a shrug.
    let failed = 0;
    const out = await Promise.all(baseTracks.map(async t => {
      try {
        const e = await scrapeSpotifyEmbed(`track/${t.id}`, env);
        // canonicalized here too, not just at emit: this value is what lands in
        // the KV payload and what /rn/tracks hands back as JSON, so a consumer
        // that never touches the HTML still gets one host per image.
        const image_url = canonicalArtUrl(e?.visualIdentity?.image?.[0]?.url || null);
        const artists = Array.isArray(e?.artists)
          ? e.artists
              .filter(a => a && typeof a.uri === "string" && a.uri.startsWith("spotify:artist:"))
              .map(a => {
                const id = a.uri.slice("spotify:artist:".length);
                return {
                  id,
                  name:        a.name || "",
                  spotify_url: `https://open.spotify.com/artist/${id}`,
                  image_url:   null,    // filled in tier 3 below
                };
              })
          : [];
        return { ...t, image_url, artists };
      } catch {
        failed++;
        return { ...t, image_url: null, artists: [] };
      }
    }));
    s.setAttribute("rn.track_embeds_failed", failed);
    return out;
  });

  // tier 3: per-unique-artist embed → profile picture. cached in KV
  // under `artist:<id>` for ARTIST_KV_TTL because artist photos rarely
  // change. cache hit → no network. cache miss → scrape + write back.
  const uniqueArtists = new Map();
  for (const t of enriched) {
    for (const a of (t.artists || [])) {
      if (!uniqueArtists.has(a.id)) uniqueArtists.set(a.id, a);
    }
  }
  // The hit/miss split is the number worth having here: artist photos are
  // KV-cached for ARTIST_KV_TTL precisely so a cold playlist scrape does not pay
  // network per artist, and whether that is actually working is invisible from
  // the outside. A scrape that shows 0 hits and 20 misses says the artist cache
  // expired under it; the same scrape at 20 hits and 0 misses is cheap.
  await span("rn.scrape.artists", async (s) => {
    s.setAttribute("rn.unique_artists", uniqueArtists.size);
    let cached = 0, scraped = 0, failed = 0;
    await Promise.all([...uniqueArtists.values()].map(async a => {
      const cacheKey = `artist:${a.id}`;
      if (env?.RN_KV) {
        const hit = await env.RN_KV.get(cacheKey, "json");
        if (hit && typeof hit === "object") {
          cached++;
          a.image_url = hit.image_url || null;
          if (hit.name && !a.name) a.name = hit.name;
          return;
        }
      }
      try {
        const e = await scrapeSpotifyEmbed(`artist/${a.id}`, env);
        scraped++;
        // pick the 320px variant: the tooltip renders at 120×120 (luna.css pins
        // .xp-tooltip .cover.album to exactly that), so a 2x display wants 240
        // and 320 is the smallest Spotify tier that clears it without paying the
        // 640px hero weight. The next tier DOWN is 160, which goes soft on
        // retina, so there is no cheaper correct answer among Spotify's sizes.
        // (This comment said 180×180 until 2026-07-30; the conclusion was right
        // and the number was never checked against the stylesheet.)
        // fall through to whatever's first if no 320 variant exists.
        const imgs = Array.isArray(e?.visualIdentity?.image) ? e.visualIdentity.image : [];
        const pick = imgs.find(i => i.maxWidth === 320) || imgs.find(i => i.maxWidth === 160) || imgs[0] || null;
        a.image_url = canonicalArtUrl(pick?.url || null);
        if (e?.name && !a.name) a.name = e.name;
        if (env?.RN_KV && ctx) {
          ctx.waitUntil(env.RN_KV.put(cacheKey, JSON.stringify({
            name: a.name, image_url: a.image_url
          }), { expirationTtl: ARTIST_KV_TTL }));
        }
      } catch {
        failed++;
        a.image_url = null;
      }
    }));
    s.setAttribute("rn.artists_cached", cached);
    s.setAttribute("rn.artists_scraped", scraped);
    s.setAttribute("rn.artists_failed", failed);
  });

  // copy enriched artist data back onto every track (the per-track .artists
  // arrays share Map references but Promise.all parallelism means we need
  // to re-derive image_url after the artist loop resolves)
  for (const t of enriched) {
    t.artists = (t.artists || []).map(a => ({
      ...a,
      image_url: uniqueArtists.get(a.id)?.image_url || null,
      name:      uniqueArtists.get(a.id)?.name || a.name,
    }));
  }

  return {
    playlist_id:   playlistId,
    playlist_name: playlistEntity.name || "rn",
    tracks:        enriched,
    fetched_at:    new Date().toISOString(),
  };
}

// shared Spotify embed scraper. fetches https://open.spotify.com/embed/<kind>/<id>
// where kind is "playlist" | "track" | "artist", parses the SSR'd __NEXT_DATA__
// blob, and returns the top-level entity. used by tiers 1-3 above.
// cf.cacheTtl gives us automatic Cloudflare edge caching per URL so concurrent
// playlist refreshes don't multiply the upstream load.
//
// retry behavior: a small fraction of track embeds were returning HTML that
// parses but lacks visualIdentity/artists (Spotify treating CF egress IPs
// differently? regional A/B test? unclear). worse, the bad response gets
// cached at the CF edge for 24h because of cacheEverything+cacheTtl above,
// so the bad state sticks across worker invocations. on a failed extraction
// (parse error OR missing both visualIdentity and artists), retry once
// with cacheTtl: 0 + a cache-busting query param to force a fresh fetch.
export async function scrapeSpotifyEmbed(kindAndId, env) {
  // The playlist embed is the one upstream document that changes, and the 24h
  // edge cache below once fed every rebuild a day-old listing (a new track took
  // a day to appear no matter how often the sentinel lapsed). Playlist fetches
  // now always bypass the CF cache; they only fire on rebuilds (~1/hour), so
  // Spotify sees no extra load. Track and artist embeds are near-immutable and
  // keep the 24h cache.
  const isPlaylist = kindAndId.startsWith("playlist/");
  const tryOnce = async (bustCache) => {
    const fresh = bustCache || isPlaylist;
    const qs = fresh ? `?_t=${Date.now()}` : "";
    // signedFetch adds the required Web Bot Auth signature (RFC 9421), so a
    // plain fetch can never accidentally put the AadharshBot UA on the wire.
    const res = await signedFetch(`https://open.spotify.com/embed/${kindAndId}${qs}`, env || {}, {
      // 5s deadline. scrapePlaylistTracks fans out to dozens of these embeds in
      // Promise.all, and one stuck fetch used to hang its whole branch. A timeout
      // throws into the same empty-entity path any embed failure already takes.
      signal: AbortSignal.timeout(5000),
      cf: fresh
        ? { cacheTtl: 0, cacheEverything: false }     // bypass CF cache (retry + every playlist fetch)
        : { cacheTtl: 86400, cacheEverything: true }, // 24h CF edge cache (track/artist embeds)
    });
    if (!res.ok) throw new Error(`embed ${kindAndId}: ${res.status}`);
    const html = await res.text();
    const m = html.match(/<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    if (!m) throw new Error(`no __NEXT_DATA__ in ${kindAndId}`);
    const data = JSON.parse(m[1]);
    return data?.props?.pageProps?.state?.data?.entity || {};
  };

  // first attempt: normal CF-cached path
  let entity = null;
  try {
    entity = await tryOnce(false);
  } catch (_e) {
    // fall through to retry
  }

  // if the entity is empty-ish on a track / artist fetch (no name AND no
  // visualIdentity), it's almost certainly a bad cached response — retry
  // once bypassing CF's edge cache. cheap to test, expensive to be wrong.
  const looksEmpty = !entity || (
    !entity.name &&
    !entity.visualIdentity &&
    !(Array.isArray(entity.artists) && entity.artists.length) &&
    !(Array.isArray(entity.trackList) && entity.trackList.length)
  );
  if (looksEmpty) {
    entity = await tryOnce(true);
  }
  return entity || {};
}

// ── /rn/admin handler ───────────────────────────────────────────────
// renders the bookmark-friendly form. requires ?secret=<RN_BUST_SECRET>.
// the form posts to /rn/set so the actual write logic stays in one place.
export async function handleRnAdmin(request, env) {
  const url = new URL(request.url);
  const secret = url.searchParams.get("secret") || "";

  if (!env.RN_BUST_SECRET || !timingSafeEqual(secret, env.RN_BUST_SECRET)) {
    return setPage(403, "denied", "wrong secret. check the bookmark.");
  }

  // show current target so you can tell at a glance what /rn points to.
  let current = "(empty — using fallback)";
  if (env.RN_KV) {
    const id = await env.RN_KV.get("playlist-id");
    if (id) current = `<a href="https://open.spotify.com/playlist/${esc(id)}" target="_blank" rel="noopener">open.spotify.com/playlist/${esc(id)}</a>`;
  }

  const body = `
    <p><strong>Currently:</strong><br>${current}</p>
    <form method="POST" action="/rn/set" autocomplete="off" style="margin-top:14px">
      <input type="hidden" name="secret" value="${esc(secret)}">
      <label for="u" style="display:block;font-weight:bold;color:oklch(41.92% 0.0962 250.51);margin-bottom:4px">New playlist URL:</label>
      <input id="u" name="url" type="text" placeholder="https://open.spotify.com/playlist/..." autofocus class="xp-input" style="font-family:'Courier New',monospace">
      <p style="margin-top:10px">
        <button type="submit" class="xp-button default">
          Update /rn
        </button>
      </p>
    </form>
    <p style="margin-top:18px;color:oklch(51.03% 0 0);font-size:9.5pt">
      <em>Tip:</em> on Spotify desktop, right-click the playlist &rarr; Share &rarr;
      Copy link to playlist, then paste here.
    </p>`;
  return setPage(200, "update /rn", body);
}

// ── /rn/set handler ─────────────────────────────────────────────────
// the actual write endpoint. accepts inputs from three places:
//   GET  /rn/set?secret=...&url=...   (shortcuts, bookmarks, curl)
//   POST /rn/set  with secret+url in form-encoded body  (the admin form)
//   POST /rn/set  with secret+url as JSON               (programmatic)
// returns the same tiny period-correct confirmation page in all cases.
export async function handleRnSet(request, env) {
  const url = new URL(request.url);
  const params = await readParams(request, url);
  const secret = params.get("secret") || "";
  const target = params.get("url")    || "";

  if (!env.RN_BUST_SECRET || !timingSafeEqual(secret, env.RN_BUST_SECRET)) {
    return setPage(403, "denied", "wrong secret. check the bookmark.");
  }

  // accept either a full open.spotify.com URL, a spotify: URI, or a bare id.
  const m =
    target.match(/^spotify:playlist:([0-9A-Za-z]{22})$/) ||
    target.match(/open\.spotify\.com\/playlist\/([0-9A-Za-z]{22})/) ||
    target.match(/^([0-9A-Za-z]{22})$/);
  if (!m) {
    return setPage(400, "bad url",
      "couldn't find a 22-character playlist id in <code>" + esc(target) + "</code>.");
  }
  const id = m[1];

  if (!env.RN_KV) {
    return setPage(500, "no kv binding", "the worker can't see RN_KV — bind it in wrangler.jsonc.");
  }
  await env.RN_KV.put("playlist-id", id);

  return setPage(200, "updated",
    `<code>/rn</code> now points to <a href="https://open.spotify.com/playlist/${esc(id)}" target="_blank" rel="noopener">open.spotify.com/playlist/${esc(id)}</a>.<br>` +
    `<small><a href="/rn/admin?secret=${esc(secret)}">&larr; back to admin</a></small>`);
}

// gather params from query string, form body, or JSON body — query wins ties.
export async function readParams(request, url) {
  const out = new URLSearchParams(url.searchParams);
  if (request.method === "POST") {
    const ct = (request.headers.get("content-type") || "").toLowerCase();
    try {
      if (ct.startsWith("application/x-www-form-urlencoded")) {
        const body = await request.text();
        for (const [k, v] of new URLSearchParams(body)) {
          if (!out.has(k)) out.set(k, v);
        }
      } else if (ct.startsWith("application/json")) {
        const data = await request.json();
        for (const k of Object.keys(data || {})) {
          if (!out.has(k)) out.set(k, String(data[k]));
        }
      }
    } catch {}
  }
  return out;
}

// ── tiny period-correct confirmation page ───────────────────────────
export function setPage(status, title, bodyHtml) {
  const pageTitle = `aadhar.sh/rn/set/${title}`;
  return lunaPage({
    status,
    title: pageTitle,
    path: pageTitle,
    width: 520,
    robots: "noindex",
    css: `
  h1 {
    font-family: "Trebuchet MS", Verdana, Geneva, sans-serif; color: oklch(41.92% 0.0962 250.51);
    font-size: 16pt; margin: 0 0 8px;
  }
  a:link    { color: oklch(42.61% 0.2353 263.74); text-decoration: underline; }
  a:visited { color: oklch(42.09% 0.1935 328.36); }
  a:hover   { color: oklch(62.80% 0.2577 29.23); }
  code { font-family: "Courier New", Courier, monospace; background: oklch(96.72% 0 0); padding: 0 3px; border: 1px solid oklch(88.22% 0 0); }
`,
    body: `
    <h1>${esc(title)}</h1>
    <p>${bodyHtml}</p>
    <p><small>&larr; <a href="/">aadhar.sh</a></small></p>
`,
    cache: "no-store",
    headers: {
      "x-robots-tag":  "noindex",
    },
  });
}
