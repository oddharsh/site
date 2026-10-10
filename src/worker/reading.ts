// reading.js — extracted from the worker (no-build reorg). Bundled by
// wrangler/Cloudflare at deploy; not served (inside _worker.js/).
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
  // ONE shared deadline across the whole crawl (not per-page): Curius measured
  // ~3s/page, so a full 8-page serial crawl could otherwise hang ~13s. This
  // aborts the whole thing at ~3.5s and returns whatever pages arrived. In
  // steady state the crawl runs in ctx.waitUntil (SWR), so no visitor waits on
  // it regardless; this just bounds the first-run inline path + the background task.
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
    } catch (_e) { break; }   // abort (deadline) or network error → stop, return what we have
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

// stale-while-revalidate (mirrors rn.getTracksSWR):
// the list is stored WITHOUT a TTL (persistent value key) and the entry's KV
// metadata carries the write time the 6h freshness window runs from. Once that
// lapses, the visitor gets the stale list instantly and the Curius crawl rides
// ctx.waitUntil in the background, so nobody ever waits on the ~3.5s (bounded)
// crawl except the true first run.
async function buildCuriusPayload(env) {
  const items = await fetchCuriusLinks(env);
  return { items, fetchedAt: new Date().toISOString() };
}

export async function getCuriusCached(request, env, ctx) {
  const url = new URL(request.url);
  if (secretMatches(url.searchParams.get("bust"), env.RN_BUST_SECRET) && env.RN_KV) {
    // drop the value itself, since the persistent key is what a rebuild is gated on.
    await deleteSWRKV(env, CURIUS_CACHE_KEY);
  }
  // no cached value at all — true first run or right after a bust — builds inline.
  // non-empty guard: a transient Curius failure must not blank a good stale list.
  //
  // cacheTtl 900: this was the one swrKV caller passing none, while both siblings
  // (rn 1800, dyno 300) pass one, and no argument was recorded for the difference.
  // 900 adds 15 minutes to a list that already refreshes every 6 hours, so 4% on
  // its own window. It has to clear 300 to do anything, because handleReading sits
  // behind cachedRender at max-age=300 and this read only runs on an edge miss. The
  // bust is unaffected for whoever runs it: ?bust= deletes both keys and rebuilds
  // inline in the same request, and evicts that colo's edge entry too.
  return swrKV(env, ctx, CURIUS_CACHE_KEY, CURIUS_TTL, () => buildCuriusPayload(env), {
    cacheTtl: 900,
    isValid: (p) => p && Array.isArray(p.items),
    shouldStore: (p) => p && Array.isArray(p.items) && p.items.length > 0,
  });
}

// /reading is a BUILT document since 2026-09-29: build.ts step 5b bakes
// renderReadingPage() once, so the lede, the chrome and the 2 KB of CSS ship as
// a q11 twin with a dcz delta, an ETag and hashed CSP. The list (its count bar,
// the rows, and the footer under them) is the island at LIST_URL, rendered from
// the Curius SWR payload and edge-cached for five minutes, the same cache the
// whole page carried before. The footer rides in the island because nothing may
// sit below an island whose height the list decides.
//
// It sat on config/per-request-pages.json because the items are most of the
// page's bytes. That priced only the first visit: a returning reader already
// holds the shell, so what they fetch shrinks to the dictionary delta plus the
// list, and the list is the one part that could have changed.
export const LIST_URL = READING_LIST_URL;

const LIST_CACHE = "public, max-age=300";

// A screenful of rows for the placeholder, and the placeholder model the SAME
// renderer draws them from (lib/island.ts, rule 1). The live list is ~150 rows
// and does not need to match: nothing visible follows the island.
const PENDING_ROWS = 6;
const PENDING_MODEL = {
  pending: true,
  fetchedAt: null,
  items: Array.from({ length: PENDING_ROWS }, () => ({ title: "…", link: "", domain: "…", snippet: "", highlights: [], created: null, favorite: false })),
};

// The HN map is joined here rather than written into the Curius payload, so the
// 6-hourly Curius rebuild and the :07/:37 HN job never overwrite each other. A
// missing or unreadable map renders the list without the badges. `ok` says
// whether this read is worth caching: an empty list is a Curius failure with
// nothing stale to fall back on, and it gets a minute rather than five.
async function readReadingList(request, env, ctx): Promise<{ response: Response; ok: boolean }> {
  const [payload, hn] = await Promise.all([
    getCuriusCached(request, env, ctx).catch(() => ({ items: [], fetchedAt: new Date().toISOString() })),
    // Promise.resolve, because with no store bound the ternary is a bare null
    // and `.then` on it threw; the per-request page carried the same bug.
    Promise.resolve(env?.RN_KV ? env.RN_KV.get(HN_MAP_KEY, { type: "json", cacheTtl: 900 }) : null).then(readHnMap, () => ({})),
  ]);
  const ok = Array.isArray(payload?.items) && payload.items.length > 0;
  return { ok, response: islandResponse(renderReadingList(payload, hn), { "cache-control": ok ? LIST_CACHE : "public, max-age=60" }) };
}

// The owner's force-refresh, on the island now because the page is a static file
// and cannot take a query (around.ts's refreshAroundSnapshot is the same shape).
// A valid ?bust=SECRET makes getCuriusCached drop the KV payload and re-crawl
// inline, and the fresh fragment OVERWRITES this colo's cached copy, awaited, so
// the owner's own next load reads the new list. Anything else is null.
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

// The route. ?bust=SECRET still works at the page URL: it refreshes the island's
// cached copy before the shell goes out, so the island the shell then fetches is
// the new list. It serves the built shell with the page policy every generated
// document takes, and falls back to rendering the shell where no bake is staged
// (bun run dev, and the contract suite, which is why it lives here rather than in
// index.ts).
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

// toLocaleDateString with options builds a new Intl.DateTimeFormat on every
// call, and the list made one per row plus one per month: 127 for 120 links,
// about 4.9 ms of a 9.3 ms cold render under node (2026-10-09). Production bills
// this fragment at a 31 ms median, because the edge copy is keyed by version and
// a visitor nearly always misses it. A cached formatter's format() is the same
// string by spec, since both shapes name their own fields and so take no
// defaults (the reasoning cal's slotLabels rests on). Built on first use, so a
// request that never renders the list doesn't pay for them.
let rowDates: { month: Intl.DateTimeFormat; day: Intl.DateTimeFormat } | undefined;
const readingDates = () => rowDates ??= {
  month: new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric", timeZone: "UTC" }),
  day:   new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" }),
};

/** The island: the count bar, the rows and the footer, or the placeholder. */
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
      // A placeholder row links nowhere, so its title is a span in the same class.
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

/** The shell build.ts bakes. It takes no arguments, so every build agrees. */
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
