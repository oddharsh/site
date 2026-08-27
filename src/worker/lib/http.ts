// lib/http.js — extracted from the worker (no-build reorg). Bundled by
// wrangler/Cloudflare at deploy; not served (inside _worker.js/).
export function escAttr(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function escHtml(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function jsonResponse(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body, null, 2) + "\n", {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...extraHeaders,
    },
  });
}

// short-cache error response. matches the CF Cache Rule that pins edge
// TTL to 30s on 4xx/5xx — sending max-age=30 makes the browser cache
// honor the same window, so a transient 404 during a deploy race
// doesn't get pinned in either CF's edge OR the visitor's browser for
// the platform's default 4h negative-cache. use everywhere we emit a 4xx/5xx ourselves.
export function errorResp(body, status) {
  return new Response(body, {
    status,
    headers: {
      "content-type":  "text/plain; charset=utf-8",
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
// text/markdown at all and is stopped by the guard above; nothing about a client
// that ranks HTML higher; and nothing about `text/markdown;q=0`, which is an
// explicit refusal and still returns false.
export function wantsMarkdown(request) {
  const accept = (request.headers.get("accept") || "").toLowerCase();
  if (!/(^|,)\s*text\/markdown\s*(?:;|,|$)/i.test(accept)) return false;
  const markdownQ = acceptQ(accept, "text/markdown");
  if (markdownQ <= 0) return false;
  const htmlQ = Math.max(
    acceptQ(accept, "text/html"),
    acceptQ(accept, "application/xhtml+xml")
  );
  if (markdownQ !== htmlQ) return markdownQ > htmlQ;
  return acceptIndex(accept, "text/markdown") < Math.min(
    acceptIndex(accept, "text/html"),
    acceptIndex(accept, "application/xhtml+xml")
  );
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
  for (const raw of accept.split(",")) {
    const parts = raw.trim().split(";").map(s => s.trim());
    const media = parts.shift();
    if (!media || !media.includes("/")) continue;
    const [gotType, gotSub] = media.split("/");
    if (!((gotType === wantType || gotType === "*") && (gotSub === wantSub || gotSub === "*"))) continue;
    let q = 1;
    for (const p of parts) {
      const m = p.match(/^q=([0-9.]+)$/);
      if (m) q = Math.max(0, Math.min(1, Number(m[1]) || 0));
    }
    if (q > best) best = q;
  }
  return best;
}

export function jsonResp(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "content-type":  "application/json; charset=utf-8",
      // errors get the errorResp() discipline (30s), never the 5-minute
      // success TTL — a transient scrape 502 must not pin in browsers.
      "cache-control": status >= 400
        ? "public, max-age=30, must-revalidate"
        : "public, max-age=300, s-maxage=600",
      "access-control-allow-origin": "*",
    },
  });
}

export function extractTitle(html) {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? decodeEntities(m[1].trim()).slice(0, 200) : "";
}

export function extractMeta(html, name) {
  const re = new RegExp(
    `<meta[^>]+(?:name|property)=["']${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["'][^>]*content=["']([^"']+)["']`,
    "i"
  );
  const m = html.match(re);
  return m ? decodeEntities(m[1].trim()).slice(0, 240) : "";
}

// &amp; is decoded LAST, and the order is the whole correctness of this function.
// Decoding it first re-feeds its own output to the passes below, so `&amp;lt;` —
// a page saying the literal text "&lt;" — comes out as a real `<`. That turns
// inert prose from an arbitrary third party into markup, which is exactly the
// input this sees: every caller runs it over a crawled page's <title>, meta
// description, or author (crawl.js, around.js, webmention.js). The sinks escape
// today, so this was never live XSS; it was a decoder manufacturing tags that
// only the next un-escaped sink would have to catch.
function decodeEntities(s) {
  return s
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

// constant-time string compare so we don't leak the secret via timing.
export function timingSafeEqual(a, b) {
  // NOT parsed through lib/parse.js, deliberately. `asText` treats "" as absent,
  // which is right at a boundary and wrong here: two empty secrets must still
  // compare equal rather than fall out as a type failure. This is a precondition
  // on an internal call, not a boundary parse, and it guards a timing-safe
  // compare, so it stays the plain type test.
  // oxlint-disable-next-line anti-slop/no-runtime-typeof
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
