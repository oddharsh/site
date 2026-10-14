// dev-stage.mjs: compose the served URL root for LOCAL DEV, as a symlink farm.
//
// A symlink farm buys the merge without the copy. wrangler serves through both
// file and directory symlinks, and an edit to a symlink TARGET is picked up
// live — measured 2026-08-19 against wrangler 4.123.0 / workerd 1.20260811.1,
// including wrangler noticing the change and reloading on its own. So the farm
// is built once at `bun run dev` startup and then gets out of the way; there is
// no watcher, no second build path, and no dependency.
import { rm } from "node:fs/promises";
import { linkServedTree, planServedTree, STAGED_ROOTS } from "./lib/served-tree.ts";

export const ASSET_ROOTS = STAGED_ROOTS;

export const FARM = ".dev-assets";

export async function stage() {
  const plan = await planServedTree();
  await rm(FARM, { recursive: true, force: true });
  const { links, dirs } = await linkServedTree(plan, FARM);

  if (links < 20) throw new Error(`dev-stage: only ${links} links staged — the merge found almost nothing, refusing to serve an empty site`);

  return { links, dirs, skipped: plan.skipped };
}

if (import.meta.main) {
  const { links: n, dirs: d, skipped } = await stage();
  console.log(`dev-stage: ${FARM}/ ready — ${n} links across ${d} merged director${d === 1 ? "y" : "ies"} from ${ASSET_ROOTS.join(", ")}`);
  for (const path of skipped) console.warn(`dev-stage: left out ${path} (the build derives it; this copy is a local leftover)`);
}
