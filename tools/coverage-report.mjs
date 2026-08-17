#!/usr/bin/env bun
// coverage-report.mjs — which modules the contract suite never executes.
//
//   bun run test:coverage              read it here
//   bun run test:coverage --markdown   the shape CI puts in the job summary
//
// IT IS A REPORT AND NEVER A GATE, which is a deliberate copy of how perf-diff
// sits outside `validate`. A coverage floor is one more constant somebody has to
// widen, and this repo already has the receipts for what that does: perf-budget
// spent a whole era in breach while printing "hard checks green" over it. A
// number that blocks a merge trains people to raise the number. This one exists
// to be read, most usefully when deciding what to test next — #444 picked its
// two modules by hand, and this names them.
//
// WHAT IT CANNOT SEE, stated because the raw table is misleading about it: the
// cal Worker is tested by its own Vitest suite inside workerd, so cal/ files
// look uncovered here and are not. They are listed separately rather than
// dropped, since silently hiding a directory is how a report starts lying.
import { spawnSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";

const markdown = process.argv.includes("--markdown");
const SUITE = "tools/contract-tests.test.mjs";
const OUT = "coverage";

rmSync(OUT, { recursive: true, force: true });
const run = spawnSync("bun", ["test", "--coverage", "--coverage-reporter=lcov", SUITE], { encoding: "utf8" });
if (run.status !== 0) {
  console.error(run.stderr?.slice(-2000) ?? "coverage: the suite failed");
  process.exit(run.status ?? 1);
}
const tests = /Ran (\d+) tests/.exec(run.stderr ?? "")?.[1] ?? "?";

const files = [];
for (const record of readFileSync(`${OUT}/lcov.info`, "utf8").split("end_of_record")) {
  const path = /^SF:(.+)$/m.exec(record)?.[1];
  if (!path) continue;
  const da = [...record.matchAll(/^DA:\d+,(\d+)$/gm)];
  if (!da.length) continue;
  files.push({ path, found: da.length, hit: da.filter((m) => m[1] !== "0").length });
}
rmSync(OUT, { recursive: true, force: true });

const pct = (f) => (100 * f.hit) / f.found;
const owned = (f) => f.path.startsWith("cal/");           // the Vitest suite's, not ours
const mine = files.filter((f) => !owned(f));
const total = mine.reduce((a, f) => ({ found: a.found + f.found, hit: a.hit + f.hit }), { found: 0, hit: 0 });
const worst = mine.filter((f) => pct(f) < 60).sort((a, b) => pct(a) - pct(b)).slice(0, 12);

const row = (f) => `${pct(f).toFixed(1).padStart(6)}%  ${f.path}  (${f.hit}/${f.found} lines)`;
if (markdown) {
  console.log(`### Coverage, advisory\n`);
  console.log(`${tests} contract tests execute **${total.hit} of ${total.found} lines (${((100 * total.hit) / total.found).toFixed(1)}%)** across ${mine.length} files.\n`);
  console.log(`Least covered:\n`);
  console.log("| lines | file |\n|--:|---|");
  for (const f of worst) console.log(`| ${pct(f).toFixed(1)}% | \`${f.path}\` |`);
  console.log(`\n${files.length - mine.length} \`cal/\` files are covered by that Worker's own Vitest suite and are not measured here. This report gates nothing.`);
} else {
  console.log(`coverage: ${tests} contract tests execute ${total.hit}/${total.found} lines (${((100 * total.hit) / total.found).toFixed(1)}%) across ${mine.length} files\n`);
  console.log(`  least covered:`);
  for (const f of worst) console.log(`  ${row(f)}`);
  console.log(`\n  ${files.length - mine.length} cal/ files are the Vitest suite's and are not measured here.`);
  console.log(`  advisory: this is a report, never a gate.`);
}
