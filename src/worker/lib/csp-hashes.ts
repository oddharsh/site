// csp-hashes.js — the per-document sha256 allowlist for inline <script> blocks,
// so `script-src` can drop 'unsafe-inline' and start doing real work.
//
// Same shape as shell-assets.js: this file is COMMITTED readable with an empty
// map, and build.ts overwrites the marked line in the staged .build/ copy with
// hashes derived from the final bytes it just wrote. Keep the
// `// build:csp-hashes` marker — the build replaces that whole line.
//
// Empty here on purpose. `bun run dev` (wrangler.dev.jsonc) serves the readable
// unminified source tree through the .dev-assets farm, whose inline blocks
// hash differently from the staged
// ones, so a committed map would be wrong for exactly the surface it claims to
// protect. An empty map means every path falls back to the loose policy, which is
// what dev wants and what production must never silently get — build.ts hard-fails
// if the map it emits does not cover essentially every staged document.
//
// Keys are canonical REQUEST paths (no trailing slash, no .html), because that is
// what withSecurityHeaders() is handed. Values are bare base64 digests; the
// 'sha256-' prefix and quoting are added when the policy is assembled.
export const PAGE_SCRIPT_HASHES = {}; // build:csp-hashes

// Live worker-rendered documents (/whoareyou, /around, /coffee, /search, /ledger,
// /rn/admin, /serendipity) are NOT in the map and keep the loose policy. Their HTML
// is assembled per request from template literals, so no build-time hash can be
// right. The honest fix for those is a per-response nonce, which they can take
// precisely BECAUSE they are not precompressed — see the PR notes. Until then the
// fallback keeps them exactly as secure as they are today, and no less.
//
// The staged documents (43 of them: the homepage, garage, lwe, pixel-peeper,
// /lens, /writing/*, /photos, /bot, /updates, /restore) are all deterministic
// build output, which is what makes a build-time hash the correct mechanism
// rather than a convenient one.

// A request path can arrive in several equivalent spellings. Canonical URLs on
// this site carry no trailing slash (wrangler's drop-trailing-slash html_handling
// and both rel=canonical tags agree), so fold the variants onto that form before
// looking a document up.
export function canonicalPath(pathname) {
  if (!pathname) return "/";
  let p = pathname;
  if (p.endsWith(".html")) p = p.slice(0, -5);
  if (p.endsWith("/index")) p = p.slice(0, -6) || "/";
  if (p.length > 1 && p.endsWith("/")) p = p.slice(0, -1);
  return p || "/";
}

// No pathname means the caller could not name this document (the /lens self-scan
// passes none). That must NOT canonicalize to "/" and hand some other response the
// homepage's hashes, so it returns null and takes the loose policy.
export function scriptHashesFor(pathname) {
  if (!pathname) return null;
  return PAGE_SCRIPT_HASHES[canonicalPath(pathname)] || null;
}
