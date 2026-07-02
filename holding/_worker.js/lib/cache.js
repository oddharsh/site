// lib/cache.js — the Worker-side caching kit.
//
// Two cache shapes live here:
//   - swrKV: persistent KV value + tiny ":fresh" TTL sentinel. Stale values serve
//     immediately while the rebuild rides ctx.waitUntil; true cold misses build
//     inline. Callers provide validity/storage guards so a transient empty rebuild
//     cannot wipe a good stale value.
//   - cachedRender: caches.default wrapper for worker-rendered shells whose bytes
//     are static-shaped.

export async function swrKV(env, ctx, key, ttl, buildFn, opts = {}) {
  const kv = env && env.RN_KV;
  const type = opts.type || "json";
  const freshKey = opts.freshKey || `${key}:fresh`;
  const isValid = opts.isValid || ((value) => value !== null && value !== undefined);
  const shouldStore = opts.shouldStore || isValid;
  const buildOnMiss = opts.buildOnMiss !== false;

  const store = async (value) => {
    if (!kv || !shouldStore(value)) return value;
    const body = type === "json" ? JSON.stringify(value) : value;
    await Promise.all([
      kv.put(key, body),
      kv.put(freshKey, "1", { expirationTtl: ttl }),
    ]);
    return value;
  };

  if (kv) {
    let value = null, fresh = null;
    try {
      [value, fresh] = await Promise.all([
        kv.get(key, type),
        kv.get(freshKey),
      ]);
    } catch {}

    if (isValid(value)) {
      if (!fresh && ctx) {
        ctx.waitUntil(
          Promise.resolve()
            .then(buildFn)
            .then(store)
            .catch(() => {})
        );
      }
      return value;
    }
  }

  if (!buildOnMiss) return null;

  const value = await buildFn();
  if (kv && shouldStore(value)) {
    const write = store(value).catch(() => {});
    if (ctx) ctx.waitUntil(write);
    else await write;
  }
  return value;
}

export async function deleteSWRKV(env, key, opts = {}) {
  if (!env || !env.RN_KV) return;
  const freshKey = opts.freshKey || `${key}:fresh`;
  await Promise.all([
    env.RN_KV.delete(key),
    env.RN_KV.delete(freshKey),
  ]);
}

// edge-render cache: a small caches.default layer for static-shaped
// worker-rendered routes (same pattern proven by servePhotoFromR2 in photos.js).
//
// Contract:
//   - the EDGE TTL comes from the response's own cache-control (caches.default
//     honors s-maxage, else max-age) — no header rewriting.
//   - cache.put ONLY on status 200 — a transient 404/500 must never get pinned.
//   - the key is a normalized URL (path only by default) so query-string variants
//     of a query-independent shell share one entry.
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
