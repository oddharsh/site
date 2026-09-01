#!/usr/bin/env node
// check-tool-types.mjs — type-check tools/ and report only what this program can
// legitimately judge.
//
// WHY A WRAPPER RATHER THAN A BARE `tsc -p`. The tools import the Worker, so the
// Worker's modules are pulled into this program transitively and checked against
// BUN globals instead of the Cloudflare ones they actually run on. That produced
// 31 errors in 16 files outside tools/ on the first run, none of them findings:
// the same files pass in tsconfig.json's program, which is the one whose globals
// match their runtime. Reporting them would train everyone to ignore this check.
//
// So diagnostics are filtered to files under tools/. The FLOOR below is what
// keeps that filter honest: a wrapper that reports nothing because it scanned
// nothing looks identical to a clean run, which is this repo's most-repeated
// failure (see the route invariant's own floor in build.ts).
// The run-and-filter half lives in tools/lib/tsc-scope.ts, shared with
// check-test-types.mjs. Two copies of a diagnostic filter that each have to keep
// their own floor honest is the drift this repo names everywhere else.
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { ratchet, runScopedTsc } from "./lib/tsc-scope.ts";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const TSC = join(REPO, "node_modules", "typescript", "bin", "tsc");

// THE TREES THIS PROGRAM JUDGES, which is wider than its name. tools/ is most
// of it; pipelines/ (the page generators) and talks/ (the deck builder) are the
// same kind of program on the same runtime, and they joined tsconfig.tools.json
// on 2026-08-23. Filtering on `tools/` alone after that widening would have put
// their diagnostics in the foreign bucket, so the include would have bought
// coverage on paper and judged nothing.
const OWNED = ["tools/", "pipelines/", "talks/"];

const { mine, foreign, ownedFiles, byFile } = runScopedTsc({
  repo: REPO, tsc: TSC, owns: OWNED, label: "check-tool-types",
  config: join(REPO, "config/tsconfig.tools.json"),
});

// The floor. tsc emits one line per diagnostic and nothing when clean, so an
// empty diagnostic list is only trustworthy if the program actually held files.
const listed = ownedFiles.filter((f) => f.endsWith(".mjs") || f.endsWith(".ts")).length;
if (listed < 50) {
  console.error(`check-tool-types: the program holds only ${listed} owned files — it has lost a directory, not the errors`);
  process.exit(1);
}

// A RATCHET, not a wall — the shared one in tools/lib/tsc-scope.ts, which
// check-worker-types.ts also uses. It was inline here until the Worker program
// needed the same behaviour; two copies of a rule about monotonicity is exactly
// the drift this repo names everywhere else.
const BASELINE = join(REPO, "config/ts-tools-baseline.json");
const { rewritten, problems, owed } = ratchet({
  baselinePath: BASELINE, byFile, total: mine.length,
  updateCommand: "bun run typecheck:tools -- --update",
  update: process.argv.includes("--update"),
});

if (rewritten) {
  console.log(`check-tool-types: baseline rewritten — ${mine.length} error(s) across ${byFile.size} files`);
  process.exit(0);
}

for (const [f, n] of [...byFile].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(3)}  ${f}`);
console.log(`check-tool-types: ${mine.length} error(s) across ${byFile.size} of ${listed} owned files` +
  (foreign ? ` (${foreign} in transitively-imported non-tools files, not reported — see the header)` : ""));

if (problems.length) {
  console.error(`\ncheck-tool-types: FAILED against config/ts-tools-baseline.json\n  - ${problems.join("\n  - ")}`);
  process.exit(1);
}
console.log(`check-tool-types: matches the baseline (${owed} owed)`);
