// lib/http.ts: the HTTP kit every route shares. JSON and error responses,
// Accept negotiation for Markdown and JSON, HTML escaping, entity decoding for
// crawled titles, and the constant-time owner-secret check.

import { escape } from "./html.ts";
import { readBytesCapped } from "./public-fetch.ts";
import { forwardSearch } from "./text.ts";

// The one JSON response every route builds. Defaults to a private reply: never
// cached, pretty-printed for a person reading it with curl. A route changes the
// policy through extraHeaders (cache-control, CORS, x-robots-tag, ...), and a
// big public payload passes { pretty: false } to ship compact bytes. A header
// set to null is dropped, which is how a caller turns a default off entirely.
export function jsonResponse(body, status = 200, extraHeaders = {}, { pretty = true } = {}) {
  const headers = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...extraHeaders };
  for (const key of Object.keys(headers)) if (headers[key] === null) delete headers[key];
  return new Response(pretty ? JSON.stringify(body, null, 2) + "\n" : JSON.stringify(body), { status, headers });
}

// Every inbound request body goes through here. Cloudflare accepts a body of
// up to 100 MB on Workers Free and the isolate has 128 MB, so buffering
// whatever anyone POSTs could take down every request sharing the isolate.
// This stops reading at maxBytes and returns null; under the cap it hands back
// the same bytes as a Body, so callers keep their .json(), .formData() or .text().
// contract-request-bodies-stop-at-their-cap fails on a raw read anywhere public.
export const REQUEST_BODY_CAP = 64 * 1024;
export async function cappedRequestBody(request: Request, maxBytes = REQUEST_BODY_CAP): Promise<Response | null> {
  if (Number(request.headers.get("content-length")) > maxBytes) return null;
  const read = await readBytesCapped(request, maxBytes);
  if (read?.truncated) return null;
  const text = read ? new TextDecoder("utf-8").decode(read.bytes) : "";
  const type = request.headers.get("content-type");
  return new Response(text, type ? { headers: { "content-type": type } } : {});
}

// The headers Response.json() sends, for an internal hop (a Durable Object
// answering its own Worker) that should stay byte-identical to it.
export const PLAIN_JSON = { "content-type": "application/json", "cache-control": null };

// The one 405 a route sends for a method it does not serve: a JSON body naming
// the methods, and the same list in Allow (RFC 9110 section 15.5.6). GET implies
// HEAD, as it does everywhere a route answers GET. Returns null to proceed.
export function methodGuard(request: Request, allow: readonly string[]): Response | null {
  const methods = allow.includes("GET") ? ["GET", "HEAD", ...allow.filter((m) => m !== "GET" && m !== "HEAD")] : [...allow];
  if (methods.includes(request.method)) return null;
  const header = methods.join(", ");
  return jsonResponse({ ok: false, error: `${request.method} is not served here. Use ${header}.`, code: "method_not_allowed", allow: methods }, 405, {
    allow: header,
  });
}

// short-cache error response. max-age=30 bounds how long a transient 404 from
// a deploy race can be pinned, at the edge or in the visitor's browser. Use
// everywhere we emit a 4xx/5xx ourselves.
export function errorResp(body, status) {
  return new Response(body, {
    status,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "public, max-age=30, must-revalidate",
    },
  });
}

// ── markdown negotiation ────────────────────────────────────────────
// returns true iff the client's Accept header explicitly asks for text/markdown
// and prefers it over HTML. Do not let generic */* negotiate to Markdown: the
// root URL is primarily a browser page, and /index.md is the stable cacheable
// Markdown URL for agents that do not send a precise Accept header.
//
// A TIE GOES TO WHICHEVER WAS LISTED FIRST, and until 2026-08-27 it went to
// HTML. That rule was `markdownQ > htmlQ`, so a header naming both types at q=1
// lost, and the three most common agent clients send exactly that:
//
//   Claude Code, Copilot CLI, Microsoft Copilot:  text/markdown, text/html, */*
//
// All three were handed markup meant for a browser while /lens/markdown graded
// this origin as passing every conformance check on the list. That gap is the
// whole reason that tab replays real Accept strings instead of scoring a
// checklist, and it found this on its first run against our own /garage/horizon.
//
// RFC 9110 gives no significance to order within Accept, so preferring the
// first-listed of two equal-q types is a CONVENTION rather than a rule. It is
// the convention every one of these clients relies on, and the alternative is
// not neutrality: it is silently preferring HTML, which is a choice too, and the
// one that costs an agent the whole point of asking.
//
// Deliberately narrow. It changes nothing about a browser, which never names
// text/markdown at all and is stopped by the function's first test; nothing about a client
// that ranks HTML higher; and nothing about `text/markdown;q=0`, which is an
// explicit refusal and still returns false.
export function wantsMarkdown(request) {
  const accept = (request.headers.get("accept") || "").toLowerCase();
  if (!/(^|,)\s*text\/markdown\s*(?:;|,|$)/i.test(accept)) return false;
  const markdownQ = acceptQ(accept, "text/markdown");
  if (markdownQ <= 0) return false;
  const htmlQ = Math.max(acceptQ(accept, "text/html"), acceptQ(accept, "application/xhtml+xml"));
  if (markdownQ !== htmlQ) return markdownQ > htmlQ;
  return acceptIndex(accept, "text/markdown") < Math.min(acceptIndex(accept, "text/html"), acceptIndex(accept, "application/xhtml+xml"));
}

// true iff Accept explicitly names application/json and prefers it over HTML,
// by the same rules as wantsMarkdown: a named type only (no `*/*`), q > 0, and a
// tie goes to whichever was listed first. A browser never names it, so this
// moves nothing for a person.
export function wantsJson(request) {
  const accept = (request.headers.get("accept") || "").toLowerCase();
  if (!/(^|,)\s*application\/json\s*(?:;|,|$)/i.test(accept)) return false;
  const jsonQ = acceptQ(accept, "application/json");
  if (jsonQ <= 0) return false;
  const htmlQ = Math.max(acceptQ(accept, "text/html"), acceptQ(accept, "application/xhtml+xml"));
  if (jsonQ !== htmlQ) return jsonQ > htmlQ;
  return acceptIndex(accept, "application/json") < Math.min(acceptIndex(accept, "text/html"), acceptIndex(accept, "application/xhtml+xml"));
}

/** True when Accept names HTML itself (text/html or XHTML, q > 0): a browser
 *  navigating. A bare wildcard does not count, so curl's default and most
 *  HTTP clients read as not asking for a page. */
export function namesHtml(request) {
  const accept = (request.headers.get("accept") || "").toLowerCase();
  return ["text/html", "application/xhtml+xml"].some((t) => acceptIndex(accept, t) !== Infinity && acceptQ(accept, t) > 0);
}

// Where a type is named EXACTLY in the Accept header, as an ordinal, or Infinity
// when it is not named at all. Wildcards are deliberately not matched here even
// though acceptQ matches them for q: `*/*` expresses no preference BETWEEN two
// named types, so it cannot break a tie between them. That distinction is what
// makes `text/markdown, */*` resolve to Markdown, since the only explicit type
// in it is the Markdown one.
function acceptIndex(accept, type) {
  const [wantType, wantSub] = type.split("/");
  const entries = accept.split(",");
  for (let i = 0; i < entries.length; i++) {
    const media = entries[i].trim().split(";")[0].trim();
    if (!media.includes("/")) continue;
    const [gotType, gotSub] = media.split("/");
    if (gotType === wantType && gotSub === wantSub) return i;
  }
  return Infinity;
}

function acceptQ(accept, type) {
  const [wantType, wantSub] = type.split("/");
  let best = 0;
  let specificity = -1;
  for (const raw of accept.split(",")) {
    const parts = raw
      .trim()
      .split(";")
      .map((s) => s.trim());
    const media = parts.shift();
    if (!media || !media.includes("/")) continue;
    const [gotType, gotSub] = media.split("/");
    if (!((gotType === wantType || gotType === "*") && (gotSub === wantSub || gotSub === "*"))) continue;
    let q = 1;
    for (const p of parts) {
      const m = p.match(/^q=([0-9.]+)$/);
      if (m) q = Math.max(0, Math.min(1, Number(m[1]) || 0));
    }
    // RFC 9110 section 12.5.1: the most specific matching range supplies
    // the weight. A wildcard cannot raise an explicit q=0 refusal to q=1.
    const rank = gotType === "*" ? 0 : gotSub === "*" ? 1 : 2;
    if (rank > specificity) {
      specificity = rank;
      best = q;
    } else if (rank === specificity && q > best) best = q;
  }
  return best;
}

// The cache policy for a public read (search, photos, ledger, the playlist):
// errors get the errorResp() discipline (30s), never the 5-minute success TTL,
// so a transient scrape 502 does not pin in browsers.
export function publicCacheControl(status: number): string {
  return status >= 400 ? "public, max-age=30, must-revalidate" : "public, max-age=300, s-maxage=600";
}

// A public, CORS-open JSON read: publicCacheControl, compact bytes because the
// payloads are big and machine-read, and `noindex` for a feed worth fetching
// and worthless in a search index.
export function publicJsonResponse(body: unknown, status = 200, { noindex = false } = {}): Response {
  const headers = { "cache-control": publicCacheControl(status), "access-control-allow-origin": "*", "x-robots-tag": noindex ? "noindex" : null };
  return jsonResponse(body, status, headers, { pretty: false });
}

// extractTitle and extractMeta read pages whoever runs the other origin wrote,
// and until 2026-11-20 each was one regex that rescanned to the end of the page
// from every opener that could not match: 256 KB of "<meta " took 6.5 s and of
// "<title " 4.2 s in Node 26. Both now scan forward once and find what the
// regex found; contract-lazy-tag-scans-stay-linear fuzzes each against it.

// /<title[^>]*>([\s\S]*?)<\/title>/i. The first "<title" decides: when it has no
// ">" or no closer after it, no later one has either.
export function extractTitle(html) {
  const open = /<title/gi.exec(html);
  const body = open ? html.indexOf(">", open.index + 6) + 1 : 0;
  const close = /<\/title>/gi;
  close.lastIndex = body;
  const end = body ? close.exec(html) : null;
  return end ? decodeEntities(html.slice(body, end.index).trim()).slice(0, 200) : "";
}

// <meta[^>]+(?:name|property)=["']NAME["'][^>]*content=["']([^"']+)["'], case
// blind. Every "<meta" before the same ">" can match only what the first of them
// can, so each tag is tried once. Inside it the regex keeps the LAST content=
// after the first NAME attribute whose value is nonempty and closed by a quote,
// and that value may run past the ">".
export function extractMeta(html, name) {
  const attr = forwardSearch(new RegExp(`(?:name|property)=["']${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["']`, "gi"), html);
  const content = forwardSearch(/content=["']/gi, html);
  const lastQuote = Math.max(html.lastIndexOf('"'), html.lastIndexOf("'"));
  const open = /<meta/gi;
  for (let m; (m = open.exec(html));) {
    const gt = html.indexOf(">", m.index + 5);
    const tagEnd = gt < 0 ? html.length : gt;
    const a = attr(m.index + 6);
    let value = -1;
    if (a && a.index + a[0].length <= tagEnd) {
      for (let c = content(a.index + a[0].length); c && c.index + c[0].length <= tagEnd; c = content(c.index + 1)) {
        const at = c.index + c[0].length;
        if (at < lastQuote && html[at] !== '"' && html[at] !== "'") value = at;
      }
    }
    if (value >= 0) {
      const end = /["']/g;
      end.lastIndex = value;
      return decodeEntities(html.slice(value, end.exec(html)?.index).trim()).slice(0, 240);
    }
    if (gt < 0) break;
    open.lastIndex = gt;
  }
  return "";
}

// &amp; is decoded LAST, and the order is the whole correctness of this function.
// Decoding it first re-feeds its own output to the passes below, so `&amp;lt;` —
// a page saying the literal text "&lt;" — comes out as a real `<`. That turns
// inert prose from an arbitrary third party into markup, which is exactly the
// input this sees: every caller runs it over a crawled page's <title>, meta
// description, or author (lib/crawl.ts, around.ts, webmention.ts). The sinks escape
// today, so this was never live XSS; it was a decoder manufacturing tags that
// only the next un-escaped sink would have to catch.
function decodeEntities(s) {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

// A response already built for a GET, answered to the request's method: a HEAD
// keeps every header and drops the body, cancelling its stream so nothing is
// left unread. Not `new Response(null, res)`: Response init is read as a plain
// object there, so status/headers survive but anything carried out-of-band does
// not, the same write-only-init trap that made encodeBody a silent no-op
// site-wide (docs/GOTCHAS.md gotcha 13). A route that can skip rendering the
// body for a HEAD should build it null instead and not call this.
export function forMethod(request: Request, res: Response): Response {
  if (request.method !== "HEAD") return res;
  try {
    void res.body?.cancel();
  } catch {}
  return new Response(null, { status: res.status, headers: new Headers(res.headers) });
}

// constant-time string compare so we don't leak the secret via timing.
export function timingSafeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// The one gate for an owner secret arriving in a request: a query parameter, a
// header, a form field. It fails CLOSED when the secret is unset or empty, so a
// missing binding can never match a missing parameter, and it compares in
// constant time. Every owner gate calls this one function, so the rule lives
// in code; when it lived in a comment, 6 of 10 owner checks compared with `===`.
export function secretMatches(supplied: string | null | undefined, secret: string | undefined): boolean {
  if (!secret || supplied == null) return false;
  return timingSafeEqual(supplied, secret);
}

// The owner's refresh: `?bust=<RN_BUST_SECRET>` on /rn, /around and /reading
// makes that request drop its cache and fetch fresh. One spelling of the
// parameter and the secret it is checked against, for every page that takes it.
export function isOwnerBust(request: Request, env: { RN_BUST_SECRET?: string }): boolean {
  return secretMatches(new URL(request.url).searchParams.get("bust"), env.RN_BUST_SECRET);
}

export function esc(s) {
  return escape(String(s ?? ""));
}
