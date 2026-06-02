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
//     /.well-known/http-message-signatures-directory, /favicon.ico
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
const CACHE_VERSION = "aadhar-v34-mule-lore";

const CACHE_FIRST = [
  // image files only — NOT /images/ or /images/full/ themselves (those are
  // directory-listing HTML pages, served via the worker, must stay fresh).
  // formats limited to what add-photos.sh actually produces + R2 originals.
  /^\/images\/[0-9A-Za-z._-]+\.(jpg|jpeg|avif|png|gif|heic|heif)$/i,
  /^\/images\/full\/[0-9A-Za-z._-]+\.(jpg|jpeg|avif|png|gif|heic|heif|hif)$/i,
];
const SWR = [
  /^\/llms\.txt$/,
  /^\/sitemap\.xml$/,
  /^\/robots\.txt$/,
  /^\/\.well-known\/http-message-signatures-directory$/,
  /^\/favicon\.ico$/,
  // static, content-stable pages: pre-cached on install (below) + served
  // stale-while-revalidate, so navigations are instant cache hits even in
  // engines that don't (yet) run our Speculation Rules prerender — i.e.
  // Safari + Firefox. this is the cross-browser half of the McMaster snap.
  // dynamic pages stay network-only and are deliberately NOT here:
  //   /          — no-store (re-randomizes photos + ticks the counter)
  //   /around    — a live crawl
  //   /whoareyou — per-request fingerprint
  /^\/garage\/$/,
  /^\/garage\/(horizon|tooltips|scroll|chunks|pretext)$/,
  /^\/garage\/pretext\.lib\.js$/,   // vendored pretext bundle (this page only)
  /^\/bot$/,
  // photo-tooltip metadata (EXIF + histogram) + histograms — content-stable,
  // fetched on first photo hover. SWR so the first hover after a photo-set
  // change still revalidates in the background.
  /^\/images\/metadata\.json$/,
  /^\/images\/histograms\.json$/,
];

// URLs warmed on SW install so the FIRST navigation is already a hit (the
// 200-returning forms — /garage 308-redirects to /garage/, so cache the slash).
const PRECACHE_PAGES = ["/garage/", "/garage/horizon", "/garage/tooltips", "/garage/scroll", "/garage/chunks", "/garage/pretext", "/bot"];

self.addEventListener("install", (event) => {
  // new SW takes over immediately on next reload
  self.skipWaiting();
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
    // background revalidate (don't await)
    fetch(req).then(res => {
      if (isImage(res)) cache.put(req, res.clone());
    }).catch(() => {});
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
