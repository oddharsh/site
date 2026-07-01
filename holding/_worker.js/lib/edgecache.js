// edgecache.js — a small caches.default layer for static-shaped worker-rendered
// routes (same pattern proven by servePhotoFromR2's x-photo-cache in photos.js).
//
// Why: worker responses are NOT auto edge-cached, so an s-maxage on a rendered
// route does nothing by itself. This makes it true: repeat hits per colo serve
// from the edge instead of re-running the render (KV reads, ASSETS fan-out,
// template assembly).
//
// Contract:
//   - the EDGE TTL comes from the response's own cache-control (caches.default
//     honors s-maxage, else max-age) — no header rewriting, so browsers see the
//     route's intended headers on hit and miss alike. Keep those TTLs honest
//     (<= ~300s edge for anything that changes on deploy: caches.default is NOT
//     flushed by a deploy, the TTL bounds the stale window).
//   - cache.put ONLY on status 200 — a transient 404/500 must never get pinned
//     at the edge (the poison class this repo has burned on; see CLAUDE.md).
//   - the key is a normalized URL (path only by default) so query-string
//     variants of a query-independent shell share one entry.
//   - x-edge-cache: hit|miss makes the layer observable from curl.
export async function cachedRender(request, ctx, renderFn, keyPath) {
  const url = new URL(request.url);
  const key = new Request(url.origin + (keyPath || url.pathname), { method: "GET" });
  const cache = caches.default;

  if (request.method === "GET") {
    const hit = await cache.match(key);
    if (hit) {
      const r = new Response(hit.body, hit);
      r.headers.set("x-edge-cache", "hit");
      return r;
    }
  }

  const resp = await renderFn();
  if (request.method === "GET" && resp.status === 200 && ctx) {
    ctx.waitUntil(cache.put(key, resp.clone()));
    const out = new Response(resp.body, resp);
    out.headers.set("x-edge-cache", "miss");
    return out;
  }
  return resp;
}
