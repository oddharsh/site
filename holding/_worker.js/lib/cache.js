// lib/cache.js: the worker's caching kit, one primitive surface where four
// hand-rolled dialects used to drift apart.
//
//   swrKV: a persistent KV value plus a tiny ":fresh" TTL sentinel. Stale serves
//   instantly, the rebuild rides ctx.waitUntil, and only a true cold miss builds
//   inline. Callers pass validity guards because a transient empty rebuild must
//   never wipe a good stale value; two of the four old copies allowed exactly that.
//
//   cachedRender: caches.default for rendered shells whose bytes are static-shaped,
//   so the s-maxage a route declares finally means something on worker output.

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

// Contract, in the order it saves you:
//   - the edge TTL is the response's own cache-control (caches.default honors
//     s-maxage, else max-age); nothing rewrites headers, so browsers see exactly
//     what the route declared.
//   - cache.put fires only on status 200, because a pinned transient 404 is the
//     poison class this site has already paid for once.
//   - the key normalizes to a path, so query variants of a query-independent
//     shell share one entry.
//   - x-edge-cache: hit|miss makes every request auditable from curl.
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
