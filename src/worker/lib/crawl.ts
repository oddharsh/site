// lib/crawl.js — bounded, identified document reads shared by AadharshBot
// utilities. This module never stores a response body; callers receive only the
// bounded text needed to extract evidence plus a digest of the bytes observed.
import { signedFetch } from "./botauth.ts";
import type { BotRequestOptions } from "./botauth.ts";
import { DEFAULT_CRAWL_BODY_CAP, readResponseCapped } from "./public-fetch.ts";
import { extractMeta, extractTitle } from "./http.ts";

// Keep scheduled fan-out polite and predictable. Results retain input order,
// while at most `limit` target requests are active at once.
export async function mapWithConcurrency(items, limit, fn) {
  const values = Array.from(items || []);
  const output = new Array(values.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const index = next++;
      if (index >= values.length) return;
      output[index] = await fn(values[index], index);
    }
  };
  const workers = Math.min(Math.max(1, Number(limit) || 1), values.length);
  await Promise.all(Array.from({ length: workers }, () => worker()));
  return output;
}

// Kept as exports for the auxiliary Reader Worker and existing crawl callers.
export { DEFAULT_CRAWL_BODY_CAP, readResponseCapped, sha256Hex } from "./public-fetch.ts";

// Fetch one bounded HTML-ish document as AadharshBot. The body is deliberately
// returned only for the current parser; persistence callers should keep the
// digest and normalized signals, not the raw third-party text.
export async function crawlDocument(targetUrl, env, opts: BotRequestOptions & { maxBytes?: number; timeoutMs?: number } = {}) {
  const {
    maxBytes = DEFAULT_CRAWL_BODY_CAP,
    timeoutMs = 4000,
    signal,
    ...fetchOpts
  } = opts;
  const started = Date.now();
  const response = await signedFetch(targetUrl, env, {
    ...fetchOpts,
    signal: signal || AbortSignal.timeout(timeoutMs),
  });
  const body = await readResponseCapped(response, maxBytes);
  const text = body.text;
  return {
    finalUrl: response.url || targetUrl,
    status: response.status,
    contentType: response.headers.get("content-type") || "",
    server: response.headers.get("server") || "",
    lastModified: response.headers.get("last-modified") || "",
    title: extractTitle(text),
    description: extractMeta(text, "description") || extractMeta(text, "og:description") || "",
    bodyHash: body.digest,
    bytesRead: body.bytesRead,
    truncated: body.truncated,
    elapsedMs: Date.now() - started,
    text,
  };
}
