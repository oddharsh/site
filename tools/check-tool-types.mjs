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
// failure (see the route invariant's own floor in build.mjs).
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const TSC = join(REPO, "node_modules", "typescript", "bin", "tsc");

let out = "";
try {
  out = execFileSync(process.execPath, [TSC, "-p", join(REPO, "config/tsconfig.tools.json")], {
    encoding: "utf8", cwd: REPO,
  });
} catch (e) {
  out = `${e.stdout || ""}\n${e.stderr || ""}`;
}

const lines = out.split("\n").filter((l) => /error TS\d+/.test(l));
if (out.includes("error TS5") && !lines.length) {
  console.error(`check-tool-types: tsc could not run the program:\n${out.trim().slice(-600)}`);
  process.exit(1);
}

const mine = lines.filter((l) => l.startsWith("tools/"));
const foreign = lines.length - mine.length;

// The floor. tsc emits one line per diagnostic and nothing when clean, so an
// empty `lines` is only trustworthy if the program actually held files.
const listed = execFileSync(process.execPath, [TSC, "-p", join(REPO, "config/tsconfig.tools.json"), "--listFilesOnly"], { encoding: "utf8", cwd: REPO })
  .split("\n").filter((f) => f.includes("/tools/") && f.endsWith(".mjs")).length;
if (listed < 50) {
  console.error(`check-tool-types: the program holds only ${listed} tools files — it has lost the directory, not the errors`);
  process.exit(1);
}

const byFile = new Map();
for (const l of mine) {
  const f = l.slice(0, l.indexOf("("));
  byFile.set(f, (byFile.get(f) || 0) + 1);
}

// A RATCHET, not a wall. tools/ carries 124 errors today, so a check that simply
// failed on them could never be required, and an unrequired check is decoration
// — this repo has the perf-budget history to prove it. The baseline records what
// is owed per file; the check fails on a NEW file, on a file that got WORSE, and
// on a file that got BETTER without the baseline being updated. That last arm is
// what makes the number monotone rather than a suggestion.
//
// Same mechanism config/ts-migration.json used for the Worker, which reached
// zero and was deleted. This one is expected to go the same way.
const BASELINE = join(REPO, "config/ts-tools-baseline.json");
const declared = JSON.parse(readFileSync(BASELINE, "utf8"));
const actual = Object.fromEntries([...byFile].sort());

if (process.argv.includes("--update")) {
  writeFileSync(BASELINE, `${JSON.stringify({ files: actual, total: mine.length }, null, 2)}\n`);
  console.log(`check-tool-types: baseline rewritten — ${mine.length} error(s) across ${byFile.size} files`);
  process.exit(0);
}

const problems = [];
for (const [f, n] of Object.entries(actual)) {
  const was = declared.files[f];
  if (was === undefined) problems.push(`${f}: ${n} error(s), and this file is not in the baseline`);
  else if (n > was) problems.push(`${f}: ${n} error(s), up from ${was}`);
  else if (n < was) problems.push(`${f}: ${n} error(s), DOWN from ${was} — run \`bun run typecheck:tools -- --update\``);
}
for (const f of Object.keys(declared.files)) {
  if (!(f in actual)) problems.push(`${f}: now clean — run \`bun run typecheck:tools -- --update\` and drop it`);
}

for (const [f, n] of [...byFile].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(3)}  ${f}`);
console.log(`check-tool-types: ${mine.length} error(s) across ${byFile.size} of ${listed} tools files` +
  (foreign ? ` (${foreign} in transitively-imported non-tools files, not reported — see the header)` : ""));

if (problems.length) {
  console.error(`\ncheck-tool-types: FAILED against config/ts-tools-baseline.json\n  - ${problems.join("\n  - ")}`);
  process.exit(1);
}
console.log(`check-tool-types: matches the baseline (${declared.total} owed)`);
