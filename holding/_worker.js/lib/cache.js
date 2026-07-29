// lib/cache.js: the worker's caching kit, one primitive surface where four
// hand-rolled dialects used to drift apart.
//
//   swrKV: a persistent KV value plus a tiny ":fresh" TTL sentinel. Stale serves
//   instantly, the rebuild rides ctx.waitUntil, and only a true cold miss builds
//   inline. Callers pass validity guards because a transient empty rebuild must
//   never wipe a good stale value; two of the four old copies allowed exactly that.
//
//   cachedRender: a local caches.default fallback for rendered shells whose bytes
//   are static-shaped. Production's named CachedPages entrypoint now sits in
//   front of these routes, so a Workers Cache hit skips the worker entirely;
//   this fallback still covers local dev, internal self-dispatch, and a miss
//   where the per-colo response is already warm.

// opts.cacheTtl (seconds, KV floor 30) keeps the value cached at the colo that
// read it. Without it KV's default is 60s, and this site's traffic is thin
// enough that most real visits are the first at their colo in over a minute, so
// they pay the central-store round trip: 120-200ms against a colo-local 3-5ms.
// Measured on the homepage 2026-07-27 (manifest 126ms / counter 149ms /
// tracks 204ms cold, versus 3-5ms each once warm).
//
// Two things follow from it, and both are the caller's call to price:
//   - a write or delete from ANOTHER colo stays invisible here for up to
//     cacheTtl, so a manual `wrangler kv key delete` bust lands late. Callers
//     that document a bust step keep this short.
//   - the sentinel gets the SAME cacheTtl on purpose. It rides the Promise.all
//     below, so leaving it uncached just moves the cold read rather than
//     removing it. The cost is that the effective freshness window at a colo
//     stretches to ttl + cacheTtl, and a lapsed sentinel reads as absent for up
//     to cacheTtl, so a colo can fire an extra background rebuild or two before
//     its own write settles. Both are bounded; neither touches the response.
export async function swrKV(env, ctx, key, ttl, buildFn, opts = {}) {
  const kv = env && env.RN_KV;
  const type = opts.type || "json";
  const freshKey = opts.freshKey || `${key}:fresh`;
  const isValid = opts.isValid || ((value) => value !== null && value !== undefined);
  const shouldStore = opts.shouldStore || isValid;
  const buildOnMiss = opts.buildOnMiss !== false;
  const cacheTtl = opts.cacheTtl;

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
        kv.get(key, cacheTtl ? { type, cacheTtl } : type),
        kv.get(freshKey, cacheTtl ? { type: "text", cacheTtl } : "text"),
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

// deadline: give a read a fixed budget on the render path, then ship without
// it. KV's per-colo cache is a shared LRU, so at this site's traffic a key can
// come back 100-200ms cold at ANY time (observed on the homepage 2026-07-27/28,
// including seconds after a warm read) — no cacheTtl makes that tail go away,
// because eviction isn't expiry. Racing the read caps what it can cost the
// response; the underlying promise is NOT cancelled, so a timed-out KV get
// still completes, still fires its SWR refresh, and still warms the colo for
// the next visitor. The work isn't wasted, only un-waited-for.
//
// onTimeout fires only if the budget lapses first (the timer is cleared when
// the read settles, so a 5ms read can never mark itself deadlined at 25ms).
// Callers pass a fallback distinguishable from the read's own miss value when
// they need "slow" and "absent" to behave differently downstream.
export function deadline(promise, ms, fallback, onTimeout) {
  let timer;
  return Promise.race([
    Promise.resolve(promise).finally(() => clearTimeout(timer)),
    new Promise((resolve) => {
      timer = setTimeout(() => {
        if (onTimeout) onTimeout();
        resolve(fallback);
      }, ms);
    }),
  ]);
}

export async function deleteSWRKV(env, key, opts = {}) {
  if (!env || !env.RN_KV) return;
  const freshKey = opts.freshKey || `${key}:fresh`;
  await Promise.all([
    env.RN_KV.delete(key),
    env.RN_KV.delete(freshKey),
  ]);
}

// The cache key folds in the deployed worker VERSION (CF_VERSION_METADATA.id),
// so a deploy mints a fresh keyspace and every old rendered shell is orphaned at
// once — the same "a name points at exact bytes" trick the /i/ content-hashed
// images use, lifted to worker output. No purge step, no TTL wait, no manual
// bump: the old entries just age out under their own max-age. Falls back to
// "dev" when the binding is absent (local dev, preview), so nothing breaks there.
export function edgeKey(origin, keyPath, env) {
  const ver = (env && env.CF_VERSION_METADATA && env.CF_VERSION_METADATA.id) || "dev";
  return new Request(`${origin}/__ec/${encodeURIComponent(ver)}${keyPath}`, { method: "GET" });
}

// If-None-Match uses WEAK comparison for GET/HEAD. Every validator this site
// emits has a deliberately simple opaque tag, but the request may contain a
// comma-separated list or `*`, so normalize the weak prefix on both sides and
// compare each candidate. A malformed candidate is simply not a match.
export function ifNoneMatchMatches(request, etag) {
  if (!etag || (request.method !== "GET" && request.method !== "HEAD")) return false;
  const raw = request.headers.get("if-none-match");
  if (!raw) return false;
  if (raw.trim() === "*") return true;
  const weak = (s) => s.trim().replace(/^W\//i, "");
  const current = weak(etag);
  return raw.split(",").some((candidate) => weak(candidate) === current);
}

// A 304 carries the metadata needed to update the cached representation, but no
// encoded body. Keep validators, cache policy, Vary, Link, dictionary offers,
// and diagnostics; remove only headers that describe payload bytes.
export function notModifiedIfFresh(request, response) {
  const etag = response.headers.get("etag");
  if (!ifNoneMatchMatches(request, etag)) return response;
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  headers.delete("content-encoding");
  headers.delete("transfer-encoding");
  // The 200 we are replacing usually wraps a live ASSETS/cache stream. Dropping the
  // Response without draining it leaves that stream unconsumed for the rest of the
  // invocation, so cancel it explicitly — same discipline as every other body we
  // decide not to serve in assets.js.
  try { response.body?.cancel(); } catch {}
  return new Response(null, { status: 304, headers });
}

// Worker-rendered shells have deterministic bytes but historically had no
// validator, so max-age=0 forced their complete body over the wire. Hash once
// on the cache miss, store the tagged response, and every warm revalidation can
// use the same cheap 304 path as a static asset.
export async function withWeakEtag(response) {
  if (response.status !== 200 || response.headers.has("etag")) return response;
  const bytes = await response.arrayBuffer();
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  let hex = "";
  for (const byte of digest) hex += byte.toString(16).padStart(2, "0");
  const headers = new Headers(response.headers);
  headers.set("etag", `W/"sha256-${hex}"`);
  headers.set("content-length", String(bytes.byteLength));
  return new Response(bytes, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

// Contract, in the order it saves you:
//   - the edge TTL is the response's own cache-control (caches.default honors
//     s-maxage, else max-age); nothing rewrites headers, so browsers see exactly
//     what the route declared.
//   - the key folds in the deploy version (edgeKey), so shipping busts every
//     shell atomically; within a version the response's max-age still bounds it.
//   - cache.put fires only on status 200, because a pinned transient 404 is the
//     poison class this site has already paid for once.
//   - the key normalizes to a path, so query variants of a query-independent
//     shell share one entry.
//   - x-edge-cache: hit|miss makes every request auditable from curl.
export async function cachedRender(request, ctx, renderFn, keyPath, env) {
  const url = new URL(request.url);
  const key = edgeKey(url.origin, keyPath || url.pathname, env);
  const cache = caches.default;

  if (request.method === "GET") {
    const hit = await cache.match(key);
    if (hit) {
      const r = new Response(hit.body, hit);
      r.headers.set("x-edge-cache", "hit");
      return notModifiedIfFresh(request, r);
    }
  }

  let resp = await renderFn();
  if (request.method === "GET" && resp.status === 200) {
    resp = await withWeakEtag(resp);
  }
  if (request.method === "GET" && resp.status === 200 && ctx) {
    ctx.waitUntil(cache.put(key, resp.clone()));
    const out = new Response(resp.body, resp);
    out.headers.set("x-edge-cache", "miss");
    return notModifiedIfFresh(request, out);
  }
  return notModifiedIfFresh(request, resp);
}
