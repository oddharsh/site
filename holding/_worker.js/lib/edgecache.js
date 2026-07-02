// edgecache.js is kept as a compatibility shim. The cache helpers now live
// together in lib/cache.js so the Worker has one caching primitive surface.
export { cachedRender } from "./cache.js";
