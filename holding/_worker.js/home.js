// home.js — extracted from the worker (no-build reorg). Bundled by
// wrangler/Cloudflare at deploy; not served (inside _worker.js/).
import { wantsMarkdown } from "./lib/http.js";
import { HOMEPAGE_DISCOVERY_LINK } from "./lib/security.js";
import { renderPhotoSlots } from "./lib/photo-grid.js";
import { getAltMap, getImagesManifest } from "./photos.js";

export function homepageHeadResponse(request) {
  const markdown = wantsMarkdown(request);
  return new Response(null, {
    status: 200,
    headers: {
      "content-type": markdown
        ? "text/markdown; charset=utf-8"
        : "text/html; charset=utf-8",
      // HTML mirrors the GET path's bfcache-friendly policy (see _headers "/"):
      // private + no-cache keeps every real fetch fresh while leaving the page
      // eligible for the browser's back/forward cache. markdown rep stays no-store
      // (it is a content-negotiated representation, never a back/forward target).
      "cache-control": markdown
        ? "no-store, must-revalidate"
        : "private, no-cache, must-revalidate",
      "vary": "accept",
      "link": HOMEPAGE_DISCOVERY_LINK,
      "x-content-type-options": "nosniff",
    },
  });
}

// ── the homepage's dynamic half, as a fragment ──────────────────────
// `/` itself is now a DETERMINISTIC static document: build.mjs bakes a fixed
// twelve tiles and the newest-photo date into it, so it carries a q11 twin, a
// dcz delta, and a real ETag like every other page here. What used to be four
// HTMLRewriter injections (tracks, photo grid, visit counter, last-modified)
// left the document by four different routes:
//
//   tracks          → /rn/tracks.html, the fragment the SSR deadline path
//                     already fell back to. Now the only path.
//   photo grid      → this handler.
//   visit counter   → /hit?peek=1, which already read without bumping.
//   last-modified   → BAKED. It derives from the bundled photo index, so it
//                     changes only on deploy; a build is the honest place for
//                     it. The old comment here claimed "there's no build step",
//                     which stopped being true when build.mjs arrived.
//
// no-store, because the whole point of this response is that it differs every
// time. It is small (twelve <a> blocks, ~4KB br) and it is fetched after the
// document has already painted its text.
export async function handlePhotoGrid(request, env, ctx) {
  const [pool, altMap] = await Promise.all([
    getImagesManifest(env, ctx).then((a) => (Array.isArray(a) && a.length ? a : null), () => null),
    getAltMap(env).catch(() => ({})),
  ]);
  if (!pool) return new Response("", { status: 503, headers: { "cache-control": "no-store" } });
  return new Response(renderPhotoSlots(pickRandom(pool, 12), altMap || {}), {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store, must-revalidate",
      "x-content-type-options": "nosniff",
    },
  });
}

// fisher-yates shuffle, return first N elements. doesn't mutate input.
export function pickRandom(arr, n) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, n);
}

// per-artist nav targets that open spotify's artist page. emitted as
// spans (not <a>) because the wrapping row is an <a> and nested anchors
// are invalid HTML — the inline script on index.html intercepts clicks
// on .np-artist-link, stopPropagation, and opens the data-href. role+
// tabindex keep them keyboard- and screen-reader-accessible.
//
// each span also carries data-artist-name and (when known) data-artist-image
// so the XP hover-tooltip can show a profile pic + name on hover. when we
export async function serveMarkdown(request, env) {
  // ask the static assets layer for /index.md
  const mdUrl = new URL("/index.md", request.url);
  const mdRes = await env.ASSETS.fetch(new Request(mdUrl.toString(), request));
  if (!mdRes.ok) {
    // markdown not available — fall back to HTML
    return env.ASSETS.fetch(request);
  }
  const body = await mdRes.text();
  // rough token estimate: ~4 chars per token. honest approximation; agents
  // that care about exact counts can run their own tokenizer.
  const tokens = Math.ceil(body.length / 4);
  return new Response(body, {
    status: 200,
    headers: {
      "content-type":     "text/markdown; charset=utf-8",
      "x-markdown-tokens": String(tokens),
      // Cloudflare's edge can serve a cached negotiated root variant to clients
      // with a different Accept header. /index.md remains the cacheable Markdown
      // resource; negotiated "/" Markdown must stay uncacheable.
      "cache-control":    "no-store, must-revalidate",
      "vary":             "accept",
      "link":             HOMEPAGE_DISCOVERY_LINK,
      "x-content-type-options": "nosniff",
    },
  });
}
