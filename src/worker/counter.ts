import { asNumber } from "./lib/parse.ts";
import { jsonResponse } from "./lib/http.ts";

const PEEK_UA = /bot|crawl|spider|slurp|crawler|bingpreview|facebookexternalhit|embedly|slackbot|whatsapp|telegrambot|discordbot|redditbot|petalbot|gptbot|claudebot|ccbot|perplexity|bytespider|google-extended/i;

// Without a throttle this is one write per visit, and it would also fight
// Cloudflare's 1-write-per-second-per-key limit under any burst. Behind the stamp
// the worst case is one write per MIRROR_TTL under continuous traffic:
// 86400 / 60 = 1,440 a day. A visit odometer trailing real time by a minute is
// not a number anyone audits.
export const COUNT_KEY = "counter:n";
const MIRROR_TTL = 60;

async function mirrorCount(env, n, force = false) {
  try {
    if (!force) {
      const { metadata } = await env.RN_KV.getWithMetadata(COUNT_KEY, { type: "text" });
      const written = Number(metadata && metadata.t);
      if (Number.isFinite(written) && Date.now() - written < MIRROR_TTL * 1000) return;
    }
    await env.RN_KV.put(COUNT_KEY, String(n), { metadata: { t: Date.now() } });
  } catch {}
}

export async function handleHit(request, env, ctx) {
  const url = new URL(request.url);
  const ua = request.headers.get("user-agent") || "";
  const peek = request.method === "HEAD"
    || url.searchParams.has("peek")
    || /prefetch|prerender/i.test(request.headers.get("sec-purpose") || "")
    || request.cf?.botManagement?.verifiedBot === true
    || PEEK_UA.test(ua);

  const readCount = async () => {
    if (!env.COUNTER) return null;
    try {
      const stub = env.COUNTER.get(env.COUNTER.idFromName("homepage-visits"));
      return (await (await stub.fetch(`https://do/${peek ? "?peek=1" : ""}`)).json()).n;
    } catch { return null; }
  };
  const mirror = (n) => (env.RN_KV && asNumber(n) !== null ? mirrorCount(env, n) : null);

  if (url.searchParams.has("tick")) {
    const work = readCount().then(mirror).catch(() => {});
    if (ctx) ctx.waitUntil(work); else await work;
    if (!url.searchParams.has("n")) return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
  }

  if (url.searchParams.has("n")) {
    let n = null;
    try { const v = env.RN_KV && await env.RN_KV.get(COUNT_KEY, { cacheTtl: MIRROR_TTL }); if (v != null) n = Number(v); } catch {}
    return jsonResponse({ n: Number.isFinite(n) ? n : null }, 200, { "x-robots-tag": "noindex" }, { pretty: false });
  }

  const n = await readCount();
  const pending = mirror(n);
  if (pending && ctx) ctx.waitUntil(pending);

  const digits = asNumber(n) === null ? "------" : String(n).padStart(6, "0");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="52" height="12" viewBox="0 0 52 12" role="img" aria-label="visitor ${digits}"><text x="0" y="10" font-family="'Courier New',Courier,monospace" font-size="12" font-weight="bold" letter-spacing="1.2" fill="oklch(86.52% 0.1768 90.38)">${digits}</text></svg>`;
  return new Response(svg, {
    headers: {
      "content-type":  "image/svg+xml; charset=utf-8",
      "cache-control": "no-store",
      "x-robots-tag":  "noindex",
    },
  });
}
