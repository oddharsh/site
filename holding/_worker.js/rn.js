// rn.js — extracted from the worker (no-build reorg). Bundled by
// wrangler/Cloudflare at deploy; not served (inside _worker.js/).
import { signedFetch } from "./lib/botauth.js";
import { deleteSWRKV, swrKV } from "./lib/cache.js";
import { lunaPage } from "./lib/chrome.js";
import { esc, escAttr, escHtml, jsonResp, timingSafeEqual } from "./lib/http.js";

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
export async function handleRn(request, env) {
  let playlistId = null;
  if (env.RN_KV) {
    try { playlistId = await env.RN_KV.get("playlist-id"); } catch {}
  }
  const target = (playlistId && /^[0-9A-Za-z]{22}$/.test(playlistId))
    ? `https://open.spotify.com/playlist/${playlistId}`
    : RN_FALLBACK;
  return new Response(null, {
    status: 302,
    headers: {
      "location":        target,
      "cache-control":   "no-store, must-revalidate",
      "referrer-policy": "no-referrer",
    },
  });
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
function trackResponse(payload, status = 200, format = "json") {
  if (format === "html") {
    return new Response(renderTrackListHtml(payload), {
      status,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": status >= 400 ? "public, max-age=30, must-revalidate" : "public, max-age=300, s-maxage=600",
        "x-content-type-options": "nosniff",
        // positive proof this body is OUR fragment. A 500/522/1101 from the edge is
        // also text/html and also resolves fine, so the homepage requires this marker
        // before injecting the response into the track list.
        "x-rn-fragment": "1",
      },
    });
  }
  return jsonResp(payload, status);
}

async function loadRnTracks(request, env, ctx) {
  const url = new URL(request.url);

  if (!env.RN_KV) {
    return { payload: { error: "no kv binding", tracks: [] }, status: 500 };
  }
  const playlistId = await env.RN_KV.get("playlist-id");
  if (!playlistId || !/^[0-9A-Za-z]{22}$/.test(playlistId)) {
    return { payload: { error: "no playlist set", tracks: [] }, status: 200 };
  }

  const cacheKey = `tracks:${playlistId}`;

  // optional bust — drop both the value and its freshness sentinel.
  // constant-time compare, same as the admin/set gate (a plain === leaks the
  // secret's length + prefix through timing).
  if (env.RN_BUST_SECRET && timingSafeEqual(url.searchParams.get("bust") || "", env.RN_BUST_SECRET)) {
    await deleteSWRKV(env, cacheKey);
  }

  // two-key SWR (same shape as the photo manifest): stale serves instantly,
  // a lapsed sentinel refreshes in the background. only a true cold start
  // (or a bust) pays the 3-tier Spotify scrape inline.
  let payload;
  try {
    payload = await getTracksSWR(env, ctx, playlistId, { buildOnMiss: true });
  } catch (e) {
    return { payload: { error: "scrape failed", tracks: [] }, status: 502 };
  }
  return { payload, status: 200 };
}

// `/rn/tracks` is the stable machine contract. Keep its representation fixed
// so callers do not need to negotiate against a browser-oriented HTML shape.
export async function handleRnTracks(request, env, ctx) {
  const result = await loadRnTracks(request, env, ctx);
  return trackResponse(result.payload, result.status, "json");
}

// `/rn/tracks.html` is the browser fragment contract used by the homepage's
// no-SSR fallback. It intentionally returns `<li>` rows, not a full document.
export async function handleRnTracksHtml(request, env, ctx) {
  const result = await loadRnTracks(request, env, ctx);
  return trackResponse(result.payload, result.status, "html");
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
      (t.image_url   ? ` data-track-image="${escAttr(t.image_url)}"` : "") +
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

function linkifyArtists(artists, fallbackText) {
  if (Array.isArray(artists) && artists.length) {
    return artists.map(a => {
      const href = a.spotify_url || `https://open.spotify.com/search/${encodeURIComponent(a.name)}/artists`;
      const img = a.image_url ? ` data-artist-image="${escAttr(a.image_url)}"` : "";
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
  return swrKV(env, ctx, `tracks:${pid}`, RN_TRACKS_TTL, () => scrapePlaylistTracks(pid, env, ctx), {
    buildOnMiss: opts.buildOnMiss === true,
    isValid: (p) => p && Array.isArray(p.tracks),
    shouldStore: (p) => p && Array.isArray(p.tracks) && p.tracks.length > 0,
  });
}

export async function scrapePlaylistTracks(playlistId, env, ctx) {
  // tier 1: playlist embed → ordered track list
  const playlistEntity = await scrapeSpotifyEmbed(`playlist/${playlistId}`, env);
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
  const enriched = await Promise.all(baseTracks.map(async t => {
    try {
      const e = await scrapeSpotifyEmbed(`track/${t.id}`, env);
      const image_url = e?.visualIdentity?.image?.[0]?.url || null;
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
      return { ...t, image_url: null, artists: [] };
    }
  }));

  // tier 3: per-unique-artist embed → profile picture. cached in KV
  // under `artist:<id>` for ARTIST_KV_TTL because artist photos rarely
  // change. cache hit → no network. cache miss → scrape + write back.
  const uniqueArtists = new Map();
  for (const t of enriched) {
    for (const a of (t.artists || [])) {
      if (!uniqueArtists.has(a.id)) uniqueArtists.set(a.id, a);
    }
  }
  await Promise.all([...uniqueArtists.values()].map(async a => {
    const cacheKey = `artist:${a.id}`;
    if (env?.RN_KV) {
      const hit = await env.RN_KV.get(cacheKey, "json");
      if (hit && typeof hit === "object") {
        a.image_url = hit.image_url || null;
        if (hit.name && !a.name) a.name = hit.name;
        return;
      }
    }
    try {
      const e = await scrapeSpotifyEmbed(`artist/${a.id}`, env);
      // pick the 320px variant: tooltip renders at 180×180, so 320 source
      // gives a crisp retina-ready image without paying the 640px hero
      // weight. fall through to whatever's first if no 320 variant exists.
      const imgs = Array.isArray(e?.visualIdentity?.image) ? e.visualIdentity.image : [];
      const pick = imgs.find(i => i.maxWidth === 320) || imgs.find(i => i.maxWidth === 160) || imgs[0] || null;
      a.image_url = pick?.url || null;
      if (e?.name && !a.name) a.name = e.name;
      if (env?.RN_KV && ctx) {
        ctx.waitUntil(env.RN_KV.put(cacheKey, JSON.stringify({
          name: a.name, image_url: a.image_url
        }), { expirationTtl: ARTIST_KV_TTL }));
      }
    } catch {
      a.image_url = null;
    }
  }));

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
