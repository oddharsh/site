// og-video.ts: a link preview that plays, for the two preview fetchers that
// play one, in the one codec each can be trusted to decode.
//
// A page with a clip keeps its static document for everyone else, people and
// every other bot included, so a clip costs nothing on the path that matters.
// Only the two fetchers below get a rewritten copy carrying og:video, and the
// copy is no-store and says it varies by User-Agent, so no cache can hand it
// to a person.
//
//   iMessage  HEVC in MP4. The SENDER's device downloads the clip and ships it
//             inside the message, so the RECIPIENT's device is the decoder that
//             has to cope. Every iPhone since the 7 decodes HEVC in hardware;
//             AV1 has hardware decode only from A17 Pro / M3, and AVFoundation
//             has no software fallback, so an AV1 clip is a dead card on an
//             older phone. Apple's TN3156 asks for a direct, downloadable file.
//   Discord   AV1 in WebM. Discord's docs take .mp4, .webm and .mov pointed at
//             directly, need og:type video.*, and keep og:image as the poster.
//
// Measured 2026-10-23 on nine recorded demos at SSIMULACRA2 80 with matched
// 4:2:0 conversion: H.264 2017 KB, HEVC 1077 KB, AV1 406 KB in total. The
// /garage/encoding clip is 197 KB as HEVC and 78 KB as AV1. The homepage's is
// an XP-style boot screen looping on its progress bar, mostly black, so it
// ships at SSIMULACRA2 88 for 32 KB and 11 KB (tools/photos/og-video/).
//
// The iMessage match is its whole LinkPresentation signature, not the
// facebookexternalhit token alone: Facebook's own crawler sends that token too,
// and nothing here says Facebook plays HEVC.
//
// The clip URLs take the REQUEST's origin, so a preview URL's copy points at
// the preview's own files rather than at production, where a new clip does
// not exist until the merge deploys.
export type OgVideo = { hevc: string; av1: string; width: number; height: number };

/** Keyed by page path. Files are site-relative under public/og/video/
 *  (contract-og-videos-resolve), each with the page's og:image as its poster. */
export const OG_VIDEOS: Readonly<Record<string, OgVideo>> = {
  "/": { hevc: "/og/video/home.hevc.mp4", av1: "/og/video/home.av1.webm", width: 1200, height: 630 },
  "/garage/encoding": { hevc: "/og/video/garage-encoding.hevc.mp4", av1: "/og/video/garage-encoding.av1.webm", width: 1200, height: 630 },
};

const IMESSAGE = /facebookexternalhit\/1\.1 Facebot Twitterbot\/1\.0/;
const DISCORD = /\bDiscordbot\b/;

export type ChosenVideo = { codec: "hevc" | "av1"; path: string; type: string; width: number; height: number };

export function ogVideoFor(pathname: string, userAgent: string | null | undefined): ChosenVideo | null {
  const v = OG_VIDEOS[pathname];
  if (!v || !userAgent) return null;
  if (DISCORD.test(userAgent)) return { codec: "av1", path: v.av1, type: "video/webm", width: v.width, height: v.height };
  if (IMESSAGE.test(userAgent)) return { codec: "hevc", path: v.hevc, type: "video/mp4", width: v.width, height: v.height };
  return null;
}

/** The page's own document with og:type set to video.other and the og:video
 *  block written after it. Everything else in it is left as built. */
export function withOgVideo(page: Response, origin: string, v: ChosenVideo): Response {
  const url = `${origin}${v.path}`;
  const tags = [
    `<meta property="og:video" content="${url}">`,
    `<meta property="og:video:secure_url" content="${url}">`,
    `<meta property="og:video:type" content="${v.type}">`,
    `<meta property="og:video:width" content="${v.width}">`,
    `<meta property="og:video:height" content="${v.height}">`,
  ].join("");
  // The block goes right after og:type, never at the end of <head>: the
  // minifier drops the optional </head>, and an append on an element with no
  // end tag writes nothing (measured on the built /garage/encoding, 2026-10-23).
  const rewritten = new HTMLRewriter()
    .on('meta[property="og:type"]', {
      element(e) {
        e.setAttribute("content", "video.other");
        e.after(tags, { html: true });
      },
    })
    .transform(page);
  const out = new Response(rewritten.body, rewritten);
  // The bytes are no longer the asset's, so its validator would lie.
  out.headers.delete("etag");
  out.headers.delete("last-modified");
  out.headers.set("cache-control", "no-store");
  out.headers.set("vary", "User-Agent");
  out.headers.set("x-og-video", v.codec);
  return out;
}

export type ByteRange = { start: number; end: number };

/** One `bytes=` range against a body of `size` bytes: a range, "unsatisfiable",
 *  or null for no usable Range (absent, malformed or multi-range), which the
 *  caller answers with the whole body as RFC 9110 allows. */
export function parseRange(header: string | null, size: number): ByteRange | "unsatisfiable" | null {
  if (!header) return null;
  const m = header.trim().match(/^bytes=(\d*)-(\d*)$/);
  if (!m || (m[1] === "" && m[2] === "")) return null;
  if (m[1] === "") {
    const n = Number(m[2]);
    if (n === 0) return "unsatisfiable";
    return { start: Math.max(0, size - n), end: size - 1 };
  }
  const start = Number(m[1]);
  if (start >= size) return "unsatisfiable";
  const end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
  if (end < start) return null;
  return { start, end };
}

// The clips need Range, and the asset layer ignores it: a `Range: bytes=0-99`
// on /og/home.jpg came back 200 with all 105,441 bytes (measured 2026-10-23),
// and AVFoundation, which plays the iMessage card, wants 206 for MP4. A clip is
// a few hundred KB, so slicing the whole asset in the Worker is cheaper than
// anything cleverer.
const VIDEO_TYPES: Record<string, string> = { mp4: "video/mp4", webm: "video/webm" };

export async function serveOgVideo(request: Request, assets: { fetch: (r: Request) => Promise<Response> }): Promise<Response> {
  const url = new URL(request.url);
  const type = VIDEO_TYPES[url.pathname.split(".").pop()?.toLowerCase() ?? ""];
  const head = request.method === "HEAD";
  if (!type || (!head && request.method !== "GET")) return new Response("not found", { status: 404 });
  const asset = await assets.fetch(new Request(url.toString(), { headers: { "accept-encoding": "identity" } }));
  if (!asset.ok) return asset;
  const bytes = new Uint8Array(await asset.arrayBuffer());
  const headers = new Headers({
    "content-type": type,
    "accept-ranges": "bytes",
    // the /og/* policy in public/_headers: stable URL, regenerated rarely
    "cache-control": "public, max-age=2592000, s-maxage=2592000",
    "x-content-type-options": "nosniff",
  });
  const etag = asset.headers.get("etag");
  if (etag) headers.set("etag", etag);
  if (etag && request.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers });
  const range = parseRange(request.headers.get("range"), bytes.length);
  if (range === "unsatisfiable") {
    headers.set("content-range", `bytes */${bytes.length}`);
    return new Response(null, { status: 416, headers });
  }
  if (range) {
    headers.set("content-range", `bytes ${range.start}-${range.end}/${bytes.length}`);
    headers.set("content-length", String(range.end - range.start + 1));
    return new Response(head ? null : bytes.subarray(range.start, range.end + 1), { status: 206, headers });
  }
  headers.set("content-length", String(bytes.length));
  return new Response(head ? null : bytes, { status: 200, headers });
}
