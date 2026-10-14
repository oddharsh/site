import { signedFetch } from "./lib/botauth.ts";
import { SUBREQUEST_CAP_FREE, createBudget, recordBudget } from "./lib/budget.ts";
import { deleteSWRKV, swrKV } from "./lib/cache.ts";
import { lunaPage } from "./lib/chrome.ts";
import { EMPTY, html, joinHtml, unsafeHtml, type Html } from "./lib/html.ts";
import { islandResponse } from "./lib/island.ts";
import { asList, asNumber, asRecord, asText } from "./lib/parse.ts";
import { esc, jsonResponse, publicJsonHeaders, secretMatches, wantsMarkdown } from "./lib/http.ts";
import { span } from "./lib/trace.ts";

export const RN_FALLBACK = "https://open.spotify.com/playlist/4IRq9W1N2tOWHhH0O3vXiF";

export const PLAYLIST_ID_CACHE_TTL = 900;

const PLAYLIST_ID = /^[0-9A-Za-z]{22}$/;
const FALLBACK_ID = RN_FALLBACK.split("/").pop() as string;

export async function readPlaylistId(env, { fresh = false } = {}): Promise<string | null> {
  if (!env?.RN_KV) return null;
  const id = await env.RN_KV.get("playlist-id", fresh ? undefined : { cacheTtl: PLAYLIST_ID_CACHE_TTL });
  return id && PLAYLIST_ID.test(id) ? id : null;
}

export async function currentPlaylistId(env): Promise<string> {
  return (await readPlaylistId(env).catch(() => null)) ?? FALLBACK_ID;
}

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

async function playlistUrl(env) {
  return `https://open.spotify.com/playlist/${await currentPlaylistId(env)}`;
}

export const RN_TRACKS_TTL  = 3600;

export const ARTIST_KV_TTL  = 30 * 86400;

// Spotify serves the same art under several interchangeable CDN aliases, and
// this file asks for art in two independent places: the per-track embed (tier 2)
// and the per-artist embed (tier 3). Nothing makes those two scrapes agree on a
// hostname, so one album cover can come back as image-cdn-fa under one track and
// image-cdn-ak under another. Browsers cache by origin, so identical bytes then
// download twice, over two TLS handshakes to two origins.
const SPOTIFY_ART_ALIAS = /^image-cdn-[a-z0-9]+\.spotifycdn\.com$/i;
export function canonicalArtUrl(raw) {
  if (!raw) return raw;
  try {
    const u = new URL(raw);
    if (SPOTIFY_ART_ALIAS.test(u.hostname) && u.pathname.startsWith("/image/")) {
      u.hostname = "i.scdn.co";
      return u.toString();
    }
  } catch {}
  return raw;
}

export const ART_VERSION = 2;

const ART_WIDTHS = new Set([120, 240]);

const ART_EXT = { avif: "image/avif", jpg: "image/jpeg" };

const ART_HASH = /^[0-9a-f]{40}$/;
const ART_PATH = /^\/rn\/art\/([0-9a-f]{40})-(\d{2,4})-(\d{1,4})\.(avif|jpg)$/;

export function spotifyArtHash(raw) {
  if (!raw) return null;
  try {
    const u = new URL(canonicalArtUrl(raw));
    if (u.hostname !== "i.scdn.co") return null;
    const id = u.pathname.slice("/image/".length);
    return u.pathname.startsWith("/image/") && ART_HASH.test(id) ? id : null;
  } catch { return null; }
}

export function artUrls(raw) {
  const hash = spotifyArtHash(raw);
  if (!hash) return null;
  const at = (w, ext) => `/rn/art/${hash}-${w}-${ART_VERSION}.${ext}`;
  const avif2x = at(240, "avif");
  return { src: avif2x, warm: avif2x };
}

function artAttrs(kind: "track" | "artist", rawUrl): Html {
  if (!rawUrl) return EMPTY;
  const art = artUrls(rawUrl);
  if (!art) return EMPTY;
  return kind === "track" ? html` data-track-image="${art.src}"` : html` data-artist-image="${art.src}"`;
}

export async function handleRnArt(request, env, ctx) {
  const url = new URL(request.url);
  const m = ART_PATH.exec(url.pathname);
  if (!m) return new Response("not found", { status: 404, headers: { "cache-control": "no-store" } });
  const [, hash, widthRaw, , ext] = m;
  const width = Number(widthRaw);
  if (!ART_WIDTHS.has(width)) {
    return new Response("not found", { status: 404, headers: { "cache-control": "no-store" } });
  }

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
  let res: Response | null = null;
  try {
    res = await fetch(upstream, {
      cf: { image: { width, fit: "scale-down", format: ext === "jpg" ? "jpeg" : "avif", quality: 63 } },
    });
  } catch { res = null; }

  let transformed = true;
  if (!res || !res.ok) {
    transformed = false;
    try { res = await fetch(upstream); } catch { res = null; }
  }
  if (!res || !res.ok) {
    return new Response("upstream unavailable", { status: 502, headers: { "cache-control": "no-store" } });
  }

  const headers = new Headers();
  headers.set("content-type", transformed ? ART_EXT[ext] : (res.headers.get("content-type") || "image/jpeg"));
  headers.set("cache-control", transformed
    ? "public, max-age=31536000, immutable"
    : "public, max-age=300");
  headers.set("x-content-type-options", "nosniff");
  headers.set("x-art-transformed", transformed ? "1" : "0");
  const out = new Response(res.body, { status: 200, headers });
  if (cacheable && ctx && transformed) {
    ctx.waitUntil(cache.put(request, out.clone()));
    out.headers.set("x-art-cache", "miss");
  }
  return out;
}

export const WARM_MAX_URLS = 40;

// The URL set one warm may touch, as a PURE function so it is testable without
// a `caches` global (contract-tests.mjs runs under plain node, gotcha 16).
export function artWarmList(payload, origin) {
  const tracks = Array.isArray(payload?.tracks) ? payload.tracks : [];
  const seen = new Set<string>();
  const add = (raw) => {
    const art = artUrls(raw);
    if (art && seen.size < WARM_MAX_URLS) seen.add(origin + art.warm);
  };
  for (const t of tracks) add(t.image_url);
  for (const t of tracks) for (const a of t.artists || []) add(a.image_url);
  return [...seen];
}

export async function warmArtCache(payload, request, env, ctx) {
  const none = { warmed: 0, already: 0, untransformed: 0, failed: 0 };
  // `caches` is a BARE GLOBAL that may not be declared at all, and referencing
  // an undeclared identifier to hand it to a parser throws ReferenceError, so
  // `typeof` is the only operator that can ask the question. This is the one
  // class lib/parse.js cannot cover.
  // oxlint-disable-next-line anti-slop/no-runtime-typeof
  if (!ctx || typeof caches === "undefined") return none;
  const urls = artWarmList(payload, new URL(request.url).origin);
  if (!urls.length) return none;

  const outcomes = await Promise.all(urls.map(async (u) => {
    try {
      const res = await handleRnArt(new Request(u), env, ctx);
      if (res.body) await res.arrayBuffer();
      const mark = res.headers.get("x-art-cache");
      if (mark === "hit") return "already";
      if (mark === "miss") return "warmed";
      return res.ok ? "untransformed" : "failed";
    } catch { return "failed"; }
  }));

  const count = (o: string) => outcomes.filter((x) => x === o).length;
  return { warmed: count("warmed"), already: count("already"), untransformed: count("untransformed"), failed: count("failed") };
}

function trackResponse(payload, status = 200, format = "json") {
  if (format === "html") {
    return islandResponse(renderTrackListHtml(payload), {
      "cache-control": status >= 400 ? "public, max-age=30, must-revalidate" : "public, max-age=300, s-maxage=600",
    }, status);
  }
  return jsonResponse(payload, status, { ...publicJsonHeaders(status), "x-robots-tag": "noindex" }, { pretty: false });
}

async function loadRnTracks(request, env, ctx) {
  return span("rn.tracks.load", (s) => loadRnTracksInner(request, env, ctx, s));
}

async function loadRnTracksInner(request, env, ctx, s) {
  const url = new URL(request.url);

  if (!env.RN_KV) {
    s.setAttribute("rn.outcome", "no_kv_binding");
    return { payload: { error: "no kv binding", tracks: [] }, status: 500 };
  }
  const playlistId = await span("rn.tracks.playlist_id", () => readPlaylistId(env));
  if (!playlistId) {
    s.setAttribute("rn.outcome", "no_playlist_set");
    return { payload: { error: "no playlist set", tracks: [] }, status: 200 };
  }
  s.setAttribute("rn.playlist_id", playlistId);

  const cacheKey = `tracks:${playlistId}`;

  if (secretMatches(url.searchParams.get("bust"), env.RN_BUST_SECRET)) {
    s.setAttribute("rn.busted", true);
    await span("rn.tracks.bust", () => deleteSWRKV(env, cacheKey));
  }

  let payload;
  try {
    payload = await span("rn.tracks.swr", () => getTracksSWR(env, ctx, playlistId, { buildOnMiss: true }));
  } catch (e) {
    s.setAttribute("rn.outcome", "scrape_failed");
    s.setAttribute("rn.error", (e && e.message) || String(e));
    return { payload: { error: "scrape failed", tracks: [] }, status: 502 };
  }
  s.setAttribute("rn.outcome", "ok");
  s.setAttribute("rn.track_count", Array.isArray(payload?.tracks) ? payload.tracks.length : 0);
  return { payload, status: 200 };
}

export async function handleRnTracks(request, env, ctx) {
  let result;
  try {
    result = await loadRnTracks(request, env, ctx);
  } catch (e) {
    console.error("rn/tracks: load failed", e);
    return trackResponse({ error: "playlist read failed", code: "storage_unavailable", tracks: [] }, 503, "json");
  }
  if (result.status === 200 && result.payload?.error) {
    return trackResponse({ ...result.payload, code: "no_playlist" }, 503, "json");
  }
  return trackResponse(result.payload, result.status, "json");
}

export function handleRnTracksHtml(request, env, ctx) {
  return rnTracksHtml(request, env, ctx, { warm: true });
}

export async function rnTracksHtml(request, env, ctx, opts: { warm: boolean }) {
  const result = await loadRnTracks(request, env, ctx);
  const res = trackResponse(result.payload, result.status, "html");
  if (ctx && result.status === 200 && opts.warm) {
    ctx.waitUntil(span("rn.art.warm", async (s) => {
      const { warmed, already, untransformed, failed } = await warmArtCache(result.payload, request, env, ctx);
      // EVERY outcome, because any one alone is ambiguous. `warmed` 0 with
      // `already` 28 is a healthy warm colo; `warmed` 0 with `already` 0 is the
      // feature not running at all, and the first version of this span could not
      // tell those apart. That is precisely how the broken guard shipped green.
      // `failed` is the subrequest cap (gotcha 36) and `untransformed` the
      // Images fallback; the four always sum to the URLs attempted.
      s.setAttribute("rn.art.warmed", warmed);
      s.setAttribute("rn.art.already", already);
      s.setAttribute("rn.art.untransformed", untransformed);
      s.setAttribute("rn.art.failed", failed);
    }).catch(() => {}));
  }
  return res;
}

export function renderTrackListHtml(payload): Html {
  const tracks = Array.isArray(payload?.tracks) ? payload.tracks : [];
  if (payload?.error) return html`<li class="np-empty">Couldn&#39;t load tracks right now. <a href="/rn">Open on Spotify</a>.</li>`;
  if (!tracks.length) return html`<li class="np-empty">No tracks yet. <a href="/rn">Open on Spotify</a>.</li>`;
  return joinHtml(tracks.map(t => {
    const dur = t.duration_ms ? fmtDuration(t.duration_ms) : "";
    const artistsText = t.artists_text || (t.artists || []).map(a => a.name).join(", ");
    return html`<li data-track-title="${t.title}" data-track-artists="${artistsText}"${artAttrs("track", t.image_url)}${
      t.duration_ms ? html` data-track-duration="${dur}"` : EMPTY}${t.is_explicit ? html` data-track-explicit="1"` : EMPTY}>
      <a href="${t.song_link_url}" target="_blank" rel="noopener">${
        dur ? html`<span class="np-duration">${dur}</span>` : EMPTY
      }<span class="np-title">${t.title}</span><span class="np-sep">&mdash;</span><span class="np-artist">${linkifyArtists(t.artists, artistsText)}</span>${
        t.is_explicit ? html`<span class="np-explicit">E</span>` : EMPTY
      }</a>
    </li>`;
  }));
}

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

const mdText = (s) => String(s ?? "").replace(/([\\`*_[\]])/g, "\\$1");

// `/rn.md` is the URL form, for a client that cannot set an Accept header. It is
// the cacheable representation of the pair (the negotiated /rn response is
// no-store, because the edge keys on URL and not on Accept), and it rides the
// same SWR payload, so answering it costs a KV read.
export async function handleRnMarkdown(request, env, ctx) {
  const [result, target] = await Promise.all([loadRnTracks(request, env, ctx), playlistUrl(env)]);
  const negotiated = wantsMarkdown(request) && !new URL(request.url).pathname.endsWith(".md");
  const headers: Record<string, string> = {
    "content-type":           "text/markdown; charset=utf-8",
    "cache-control":          negotiated ? "no-store, must-revalidate" : "public, max-age=300, s-maxage=600",
    "x-content-type-options": "nosniff",
  };
  if (negotiated) headers.vary = "accept";
  return new Response(renderTrackListMarkdown(result.payload, target), {
    status: 200,
    headers,
  });
}

function linkifyArtists(artists, fallbackText): Html {
  if (Array.isArray(artists) && artists.length) {
    return joinHtml(artists.map(a => {
      const href = a.spotify_url || `https://open.spotify.com/search/${encodeURIComponent(a.name)}/artists`;
      return html`<span class="np-artist-link" data-href="${href}" data-artist-name="${a.name}"${artAttrs("artist", a.image_url)} role="link" tabindex="0">${a.name}</span>`;
    }), ", ");
  }
  const raw = fallbackText || asText(artists, "");
  if (!raw) return EMPTY;
  return joinHtml(String(raw).split(/,\s*/).filter(Boolean).map(name => {
    const href = `https://open.spotify.com/search/${encodeURIComponent(name)}/artists`;
    return html`<span class="np-artist-link" data-href="${href}" data-artist-name="${name}" role="link" tabindex="0">${name}</span>`;
  }), ", ");
}

function fmtDuration(ms) {
  const total = Math.round(ms / 1000);
  const m = Math.floor(total / 60);
  const s = String(total % 60).padStart(2, "0");
  return `${m}:${s}`;
}

export async function getTracksSWR(env, ctx, pid, opts: { buildOnMiss?: boolean } = {}) {
  return swrKV(env, ctx, `tracks:${pid}`, RN_TRACKS_TTL, () => scrapePlaylistTracks(pid, env, ctx), {
    cacheTtl: 1800,
    buildOnMiss: opts.buildOnMiss === true,
    isValid: (p) => p && Array.isArray(p.tracks),
    shouldStore: (p) => p && Array.isArray(p.tracks) && p.tracks.length > 0,
  });
}

export async function scrapePlaylistTracks(playlistId, env, ctx) {
  const playlistEntity = await span(
    "rn.scrape.playlist",
    () => scrapeSpotifyEmbed(`playlist/${playlistId}`, env),
    { "rn.playlist_id": playlistId },
  );
  const trackList = Array.isArray(playlistEntity.trackList) ? playlistEntity.trackList : [];

  const baseTracks = trackList
    .filter(t => asText(t?.uri, "").startsWith("spotify:track:"))
    .map(t => {
      const id = t.uri.slice("spotify:track:".length);
      return {
        id,
        title:         t.title    || "",
        artists_text:  t.subtitle || "",
        spotify_url:   `https://open.spotify.com/track/${id}`,
        song_link_url: `https://song.link/s/${id}`,
        duration_ms:   asNumber(t.duration),
        preview_url:   t.audioPreview?.url || null,
        is_explicit:   !!t.isExplicit,
      };
    });

  const meta = await span("rn.scrape.meta", async (s) => {
    let known: Record<string, StoredTrackMeta> = {};
    try {
      known = readTrackMeta(await env?.RN_KV?.get(TRACK_META_KEY, "json"));
    } catch { /* a missing map means every cover is pending, never an error */ }
    s.setAttribute("rn.meta_known", Object.keys(known).length);
    return known;
  });

  const tracks = baseTracks.map(t => withTrackMeta(t, meta[t.id]));
  return {
    playlist_id:   playlistId,
    playlist_name: playlistEntity.name || "rn",
    tracks,
    fetched_at:    new Date().toISOString(),
  };
}

function withTrackMeta(track, meta) {
  return {
    ...track,
    image_url: meta?.image_url || null,
    artists:   Array.isArray(meta?.artists) ? meta.artists.map(({ checked: _checked, ...a }) => a) : [],
  };
}

const TRACK_META_KEY       = "trackmeta:v1";
const ENRICH_TRACK_BUDGET  = 6;
const ENRICH_ARTIST_BUDGET = 6;
const ENRICH_BUDGET_RESERVE = 4;
const TRACK_META_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

// The stored shape under TRACK_META_KEY, one entry per track id. `checked` and
// `seen` are the cron's bookkeeping, absent on entries older deploys wrote.
type StoredArtist = { id: string; name: string; spotify_url: string; image_url: string | null; checked?: number };
type StoredTrackMeta = { image_url: string | null; artists: StoredArtist[]; seen?: number };

/** Parse the stored map, dropping any entry an older deploy shaped differently. */
function readTrackMeta(raw: unknown): Record<string, StoredTrackMeta> {
  const out: Record<string, StoredTrackMeta> = {};
  for (const [id, value] of Object.entries(asRecord(raw) ?? {})) {
    const m = asRecord(value);
    if (!m) continue;
    const entry: StoredTrackMeta = { image_url: asText(m.image_url), artists: asList(m.artists).flatMap(readStoredArtist) };
    const seen = asNumber(m.seen);
    if (seen !== null) entry.seen = seen;
    out[id] = entry;
  }
  return out;
}

function readStoredArtist(raw: unknown): StoredArtist[] {
  const a = asRecord(raw);
  const id = asText(a?.id);
  if (!a || id === null) return [];
  const artist: StoredArtist = {
    id,
    name:        asText(a.name, ""),
    spotify_url: asText(a.spotify_url, `https://open.spotify.com/artist/${id}`),
    image_url:   asText(a.image_url),
  };
  const checked = asNumber(a.checked);
  if (checked !== null) artist.checked = checked;
  return [artist];
}

function trackMetaFromEntity(e): StoredTrackMeta {
  return {
    image_url: canonicalArtUrl(e?.visualIdentity?.image?.[0]?.url || null),
    artists: Array.isArray(e?.artists)
      ? e.artists
          .filter(a => asText(a?.uri, "").startsWith("spotify:artist:"))
          .map(a => {
            const id = a.uri.slice("spotify:artist:".length);
            return {
              id,
              name:        a.name || "",
              spotify_url: `https://open.spotify.com/artist/${id}`,
              image_url:   null,
            };
          })
      : [],
  };
}

// ONE bulk read is ONE subrequest, whatever the key count, and that is the whole
// reason this exists instead of a Promise.all of gets. Cloudflare's KV "Read
// key-value pairs" reference says so under "Requesting more keys per Worker
// invocation with bulk requests": up to 100 keys per call, and "These count as a
// single operation against the 1,000 operation limit". That figure is the
// ceiling in its PAID form; Free is the same counter at 50, which is the one
// SUBREQUEST_CAP_FREE holds.
//
// `json` is not a default anyone may widen. The bulk form supports `text` and
// `json` alone; `arrayBuffer` and `stream` are documented as unsupported and
// want individual gets under Promise.all instead. Errors are left to the caller,
// since the two call sites want opposite things from a read that fails.
function kvBulkJson(env, budget, keys) {
  budget.charge(1);
  return env.RN_KV.get(keys, "json");
}

export async function cronEnrichTracks(env, ctx) {
  if (!env?.RN_KV) return { ok: false, reason: "no_kv_binding" };

  return span("rn.enrich", async (s) => {
    const playlistId = await readPlaylistId(env, { fresh: true });
    if (!playlistId) {
      s.setAttribute("rn.outcome", "no_playlist_set");
      return { ok: false, reason: "no_playlist_set" };
    }
    const budget = createBudget(SUBREQUEST_CAP_FREE, { reserve: ENRICH_BUDGET_RESERVE });
    let capped = false;

    const cacheKey = `tracks:${playlistId}`;
    const setup = await kvBulkJson(env, budget, [cacheKey, TRACK_META_KEY]);
    const payload = setup.get(cacheKey);
    const storedMeta = setup.get(TRACK_META_KEY);
    if (!payload || !Array.isArray(payload.tracks) || payload.tracks.length === 0) {
      s.setAttribute("rn.outcome", "no_payload");
      return { ok: false, reason: "no_payload" };
    }

    const meta = readTrackMeta(storedMeta);
    const live: string[] = payload.tracks.map((t) => t.id).filter(Boolean);

    const now = Date.now();
    const liveSet = new Set(live);
    for (const id of liveSet) {
      if (meta[id]) meta[id].seen = now;
    }
    let pruned = 0;
    for (const id of Object.keys(meta)) {
      const seen = meta[id].seen;
      if (seen === undefined) { meta[id].seen = now; continue; }
      if (now - seen > TRACK_META_MAX_AGE_MS) { delete meta[id]; pruned++; }
    }

    const pendingTracks = live.filter(id => !meta[id]).slice(0, ENRICH_TRACK_BUDGET);
    let trackScraped = 0, trackFailed = 0;
    await Promise.all(pendingTracks.map(async id => {
      budget.charge(1);
      try {
        meta[id] = trackMetaFromEntity(await scrapeSpotifyEmbed(`track/${id}`, env));
        trackScraped++;
      } catch (e) {
        if (budget.fault(e) === "cap") capped = true;
        else trackFailed++;
      }
    }));

    const pendingArtists = new Map();
    for (const id of liveSet) {
      for (const a of (meta[id]?.artists || [])) {
        const checked = asNumber(a.checked);
        const settled = a.image_url || (checked !== null && now - checked < ARTIST_KV_TTL * 1000);
        if (!settled && !pendingArtists.has(a.id)) pendingArtists.set(a.id, a.name || "");
        if (pendingArtists.size >= ENRICH_ARTIST_BUDGET) break;
      }
      if (pendingArtists.size >= ENRICH_ARTIST_BUDGET) break;
    }

    const resolved = new Map();
    let artistCached = 0, artistScraped = 0, artistFailed = 0;

    const artistIds = [...pendingArtists.keys()];
    const artistKey = (id) => `artist:${id}`;
    let cachedArtists: Map<string, unknown> | null = null;
    try {
      if (artistIds.length > 0) cachedArtists = await kvBulkJson(env, budget, artistIds.map(artistKey));
    } catch (e) {
      if (budget.fault(e) === "cap") capped = true;
    }

    const toScrape: string[] = [];
    for (const id of artistIds) {
      const hit = asRecord(cachedArtists?.get(artistKey(id)));
      if (!hit) { toScrape.push(id); continue; }
      artistCached++;
      resolved.set(id, { name: asText(hit.name, ""), image_url: asText(hit.image_url) });
    }

    await Promise.all(toScrape.map(async id => {
      const key = artistKey(id);
      budget.charge(1);
      try {
        const e = await scrapeSpotifyEmbed(`artist/${id}`, env);
        artistScraped++;
        const imgs = Array.isArray(e?.visualIdentity?.image) ? e.visualIdentity.image : [];
        const pick = imgs.find(i => i.maxWidth === 320) || imgs.find(i => i.maxWidth === 160) || imgs[0] || null;
        const rec = { name: e?.name || "", image_url: canonicalArtUrl(pick?.url || null) };
        resolved.set(id, rec);
        if (ctx) ctx.waitUntil(env.RN_KV.put(key, JSON.stringify(rec), { expirationTtl: ARTIST_KV_TTL }));
      } catch (e) {
        if (budget.fault(e) === "cap") capped = true;
        else artistFailed++;
      }
    }));

    for (const id of Object.keys(meta)) {
      meta[id].artists = (meta[id].artists || []).map(a => {
        const hit = resolved.get(a.id);
        return hit ? { ...a, image_url: hit.image_url || null, name: a.name || hit.name, checked: now } : a;
      });
    }

    const next = { ...payload, tracks: payload.tracks.map(t => withTrackMeta(t, meta[t.id])) };
    budget.charge(2);
    await Promise.all([
      env.RN_KV.put(TRACK_META_KEY, JSON.stringify(meta)),
      env.RN_KV.put(cacheKey, JSON.stringify(next)),
    ]);

    const covered = live.filter(id => meta[id]?.image_url).length;
    s.setAttribute("rn.tracks_total", live.length);
    s.setAttribute("rn.tracks_covered", covered);
    s.setAttribute("rn.track_scraped", trackScraped);
    s.setAttribute("rn.track_failed", trackFailed);
    s.setAttribute("rn.artists_cached", artistCached);
    s.setAttribute("rn.artists_scraped", artistScraped);
    s.setAttribute("rn.artists_failed", artistFailed);
    s.setAttribute("rn.meta_pruned", pruned);
    s.setAttribute("rn.covers_pending", live.length - covered);
    s.setAttribute("rn.capped", capped);
    recordBudget(s, budget);
    return { ok: true, total: live.length, covered, pending: live.length - covered };
  });
}

export async function scrapeSpotifyEmbed(kindAndId, env) {
  const isPlaylist = kindAndId.startsWith("playlist/");
  const tryOnce = async (bustCache) => {
    const fresh = bustCache || isPlaylist;
    const qs = fresh ? `?_t=${Date.now()}` : "";
    const res = await signedFetch(`https://open.spotify.com/embed/${kindAndId}${qs}`, env || {}, {
      robots: "spotify-embed",
      signal: AbortSignal.timeout(5000),
      cf: fresh
        ? { cacheTtl: 0, cacheEverything: false }
        : { cacheTtl: 86400, cacheEverything: true },
    });
    if (!res.ok) throw new Error(`embed ${kindAndId}: ${res.status}`);
    const html = await res.text();
    const m = html.match(/<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    if (!m) throw new Error(`no __NEXT_DATA__ in ${kindAndId}`);
    const data = JSON.parse(m[1]);
    return data?.props?.pageProps?.state?.data?.entity || {};
  };

  let entity = null;
  try {
    entity = await tryOnce(false);
  } catch (_e) {
  }

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

export async function handleRnAdmin(request, env) {
  const url = new URL(request.url);
  const secret = url.searchParams.get("secret") || "";

  if (!secretMatches(secret, env.RN_BUST_SECRET)) {
    return setPage(403, "denied", "wrong secret. check the bookmark.");
  }

  let current = "(empty — using fallback)";
  if (env.RN_KV) {
    const id = await env.RN_KV.get("playlist-id");
    if (id) current = `<a href="https://open.spotify.com/playlist/${esc(id)}" target="_blank" rel="noopener">open.spotify.com/playlist/${esc(id)}</a>`;
  }

  const body = `
    <p><strong>Currently:</strong><br>${current}</p>
    <form method="POST" action="/rn/set" autocomplete="off" style="margin-top:14px">
      <input type="hidden" name="secret" value="${esc(secret)}">
      <label for="u" style="display:block;font-weight:bold;color:var(--blue-40);margin-bottom:4px">New playlist URL:</label>
      <input id="u" name="url" type="text" placeholder="https://open.spotify.com/playlist/..." autofocus class="xp-input" style="font-family:var(--font-mono)">
      <p style="margin-top:10px">
        <button type="submit" class="xp-button default">
          Update /rn
        </button>
      </p>
    </form>
    <p style="margin-top:18px;color:var(--ink-dim);font-size:var(--text-sm)">
      <em>Tip:</em> on Spotify desktop, right-click the playlist &rarr; Share &rarr;
      Copy link to playlist, then paste here.
    </p>`;
  return setPage(200, "update /rn", body);
}

export async function handleRnSet(request, env) {
  const url = new URL(request.url);
  const params = await readParams(request, url);
  const secret = params.get("secret") || "";
  const target = params.get("url")    || "";

  if (!secretMatches(secret, env.RN_BUST_SECRET)) {
    return setPage(403, "denied", "wrong secret. check the bookmark.");
  }

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
    return setPage(500, "no kv binding", "the worker can't see RN_KV — bind it in cloudflare.config.ts.");
  }
  await env.RN_KV.put("playlist-id", id);

  return setPage(200, "updated",
    `<code>/rn</code> now points to <a href="https://open.spotify.com/playlist/${esc(id)}" target="_blank" rel="noopener">open.spotify.com/playlist/${esc(id)}</a>.<br>` +
    `<small><a href="/rn/admin?secret=${esc(secret)}">&larr; back to admin</a></small>`);
}

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

export function setPage(status, title, bodyHtml) {
  const pageTitle = `aadhar.sh/rn/set/${title}`;
  return lunaPage({
    status,
    title: pageTitle,
    path: pageTitle,
    width: 520,
    robots: "noindex",
    css: `
  h1 { font-size: 16pt; margin: 0 0 8px; }
  a:link    { color: var(--link); text-decoration: underline; }
  a:visited { color: var(--link-visited); }
  a:hover   { color: var(--link-hover); }
  code { font-family: var(--font-mono); background: oklch(96.72% 0 0); padding: 0 3px; border: 1px solid var(--grey-88); }
`,
    body: unsafeHtml(`
    <h1>${esc(title)}</h1>
    <p>${bodyHtml}</p>
    <p><small>&larr; <a href="/">aadhar.sh</a></small></p>
`),
    cache: "no-store",
    headers: {
      "x-robots-tag":  "noindex",
    },
  });
}
