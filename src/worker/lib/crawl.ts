// lib/crawl.js — bounded, identified document reads shared by AadharshBot
// utilities. This module never stores a response body; callers receive only the
// bounded text needed to extract evidence plus a digest of the bytes observed.
import { signedFetch } from "./botauth.ts";
import type { BotRequestOptions } from "./botauth.ts";
import { extractMeta, extractTitle } from "./http.ts";

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
//
// Four shapes were measured through this function on 2026-08-07 and came back
// ALLOW, so each one below is a hole that was open rather than a hypothetical:
//
//   localhost.        a trailing dot is a legal absolute FQDN and resolves the
//   127.0.0.1.        same, but `=== "localhost"` and the dotted-quad regex both
//                     miss it. Normalized off before any comparison.
//   ::                the unspecified address. Routes to loopback on a stack that
//                     accepts it, and `=== "::1"` does not cover it.
//   ::ffff:127.0.0.1  v4-mapped IPv6. The one that matters: the whole dotted-quad
//   ::ffff:169.254…   table below was being skipped because the host does not
//                     match the v4 regex, so the metadata address had a spelling
//                     that walked straight through.
//   fe81:: … febf::   link-local is fe80::/10, which is every prefix fe80 through
//                     febf. Matching the literal string "fe80:" covered one of 64.
//
// The v4 table is applied to a v4-mapped address by unwrapping to its dotted
// quad and re-testing, so the two spellings can never drift apart again.
export function privateHostBlocked(host) {
  const h = String(host || "").toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (!h) return true;
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal") || h.endsWith(".onion")) return true;
  if (h === "::" || h === "::1" || h.startsWith("fc") || h.startsWith("fd")) return true;
  if (/^fe[89ab][0-9a-f]:/.test(h)) return true;    // fe80::/10 link-local, all 64 prefixes
  // v4-mapped IPv6, in BOTH spellings, because the caller decides which one this
  // function ever sees. `new URL("https://[::ffff:169.254.169.254]/").hostname`
  // is `[::ffff:a9fe:a9fe]`: the WHATWG parser rewrites the dotted tail into hex
  // groups. Handling only the dotted form meant this returned false for every
  // address that arrived through a URL, which is every address /lens inspects.
  // Caught in production 2026-08-08, after a unit test that called this function
  // with a shape no caller produces reported it fixed.
  const mappedDotted = h.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (mappedDotted) return privateHostBlocked(mappedDotted[1]);
  const mappedHex = h.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (mappedHex) {
    const high = parseInt(mappedHex[1], 16), low = parseInt(mappedHex[2], 16);
    return privateHostBlocked(`${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`);
  }
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

// Only public http(s). Reject loopback / private / link-local / cloud-metadata
// literals + non-standard ports. (Workers can't egress to the internal network
// anyway, but blocking the obvious literals is cheap hygiene.)
//
// This lived in lens.js until the Reader lens shipped. It moved HERE, next to
// the host floor it wraps, because `lens-reader/` is a SEPARATE Worker that
// aims the same visitor-supplied URL at the same public internet, and a second
// copy of an SSRF allowlist is the kind of duplicate that passes review on the
// day it is written and diverges quietly afterwards. lens.js re-exports it, so
// every existing caller and the contract tests that name it are untouched.
export function validateLensTarget(raw) {
  const s0 = String(raw || "").trim();
  if (!s0) return { ok: false, error: "Type a URL to inspect." };
  if (/^[a-z][a-z0-9+.-]*:/i.test(s0) && !/^https?:\/\//i.test(s0)) {
    return { ok: false, error: "Only http and https URLs." };
  }
  const s = /^https?:\/\//i.test(s0) ? s0 : "https://" + s0;
  let url;
  try { url = new URL(s); } catch { return { ok: false, error: "That doesn't parse as a URL." }; }
  if (url.protocol !== "http:" && url.protocol !== "https:") return { ok: false, error: "Only http and https URLs." };
  // Credentials in the authority are refused rather than stripped. A scan is a
  // public read published back to the visitor, so a URL carrying a secret is
  // either a mistake or an attempt to make this site replay it; stripping would
  // quietly scan a different resource than the one that was typed.
  if (url.username || url.password) return { ok: false, error: "Remove the credentials from that URL." };
  if (url.port && url.port !== "80" && url.port !== "443") return { ok: false, error: "Only ports 80 and 443 are allowed." };
  if (privateHostBlocked(url.hostname)) return { ok: false, error: "That host is on the no-fetch list (localhost / private / link-local)." };
  return { ok: true, url: url.toString() };
}

// Follow redirects one hop at a time so every hop is checked, rather than asking
// fetch to follow them and inspecting only where it landed.
//
// The post-hoc check this replaces guarded the DISCOVERY probes, so a public URL
// that 302s to a blocked host still had its body fetched and returned; only the
// origin-level fan-out was skipped. Validating per hop means the request to the
// blocked host is never made at all.
//
// `check` is the caller's full allowlist (scheme, port, host), not just this
// module's host floor, because a redirect can change the scheme and port too.
export async function fetchFollowingPublicRedirects(url, init, check, maxHops = 4) {
  let current = url;
  for (let hop = 0; hop <= maxHops; hop++) {
    const verdict = check(current);
    if (!verdict.ok) return { ok: false, error: verdict.error, blockedHop: hop, url: current };
    const response = await fetch(current, { ...init, redirect: "manual" });
    const location = response.status >= 300 && response.status < 400 ? response.headers.get("location") : null;
    if (!location) return { ok: true, response, finalUrl: current, hops: hop };
    let next;
    try { next = new URL(location, current).toString(); }
    catch { return { ok: false, error: "That redirect target does not parse as a URL.", blockedHop: hop, url: current }; }
    try { await response.body?.cancel(); } catch (_e) { /* nothing buffered yet */ }
    current = next;
  }
  return { ok: false, error: `That URL redirected more than ${maxHops} times.`, blockedHop: maxHops, url: current };
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
