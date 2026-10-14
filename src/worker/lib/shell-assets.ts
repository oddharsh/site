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
