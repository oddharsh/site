// dev-stage.ts: compose the served URL root for LOCAL DEV, as a symlink farm.
//
//   bun tools/dev-stage.ts         # (re)build .dev-assets/ only
//
// `bun run dev` (tools/dev.ts) and `bun run dev:remote` both call this first.
//
// WHY THIS EXISTS. The served tree is authored across five directories now
// (public/, src/pages/, src/content/, src/client/, src/styles/) and merged into
// one URL root. Only build.ts used to do that merge, and it merges by COPYING
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
// is built once at `bun run dev` startup. A watcher erases client TypeScript
// edits with the same compiler as the build; the other assets stay symlinked.
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
// It is NOT a second definition of the served tree. The roots, their order, the
// derived paths left out and the one-owner-per-path rule live in
// tools/lib/served-tree.ts, which plans the tree once. build.ts copies that
// plan; this file symlinks the same plan. A sixth root added there reaches
// both, and a path two roots claim is refused there, before either adapter runs.
//
// Dev derives nothing, so the three DERIVED_PATHS are build-only surfaces here,
// the same standing as the generated /lens shell and /run that CLAUDE.md
// records as 404ing under `bun run dev`.
//
// **THE TOOLTIP LOSES ITS EXIF UNDER `bun run dev`, and that is new as of
// 2026-08-29.** Both of its tiers (/images/exif.json and /images/meta/) are
// derived now, so a hover in dev draws the frame and no EXIF lines.
// `photo_recipe`'s byte-match arm degrades the same way, since it reads
// fingerprints.json through ASSETS. Build if you need either.
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { realpathSync, watch } from "node:fs";
import { dirname, resolve } from "node:path";
import { spawn } from "node:child_process";
import { browserJavaScript } from "./lib/browser-source.ts";
import { linkServedTree, planServedTree, STAGED_ROOTS } from "./lib/served-tree.ts";

// Re-exported under the name this file has always used for them.
export const ASSET_ROOTS = STAGED_ROOTS;

export const FARM = ".dev-assets";

// Everything below runs only when this file is INVOKED, never when it is
// imported. A contract test imports ASSET_ROOTS and FARM, and an import that
// staged as a side effect would rm -rf and rebuild the farm under a dev server
// that happens to be running.
export async function stage() {
  // Plan BEFORE removing the old farm: a refused plan (a missing root, a path
  // two roots claim) then leaves the last good farm in place.
  const plan = await planServedTree();
  await rm(FARM, { recursive: true, force: true });
  const { links, dirs } = await linkServedTree(plan, FARM);

  // A farm that collapses to a handful of links serves a site with no pages, and
  // wrangler reports that as 404s rather than as a staging failure. 36 documents
  // author in src/pages today; the floor is deliberately well under that so it
  // catches a collapse without firing on ordinary authoring.
  if (links < 20) throw new Error(`dev-stage: only ${links} links staged — the merge found almost nothing, refusing to serve an empty site`);

  return { links, dirs, skipped: plan.skipped };
}

// Other assets stay live through symlinks. Client TypeScript needs erasure on
// edits too, using the same compiler as both staging adapters.
export function watchClientSources(dest = FARM, cwd = ".") {
  let pending = Promise.resolve();
  return watch(realpathSync(resolve(cwd, "src/client")), { recursive: true }, (_event, filename) => {
    if (!filename || !filename.endsWith(".ts") || filename.endsWith(".d.ts")) return;
    const source = resolve(cwd, "src/client", filename);
    const output = resolve(cwd, dest, filename.replace(/\.ts$/, ".js"));
    pending = pending.then(async () => {
      let text: string;
      try { text = await readFile(source, "utf8"); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        await rm(output, { force: true });
        return;
      }
      const js = browserJavaScript(text, filename);
      await mkdir(dirname(output), { recursive: true });
      await writeFile(output, js);
    }).catch((error) => { console.error(`dev: ${filename}: ${error.message}`); });
  });
}

if (import.meta.main) {
  const { links: n, dirs: d, skipped } = await stage();
  console.log(`dev-stage: ${FARM}/ ready — ${n} links across ${d} merged director${d === 1 ? "y" : "ies"} from ${ASSET_ROOTS.join(", ")}`);
  if (process.argv.includes("--watch")) {
    const command = process.argv.slice(process.argv.indexOf("--") + 1);
    if (!process.argv.includes("--") || command.length === 0) throw new Error("dev-stage --watch -- <command> [args]");
    const watcher = watchClientSources();
    const child = spawn(command[0], command.slice(1), { stdio: "inherit" });
    for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => { watcher.close(); child.kill(signal); });
    child.once("error", (error) => { watcher.close(); console.error(error); process.exitCode = 1; });
    child.once("exit", (code) => { watcher.close(); process.exitCode = code ?? 1; });
  }
  for (const path of skipped) console.warn(`dev-stage: left out ${path} (the build derives it; this copy is a local leftover)`);
}
