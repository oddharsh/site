#!/usr/bin/env node
// check-worker-types.ts — type-check the site Worker's program against a
// ratchet, so strictNullChecks could be turned on before every diagnostic was
// paid off.
//
// WHY A WRAPPER RATHER THAN `tsc -p config/tsconfig.json`. That program covers
// src/worker, cal/src and serendipity, and it carried 572 strictNullChecks
// diagnostics when the flag went on. 264 were fixed in the change that added
// this; the rest are recorded per file in config/ts-worker-baseline.json and can
// only fall. A bare `tsc -p` would have meant leaving the flag off until all 572
// were done, which protects nothing in the meantime and is how a repo ends up
// with a strictness migration nobody finishes.
//
// NO DIAGNOSTIC FILTERING HERE, unlike check-tool-types.ts. Everything this
// program holds is code the site Worker actually bundles, checked against the
// Cloudflare globals it actually runs on, so there is no foreign tree whose
// diagnostics would be missing declarations rather than findings. `owns` is the
// whole program, and the floor below is what keeps that honest.
//
// The ratchet itself lives in tools/lib/tsc-scope.ts, shared with
// check-tool-types.ts.
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { ratchet, runScopedTsc } from "./lib/tsc-scope.ts";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const TSC = join(REPO, "node_modules", "typescript", "bin", "tsc");

// The three trees config/tsconfig.json holds. cal/src is already clean under the
// flag (its own program declares strictNullChecks outright), so in practice this
// ratchets src/worker and serendipity.
const OWNED = ["src/worker/", "cal/", "serendipity/"];

const { mine, ownedFiles, byFile } = runScopedTsc({
  repo: REPO, tsc: TSC, owns: OWNED, label: "check-worker-types",
  config: join(REPO, "config/tsconfig.json"),
});

// The floor. tsc prints nothing when clean, so an empty diagnostic list is only
// trustworthy if the program actually held files — the failure this repo repeats
// more than any other.
const listed = ownedFiles.filter((f) => f.endsWith(".ts") || f.endsWith(".js")).length;
if (listed < 60) {
  console.error(`check-worker-types: the program holds only ${listed} owned files — it has lost a tree, not the errors`);
  process.exit(1);
}

const BASELINE = join(REPO, "config/ts-worker-baseline.json");
const UPDATE = "bun run typecheck:worker -- --update";
const { rewritten, problems, owed } = ratchet({
  baselinePath: BASELINE, byFile, total: mine.length, updateCommand: UPDATE,
  update: process.argv.includes("--update"),
});

if (rewritten) {
  console.log(`check-worker-types: baseline rewritten — ${mine.length} error(s) across ${byFile.size} files`);
  process.exit(0);
}

for (const [f, n] of [...byFile].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(3)}  ${f}`);
console.log(`check-worker-types: ${mine.length} error(s) across ${byFile.size} of ${listed} Worker files`);

if (problems.length) {
  console.error(`\ncheck-worker-types: FAILED against config/ts-worker-baseline.json\n  - ${problems.join("\n  - ")}`);
  process.exit(1);
}
console.log(`check-worker-types: matches the baseline (${owed} owed)`);
