// shell-assets.js — the URLs of the two critical shell assets (luna.css,
// nav.js), emitted as an HTTP `Link: rel=preload` header so Cloudflare Early
// Hints can replay them as a 103 ahead of the HTML body. The homepage is
// no-cache + worker-generated (it does KV reads before the 200), which is
// exactly where a 103 during that think-time buys the most.
//
// Safe as a cross-request Early Hint, unlike the random homepage photo (which
// home.js deliberately keeps OFF the Link header): these URLs are identical
// for every visitor within a build, so a harvested 103 is never stale — a
// deploy changes the content hash and CF re-harvests from the first fresh 200.
//
// build.mjs OVERWRITES the SHELL_ASSETS line below in the staged .build/ copy
// with the immutable /a/<name>.<hash8> URLs (matching the refs it rewrites into
// the HTML). The values here are the readable-dev fallbacks: wrangler.dev.jsonc
// serves the unhashed files, so `npm run dev` preloads exactly the URLs its
// (un-rewritten) HTML references. Keep the `// build:shell-assets` marker.
export const SHELL_ASSETS = { luna: "/luna.css", nav: "/nav.js" }; // build:shell-assets
// Empty in readable local development: the page dictionary is derived from the
// final staged HTML, so it does not exist until build.mjs runs. The build
// replaces this marker with its immutable content-addressed URL.
export const PAGE_DICTIONARY = ""; // build:page-dictionary

// luna.css first: it is render-blocking style, so it outranks the deferred
// nav.js script. Browsers dedupe a preload against the in-document <link
// rel=preload> + the eventual request by URL, so this never double-fetches.
export const SHELL_PRELOAD_LINK =
  `<${SHELL_ASSETS.luna}>; rel="preload"; as="style", ` +
  `<${SHELL_ASSETS.nav}>; rel="preload"; as="script"`;
