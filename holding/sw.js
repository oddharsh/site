// sw.js — aadhar.sh service worker.
//
// goal: make repeat visits instant for the things that don't change often
// (images, /llms.txt, /sitemap.xml, /robots.txt) while keeping HTML and
// dynamic worker endpoints (/rn, /rn/tracks, /around, /whoareyou, /bot)
// honest — always go to the network for those so a content update lands.
//
// caching strategies used:
//   - cache-first (with background revalidate): /img/*
//     thumbnails + full-res photos. immutable in practice, but we still
//     refresh in the background so renamed files surface eventually.
//   - stale-while-revalidate: /llms.txt, /sitemap.xml, /robots.txt,
//     /.well-known/http-message-signatures-directory
//     small static files. show stale instantly, refresh in background.
//   - network-only: everything else (html, json apis, /rn/*, /around/*).
//
// updating the SW: bump CACHE_VERSION below. on next page load the new
// SW installs, the old caches get cleaned up in `activate`.

// bump on path renames or significant behavioral changes; old SW caches
// get swept in the next `activate` event. v6 sweeps the v5 webp+jpg
// cache after the WebP middle tier was removed — leftover entries from
// the WebP era are now broken URLs (the .webp files were deleted), so
// returning visitors need a fresh cache to repopulate from AVIF+JPG.
// `?v=N` bumps on each deploy already cycle individual entries, but a
// cache-version bump is the only way to sweep stale keys whose URL
// pattern no longer matches anything we serve.
const CACHE_VERSION = "aadhar-v75-confetti";

const CACHE_FIRST = [
  // thumbnail image files only — NOT /images/ itself (a directory-listing
  // HTML page, served via the worker, must stay fresh) and NOT /images/full/*:
  // the ~20MB R2 originals are already held by the browser HTTP cache under
  // max-age=31536000 immutable, so copying them into Cache Storage doubled
  // disk/quota cost (plus a background re-fetch per hit) for zero hit-rate
  // gain. formats limited to what add-photos.sh actually produces.
  /^\/images\/[0-9A-Za-z._-]+\.(jpg|jpeg|avif|png|gif|heic|heif)$/i,
];
const SWR = [
  /^\/llms\.txt$/,
  /^\/sitemap\.xml$/,
  /^\/robots\.txt$/,
  /^\/\.well-known\/http-message-signatures-directory$/,
  // /nav.js — the site-wide taskbar + Run palette. stable + shared across every
  // page; SWR makes repeat nav instant and picks up updates on the next load.
  /^\/nav\.js$/,
  // /notepad.js — behavior for the /writing Notepad view. same deal.
  /^\/notepad\.js$/,
  // NB: /favicon.ico is NOT SWR'd — it used to SPA-fall-back to the 75KB
  // homepage, so caching it here stored a 75KB HTML blob under the favicon key.
  // the worker now serves a real SVG at /favicon.ico (immutable), so the browser
  // HTTP-caches it; no SW entry needed.
  // /bot is content-stable — SWR for instant repeat nav.
  // NB: /garage/* are deliberately NOT cached here. they're active development
  // mules that change constantly; SWR served the owner (and returning visitors)
  // a stale copy until a SECOND load, which kept hiding fresh edits. they're now
  // network-only — always fresh — and still fast via the edge cache + Chromium's
  // Speculation Rules prerender. other dynamic pages stay network-only too:
  //   /          — no-store (re-randomizes photos + ticks the counter)
  //   /around    — a live crawl  ·  /whoareyou — per-request fingerprint
  /^\/bot$/,
  // NB: /images/meta/<stem>.json (per-photo EXIF for the tooltip) + the full
  // /images/metadata.json index are network-only — never SW-cached — so a stale
  // copy can't slip in. they're tiny + immutable, and the browser HTTP-caches
  // them anyway. (histograms are computed client-side now; no histograms.json.)
];

// URLs warmed on SW install so the FIRST navigation is already a hit.
// (garage pages are intentionally network-only now — see SWR note above.)
const PRECACHE_PAGES = ["/bot"];

self.addEventListener("install", (event) => {
  // new SW takes over immediately on next reload
  self.skipWaiting();

  // Service Worker static routing (Chrome; progressive). Declare the
  // "always-the-network" paths so the browser serves them WITHOUT cold-booting
  // this worker — these are network-only in the fetch handler below, so today
  // they wake the SW just to fall through to the network. A static route skips
  // that boot tax (notably on `/`, which is no-store + hit every visit). The
  // SWR + cache-first paths are deliberately NOT routed here — they need the
  // handler's logic. Unsupported browsers ignore addRoutes() and behave as before.
  if ("addRoutes" in event) {
    const net = (pathname) => ({
      condition: { urlPattern: new URLPattern({ pathname }), requestMethod: "GET" },
      source: "network",
    });
    try {
      event.addRoutes([
        net("/"),                 // homepage — no-store, re-rendered every visit
        net("/around*"),          // live crawl
        net("/whoareyou*"),       // per-request fingerprint
        net("/rn*"),              // playlist redirect + /rn/tracks JSON
        net("/images/*.json"),    // manifest.json / alt.json
        net("/images/meta/*"),    // per-photo EXIF JSON (network-only by design)
      ]);
    } catch (e) { /* older addRoutes shape / bad pattern — fall back to the handler */ }
  }

  // warm the cache with the static pages so the first nav to them is a hit
  // (no loading bar). allSettled so one failed fetch can't block install.
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_VERSION);
    await Promise.allSettled(PRECACHE_PAGES.map((u) => cache.add(u)));
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    // sweep old caches
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== CACHE_VERSION).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;  // never touch cross-origin
  const path = url.pathname;

  if (CACHE_FIRST.some(re => re.test(path))) {
    event.respondWith(cacheFirst(req));
    return;
  }
  if (SWR.some(re => re.test(path))) {
    event.respondWith(staleWhileRevalidate(req));
    return;
  }
  // everything else: go to the network. (don't call event.respondWith —
  // the browser handles it directly, which is faster than us proxying.)
});

// cache-first for content-addressed images. only cache image responses
// (defensive against any future edge weirdness where a non-image 200
// somehow lands under an image URL — e.g. a JSON error body served with
// a 200 status). 404s are never .ok so they're already excluded.
const isImage = (res) =>
  !!res && res.ok && (res.headers.get("content-type") || "").startsWith("image/");

async function cacheFirst(req) {
  const cache = await caches.open(CACHE_VERSION);
  const hit = await cache.match(req);
  if (hit) {
    // NO background revalidate: thumbnails are content-addressed (?v=N,
    // 1-year immutable) — a refetch can never observe new bytes, so it'd
    // be a pure redundant disk write per view. invalidation is the ?v
    // bump (new URL) + the activate-event sweep of old cache versions.
    return hit;
  }
  const res = await fetch(req);
  if (isImage(res)) cache.put(req, res.clone());
  return res;
}

async function staleWhileRevalidate(req) {
  const cache = await caches.open(CACHE_VERSION);
  // ignoreVary: a navigation request's headers differ from the bare GET that
  // cache.add() stored on install; without this they wouldn't match.
  const cached = cache.match(req, { ignoreVary: true });
  const network = fetch(req).then(res => {
    if (res && res.ok) cache.put(req, res.clone());
    return res;
  }).catch(() => null);
  const inCache = await cached;
  return inCache || (await network) || new Response("", { status: 504 });
}

// allow the page to ask the SW to clear caches (no UI yet, but useful):
//   navigator.serviceWorker.controller.postMessage({type:"clear"})
self.addEventListener("message", async (event) => {
  if (event.data?.type === "clear") {
    const keys = await caches.keys();
    await Promise.all(keys.map(k => caches.delete(k)));
    event.source?.postMessage({ type: "cleared" });
  }
});
