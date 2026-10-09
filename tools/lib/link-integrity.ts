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
// build.ts already extracts for invariant #1 (the ROUTES keys, run_worker_first's
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

import { claimedByWorker } from "../../src/worker/routes.ts";

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
  const workerOwned = claimedByWorker(allow);

  const governed = new Set();
  for (const p of surfaces) {
    const parent = p.slice(0, p.lastIndexOf("/"));
    if (parent) governed.add(parent);
  }

  return function resolves(path) {
    // /cdn-cgi/ is Cloudflare's own namespace on every zone it fronts (the edge
    // answers /cdn-cgi/trace before any Worker or asset runs), so nothing in
    // this tree could ever serve it and nothing here can vouch for it either.
    // /whoareyou links /cdn-cgi/trace, and became the first built page to do so
    // on 2026-09-25; before that it rendered per request and was never scanned.
    if (path.startsWith("/cdn-cgi/")) return true;
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
 * The reason to be rid of the pattern stands: the HTML minifier UNQUOTES every
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

/**
 * The paths this document hands a link-preview crawler as its card image.
 *
 * `internalRefs` above skips these twice over: they live in a `content`
 * attribute, and they are written ABSOLUTE (`https://aadhar.sh/og/x.jpg`),
 * because a crawler resolves them with no page URL in hand. So a card that was
 * never generated, or was renamed, read as fine to every check in the tree.
 * Measured 2026-09-29: five garage pages shipped pointing at cards nobody had
 * made, and three more still named the `.png` cards that #841 had re-encoded
 * to `.jpg` two weeks earlier.
 *
 * Returns the PATH of each same-origin image, whether written absolute on
 * `origin` or root-relative. An off-origin image is not ours to vouch for, and
 * the `og:image:width` family is metadata about the image rather than a URL.
 */
const META_IMAGE_KEYS = new Set([
  "og:image", "og:image:url", "og:image:secure_url", "twitter:image", "twitter:image:src",
]);

export async function metaImageRefs(html: string, origin = "https://aadhar.sh"): Promise<string[]> {
  const out: string[] = [];
  const host = new URL(origin).host;
  await new HTMLRewriter()
    .on("meta", {
      element(el) {
        const key = el.getAttribute("property") || el.getAttribute("name");
        const raw = el.getAttribute("content");
        if (!key || !raw || !META_IMAGE_KEYS.has(key)) return;
        if (raw.startsWith("/") && !raw.startsWith("//")) { out.push(raw.split(/[?#]/)[0]); return; }
        let url: URL;
        try { url = new URL(raw); } catch { return; }
        if (url.host === host) out.push(url.pathname);
      },
    })
    .transform(new Response(html))
    .arrayBuffer();
  return out;
}
