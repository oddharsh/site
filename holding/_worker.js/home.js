// home.js — extracted from the worker (no-build reorg). Bundled by
// wrangler/Cloudflare at deploy; not served (inside _worker.js/).
import { wantsMarkdown } from "./lib/http.js";
import { HOMEPAGE_DISCOVERY_LINK } from "./lib/security.js";
import { renderPhotoSlots } from "./lib/photo-grid.js";
import { span } from "./lib/trace.js";
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
// Traced in two phases. What the spans buy is the SPLIT and the attributes, NOT
// visibility into compute — see the correction below.
//
// MEASURED 2026-07-29, in production, and it killed the original idea here: a
// span does NOT see pure compute. Workers spans inherit exactly the frozen-clock
// semantics of `Date.now()` (the clock advances across I/O, not during
// synchronous execution), so `home.grid.render` reports ~0 for the same reason
// perf-probe.js's `time()` helper does. Proven on `/lens/fetch` against a 752KB
// Wikipedia page: `lens.inspect` 685ms = `lens.discovery` 656ms +
// `lens.inspect.fetch` 29ms + `lens.inspect.parse` 0ms, where that parse had just
// run an HTMLRewriter pass over 752KB and emitted 81KB of markdown. For CPU, read
// `cpuTime` off the tail/log event (193ms on that request); spans are for I/O
// structure and attributes. `home.grid.render` is kept anyway, because its
// ATTRIBUTES (served, pool_size, alt_known) are the point.
//
// The two reads are also worth splitting: they run concurrently but they are
// different animals. `manifest` is a two-key SWR over KV that can pay an R2 list
// on a cold miss; `alt` is module-cached and free on a warm isolate. Fused into
// one number (as the probe's positional `doubles` fuses them) a slow cold
// manifest and a slow cold alt map are indistinguishable.
export async function handlePhotoGrid(request, env, ctx) {
  const [pool, altMap] = await Promise.all([
    span("home.grid.manifest", () =>
      getImagesManifest(env, ctx).then((a) => (Array.isArray(a) && a.length ? a : null), () => null)),
    span("home.grid.alt", () => getAltMap(env).catch(() => ({}))),
  ]);
  // 503 is the honest answer when the manifest is unreachable: the fragment has
  // nothing to say and the page keeps its baked twelve. Recorded as an attribute
  // so "how often does the grid fall back" is a query, not a guess.
  if (!pool) {
    return span("home.grid.render", (s) => {
      s.setAttribute("home.grid.served", false);
      return new Response("", { status: 503, headers: { "cache-control": "no-store" } });
    });
  }
  return span("home.grid.render", (s) => {
    s.setAttribute("home.grid.served", true);
    s.setAttribute("home.grid.pool_size", pool.length);
    s.setAttribute("home.grid.alt_known", Object.keys(altMap || {}).length);
    // deferred:false — these twelve are the real grid, not a placeholder, so
    // they carry live URLs and start the moment innerHTML lands.
    return new Response(renderPhotoSlots(pickRandom(pool, 12), altMap || {}, { deferred: false }), {
      status: 200,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store, must-revalidate",
        "x-content-type-options": "nosniff",
      },
    });
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
