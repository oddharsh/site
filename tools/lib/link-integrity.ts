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

export function makeResolver({ files, routeKeys, allow, surfaces }: {
  /** served paths in the staged tree, each leading "/" */
  files: Set<string>;
  /** exact paths from the Worker's ROUTES map */
  routeKeys: Set<string>;
  /** run_worker_first entries (negations already dropped) */
  allow: string[];
  /** registered surface paths from site-manifest.json */
  surfaces: Set<string>;
}) {
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
 * PARSED, not pattern-matched, since 2026-08-20. HTMLRewriter is the same
 * lol-html the Worker runs and it is a bun global, so this costs no dependency.
 *
 * WHAT THE REGEX ACTUALLY COVERED, measured when it was replaced, because it is
 * not what its own comment claimed. It matched `href=` and `src=` — and
 * `data-src=` too, by accident, since `src=` is a SUBSTRING of it. That accident
 * was load-bearing: this site defers photo loading through `data-src`, so 23 real
 * URLs on the homepage were being checked by luck. It never covered `srcset` or
 * `data-srcset` at all, because neither ends in `src=`.
 *
 * So the attributes are named explicitly here, and srcset is split on its
 * descriptors rather than swallowed whole. That is strictly more coverage than
 * the regex had, and all of it is now deliberate.
 *
 * The reason to be rid of the pattern stands: minify-html UNQUOTES every
 * attribute it can, and the first draft written against `href="..."` read 33
 * refs where there were 2645. A parser knows all three quoting forms because it
 * is a parser rather than a description of one.
 *
 * Async because HTMLRewriter streams; the caller awaits per document.
 */
const REF_ATTRS = ["href", "src", "data-src"];
const SET_ATTRS = ["srcset", "data-srcset"];

export async function internalRefs(html) {
  const out = [];
  const take = (raw) => {
    if (!raw || !raw.startsWith("/") || raw.startsWith("//")) return;
    const path = raw.split("#")[0].split("?")[0];
    if (path) out.push(path);
  };
  const handler = {
    element(el) {
      for (const a of REF_ATTRS) take(el.getAttribute(a));
      // `url 200w, url 400w` — the descriptor is not part of the URL.
      for (const a of SET_ATTRS) {
        const v = el.getAttribute(a);
        if (v) for (const part of v.split(",")) take(part.trim().split(/\s+/)[0]);
      }
    },
  };
  await new HTMLRewriter()
    .on("*", handler)
    .transform(new Response(html))
    .arrayBuffer();
  return out;
}
