import { json, text } from "./http.ts";
import { fetchPublicResource } from "./lens.ts";

const fallbackId = "4IRq9W1N2tOWHhH0O3vXiF";

type Track = { title?: string; artists_text?: string; artists?: { name?: string }[]; duration_ms?: number; song_link_url?: string; spotify_url?: string; is_explicit?: boolean };
type Playlist = { playlist_id?: string; playlist_name?: string; tracks?: Track[]; error?: string };

function escapeHtml(value: unknown): string {
  return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

async function playlistId(env: Env): Promise<string> {
  try {
    const value = await env.RN_KV.get("playlist-id");
    return value && /^[A-Za-z0-9]{22}$/.test(value) ? value : fallbackId;
  } catch { return fallbackId; }
}

async function playlist(env: Env): Promise<{ id: string; payload: Playlist }> {
  const id = await playlistId(env);
  try {
    return { id, payload: await env.RN_KV.get<Playlist>(`tracks:${id}`, "json") ?? { playlist_id: id, tracks: [] } };
  } catch { return { id, payload: { playlist_id: id, tracks: [] } }; }
}

type EmbedTrack = { uri?: string; title?: string; subtitle?: string; isExplicit?: boolean; duration?: number };

function decode(value: string): string {
  return value.replace(/&amp;/gi, "&").replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

export function parseSpotifyPage(source: string, id: string): Playlist {
  const script = source.match(/<script\b(?=[^>]*\bid=["']__NEXT_DATA__["'])[^>]*>([\s\S]*?)<\/script>/i)?.[1];
  if (script) {
    const document = JSON.parse(script) as { props?: { pageProps?: { state?: { data?: { entity?: { name?: string; title?: string; id?: string; trackList?: EmbedTrack[] } } } } } };
    const entity = document.props?.pageProps?.state?.data?.entity;
    if (entity && Array.isArray(entity.trackList)) return {
      playlist_id: entity.id || id,
      playlist_name: entity.name || entity.title || "Right now",
      tracks: entity.trackList.slice(0, 200).map((track) => {
        const trackId = track.uri?.match(/^spotify:track:([A-Za-z0-9]+)$/)?.[1];
        return { title: String(track.title || "Untitled").slice(0, 300), artists_text: String(track.subtitle || "").replaceAll(" ", " ").slice(0, 500), duration_ms: Number(track.duration) || 0, song_link_url: trackId ? `https://open.spotify.com/track/${trackId}` : undefined, spotify_url: trackId ? `https://open.spotify.com/track/${trackId}` : undefined, is_explicit: Boolean(track.isExplicit) };
      }),
    };
  }
  const tracks = source.split(/(?=<div\b(?=[^>]*\bdata-testid=["']track-row["']))/i).flatMap((chunk) => {
    const trackId = chunk.match(/listrow-title-track-spotify:track:([A-Za-z0-9]+)/i)?.[1];
    const title = decode(chunk.match(/data-encore-id=["']listRowTitle["'][^>]*>[\s\S]*?<span\b[^>]*>([\s\S]*?)<\/span>/i)?.[1] ?? "");
    if (!trackId || !title) return [];
    const artists = decode(chunk.match(/data-encore-id=["']listRowDetails["'][^>]*>([\s\S]*?)<\/p>/i)?.[1] ?? "").replace(/\s*,\s*/g, ", ");
    return [{ title: title.slice(0, 300), artists_text: artists.slice(0, 500), duration_ms: 0, song_link_url: `https://open.spotify.com/track/${trackId}`, spotify_url: `https://open.spotify.com/track/${trackId}`, is_explicit: /aria-label=["']Explicit["']/i.test(chunk) }];
  }).slice(0, 200);
  if (!tracks.length) throw new Error("Spotify playlist data has an unknown shape");
  const playlistName = decode(source.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "").replace(/\s*[-–]\s*playlist by[\s\S]*$/i, "") || "Right now";
  return { playlist_id: id, playlist_name: playlistName, tracks };
}

export async function refreshNowPlaying(env: Env): Promise<Playlist> {
  const id = await playlistId(env);
  const fetched = await fetchPublicResource(`https://open.spotify.com/playlist/${id}`, env, { accept: "text/html" }, 1024 * 1024);
  if (!fetched.response.ok || fetched.body.truncated) throw new Error("Spotify playlist is unavailable or too large");
  const payload = parseSpotifyPage(fetched.body.text, id);
  await env.RN_KV.put(`tracks:${id}`, JSON.stringify(payload));
  return payload;
}

function duration(ms = 0): string {
  const seconds = Math.round(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function artists(track: Track): string {
  return track.artists_text || track.artists?.map(({ name }) => name).filter(Boolean).join(", ") || "";
}

export async function rnRedirect(env: Env): Promise<Response> {
  return new Response(null, { status: 302, headers: { location: `https://open.spotify.com/playlist/${await playlistId(env)}`, "cache-control": "no-store", "referrer-policy": "no-referrer" } });
}

export async function rnTracks(env: Env): Promise<Response> {
  const { payload } = await playlist(env);
  return json(payload, { headers: { "cache-control": "public, max-age=300", "x-robots-tag": "noindex" } });
}

export async function rnTracksHtml(env: Env): Promise<Response> {
  const { payload } = await playlist(env);
  const tracks = Array.isArray(payload.tracks) ? payload.tracks : [];
  const body = tracks.length ? tracks.map((track) => `<li><a href="${escapeHtml(track.song_link_url || track.spotify_url || "#")}" rel="external noopener"><span>${escapeHtml(track.title)}</span> — <span>${escapeHtml(artists(track))}</span>${track.duration_ms ? ` <time>${duration(track.duration_ms)}</time>` : ""}${track.is_explicit ? " <abbr title=\"Explicit\">E</abbr>" : ""}</a></li>`).join("") : `<li>No tracks yet. <a href="/rn">Open the playlist on Spotify</a>.</li>`;
  return new Response(body, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=300", "x-content-type-options": "nosniff", "x-rn-fragment": "1" } });
}

export async function rnMarkdown(env: Env): Promise<Response> {
  const { id, payload } = await playlist(env);
  const tracks = Array.isArray(payload.tracks) ? payload.tracks : [];
  const lines = [`# ${payload.playlist_name ? `Right now: ${payload.playlist_name}` : "Right now"}`, "", "The current playlist behind aadhar.sh/rn.", "", "Same live payload as JSON: https://aadhar.sh/rn/tracks", "", `Playlist: <https://open.spotify.com/playlist/${id}>`, ""];
  if (!tracks.length) lines.push("No tracks yet.");
  else tracks.forEach((track, index) => lines.push(`${index + 1}. ${String(track.title ?? "Untitled").replace(/[\\`*_[\]]/g, "\\$&")} · ${artists(track)}${track.duration_ms ? ` (${duration(track.duration_ms)})` : ""}`));
  return text(`${lines.join("\n")}\n`, { headers: { "content-type": "text/markdown; charset=utf-8", "cache-control": "public, max-age=300" } });
}
