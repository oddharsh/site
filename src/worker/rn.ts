import { json, text } from "./http";

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
