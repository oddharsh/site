import { serveMarkdownTwin } from "./lib/assets.ts";
import { HOMEPAGE_DISCOVERY_LINK } from "./lib/security.ts";
import { renderPhotoSlots } from "./lib/photo-grid.ts";
import { islandResponse } from "./lib/island.ts";
import { span } from "./lib/trace.ts";
import { CURATED_POOL, getAltMap, getHistogramMap } from "./photos.ts";

// ── the homepage's dynamic half, as a fragment ──────────────────────
// `/` itself is a DETERMINISTIC static document: build.ts bakes a fixed
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
//                     it.
//
// no-store, because the whole point of this response is that it differs every
// time. It is small (twelve <a> blocks, ~4KB br) and it is fetched after the
// document has already painted its text.
//
// Traced in phases for the SPLIT and the attributes. A span does not see pure
// compute (measured in production 2026-07-29): Workers spans inherit the
// frozen-clock semantics of `Date.now()`, which advances across I/O and not
// during synchronous execution, so `home.grid.render` reports ~0. Read
// `cpuTime` off the tail/log event for CPU. `home.grid.render` stays because
// its ATTRIBUTES (served, pool_size, alt_known, hist_known) are the point.

// The document always arrives before the fragment, in the same isolate: `/` is
// Worker-served (dcz), and the fragment is a preload the document itself names.
// So the two ASSETS reads the fragment's FIRST request per isolate pays (alt.json
// 14 KB, histograms.json 70 KB, both memoised in photos.ts) can be spent while
// the document is being served instead. Measured 2026-09-21 in a real window:
// the fragment took 168 ms on a cold isolate against 44 ms warm, and the twelve
// images cannot be discovered until it lands. Runs under ctx.waitUntil, so it
// costs the document response nothing and a failed read is the same {} the
// getters already fall back to. Bundling the two files was the other repair and
// was declined once already (photos.ts, "22.9 KiB gzip").
export function warmGridData(env) {
  return Promise.all([getAltMap(env).catch(() => {}), getHistogramMap(env).catch(() => {})]);
}

export async function handlePhotoGrid(request, env) {
  const pool = span("home.grid.manifest", () => CURATED_POOL);
  const [altMap, histograms] = await Promise.all([
    span("home.grid.alt", () => getAltMap(env).catch(() => ({}))),
    // Module-cached like the alt map, so this is one ASSETS read per isolate
    // rather than per request, and free on every warm one. An empty map is a
    // legal answer: the tiles simply carry no data-hist and tooltip.js falls
    // back to the per-photo fetch.
    span("home.grid.hist", () => getHistogramMap(env).catch(() => ({}))),
  ]);
  // 503 is the honest answer when the bundled pool is empty: the fragment has
  // nothing to say and the page keeps its baked twelve. Recorded as an attribute
  // so "how often does the grid fall back" is a query, not a guess.
  if (!pool.length) {
    return span("home.grid.render", (s) => {
      s.setAttribute("home.grid.served", false);
      return new Response("", { status: 503, headers: { "cache-control": "no-store" } });
    });
  }
  return span("home.grid.render", (s) => {
    s.setAttribute("home.grid.served", true);
    s.setAttribute("home.grid.pool_size", pool.length);
    s.setAttribute("home.grid.alt_known", Object.keys(altMap || {}).length);
    s.setAttribute("home.grid.hist_known", Object.keys(histograms || {}).length);
    // deferred:false — these twelve are the real grid, not a placeholder, so
    // they carry live URLs and start the moment innerHTML lands.
    // An island fragment (lib/island.ts): the x-island marker is what lets the
    // homepage's one island script tell this body from an edge error page.
    return islandResponse(renderPhotoSlots(pickRandom(pool, 12), altMap || {}, { deferred: false, histograms }));
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

export async function serveMarkdown(request, env) {
  // Delegates to serveMarkdownTwin so the homepage negotiates exactly like every
  // other page, HEAD included. The link header is the only thing genuinely its own.
  const md = await serveMarkdownTwin(request, env, "/index.md", { link: HOMEPAGE_DISCOVERY_LINK });
  // No twin means a half-built deploy, and a navigation is worth more than a
  // representation: fall back to HTML rather than 404 the front door.
  return md || env.ASSETS.fetch(request);
}
