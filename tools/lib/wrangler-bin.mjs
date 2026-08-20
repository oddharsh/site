// wrangler-bin.mjs — how a tool in this repo spawns wrangler.
//
// The rule is one line: NAME NO PACKAGE MANAGER. Every tool here runs under
// whatever runtime invoked it, and the tree it runs in may be a bun tree or a
// pnpm tree, so a hardcoded `pnpm exec` or `bunx` is wrong half the time.
//
// It was wrong in five tools the day `main` became a bun tree (2026-08-20).
// pnpm reads package.json's `packageManager` and REFUSES on a bun tree with
// "This project is configured to use bun", so every one of those spawns died.
// They had survived the pnpm sweep in gotcha 29 for the reason that gotcha
// itself records: the manager is a QUOTED ARGUMENT, invisible to any search for
// `pnpm exec` as a phrase.
//
// Two of the five failed SILENTLY, which is why this is a module rather than a
// fixed line in each file. perf-snapshot and perf-budget both wrap the spawn in
// a catch and then regex the output for a byte count, so a refusal reads as a
// build that produced no numbers: the wire-size job reported "No change, 0
// files" and the perf budget passed without measuring anything.
//
// It runs wrangler under NODE, and that is not a leftover from the pnpm era.
// WRANGLER DOES NOT SUPPORT BUN, in its own words, measured 2026-08-20 on
// 4.124.0: `bun node_modules/wrangler/bin/wrangler.js check startup` answers
//
//     Wrangler does not support the Bun runtime. Please try this command again
//     using Node.js via `npm` or `pnpm`.
//
// and does no work, while the byte-identical call under node returns a CPU
// profile. So "run it under whatever is running" is wrong in the one direction
// that matters now that the tree is bun.
//
// The refusal is per-command rather than global, which is the trap: `deploy
// --dry-run` under bun returns a correct bundle size, so a spot check passes
// and `check startup` silently stops being measured. Do not conclude from one
// working subcommand that the runtime is supported.
//
// A manager is still never named. bunx and npx FETCH what they cannot resolve
// (gotcha 29), so the one path that publishes production must not be able to
// reach the registry for a wrangler nobody pinned.
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// Resolved from THIS file rather than from cwd, so a tool that runs from a
// subdirectory still finds the pinned wrangler instead of failing on a relative
// path that happened to work from the root.
const REPO = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
export const WRANGLER_ENTRY = join(REPO, "node_modules", "wrangler", "bin", "wrangler.js");

// Under node this is the running binary, which is exact. Under bun there is no
// node to point at, so it falls back to the PATH name; every environment that
// runs these tools has one, because `.node-version` is what CI and the Workers
// Builds image both install from.
const NODE = process.versions.bun ? "node" : process.execPath;

/** [command, argv] for spawning the pinned wrangler under node. */
export function wranglerCommand(args = []) {
  return [NODE, [WRANGLER_ENTRY, ...args]];
}
