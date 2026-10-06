#!/usr/bin/env node
// typecheck.ts — run tsc on each program the root tsconfig.json references and
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
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseJsonc } from "./lib/jsonc.ts";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const TSC = join(REPO, "node_modules", "typescript", "bin", "tsc");
const BASELINE = join(REPO, "config/ts-baseline.json");

// Which tree's errors each program reports. "" means everything it holds.
const OWNS: Record<string, string[]> = {
  "config/tsconfig.json": ["src/worker/", "cal/", "serendipity/", "counter/"],
  "config/tsconfig.browser.json": ["src/client/", "public/", "pipelines/"],
  "config/tsconfig.tools.json": ["tools/", "pipelines/"],
  "config/tsconfig.sw.json": [""],
  "config/tsconfig.lwe-ask.json": [""],
  "config/tsconfig.cf-garage.json": [""],
  "config/tsconfig.cf-garage-test.json": ["cf-garage/test/"],
  "config/tsconfig.cal-test.json": ["cal/test/"],
  "config/tsconfig.lens-reader.json": [""],
  "config/tsconfig.lens-reader-test.json": ["lens-reader/test/"],
};
const SEPARATE = ["config/tsconfig.lens-reader.json", "config/tsconfig.lens-reader-test.json"];

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

function tsc(...flags: string[]): string {
  try {
    return execFileSync(process.execPath, [TSC, ...flags], { encoding: "utf8", cwd: REPO, maxBuffer: 64 << 20 });
  } catch (e) {
    const { stdout = "", stderr = "" } = e as { stdout?: string; stderr?: string };
    return `${stdout}\n${stderr}`;
  }
}

const counts = new Map<string, number>();
const covered = new Set<string>();
for (const config of programs) {
  const owns = OWNS[config];
  if (!owns) {
    console.error(`typecheck: ${config} is not a program tools/typecheck.ts knows`);
    process.exit(1);
  }
  const out = tsc("-p", config, "--pretty", "false", "--listFiles");
  let held = 0;
  for (const line of out.split("\n")) {
    if (line.startsWith(`${REPO}/`)) {
      covered.add(line.slice(REPO.length + 1));
      held++;
      continue;
    }
    const match = /^(.+?)\(\d+,\d+\): error TS\d+:/.exec(line);
    if (match && owns.some((prefix) => match[1].startsWith(prefix))) {
      counts.set(match[1], (counts.get(match[1]) ?? 0) + 1);
    } else if (/error TS\d+/.test(line) && !match) {
      console.error(`typecheck: tsc could not run ${config}:\n${out.trim().slice(-600)}`);
      process.exit(1);
    }
  }
  if (held === 0) {
    console.error(`typecheck: ${config} holds no files, so tsc failed to read it:\n${out.trim().slice(-600)}`);
    process.exit(1);
  }
}

const actual = Object.fromEntries([...counts].sort((a, b) => a[0].localeCompare(b[0])));
const declared: Record<string, number> = JSON.parse(readFileSync(BASELINE, "utf8")).files;
// A program owning "" owns every file it checks, not every baseline entry in
// the repository. Partial runs must leave files outside their programs alone.
const inScope = (f: string) => (full || covered.has(f)) && programs.some((c) => OWNS[c].some((prefix) => f.startsWith(prefix)));

if (update) {
  const kept = Object.fromEntries(Object.entries(declared).filter(([f]) => !inScope(f)));
  const files = Object.fromEntries(Object.entries({ ...kept, ...actual }).sort((a, b) => a[0].localeCompare(b[0])));
  writeFileSync(BASELINE, `${JSON.stringify({ files }, null, 2)}\n`);
  console.log(`typecheck: baseline rewritten, ${counts.size} file(s) with errors in ${programs.length} program(s)`);
  process.exit(0);
}

const problems: string[] = [];
for (const [f, n] of Object.entries(actual)) {
  const was = declared[f];
  if (was === undefined) problems.push(`${f}: ${n} error(s), and the baseline has none for it`);
  else if (n > was) problems.push(`${f}: ${n} error(s), up from ${was}`);
  else if (n < was) problems.push(`${f}: ${n} error(s), down from ${was}; run \`bun run typecheck -- --update\``);
}
for (const f of Object.keys(declared)) {
  if (inScope(f) && !(f in actual)) problems.push(`${f}: now clean; run \`bun run typecheck -- --update\``);
}

if (full) {
  const NOT_SOURCE = ["src/dict/", "tools/fixtures/"];
  const owned = execFileSync("git", ["ls-files"], { encoding: "utf8", cwd: REPO })
    .split("\n")
    .filter((f) => /\.(?:js|mjs|cjs|ts)$/.test(f) && !NOT_SOURCE.some((prefix) => f.startsWith(prefix)));
  for (const config of SEPARATE) {
    for (const line of tsc("-p", config, "--listFilesOnly").split("\n")) {
      if (line.startsWith(`${REPO}/`)) covered.add(line.slice(REPO.length + 1));
    }
  }
  const named = new Set<string>();
  for (const config of referenced) {
    const shown = JSON.parse(tsc("-p", config, "--showConfig")) as { files?: string[] };
    for (const file of shown.files ?? []) named.add(relative(REPO, resolve(REPO, dirname(config), file)));
  }
  for (const f of owned) {
    if (!covered.has(f)) problems.push(`${f}: belongs to no tsc program; add it to the include of the program whose globals match how it runs`);
    else if (!named.has(f)) problems.push(`${f}: reached only through imports; name it in an include so oxlint's type-aware pass checks it`);
  }
}

const total = [...counts.values()].reduce((a, b) => a + b, 0);
console.log(`typecheck: ${programs.length} program(s), ${total} baselined error(s) across ${counts.size} file(s)`);
if (problems.length) {
  console.error(`\ntypecheck: FAILED against config/ts-baseline.json\n  - ${problems.join("\n  - ")}`);
  process.exit(1);
}
