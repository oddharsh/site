// twins.js — which request paths have a Markdown twin, so a page can advertise
// its own alternate representation instead of leaving agents to guess.
//
// Same shape as csp-hashes.js and shell-assets.js: COMMITTED with an empty list,
// and build.mjs overwrites the marked line in the staged .build/ copy from the
// twin set it just generated. Keep the `// build:twins` marker — the build
// replaces that whole line.
//
// Empty here on purpose, and the reason is the same one that keeps the CSP map
// empty: twins are BUILD OUTPUT (`.build/public/**/*.md`), so `pnpm run dev`
// serves a tree where none of them exist. A committed list would advertise a
// twin that answers 404 on exactly the surface it claims to describe. Empty
// means no page advertises one in dev, which is true there; build.mjs hard-fails
// if the list it emits collapses.
//
// This is the honesty rule as a build step: a page links to its Markdown only
// where the build actually wrote one.
export const TWIN_PATHS = []; // build:twins

const TWINS = new Set(TWIN_PATHS);

/** The twin URL for a canonical request path, or null when there is none. */
export function twinFor(path) {
  if (!path) return null;
  const canonical = path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
  if (!TWINS.has(canonical)) return null;
  return canonical === "/" ? "/index.md" : `${canonical}.md`;
}
