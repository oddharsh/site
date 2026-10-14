import { escape } from "./html.ts";

export function escAttr(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function escHtml(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function jsonResponse(body, status = 200, extraHeaders = {}, { pretty = true } = {}) {
  const headers = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...extraHeaders };
  for (const key of Object.keys(headers)) if (headers[key] === null) delete headers[key];
  return new Response(pretty ? JSON.stringify(body, null, 2) + "\n" : JSON.stringify(body), { status, headers });
}

export const PLAIN_JSON = { "content-type": "application/json", "cache-control": null };

export function errorResp(body, status) {
  return new Response(body, {
    status,
    headers: {
      "content-type":  "text/plain; charset=utf-8",
      "cache-control": "public, max-age=30, must-revalidate",
    },
  });
}

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

export function wantsJson(request) {
  const accept = (request.headers.get("accept") || "").toLowerCase();
  if (!/(^|,)\s*application\/json\s*(?:;|,|$)/i.test(accept)) return false;
  const jsonQ = acceptQ(accept, "application/json");
  if (jsonQ <= 0) return false;
  const htmlQ = Math.max(acceptQ(accept, "text/html"), acceptQ(accept, "application/xhtml+xml"));
  if (jsonQ !== htmlQ) return jsonQ > htmlQ;
  return acceptIndex(accept, "application/json") < Math.min(
    acceptIndex(accept, "text/html"),
    acceptIndex(accept, "application/xhtml+xml")
  );
}

export function namesHtml(request) {
  const accept = (request.headers.get("accept") || "").toLowerCase();
  return ["text/html", "application/xhtml+xml"].some((t) => acceptIndex(accept, t) !== Infinity && acceptQ(accept, t) > 0);
}

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

export function publicJsonHeaders(status) {
  return {
    "cache-control": status >= 400
      ? "public, max-age=30, must-revalidate"
      : "public, max-age=300, s-maxage=600",
    "access-control-allow-origin": "*",
  };
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
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

export function timingSafeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function secretMatches(supplied: string | null | undefined, secret: string | undefined): boolean {
  if (!secret || supplied == null) return false;
  return timingSafeEqual(supplied, secret);
}

export function esc(s) {
  return escape(String(s ?? ""));
}
