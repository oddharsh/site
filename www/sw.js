// sw.js: the unregister stub. The service worker retired in build v136
// (2026-07-03): immutable assets + bfcache + speculation-rules prerender
// already make repeat visits instant, so the SW's one remaining job was
// insurance, priced at a CACHE_VERSION ritual per deploy plus a second
// poisonable cache. This stub stays served for a year or more so every
// installed copy replaces itself, empties its caches, and unregisters;
// with no fetch handler here, pages fall straight through to the network
// the moment it activates. The deploy log lives on at /updates.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.map((k) => caches.delete(k)));
    await self.clients.claim();
    await self.registration.unregister();
  })());
});
