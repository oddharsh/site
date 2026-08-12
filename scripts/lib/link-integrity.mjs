// link-integrity.mjs — does every internal reference in the staged pages point at
// something this site actually serves?
//
// The gap this fills: moving or renaming a page changed the pages that LINK to it
// into 404s, and nothing noticed. `routes:check` sweeps the routes it is told
// about, which is the forward direction; build invariant #1 asserts the Worker's
// routes are mirrored into run_worker_first. Neither reads a page body, so a stale
// href survived every gate in the repo.
//
// Nothing here is a second copy of the route table. The inputs are exactly what
// build.mjs already extracts for invariant #1 (the ROUTES keys, run_worker_first's
// globs), plus the surface registry and the staged tree itself, so a route added
// anywhere is understood here without a matching edit.
//
// ── the one subtlety worth reading ────────────────────────────────────────────
// `run_worker_first` cannot be used as the resolver on its own. It answers "does
// the Worker SEE this request", not "does this path SERVE a page", and it holds
// `/garage/*` and `/lwe/*` — the two namespaces holding most of the site's pages.
// Treating a glob match as proof made every dangling link in those sections
// invisible, which was measured on a deliberately broken ref before this shipped.
//
// So a namespace that already holds registered surfaces is GOVERNED by the
// registry: a path in it must be a registered surface or a real file, and a glob
// buys it nothing. Namespaces with no registered surfaces (`/i/`, `/images/full/`,
// `/ad/`) are dynamic, and there the glob is the only answer available. The
// governed set is DERIVED from the manifest rather than listed, so adding a
// section governs it automatically.

/** Turn a run_worker_first entry into a matcher. */
const globRe = (g) => new RegExp("^" + g.replace(/[\\.+?^${}()|[\]]/g, "\\$&").replace(/\*/g, ".*") + "$");

/**
 * @param {object} o
 * @param {Set<string>} o.files      served paths in the staged tree, each leading "/"
 * @param {Set<string>} o.routeKeys  exact paths from the Worker's ROUTES map
 * @param {string[]} o.allow         run_worker_first entries (negations already dropped)
 * @param {Set<string>} o.surfaces   registered surface paths from site-manifest.json
 */
export function makeResolver({ files, routeKeys, allow, surfaces }) {
  const globs = allow.filter((a) => a.includes("*")).map(globRe);
  const exact = new Set(allow.filter((a) => !a.includes("*")));
  const workerOwned = (p) => exact.has(p) || globs.some((re) => re.test(p));

  const governed = new Set();
  for (const p of surfaces) {
    const parent = p.slice(0, p.lastIndexOf("/"));
    if (parent) governed.add(parent);
  }

  return function resolves(path) {
    const bare = path.length > 1 ? path.replace(/\/$/, "") : path;
    if (files.has(path) || files.has(bare)) return true;
    if (files.has(bare + ".html") || files.has(bare + "/index.html")) return true;
    if (routeKeys.has(bare) || surfaces.has(bare)) return true;
    const parent = bare.slice(0, bare.lastIndexOf("/"));
    if (governed.has(parent)) return false;
    return workerOwned(bare);
  };
}

/**
 * Every same-origin reference in one document.
 *
 * Attribute-quote-aware on purpose. minify-html UNQUOTES attributes it can, so the
 * served bytes carry `href=/coffee` far more often than `href="/coffee"`, and a
 * scanner written against the quoted form reads 33 refs where there are 2645. That
 * is the third naive scanner this repo's minified output has caught; see the
 * `<script` note in CLAUDE.md's whole-site HTML pass.
 */
export function internalRefs(html) {
  const out = [];
  for (const m of html.matchAll(/(?:href|src)=(?:"([^"]*)"|'([^']*)'|([^\s">]+))/g)) {
    const raw = m[1] ?? m[2] ?? m[3];
    if (!raw || !raw.startsWith("/") || raw.startsWith("//")) continue;
    const path = raw.split("#")[0].split("?")[0];
    if (path) out.push(path);
  }
  return out;
}
