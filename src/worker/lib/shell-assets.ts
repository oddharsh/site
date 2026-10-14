// shell-assets.ts — the URLs of the two critical shell assets (luna.css,
// nav.js), emitted as an HTTP `Link: rel=preload` header so Cloudflare Early
// Hints can replay them as a 103 ahead of the HTML body. A 103 is worth exactly
// the width of the think-time window it lands in, so it pays on the routes that
// still compute before their 200 (/lens, the fragment endpoints, any cold isolate).
//
// Safe as a cross-request Early Hint, unlike the random homepage photo (which
// home.js deliberately keeps OFF the Link header): these URLs are identical
// for every visitor within a build, so a harvested 103 is never stale — a
// deploy changes the content hash and CF re-harvests from the first fresh 200.
export const SHELL_ASSETS = { luna: "/luna.css", nav: "/nav.js" }; // build:shell-assets
export const PAGE_DICTIONARY: string = ""; // build:page-dictionary

export const SPECULATION_RULES: string = ""; // build:speculation-rules

export const HASHED_ASSETS: Record<string, string> = {}; // build:hashed-assets

export const SHELL_PRELOAD_LINK =
  `<${SHELL_ASSETS.luna}>; rel="preload"; as="style", ` +
  `<${SHELL_ASSETS.nav}>; rel="preload"; as="script"`;
