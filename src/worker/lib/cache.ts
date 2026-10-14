import { isCanonicalHost } from "./const.ts";
import { wantsMarkdown } from "./http.ts";
import { CACHEABLE_PREFIXES } from "../routes.ts";

type SwrOptions<T> = {
  type?: "text" | "json" | "arrayBuffer" | "stream";
  isValid?: (value: T | null) => boolean;
  shouldStore?: (value: T | null) => boolean;
  buildOnMiss?: boolean;
  cacheTtl?: number;
};

function isStampFresh(metadata, ttl) {
  const written = Number(metadata && metadata.t);
  return Number.isFinite(written) && Date.now() - written < ttl * 1000;
}

// opts.cacheTtl (seconds, KV floor 30) keeps the value cached at the colo that
// read it. Without it KV's default is 60s, and this site's traffic is thin
// enough that most real visits are the first at their colo in over a minute, so
// they pay the central-store round trip: 120-200ms against a colo-local 3-5ms.
// Measured on the homepage 2026-07-27 (manifest 126ms / counter 149ms /
// tracks 204ms cold, versus 3-5ms each once warm).
export async function swrKV<T>(env, ctx, key, ttl, buildFn: () => T | Promise<T>, opts: SwrOptions<T> = {}): Promise<T | null> {
  const kv = env && env.RN_KV;
  const type = opts.type || "json";
  const isValid = opts.isValid || ((value) => value !== null && value !== undefined);
  const shouldStore = opts.shouldStore || isValid;
  const buildOnMiss = opts.buildOnMiss !== false;
  const cacheTtl = opts.cacheTtl;

  const store = async (value: T) => {
    if (!kv || !shouldStore(value)) return value;
    const body = type === "json" ? JSON.stringify(value) : value;
    await kv.put(key, body, { metadata: { t: Date.now() } });
    return value;
  };

  if (kv) {
    let value: T | null = null, fresh = false;
    try {
      const read = await kv.getWithMetadata(key, cacheTtl ? { type, cacheTtl } : { type });
      value = read.value;
      fresh = isStampFresh(read.metadata, ttl);
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

export async function deleteSWRKV(env, key) {
  if (!env || !env.RN_KV) return;
  await env.RN_KV.delete(key);
}

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

export async function withWeakEtag(response) {
  if (response.status !== 200 || response.headers.has("etag")) return response;
  const bytes = await response.arrayBuffer();
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  const headers = new Headers(response.headers);
  headers.set("etag", `W/"sha256-${digest.toHex()}"`);
  headers.set("content-length", String(bytes.byteLength));
  return new Response(bytes, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

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
  if (request.method === "GET" && resp.status === 200 && ctx) {
    const cacheFill = withWeakEtag(resp.clone())
      .then((tagged) => cache.put(key, tagged))
      .catch(() => {});
    ctx.waitUntil(cacheFill);
    const out = new Response(resp.body, resp);
    out.headers.set("x-edge-cache", "miss");
    return notModifiedIfFresh(request, out);
  }
  if (request.method === "GET" && resp.status === 200) {
    resp = await withWeakEtag(resp);
  }
  return notModifiedIfFresh(request, resp);
}

// The HOST is the second axis this key cannot see, and it cost the same bug on a
// different dimension. Three hostnames reach this Worker and only one of them is
// the site: `cal.aadhar.sh` 404s every path but /coffee*, and a `*.workers.dev`
// preview is supposed to answer noindex. Both checks live in the dispatcher, and
// a cache HIT returns before the dispatcher runs, so neither was happening.
//
// MEASURED on production 2026-08-08, deliberately: GET https://aadhar.sh/reading
// twice (MISS, then HIT at age 1), then https://cal.aadhar.sh/reading — 200, HIT,
// age 1, the same 91,980-byte page, on a host whose origin answers 404 for it.
// Same object, not a second copy: /photos and /writing reported byte-identical
// `age` on both hostnames in the same second. Adding `?cb=` to any of them
// returned the real 404, which is this predicate's query-string bail sending the
// request to the dispatcher and is what makes the mechanism unambiguous.
export function shouldUseWorkersCache(request, cacheablePaths) {
  if (request.method !== "GET" && request.method !== "HEAD") return false;
  if (request.headers.has("range") || request.headers.has("if-none-match")) return false;
  if (wantsMarkdown(request)) return false;
  const url = new URL(request.url);
  if (!isCanonicalHost(url.hostname)) return false;
  if (url.search) return false;
  if (cacheablePaths.has(url.pathname)) return true;
  return CACHEABLE_PREFIXES.some((prefix) => url.pathname.startsWith(prefix));
}
