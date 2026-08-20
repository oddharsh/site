// dev-stage.mjs: compose the served URL root for LOCAL DEV, as a symlink farm.
//
//   node tools/dev-stage.mjs        # (re)build .dev-assets/, then wrangler dev
//
// WHY THIS EXISTS. The served tree is authored across five directories now
// (public/, src/pages/, src/content/, src/client/, src/styles/) and merged into
// one URL root. Only build.mjs used to do that merge, and it merges by COPYING
// into .build/public and then minifying, hashing and precompressing what it
// copied. Pointing dev at .build/public would therefore have cost the readable
// edit->reload loop this config exists for: a 2.8s rebuild per keystroke, View
// Source showing minified bytes, and `main` forced to .build too (the staged
// shell-assets.ts and csp-hashes.ts maps only agree with the HASHED asset refs
// in built pages, so a readable Worker against a built tree 404s its own shell).
//
// A symlink farm buys the merge without the copy. wrangler serves through both
// file and directory symlinks, and an edit to a symlink TARGET is picked up
// live — measured 2026-08-19 against wrangler 4.123.0 / workerd 1.20260811.1,
// including wrangler noticing the change and reloading on its own. So the farm
// is built once at `bun run dev` startup and then gets out of the way; there is
// no watcher, no second build path, and no dependency.
//
// THE MERGE RULE, and the one thing worth knowing before adding a page:
//   - a directory only ONE root provides becomes a single directory symlink, so
//     files created inside it later are served with no re-stage
//   - a directory SEVERAL roots provide is materialised for real and recursed
//     into, because a symlink can only point at one of them
// Exactly three directories collide today (garage, lwe, pixel-peeper — static
// assets in public/ beside their documents in src/pages/), plus the root. A file
// created directly in one of those four needs a dev restart to appear; anywhere
// deeper is free. That is the whole cost of not copying.
//
// It is NOT a second definition of the served tree. The roots and their order
// are build.mjs step 1's, and a contract test pins the two lists together so a
// sixth root cannot reach production while dev keeps serving five.
import { mkdir, readdir, rm, symlink, stat } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Same roots, same ORDER, as build.mjs step 1: a later root wins a path an
// earlier one also provides, which is what `cp` does there. There are no such
// paths today and the collision report below is what says so out loud.
export const ASSET_ROOTS = ["public", "src/pages", "src/content", "src/client", "src/styles"];

// build.mjs skips this and DERIVES the per-photo meta twins from exif.json +
// histograms.json instead, so copying whatever is on the local disk would make
// the tree depend on pipeline leftovers. Dev derives nothing, so /images/meta/*
// is a build-only surface here — the same standing as the generated /lens shell
// and /run, which CLAUDE.md already records as 404ing under `bun run dev`. The
// tooltip's primary tier is /images/exif.json, which is committed and staged.
const SKIP = new Set(["public/images/meta"]);

export const FARM = ".dev-assets";

// Read a directory as a map of name -> isDirectory, or null when the path is not
// a directory. Returning null rather than throwing is what lets a path that is a
// file in one root and a directory in another be reported as a collision below
// instead of crashing the stage.
async function entries(path) {
  const list = await readdir(path, { withFileTypes: true }).catch(() => null);
  if (!list) return null;
  return new Map(list.map((e) => [e.name, e.isDirectory()]));
}

let links = 0;
let dirs = 0;
const collisions = [];

// Link one path into the farm, relative so `ls -l .dev-assets` names the source
// directory a file actually authors in. That readability is the point: the farm
// is the first thing anyone looks at when dev serves something unexpected.
async function link(farmPath, target) {
  await symlink(relative(dirname(farmPath), target), farmPath);
  links++;
}

// Merge `rel` across every root that provides it. Callers pass the roots that
// still have this path, so recursion narrows rather than re-scanning all five.
async function merge(rel, roots) {
  const farmPath = rel ? `${FARM}/${rel}` : FARM;
  const listings = await Promise.all(roots.map((root) => entries(rel ? `${root}/${rel}` : root)));

  const providers = roots.filter((_, i) => listings[i]);
  if (providers.length === 1) {
    // One root owns this directory outright: point at it whole. Everything
    // created inside it later is served without touching this script again.
    await link(farmPath, resolve(providers[0], rel));
    return;
  }

  await mkdir(farmPath, { recursive: true });
  dirs++;

  // Union of names across the providers, in root order, so a later root's
  // version of a colliding path wins the same way it does under `cp`.
  const owners = new Map();
  for (const [i, listing] of listings.entries()) {
    if (!listing) continue;
    for (const [name, isDir] of listing) {
      const child = rel ? `${rel}/${name}` : name;
      if (SKIP.has(`${roots[i]}/${child}`)) continue;
      if (!owners.has(name)) owners.set(name, []);
      owners.get(name).push({ root: roots[i], isDir });
    }
  }

  for (const [name, claims] of owners) {
    const child = rel ? `${rel}/${name}` : name;
    if (claims.length > 1 && claims.every((c) => c.isDir)) {
      await merge(child, claims.map((c) => c.root));
      continue;
    }
    if (claims.length > 1) {
      // Two roots claiming ONE URL is an authoring mistake rather than a merge
      // to resolve, and it is silent under build.mjs's cp. Name it here.
      collisions.push(`/${child} <- ${claims.map((c) => c.root).join(", ")} (last wins)`);
    }
    const winner = claims[claims.length - 1];
    await link(`${FARM}/${child}`, resolve(winner.root, child));
  }
}

// Everything below runs only when this file is INVOKED, never when it is
// imported. The contract test imports ASSET_ROOTS to pin them against build.mjs
// step 1, and an import that staged as a side effect would rm -rf and rebuild
// the farm under a dev server that happens to be running.
export async function stage() {
  links = 0;
  dirs = 0;
  collisions.length = 0;

  // A root that has been renamed out from under this file is exactly the failure
  // this script was written to repair (assets.directory pointed at `www` for a
  // day after the 2026-08-18 split). Fail by NAME rather than compose a partial
  // tree: a dev server that starts and serves no documents is worse than one
  // that does not start, because the second tells you what is wrong.
  for (const root of ASSET_ROOTS) {
    const ok = await stat(root).then((s) => s.isDirectory()).catch(() => false);
    if (!ok) throw new Error(`dev-stage: asset root "${root}" does not exist — has the served tree been rearranged again? Update ASSET_ROOTS here and build.mjs step 1 together.`);
  }

  await rm(FARM, { recursive: true, force: true });
  await merge("", ASSET_ROOTS);

  // A farm that collapses to a handful of links serves a site with no pages, and
  // wrangler reports that as 404s rather than as a staging failure. 36 documents
  // author in src/pages today; the floor is deliberately well under that so it
  // catches a collapse without firing on ordinary authoring.
  if (links < 20) throw new Error(`dev-stage: only ${links} links staged — the merge found almost nothing, refusing to serve an empty site`);

  for (const c of collisions) console.warn(`dev-stage: WARNING two roots claim ${c}`);
  return { links, dirs, collisions: [...collisions] };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { links: n, dirs: d } = await stage();
  console.log(`dev-stage: ${FARM}/ ready — ${n} links across ${d} merged director${d === 1 ? "y" : "ies"} from ${ASSET_ROOTS.join(", ")}`);
}
