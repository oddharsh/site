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
  if (url.username || url.password) return { ok: false, error: "Remove the credentials from that URL." };
  if (url.port && url.port !== "80" && url.port !== "443") return { ok: false, error: "Only ports 80 and 443 are allowed." };
  if (privateHostBlocked(url.hostname)) return { ok: false, error: "That host is on the no-fetch list (localhost / private / link-local)." };
  return { ok: true, url: url.toString() };
}

export type PublicTransport = (url: string, init: RequestInit) => Promise<Response>;

export async function fetchFollowingPublicRedirects(url, init: (url: string) => RequestInit | Promise<RequestInit>, check, maxHops = 4, transport?: PublicTransport | null): Promise<
  | { ok: true; response: Response; finalUrl: string; hops: number }
  | { ok: false; error: string; blockedHop: number; url: string }
> {
  let current = url;
  for (let hop = 0; hop <= maxHops; hop++) {
    const verdict = check(current);
    if (!verdict.ok) return { ok: false, error: verdict.error, blockedHop: hop, url: current };
    const options = await init(current);
    const hopInit = { ...options, redirect: "manual" as const };
    const response = await (transport ? transport(current, hopInit) : fetch(current, hopInit));
    const location = [301, 302, 303, 307, 308].includes(response.status) ? response.headers.get("location") : null;
    if (location === null) return { ok: true, response, finalUrl: response.url || current, hops: hop };
    try { await response.body?.cancel(); } catch (_e) {}
    let next;
    try { next = new URL(location, current).toString(); }
    catch { return { ok: false, error: "That redirect target does not parse as a URL.", blockedHop: hop, url: current }; }
    current = next;
  }
  return { ok: false, error: `That URL redirected more than ${maxHops} times.`, blockedHop: maxHops, url: current };
}

export const DEFAULT_CRAWL_BODY_CAP = 200 * 1024;

export async function readResponseCapped(response, maxBytes = DEFAULT_CRAWL_BODY_CAP, signal?: AbortSignal) {
  const reader = response && response.body && response.body.getReader
    ? response.body.getReader()
    : null;
  if (!reader) {
    signal?.throwIfAborted();
    return { text: "", bytesRead: 0, truncated: false, digest: "" };
  }

  const chunks: Uint8Array[] = [];
  let bytesRead = 0;
  let truncated = false;
  const abort = () => { void reader.cancel(signal?.reason).catch(() => {}); };
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  try {
    for (;;) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      signal?.throwIfAborted();
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
    signal?.removeEventListener("abort", abort);
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
  return digest.toHex();
}
