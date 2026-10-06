#!/usr/bin/env bun
// typecheck.ts — run bun check on each program the root tsconfig.json references and
// hold every file's error count to config/ts-baseline.json.
//
// The baseline exists because strictNullChecks went on with errors still owed.
// A file's count may only fall: a new error fails, and so does a fix that isn't
// recorded. After fixing errors, run `bun run typecheck -- --update`.
//
// Some programs import code from another tree (tools import Worker source, for
// instance). Only errors in a program's own tree count; the owning program
// reports the rest.
//
// With no arguments it checks every program except lens-reader's, which has its
// own node_modules and runs from lens-reader/package.json with config paths as
// arguments. A full run also checks that every tracked source file belongs to
// some program and is named by one of its include globs, because oxlint's
// type-aware pass only finds files a tsconfig names.
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseJsonc } from "./lib/jsonc.ts";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const BASELINE = join(REPO, "config/ts-baseline.json");

// Which tree's errors each program reports. Explicit scopes also keep a
// partial --update from erasing another program's baseline.
const OWNS: Record<string, string[]> = {
  "config/tsconfig.json": ["src/worker/", "cal/", "serendipity/", "counter/"],
  "config/tsconfig.browser.json": ["src/client/", "public/", "pipelines/"],
  "config/tsconfig.tools.json": ["tools/", "pipelines/"],
  "config/tsconfig.sw.json": ["src/client/sw.js", "src/client/sw-globals.d.ts"],
  "config/tsconfig.lwe-ask.json": ["lwe-ask/"],
  "config/tsconfig.cf-garage.json": ["cf-garage/"],
  "config/tsconfig.cf-garage-test.json": ["cf-garage/test/"],
  "config/tsconfig.cal-test.json": ["cal/test/"],
  "config/tsconfig.lens-reader.json": ["lens-reader/"],
  "config/tsconfig.lens-reader-test.json": ["lens-reader/test/"],
};
const SEPARATE = ["config/tsconfig.lens-reader.json", "config/tsconfig.lens-reader-test.json"];

/** Execute the running Bun's checker; crashes and incomplete checks fail closed. */
function check(root: string, config: string, flags: string[], executable: string) {
  // --all because `bun check` groups identical errors above 50. Piped
  // --no-pretty output listed all 80 of 80 without it (measured 2026-10-06 on
  // bbdc5a519), but the baseline counts lines, so it must not depend on that.
  const result = spawnSync(executable, ["check", "-p", config, "--no-pretty", "--all", ...flags], {
    encoding: "utf8", cwd: root, maxBuffer: 64 << 20,
  });
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  // A Bun that predates the checker reads `check` as a package.json script.
  if (/Script not found "check"/.test(result.stderr ?? "")) {
    throw new Error(`${executable} has no \`bun check\` (gotcha 52); install the pinned Bun with \`bash .github/install-bun.sh ~/.bun/bin\``);
  }
  const diagnostics = (result.stdout ?? "").split("\n").filter((line) => /^.+?\(\d+,\d+\): error TS\d+:/.test(line));
  if (result.error || result.signal || result.status === null ||
      (result.status !== 0 && (result.status !== 1 || diagnostics.length === 0)) ||
      diagnostics.some((line) => /\.json\(\d+,\d+\): error TS\d+:/.test(line)) ||
      /Stopped before type checking|error TS\d+:/.test((result.stdout ?? "").split("\n").filter((line) => !diagnostics.includes(line)).join("\n")) ||
      /Stopped before type checking/.test(result.stderr ?? "")) {
    throw new Error(`bun check could not complete ${config}:\n${result.error?.message ?? output.trim().slice(-1200)}`);
  }
  const files = (result.stdout ?? "").split("\n")
    .filter((line) => line.startsWith(`${root}/`)).map((line) => line.slice(root.length + 1));
  if (files.length === 0) throw new Error(`${config} holds no files; bun check did not read the program:\n${output.trim().slice(-600)}`);
  return { files, diagnostics };
}

export function programFiles(root: string, config: string, named = false, executable = process.execPath) {
  return check(root, config, ["--listFilesOnly", ...(named ? ["--noResolve"] : [])], executable).files;
}

export function checkProgram(root: string, config: string, owns: string[], executable = process.execPath) {
  const { files, diagnostics } = check(root, config, ["--listFiles"], executable);
  const counts: Record<string, number> = {};
  for (const line of diagnostics) {
    const file = /^(.+?)\(\d+,\d+\):/.exec(line)![1];
    if (owns.some((prefix) => file.startsWith(prefix))) counts[file] = (counts[file] ?? 0) + 1;
  }
  return { files, counts };
}

export function baselineProblems(actual: Record<string, number>, declared: Record<string, number>, inScope: (file: string) => boolean) {
  const problems: string[] = [];
  for (const [file, count] of Object.entries(actual)) {
    const was = declared[file];
    if (was === undefined) problems.push(`${file}: ${count} error(s), and the baseline has none for it`);
    else if (count > was) problems.push(`${file}: ${count} error(s), up from ${was}`);
    else if (count < was) problems.push(`${file}: ${count} error(s), down from ${was}; run \`bun run typecheck -- --update\``);
  }
  for (const file of Object.keys(declared)) {
    if (inScope(file) && !(file in actual)) problems.push(`${file}: now clean; run \`bun run typecheck -- --update\``);
  }
  return problems;
}

export function coverageProblems(owned: string[], covered: Set<string>, named: Set<string>) {
  return owned.flatMap((file) => {
    if (!covered.has(file)) return [`${file}: belongs to no bun check program; add it to the include of the program whose globals match how it runs`];
    if (!named.has(file)) return [`${file}: reached only through imports; name it in an include so oxlint's type-aware pass checks it`];
    return [];
  });
}

function main() {
  if (!process.versions.bun) throw new Error("run this checker with bun tools/typecheck.ts");
  const referenced = (parseJsonc(readFileSync(join(REPO, "tsconfig.json"), "utf8")).references as { path: string }[])
    .map((r) => r.path);
  const unknown = referenced.filter((c) => !(c in OWNS));
  if (unknown.length) {
    console.error(`typecheck: tsconfig.json references ${unknown.join(", ")}, which tools/typecheck.ts has no owner for`);
    process.exit(1);
  }

  const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  const update = process.argv.includes("--update");
  const full = args.length === 0;
  const programs = full ? referenced.filter((c) => !SEPARATE.includes(c)) : args;

  const counts = new Map<string, number>();
  const covered = new Set<string>();
  for (const config of programs) {
    const owns = OWNS[config];
    if (!owns) {
      console.error(`typecheck: ${config} is not a program tools/typecheck.ts knows`);
      process.exit(1);
    }
    const result = checkProgram(REPO, config, owns);
    for (const file of result.files) covered.add(file);
    for (const [file, count] of Object.entries(result.counts)) counts.set(file, (counts.get(file) ?? 0) + count);
  }

  const actual = Object.fromEntries([...counts].sort((a, b) => a[0].localeCompare(b[0])));
  const declared: Record<string, number> = JSON.parse(readFileSync(BASELINE, "utf8")).files;
  const inScope = (f: string) => programs.some((c) => OWNS[c].some((prefix) => f.startsWith(prefix)));

  if (update) {
    const kept = Object.fromEntries(Object.entries(declared).filter(([f]) => !inScope(f)));
    const files = Object.fromEntries(Object.entries({ ...kept, ...actual }).sort((a, b) => a[0].localeCompare(b[0])));
    writeFileSync(BASELINE, `${JSON.stringify({ files }, null, 2)}\n`);
    console.log(`typecheck: baseline rewritten, ${counts.size} file(s) with errors in ${programs.length} program(s)`);
    process.exit(0);
  }

  const problems = baselineProblems(actual, declared, inScope);

  if (full) {
    const NOT_SOURCE = ["src/dict/", "tools/fixtures/"];
    const owned = execFileSync("git", ["ls-files"], { encoding: "utf8", cwd: REPO })
      .split("\n")
      .filter((f) => /\.(?:js|mjs|cjs|ts)$/.test(f) && !NOT_SOURCE.some((prefix) => f.startsWith(prefix)));
    for (const config of SEPARATE) {
      for (const file of programFiles(REPO, config)) covered.add(file);
    }
    // Disabling import resolution leaves the files selected directly by the
    // config. Bun owns include/exclude/extends semantics; no second glob parser
    // or TypeScript CLI is needed to distinguish named from imported source.
    const named = new Set(referenced.flatMap((config) => programFiles(REPO, config, true)));
    problems.push(...coverageProblems(owned, covered, named));
  }

  const total = [...counts.values()].reduce((a, b) => a + b, 0);
  console.log(`typecheck: ${programs.length} program(s), ${total} baselined error(s) across ${counts.size} file(s)`);
  if (problems.length) {
    console.error(`\ntypecheck: FAILED against config/ts-baseline.json\n  - ${problems.join("\n  - ")}`);
    process.exit(1);
  }
}

if (import.meta.main) {
  try { main(); } catch (error) {
    console.error(`typecheck: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
