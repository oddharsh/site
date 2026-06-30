// reading.js — extracted from the worker (no-build reorg). Bundled by
// wrangler/Cloudflare at deploy; not served (inside _worker.js/).
import { BOT_NAME, signedFetch } from "./lib/botauth.js";
import { xpChromeCss } from "./lib/chrome.js";
import { esc } from "./lib/http.js";

// ── /reading — a native, Luna-styled mirror of my Curius reading list ──
// Curius (the social reading-list app) exposes a clean JSON API per user. We
// pull it through AadharshBot (the same signed, identified crawler the rest of
// the site uses), normalize it down to what we render, and KV-cache the result
// so a page load costs zero Curius hits. The canonical list still lives at
// curius.app; this is the on-site, view-source-able copy.
export const CURIUS_USER_ID = 5766;

export const CURIUS_HANDLE   = "aadharsh-pannirselvam";

export const CURIUS_CACHE_KEY = "curius:links";

export const CURIUS_TTL = 21600;

   // 6h — the list moves a few times a day at most
export async function fetchCuriusLinks(env) {
  const out = [];
  const PER = 30, MAX_PAGES = 8;   // 30/page; cap the crawl so a runaway can't loop
  for (let p = 0; p < MAX_PAGES; p++) {
    let data;
    try {
      const res = await signedFetch(`https://curius.app/api/users/${CURIUS_USER_ID}/links?page=${p}`, env, {
        headers: { accept: "application/json" },
      });
      if (!res.ok) break;
      data = await res.json();
    } catch (_e) { break; }
    const saved = Array.isArray(data && data.userSaved) ? data.userSaved : [];
    if (!saved.length) break;
    for (const it of saved) {
      if (!it || !it.link) continue;
      let domain = "";
      try { domain = new URL(it.link).hostname.replace(/^www\./, ""); } catch (_e) {}
      out.push({
        title:   (it.title || it.link).replace(/\s+/g, " ").trim().slice(0, 200),
        link:    it.link,
        domain,
        snippet: (it.snippet || "").replace(/\s+/g, " ").trim().slice(0, 280),
        favorite: !!it.favorite,
        created: it.createdDate || it.modifiedDate || null,
        // the passages I highlighted while reading — the best part to surface
        highlights: (Array.isArray(it.highlights) ? it.highlights : [])
          .map((h) => (h && h.highlight ? h.highlight.replace(/\s+/g, " ").trim() : ""))
          .filter(Boolean).slice(0, 3),
      });
    }
    if (saved.length < PER) break;   // short page = last page
  }
  out.sort((a, b) => String(b.created || "").localeCompare(String(a.created || "")));  // newest first
  return out;
}

export async function getCuriusCached(request, env, ctx) {
  const url = new URL(request.url);
  if (env.RN_BUST_SECRET && url.searchParams.get("bust") === env.RN_BUST_SECRET) {
    if (env.RN_KV) await env.RN_KV.delete(CURIUS_CACHE_KEY);
  }
  if (env.RN_KV) {
    const cached = await env.RN_KV.get(CURIUS_CACHE_KEY, "json");
    if (cached && Array.isArray(cached.items)) return cached;
  }
  const items = await fetchCuriusLinks(env);
  const payload = { items, fetchedAt: new Date().toISOString() };
  // only cache a non-empty result, so a transient Curius failure doesn't pin an
  // empty list for 6h — the next request retries instead.
  if (env.RN_KV && items.length) {
    ctx.waitUntil(env.RN_KV.put(CURIUS_CACHE_KEY, JSON.stringify(payload), { expirationTtl: CURIUS_TTL }));
  }
  return payload;
}

export async function handleReading(request, env, ctx) {
  let payload;
  try { payload = await getCuriusCached(request, env, ctx); }
  catch (_e) { payload = { items: [], fetchedAt: new Date().toISOString() }; }
  return new Response(renderReadingPage(payload), {
    headers: {
      "content-type":    "text/html; charset=utf-8",
      "cache-control":   "no-store, must-revalidate",
      "referrer-policy": "strict-origin-when-cross-origin",
    },
  });
}

export function renderReadingPage(payload) {
  const items = Array.isArray(payload.items) ? payload.items : [];
  const count = items.length;
  const fetched = payload.fetchedAt ? esc(payload.fetchedAt.slice(0, 10)) : "";
  const profile = `https://curius.app/${CURIUS_HANDLE}`;

  let listHtml;
  if (!count) {
    listHtml = `<div class="rd-empty">Couldn't reach Curius just now — the list refills on the next sync. It always lives at <a href="${esc(profile)}" rel="external" target="_blank">curius.app/${esc(CURIUS_HANDLE)}</a>.</div>`;
  } else {
    let curMonth = "", parts = [];
    for (const it of items) {
      const d = it.created ? new Date(it.created) : null;
      const valid = d && !isNaN(d.getTime());
      const key = valid ? `${d.getUTCFullYear()}-${d.getUTCMonth()}` : "x";
      if (key !== curMonth) {
        curMonth = key;
        const label = valid ? d.toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" }) : "Undated";
        parts.push(`<div class="rd-month">${esc(label)}</div>`);
      }
      const dateStr = valid ? d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" }) : "";
      const star = it.favorite ? ` <span class="rd-star" title="favorite">&#9733;</span>` : "";
      const snip = it.snippet ? `<div class="rd-snip">${esc(it.snippet)}</div>` : "";
      const hls = (it.highlights || []).map((h) => `<blockquote class="rd-hl">${esc(h)}</blockquote>`).join("");
      parts.push(
        `<div class="rd-item">` +
          `<div class="rd-head"><a class="rd-title" href="${esc(it.link)}" target="_blank" rel="noopener noreferrer">${esc(it.title)}</a>${star}</div>` +
          `<div class="rd-meta"><span class="rd-dom">${esc(it.domain)}</span>${dateStr ? `<span class="rd-date">${esc(dateStr)}</span>` : ""}</div>` +
          snip + hls +
        `</div>`
      );
    }
    listHtml = parts.join("");
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>My Reading &middot; aadhar.sh</title>
<meta name="description" content="What I've been reading, saved to Curius and mirrored natively here. ${count} link${count === 1 ? "" : "s"}, newest first.">
<link rel="icon" href="/favicon.ico">
<style>
${xpChromeCss(720)}
h1 { font-family:"Trebuchet MS",Verdana,Geneva,sans-serif; font-size:14pt; color:oklch(41.92% 0.0962 250.51); margin:0 0 4px; font-weight:bold; }
.rd-lede { margin:0 0 12px; color:oklch(38.67% 0 0); font-size:10.5pt; }
.rd-lede a { color:oklch(42.61% 0.2353 263.74); }
.rd-bar { font-size:9pt; color:oklch(51.03% 0 0); border:1px solid oklch(61.14% 0.0611 253.60); background:oklch(98.81% 0.0263 99.90); padding:5px 9px; margin:0 0 6px; }
.rd-month { font-family:"Trebuchet MS",Verdana,Geneva,sans-serif; font-size:9.5pt; font-weight:bold; text-transform:uppercase; letter-spacing:.05em; color:oklch(41.92% 0.0962 250.51); background:oklch(94.66% 0.0114 252.09); border:1px solid oklch(82% 0.03 250); border-radius:3px; padding:3px 9px; margin:16px 0 8px; }
.rd-item { padding:7px 2px 9px; border-bottom:1px solid oklch(92.73% 0.0139 247.98); }
.rd-head { display:flex; align-items:baseline; gap:5px; flex-wrap:wrap; }
.rd-title { color:oklch(33% 0.09 263); font-weight:bold; font-size:11pt; text-decoration:none; }
.rd-title:hover { color:oklch(62.80% 0.2577 29.23); text-decoration:underline; }
.rd-star { color:oklch(72% 0.15 75); font-size:10pt; }
.rd-meta { display:flex; align-items:center; gap:8px; margin:3px 0 0; }
.rd-dom { font-family:"Courier New",Courier,monospace; font-size:8.5pt; color:oklch(41.92% 0.0962 250.51); background:oklch(94.66% 0.0114 252.09); border:1px solid oklch(82% 0.03 250); border-radius:2px; padding:0 5px; }
.rd-date { font-size:9pt; color:oklch(62.68% 0 0); }
.rd-snip { margin:5px 0 0; color:oklch(45% 0 0); font-size:9.5pt; line-height:1.5; }
.rd-hl { margin:6px 0 0; padding:3px 0 3px 9px; border-left:3px solid oklch(72% 0.10 250); color:oklch(33% 0.02 255); font-size:9.5pt; font-style:italic; line-height:1.45; }
.rd-empty { padding:16px 4px; color:oklch(45% 0 0); font-size:10pt; }
.rd-empty a { color:oklch(42.61% 0.2353 263.74); }
footer { text-align:center; font-size:9pt; color:oklch(44.95% 0 0); margin-top:16px; padding-top:12px; border-top:1px solid oklch(86.67% 0.0294 259.59); }
footer a { color:oklch(42.61% 0.2353 263.74); }
</style>
</head>
<body>
<div class="window">
  <div class="title-bar">
    <span><span class="icon"></span>My Reading</span>
    <span class="controls"><span class="min" aria-hidden="true"></span><span class="max" aria-hidden="true"></span><a class="close" href="/" title="back to aadhar.sh" aria-label="back to aadhar.sh"></a></span>
  </div>
  <div class="content">
    <h1>My Reading</h1>
    <p class="rd-lede">Things I've saved to read, pulled from my <a href="${esc(profile)}" rel="external me" target="_blank">Curius</a>. Newest first.</p>
    <div class="rd-bar">${count} link${count === 1 ? "" : "s"}${fetched ? ` &middot; last synced ${fetched}` : ""} &middot; source: Curius, via AadharshBot</div>
    ${listHtml}
    <footer>&larr; <a href="/">aadhar.sh</a> &middot; saved on <a href="${esc(profile)}" rel="external" target="_blank">Curius</a> &middot; fetched by <a href="/bot">${esc(BOT_NAME)}</a></footer>
  </div>
</div>
<script src="/nav.js" defer></script>
</body>
</html>`;
}
