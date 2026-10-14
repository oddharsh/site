import { serveMarkdownTwin } from "./lib/assets.ts";
import { HOMEPAGE_DISCOVERY_LINK } from "./lib/security.ts";
import { renderPhotoSlots } from "./lib/photo-grid.ts";
import { islandResponse } from "./lib/island.ts";
import { span } from "./lib/trace.ts";
import { CURATED_POOL, getAltMap, getHistogramMap } from "./photos.ts";

export function warmGridData(env) {
  return Promise.all([getAltMap(env).catch(() => {}), getHistogramMap(env).catch(() => {})]);
}

export async function handlePhotoGrid(request, env) {
  const pool = span("home.grid.manifest", () => CURATED_POOL);
  const [altMap, histograms] = await Promise.all([
    span("home.grid.alt", () => getAltMap(env).catch(() => ({}))),
    span("home.grid.hist", () => getHistogramMap(env).catch(() => ({}))),
  ]);
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
    return islandResponse(renderPhotoSlots(pickRandom(pool, 12), altMap || {}, { deferred: false, histograms }));
  });
}

export function pickRandom(arr, n) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, n);
}

export async function serveMarkdown(request, env) {
  const md = await serveMarkdownTwin(request, env, "/index.md", { link: HOMEPAGE_DISCOVERY_LINK });
  return md || env.ASSETS.fetch(request);
}
