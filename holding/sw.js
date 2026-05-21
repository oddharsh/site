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
// get swept in the next `activate` event. v5 sweeps the v4 cache, which
// accumulated entries during a stretch where the upstream image URLs
// kept changing (AVIF → JPG-only → WebP+JPG via <picture>, plus the
// `?v=N` cache-bust query bumping with each deploy). starting from a
// clean cache here gets every returning visitor onto the current bytes
// without manually clearing storage.
const CACHE_VERSION = "aadhar-v5-webp-jpg";

const CACHE_FIRST = [
  // image files only — NOT /images/ or /images/full/ themselves (those are
  // directory-listing HTML pages, served via the worker, must stay fresh)
  /^\/images\/[0-9A-Za-z._-]+\.(jpg|jpeg|avif|webp|png|gif|heic|heif)$/i,
  /^\/images\/full\/[0-9A-Za-z._-]+\.(jpg|jpeg|avif|webp|png|gif|heic|heif)$/i,
];
const SWR = [
  /^\/llms\.txt$/,
  /^\/sitemap\.xml$/,
  /^\/robots\.txt$/,
  /^\/\.well-known\/http-message-signatures-directory$/,
  /^\/favicon\.ico$/,
];

self.addEventListener("install", () => {
  // new SW takes over immediately on next reload
  self.skipWaiting();
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
  const cached = cache.match(req);
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
