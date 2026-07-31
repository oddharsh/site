// lib/crawl.js — bounded, identified document reads shared by AadharshBot
// utilities. This module never stores a response body; callers receive only the
// bounded text needed to extract evidence plus a digest of the bytes observed.
import { signedFetch } from "./botauth.js";
import { extractMeta, extractTitle } from "./http.js";

export const DEFAULT_CRAWL_BODY_CAP = 200 * 1024;

// The SSRF floor for every outbound fetch a visitor can aim: reject hosts that
// resolve inside the network rather than out on the public web, cloud-metadata
// endpoint included. It lives here, with the other bounded-fetch helpers, because
// three callers need the SAME answer — /lens, webmention source verification, and
// serendipity's cover proxy. It was written out twice (lensHostBlocked and
// coverHostBlocked, byte-identical), which is one edit away from a hole that only
// opens on one surface; consolidated 2026-07-28.
//
// Host-shaped only, deliberately. A name that resolves to a private address still
// passes here, so this is a floor and not the whole control: callers pair it with
// the scheme/port allowlist and a redirect re-check.
export function privateHostBlocked(host) {
  const h = host.replace(/^\[|\]$/g, "");
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal") || h.endsWith(".onion")) return true;
  if (h === "::1" || h.startsWith("fc") || h.startsWith("fd") || h.startsWith("fe80:")) return true;
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const a = +m[1], b = +m[2];
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;        // link-local incl. 169.254.169.254 metadata
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    if (a >= 224) return true;                        // multicast / reserved
  }
  return false;
}

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
