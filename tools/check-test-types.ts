#!/usr/bin/env node
// check-test-types.mjs — type-check the host-runtime test suites and report
// only what those programs can legitimately judge.
//
// WHY THESE NEED A WRAPPER. Every suite here imports the Worker it exercises,
// and every one runs on a HOST runtime (bun or node), so its program declares
// the host's globals and the Worker source arrives against the wrong scope.
// Measured 2026-08-23 across the first two: 10 diagnostics, of which 5 were
// that artifact (`cf` does not exist in RequestInit, `RequestInitCfProperties`
// not found, `innerHTML` on Node), every one of them clean in the program whose
// globals match. The other 5 were real and are fixed.
//
// cal/test was the exception until 2026-09-02, and its header used to say so:
// it ran INSIDE workerd through @cloudflare/vitest-pool-workers, its program
// declared Cloudflare's globals, and a plain `tsc -p` was enough. It runs on
// bun against wrangler's createTestHarness now (cal/test/harness.ts), so it
// joined this list on the day the runtime moved, with the same filter and the
// same floor.
//
// This is the piece config/tsconfig.lwe-ask.json's header named as the
// prerequisite for covering the tests at all. The filter itself lives in
// tools/lib/tsc-scope.ts, shared with check-tool-types.mjs.
//
// THE FLOOR IS STRICTER HERE THAN check-tool-types', on purpose. That one counts
// files against a threshold because it holds 124 of them. These hold one apiece,
// where a count is nearly meaningless, so this compares the program against the
// DIRECTORY: every `*.test.mjs` on disk must be in the program it belongs to. A
// suite added next week joins by existing, and a glob that stops matching fails
// by name instead of reporting a clean run over nothing.
//
// UNLIKE check-tool-types THERE IS NO BASELINE. Both suites are at zero, so a
// ratchet would be machinery guarding an empty set. Add one only if a suite
// arrives with a tail too long to fix in the change that adds it.
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { runScopedTsc } from "./lib/tsc-scope.ts";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const TSC = join(REPO, "node_modules", "typescript", "bin", "tsc");

const PROGRAMS = [
  {
    name: "cf-garage",
    config: "config/tsconfig.cf-garage-test.json",
    dir: "cf-garage/test",
    ext: ".test.mjs",
    // Resolves from the root install, so the root `typecheck` runs it.
    root: true,
  },
  {
    name: "cal",
    config: "config/tsconfig.cal-test.json",
    dir: "cal/test",
    // `.js` rather than `.mjs`: cal's package.json is `"type": "module"`, so its
    // tests never needed the extension, and the floor below is what the
    // extension is for. Naming it per program keeps a suite from being
    // silently skipped by a glob written for its neighbour.
    ext: ".test.js",
    root: true,
  },
  {
    name: "lens-reader",
    config: "config/tsconfig.lens-reader-test.json",
    dir: "lens-reader/test",
    ext: ".test.mjs",
    // readability and linkedom live in lens-reader/node_modules, deliberately
    // outside the workspace, so this one runs from lens-reader/package.json's
    // own `typecheck` after the install CI already does for its tests. Selected
    // EXPLICITLY with --only rather than auto-detected: a program that skips
    // itself when a directory is missing is a silent pass, which is the exact
    // failure the floor below exists to prevent.
    root: false,
  },
];

const only = process.argv.includes("--only") ? process.argv[process.argv.indexOf("--only") + 1] : null;
const selected = only ? PROGRAMS.filter((p) => p.name === only) : PROGRAMS.filter((p) => p.root);
if (only && !selected.length) {
  console.error(`check-test-types: no program named "${only}" — have ${PROGRAMS.map((p) => p.name).join(", ")}`);
  process.exit(1);
}

let failed = 0;
for (const program of selected) {
  const owns = [`${program.dir}/`];
  const { mine, foreign, ownedFiles, byFile } = runScopedTsc({
    repo: REPO, tsc: TSC, owns, label: `check-test-types (${program.name})`,
    config: join(REPO, program.config),
  });

  // The floor: program contents against directory contents, both sorted.
  const onDisk = readdirSync(join(REPO, program.dir))
    .filter((f) => f.endsWith(program.ext)).map((f) => `${program.dir}/${f}`).sort();
  const held = [...ownedFiles].sort();
  const missing = onDisk.filter((f) => !held.includes(f));
  if (missing.length) {
    console.error(`check-test-types (${program.name}): the program is missing test files that exist on disk:\n  ${missing.join("\n  ")}`);
    process.exit(1);
  }

  for (const [f, n] of [...byFile].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(3)}  ${f}`);
  console.log(`check-test-types (${program.name}): ${mine.length} error(s) across ${held.length} test file(s)` +
    (foreign ? ` (${foreign} in transitively-imported source, not reported — see the header)` : ""));
  if (mine.length) failed += mine.length;
}

if (failed) {
  console.error(`\ncheck-test-types: FAILED — ${failed} diagnostic(s) in test files. These suites are held at zero; fix them rather than baselining.`);
  process.exit(1);
}
console.log(`check-test-types: ${selected.length} program(s) clean`);
