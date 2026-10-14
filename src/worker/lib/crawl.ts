import { signedFetch } from "./botauth.ts";
import type { BotRequestOptions } from "./botauth.ts";
import { DEFAULT_CRAWL_BODY_CAP, readResponseCapped } from "./public-fetch.ts";
import { extractMeta, extractTitle } from "./http.ts";

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

export { DEFAULT_CRAWL_BODY_CAP, readResponseCapped, sha256Hex } from "./public-fetch.ts";

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
