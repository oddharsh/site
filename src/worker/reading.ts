import { BOT_NAME, signedFetch } from "./lib/botauth.ts";
import { serveBuiltPage } from "./lib/built-page.ts";
import { cachedRender, deleteSWRKV, edgeKey, swrKV, withWeakEtag } from "./lib/cache.ts";
import { lunaPage } from "./lib/chrome.ts";
import { PAGE_CACHE_CONTROL } from "./lib/const.ts";
import { html, unsafeHtml, type Html } from "./lib/html.ts";
import { esc, secretMatches } from "./lib/http.ts";
import { islandMount, islandPreload, islandResponse, islandScript } from "./lib/island.ts";
import { SHELL_PRELOAD_LINK } from "./lib/shell-assets.ts";
import { HN_MAP_KEY, hnThreadFor, readHnMap, type HnMap } from "./reading-hn.ts";
import { READING_LIST_URL } from "./routes.ts";

export const CURIUS_USER_ID = 5766;

export const CURIUS_HANDLE   = "aadharsh-pannirselvam";

export const CURIUS_CACHE_KEY = "curius:links";

export const CURIUS_TTL = 21600;

export async function fetchCuriusLinks(env) {
  const out = [];
  const PER = 30, MAX_PAGES = 8;
  const signal = AbortSignal.timeout(3500);
  for (let p = 0; p < MAX_PAGES; p++) {
    let data;
    try {
      const res = await signedFetch(`https://curius.app/api/users/${CURIUS_USER_ID}/links?page=${p}`, env, {
        headers: { accept: "application/json" },
        signal,
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
        highlights: (Array.isArray(it.highlights) ? it.highlights : [])
          .map((h) => (h && h.highlight ? h.highlight.replace(/\s+/g, " ").trim() : ""))
          .filter(Boolean).slice(0, 3),
      });
    }
    if (saved.length < PER) break;
  }
  out.sort((a, b) => String(b.created || "").localeCompare(String(a.created || "")));
  return out;
}

async function buildCuriusPayload(env) {
  const items = await fetchCuriusLinks(env);
  return { items, fetchedAt: new Date().toISOString() };
}

export async function getCuriusCached(request, env, ctx) {
  const url = new URL(request.url);
  if (secretMatches(url.searchParams.get("bust"), env.RN_BUST_SECRET) && env.RN_KV) {
    await deleteSWRKV(env, CURIUS_CACHE_KEY);
  }
  return swrKV(env, ctx, CURIUS_CACHE_KEY, CURIUS_TTL, () => buildCuriusPayload(env), {
    cacheTtl: 900,
    isValid: (p) => p && Array.isArray(p.items),
    shouldStore: (p) => p && Array.isArray(p.items) && p.items.length > 0,
  });
}

export const LIST_URL = READING_LIST_URL;

const LIST_CACHE = "public, max-age=300";

const PENDING_ROWS = 6;
const PENDING_MODEL = {
  pending: true,
  fetchedAt: null,
  items: Array.from({ length: PENDING_ROWS }, () => ({ title: "…", link: "", domain: "…", snippet: "", highlights: [], created: null, favorite: false })),
};

async function readReadingList(request, env, ctx): Promise<{ response: Response; ok: boolean }> {
  const [payload, hn] = await Promise.all([
    getCuriusCached(request, env, ctx).catch(() => ({ items: [], fetchedAt: new Date().toISOString() })),
    Promise.resolve(env?.RN_KV ? env.RN_KV.get(HN_MAP_KEY, { type: "json", cacheTtl: 900 }) : null).then(readHnMap, () => ({})),
  ]);
  const ok = Array.isArray(payload?.items) && payload.items.length > 0;
  return { ok, response: islandResponse(renderReadingList(payload, hn), { "cache-control": ok ? LIST_CACHE : "public, max-age=60" }) };
}

export async function refreshReadingList(request, env, ctx) {
  const url = new URL(request.url);
  if (!secretMatches(url.searchParams.get("bust"), env.RN_BUST_SECRET)) return null;
  const { ok, response } = await readReadingList(request, env, ctx);
  if (ok) {
    try { await caches.default.put(edgeKey(url.origin, LIST_URL, env), await withWeakEtag(response.clone())); } catch {}
  }
  return response;
}

export async function handleReadingList(request, env, ctx) {
  const busted = await refreshReadingList(request, env, ctx);
  if (busted) return busted;
  return cachedRender(request, ctx, async () => (await readReadingList(request, env, ctx)).response, LIST_URL, env);
}

export async function handleReading(request, env, ctx) {
  if (new URL(request.url).searchParams.has("bust")) {
    const busted = await refreshReadingList(request, env, ctx);
    try { await busted?.body?.cancel(); } catch {}
  }
  return serveBuiltPage(request, env, {
    headers: {
      "cache-control":   PAGE_CACHE_CONTROL,
      "link":            SHELL_PRELOAD_LINK,
      "referrer-policy": "strict-origin-when-cross-origin",
    },
    live: () => renderReadingPage(),
  });
}

let rowDates: { month: Intl.DateTimeFormat; day: Intl.DateTimeFormat } | undefined;
const readingDates = () => rowDates ??= {
  month: new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric", timeZone: "UTC" }),
  day:   new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" }),
};

export function renderReadingList(payload, hn: HnMap = {}): Html {
  const pending = payload?.pending === true;
  const items = Array.isArray(payload?.items) ? payload.items : [];
  const count = items.length;
  const fetched = payload?.fetchedAt ? esc(payload.fetchedAt.slice(0, 10)) : "";
  const profile = `https://curius.app/${CURIUS_HANDLE}`;

  let listHtml, discussed = 0;
  if (!count) {
    listHtml = `<div class="rd-empty">Couldn't reach Curius just now — the list refills on the next sync. It always lives at <a href="${esc(profile)}" rel="external" target="_blank">curius.app/${esc(CURIUS_HANDLE)}</a>.</div>`;
  } else {
    let curMonth = "", parts = [];
    const dates = readingDates();
    for (const it of items) {
      const d = it.created ? new Date(it.created) : null;
      const valid = d && !isNaN(d.getTime());
      const key = valid ? `${d.getUTCFullYear()}-${d.getUTCMonth()}` : "x";
      if (key !== curMonth) {
        curMonth = key;
        const label = pending ? "…" : valid ? dates.month.format(d) : "Undated";
        parts.push(`<div class="rd-month">${esc(label)}</div>`);
      }
      const dateStr = valid ? dates.day.format(d) : "";
      const star = it.favorite ? ` <span class="rd-star" title="favorite">&#9733;</span>` : "";
      const snip = it.snippet ? `<div class="rd-snip">${esc(it.snippet)}</div>` : "";
      const hls = (it.highlights || []).map((h) => `<blockquote class="rd-hl">${esc(h)}</blockquote>`).join("");
      const thread = hnThreadFor(it.link, hn);
      if (thread) discussed++;
      const noun = (n, one) => `${n} ${one}${n === 1 ? "" : "s"}`;
      const hnLink = thread
        ? `<a class="rd-hn" href="${esc(thread.href)}" target="_blank" rel="noopener noreferrer" title="Discuss on Hacker News: ${esc(noun(thread.points, "point"))}, ${esc(noun(thread.comments, "comment"))}"><span class="rd-y" aria-hidden="true">Y</span>${esc(noun(thread.comments, "comment"))}</a>`
        : "";
      const title = it.link
        ? `<a class="rd-title" href="${esc(it.link)}" target="_blank" rel="noopener noreferrer">${esc(it.title)}</a>`
        : `<span class="rd-title">${esc(it.title)}</span>`;
      parts.push(
        `<div class="rd-item">` +
          `<div class="rd-head">${title}${star}</div>` +
          `<div class="rd-meta"><span class="rd-dom">${esc(it.domain)}</span>${dateStr ? `<span class="rd-date">${esc(dateStr)}</span>` : ""}${hnLink}</div>` +
          snip + hls +
        `</div>`
      );
    }
    listHtml = parts.join("");
  }

  const bar = pending
    ? "&hellip; links"
    : `${count} link${count === 1 ? "" : "s"}${discussed ? ` &middot; ${discussed} discussed on Hacker News` : ""}${fetched ? ` &middot; last synced ${fetched}` : ""}`;
  return unsafeHtml(
    `<div class="rd-bar">${bar} &middot; source: Curius, via AadharshBot</div>` +
    listHtml +
    `<footer>&larr; <a href="/">aadhar.sh</a> &middot; saved on <a href="${esc(profile)}" rel="external" target="_blank">Curius</a> &middot; fetched by <a href="/bot">${esc(BOT_NAME)}</a></footer>`,
  );
}

export function renderReadingPage() {
  const profile = `https://curius.app/${CURIUS_HANDLE}`;
  return lunaPage({
    title: "My Reading · aadhar.sh",
    path: "My Reading",
    route: "/reading",
    width: 720,
    description: "What I've been reading, saved to Curius and mirrored natively here, newest first.",
    head: islandPreload(LIST_URL),
    headers: { "referrer-policy": "strict-origin-when-cross-origin" },
    css: `/*min*/
.rd-lede { margin:0 0 12px; color:var(--ink-soft); font-size:var(--text-body); }
.rd-lede a { color:var(--link); }
.rd-bar { font-size:var(--text-xs); color:var(--ink-dim); border:1px solid var(--frame); background:oklch(98.81% 0.0263 99.90); padding:5px 9px; margin:0 0 6px; }
.rd-month { font-family:var(--font-caption); font-size:var(--text-sm); font-weight:bold; text-transform:uppercase; letter-spacing:.05em; color:var(--blue-40); background:var(--surface-desktop); border:1px solid oklch(82% 0.03 250); border-radius:3px; padding:3px 9px; margin:16px 0 8px; }
.rd-item { padding:7px 2px 9px; border-bottom:1px solid var(--surface-desktop); }
.rd-head { display:flex; align-items:baseline; gap:5px; flex-wrap:wrap; }
.rd-title { color:oklch(33% 0.09 263); font-weight:bold; font-size:var(--text-lede); text-decoration:none; }
.rd-title:hover { color:var(--link-hover); text-decoration:underline; }
.rd-star { color:oklch(72% 0.15 75); font-size:var(--text-ui); }
.rd-meta { display:flex; flex-wrap:wrap; align-items:center; gap:2px 8px; margin:3px 0 0; }
.rd-dom { font-family:var(--font-mono); font-size:var(--text-micro); color:var(--blue-40); background:var(--surface-desktop); border:1px solid oklch(82% 0.03 250); border-radius:2px; padding:0 5px; }
.rd-date { font-size:var(--text-xs); color:var(--ink-faint); }
.rd-hn { display:inline-flex; align-items:center; gap:4px; font-size:var(--text-micro); color:oklch(33% 0.09 263); text-decoration:none; }
.rd-hn:hover { color:var(--link-hover); text-decoration:underline; }
.rd-y { display:inline-block; width:11px; height:11px; line-height:11px; text-align:center; font:bold var(--text-2xs) var(--font-ui); color:white; background:oklch(66% 0.19 42); border:1px solid oklch(56% 0.17 42); }
.rd-snip { margin:5px 0 0; color:var(--ink-quiet); font-size:var(--text-sm); line-height:1.5; }
.rd-hl { margin:6px 0 0; padding:3px 0 3px 9px; border-left:3px solid oklch(72% 0.10 250); color:oklch(33% 0.02 255); font-size:var(--text-sm); font-style:italic; line-height:1.45; }
.rd-empty { padding:16px 4px; color:var(--ink-quiet); font-size:var(--text-ui); }
.rd-empty a { color:var(--link); }
footer { text-align:center; font-size:var(--text-xs); color:var(--ink-quiet); margin-top:16px; padding-top:12px; border-top:1px solid var(--rule); }
footer a { color:var(--link); }
#rd-list[data-state="pending"] { cursor:progress; }
/* the island's failure note, shown only if the list request failed */
.rd-fail { display:none; padding:12px 4px; color:var(--ink-faint); font-size:var(--text-xs); }
.rd-fail a { color:var(--link); }
#rd-list[data-state="failed"] + .rd-fail { display:block; }
`,
    body: html`
    <h1>My Reading</h1>
    <p class="rd-lede">Things I've saved to read, pulled from my <a href="${profile}" rel="external me" target="_blank">Curius</a>. Newest first.</p>
    ${islandMount("rd-list", LIST_URL, renderReadingList(PENDING_MODEL), html`<p>The list arrives in a second request after the page loads, and that needs a script. Without one, <a href="${LIST_URL}">${LIST_URL}</a> shows it as plain HTML.</p>`)}
    <p class="rd-fail">The request for the list failed, so it stays empty rather than guessed. <a href="${LIST_URL}">${LIST_URL}</a> has it as plain HTML, and it always lives at <a href="${profile}" rel="external" target="_blank">curius.app/${CURIUS_HANDLE}</a>.</p>
`,
    scripts: islandScript(),
  });
}
