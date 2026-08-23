// platform-extras.d.ts — members the tools' program needs that its lib does not
// declare, for the same reason browser-lab.d.ts exists beside it.
//
// The tools exercise WORKER code, so they touch workerd's surface even though
// they run on bun. `caches.default` is workerd's named cache and has no lib.dom
// equivalent; four test files reference it because the Worker does.
//
// `kid` is RFC 7517 §4.5 and every JWK this repo signs with carries one. TS's
// JsonWebKey omits it, which is a gap in the lib rather than in the key.

interface CacheStorage {
  /** workerd's named default cache. Not in lib.dom, and not invented here. */
  default?: Cache;
}

interface JsonWebKey {
  /** RFC 7517 §4.5 key id. */
  kid?: string;
}
