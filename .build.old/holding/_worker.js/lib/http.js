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
export function wantsMarkdown(request) {
  const accept = (request.headers.get("accept") || "").toLowerCase();
  if (!/(^|,)\s*text\/markdown\s*(?:;|,|$)/i.test(accept)) return false;
  const markdownQ = acceptQ(accept, "text/markdown");
  const htmlQ = Math.max(
    acceptQ(accept, "text/html"),
    acceptQ(accept, "application/xhtml+xml")
  );
  return markdownQ > 0 && markdownQ > htmlQ;
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

function decodeEntities(s) {
  return s
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ");
}

// constant-time string compare so we don't leak the secret via timing.
export function timingSafeEqual(a, b) {
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
