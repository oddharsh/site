#!/usr/bin/env bun
// check-bun-lint.ts — fail `bun run lint` once, by name, when the running Bun
// has no built-in linter.
//
// The lint script's body ends in `bun lint`, which Bun hands to its built-in
// only when it has one (gotcha 67). A Bun without it reads `bun lint` as the
// package.json script of that name, so the script calls itself: every level
// re-ran gen-runtime-types and appended another `--type-aware`, and the run
// ended in dozens of "exited with code 126" lines naming nothing (measured
// 2026-10-17 on 1.4.4-canary.1+6c1eb067e, which `bun --version` prints as
// plain 1.4.4). typecheck.ts already fails closed the same way for `bun check`.
//
// The probe asks for the linter's help in an empty directory. In the repo,
// every flag but --doctor runs the shadowing script, and on a Bun without the
// linter --doctor runs it as well. Measured 2026-10-17: the pinned canary
// (+9bcbf1ecb) exits 0 printing "Usage: bun lint"; 1.4.3 and +6c1eb067e exit 1
// with `Script not found "lint"`. It probes behavior rather than versions
// because two canaries that both print 1.4.4 differ on whether they carry the
// linter. The probe costs one spawn, 14 to 23ms in those runs.
//
// It probes process.execPath on purpose: the script body runs this as
// `bun tools/check-bun-lint.ts`, so the same PATH lookup picks the Bun that the
// body's `bun lint` will reach.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Ask `executable` whether `bun lint` is its built-in; null means yes, a string says why not. */
export function bunLintProblem(executable = process.execPath): string | null {
  const dir = mkdtempSync(join(tmpdir(), "bun-lint-probe-"));
  try {
    const result = spawnSync(executable, ["lint", "--help"], { cwd: dir, encoding: "utf8", timeout: 30_000 });
    if (result.status === 0 && /Usage: bun lint\b/.test(result.stdout ?? "")) return null;
    const revision = spawnSync(executable, ["--revision"], { encoding: "utf8" }).stdout?.trim() || "unknown revision";
    const said = `${result.stderr ?? ""}${result.stdout ?? ""}`.trim().split("\n")[0] || result.error?.message || `exit ${result.status}`;
    return `${executable} (${revision}) has no built-in \`bun lint\` (gotcha 67), so the lint script would call itself ` +
      `(the probe said: ${said}). Install the pinned Bun with \`bash .github/install-bun.sh ~/.bun/bin\``;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const problem = bunLintProblem();
  if (problem) {
    console.error(`check-bun-lint: ${problem}`);
    process.exitCode = 1;
  }
}
