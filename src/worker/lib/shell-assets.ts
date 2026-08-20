// shell-assets.js — the URLs of the two critical shell assets (luna.css,
// nav.js), emitted as an HTTP `Link: rel=preload` header so Cloudflare Early
// Hints can replay them as a 103 ahead of the HTML body. A 103 is worth exactly
// the width of the think-time window it lands in, so it pays on the routes that
// still compute before their 200 (/lens, the fragment endpoints, any cold isolate).
//
// This used to name the HOMEPAGE as where a 103 buys the most, "because it does KV
// reads before the 200". That stopped being true when build.mjs step 1d baked the
// homepage into a deterministic document and moved every one of those reads onto
// separate fragments. Measured against production 2026-07-31, `/`'s 103-to-200
// window is 8.5-18.8 ms, and windows under ~100 ms were already measured not to
// complete the preload (the CDP note in CLAUDE.md). So the header stays and the
// homepage-specific claim does not.
//
// Safe as a cross-request Early Hint, unlike the random homepage photo (which
// home.js deliberately keeps OFF the Link header): these URLs are identical
// for every visitor within a build, so a harvested 103 is never stale — a
// deploy changes the content hash and CF re-harvests from the first fresh 200.
//
// build.mjs OVERWRITES the SHELL_ASSETS line below in the staged .build/ copy
// with the immutable /a/<name>.<hash8> URLs (matching the refs it rewrites into
// the HTML). The values here are the readable-dev fallbacks: wrangler.dev.jsonc
// serves the unhashed files, so `bun run dev` preloads exactly the URLs its
// (un-rewritten) HTML references. Keep the `// build:shell-assets` marker.
export const SHELL_ASSETS = { luna: "/luna.css", nav: "/nav.js" }; // build:shell-assets
// Empty in readable local development: the page dictionary is derived from the
// final staged HTML, so it does not exist until build.mjs runs. The build
// replaces this marker with its immutable content-addressed URL.
// The ANNOTATION is load-bearing now that this file is TypeScript. Build step
// rewrites this line, so at runtime it is a URL; in source it is "", and tsc
// infers the literal type from that. Every `if (PAGE_DICTIONARY)` then narrows
// to never, which reads as an unreachable branch and made oxlint reject the
// interpolation in security.ts. Declaring it `string` says what the build does.
export const PAGE_DICTIONARY: string = ""; // build:page-dictionary

// luna.css first: it is render-blocking style, so it outranks the deferred
// nav.js script. Browsers dedupe a preload against the in-document <link
// rel=preload> + the eventual request by URL, so this never double-fetches.
export const SHELL_PRELOAD_LINK =
  `<${SHELL_ASSETS.luna}>; rel="preload"; as="style", ` +
  `<${SHELL_ASSETS.nav}>; rel="preload"; as="script"`;
