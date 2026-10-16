// shell-assets.ts — the URLs of the two critical shell assets (luna.css,
// nav.js), emitted as an HTTP `Link: rel=preload` header so Cloudflare Early
// Hints can replay them as a 103 ahead of the HTML body. A 103 is worth exactly
// the width of the think-time window it lands in, so it pays on the routes that
// still compute before their 200 (/lens, the fragment endpoints, any cold isolate).
//
// The homepage is the route where it pays least. build.ts step 1d bakes `/` into
// a deterministic document with every KV read moved onto separate fragments, and
// measured against production 2026-07-31, `/`'s 103-to-200 window is 8.5-18.8 ms.
// Windows under ~100 ms were measured not to complete the preload (how to measure
// an Early Hint: gotcha 15). The header stays for the routes above.
//
// Safe as a cross-request Early Hint, unlike the random homepage photos (home.ts
// picks them per request, in a fragment): these URLs are identical
// for every visitor within a build, so a harvested 103 is never stale — a
// deploy changes the content hash and CF re-harvests from the first fresh 200.
//
// build.ts OVERWRITES the SHELL_ASSETS line below in the staged .build/ copy
// with the immutable /a/<name>.<hash8> URLs (matching the refs it rewrites into
// the HTML). The values here are the readable-dev fallbacks: local dev (config/dev/)
// serves the unhashed files, so `bun run dev` preloads exactly the URLs its
// (un-rewritten) HTML references. Keep the `// build:shell-assets` marker.
export const SHELL_ASSETS = { luna: "/luna.css", nav: "/nav.js" }; // build:shell-assets
// Empty in readable local development: the page dictionary is derived from the
// final staged HTML, so it does not exist until build.ts runs. The build
// replaces this marker with its immutable content-addressed URL.
// The `string` ANNOTATION is load-bearing. The build rewrites this line, so at
// runtime it is a URL; in source it is "", and tsc infers the literal type from
// that. Every `if (PAGE_DICTIONARY)` then narrows to never, which reads as an
// unreachable branch and made the linter reject the interpolation in
// lib/security.ts. Declaring it `string` says what the build does.
export const PAGE_DICTIONARY: string = ""; // build:page-dictionary

// The speculation ruleset, as a content-hashed /a/speculation.<hash8>.json that
// every HTML response names in a `Speculation-Rules` header (lib/security.ts).
// It rode in each document as an inline <script type="speculationrules"> until
// 2026-09-30: about 90 B of q11 on every page plus a CSP hash, for bytes that
// were identical on all of them. As a header it is a few bytes after HPACK and
// the file is fetched once a year. Empty in readable local development, like
// PAGE_DICTIONARY: build.ts derives the file from SPECULATION in
// tools/photos/shell-data.ts and replaces this marker with its URL, so `bun run
// dev` speculates nothing.
export const SPECULATION_RULES: string = ""; // build:speculation-rules

// Every content-hashed file in /a/, keyed by its name with the hash taken out
// ("icons.svg" -> "/a/icons.<hash8>.svg"). lib/not-found.ts reads it to send a
// request for a SUPERSEDED hash to the current one: on 2026-10-01 stale /a/
// URLs were 57% of every 404 this site answered, one crawler asking 1,737 times
// for a sprite two releases old. Empty in readable local development, where
// nothing is hashed; build.ts fills it after the last /a/ file is written.
export const HASHED_ASSETS: Record<string, string> = {}; // build:hashed-assets

// luna.css first: it is render-blocking style, so it outranks the deferred
// nav.js script. Browsers dedupe a preload against the in-document <link
// rel=preload> + the eventual request by URL, so this never double-fetches.
export const SHELL_PRELOAD_LINK =
  `<${SHELL_ASSETS.luna}>; rel="preload"; as="style", ` +
  `<${SHELL_ASSETS.nav}>; rel="preload"; as="script"`;
