// lib/crawl.js — bounded, identified document reads shared by AadharshBot
// utilities. This module never stores a response body; callers receive only the
// bounded text needed to extract evidence plus a digest of the bytes observed.
import { signedFetch } from "./botauth.js";
import { extractMeta, extractTitle } from "./http.js";

export const DEFAULT_CRAWL_BODY_CAP = 200 * 1024;

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

// Read at most maxBytes from a response stream. A second read after the cap
// distinguishes an exactly-max-sized body from a truncated one without ever
// buffering an unbounded response.
export async function readResponseCapped(response, maxBytes = DEFAULT_CRAWL_BODY_CAP) {
  const reader = response && response.body && response.body.getReader
    ? response.body.getReader()
    : null;
  if (!reader) return { text: "", bytesRead: 0, truncated: false, digest: "" };

  const chunks = [];
  let bytesRead = 0;
  let truncated = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value.byteLength) continue;
      if (bytesRead >= maxBytes) {
        truncated = true;
        break;
      }
      const take = Math.min(value.byteLength, maxBytes - bytesRead);
      chunks.push(value.subarray(0, take));
      bytesRead += take;
      if (take < value.byteLength) {
        truncated = true;
        break;
      }
    }
  } finally {
    if (truncated) {
      try { await reader.cancel(); } catch (_e) {}
    }
  }

  const bytes = new Uint8Array(bytesRead);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return {
    text: new TextDecoder("utf-8").decode(bytes),
    bytesRead,
    truncated,
    digest: await sha256Hex(bytes),
  };
}

export async function sha256Hex(value) {
  const bytes = value instanceof Uint8Array
    ? value
    : new TextEncoder().encode(String(value ?? ""));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

// Fetch one bounded HTML-ish document as AadharshBot. The body is deliberately
// returned only for the current parser; persistence callers should keep the
// digest and normalized signals, not the raw third-party text.
export async function crawlDocument(targetUrl, env, opts = {}) {
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
