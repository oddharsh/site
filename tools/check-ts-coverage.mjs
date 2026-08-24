#!/usr/bin/env node
// check-ts-coverage.mjs — every JavaScript and TypeScript file this repository
// owns must belong to some tsc program.
//
// WHY THIS EXISTS. config/tsconfig.browser.json's header records that an
// allowlist "only grows when somebody remembers, so its coverage silently stops
// following the code", and fixed its own include to a glob for that reason. The
// SET OF PROGRAMS is an allowlist one level up, and it failed the same way: the
// three auxiliary Workers reached production for months with no program holding
// them, and when they got one on 2026-08-21 the three test suites, the custom
// oxlint rules, the page generators and the deck builder were still orphaned.
// Nineteen files, roughly 2,900 lines, and nothing anywhere went red.
//
// Every one of those was found by hand, by diffing `git ls-files` against
// `tsc --listFilesOnly`. This is that diff, run on every PR, so the next
// auxiliary Worker or test suite joins a program on the day it is written
// instead of the day somebody thinks to look.
//
// IT ASKS "IS THIS FILE IN SOME PROGRAM", never "which one". A file can be
// covered by an include glob or pulled in transitively — serendipity.ts is 2,546
// lines reached entirely through the site Worker's imports — and both are real
// coverage. Which program a file belongs in is the individual tsconfig headers'
// argument to make.
//
// `--listFilesOnly` rather than a full check, because this is a scope question
// and not a correctness one: the other typecheck steps own correctness, and
// listing is roughly an order of magnitude cheaper. It also means this runs from
// the ROOT even for the two lens-reader programs, whose dependencies live
// outside the workspace: an unresolvable import contributes no files, while the
// files matched by the config's own globs are still listed. Verified by hiding
// lens-reader/node_modules and re-running, 2026-08-23.
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const TSC = join(REPO, "node_modules", "typescript", "bin", "tsc");

// src/dict holds the PREVIOUSLY SHIPPED BYTES of each client asset, so the .js
// files in it are compression dictionary input rather than source: a build
// cannot derive them and a checker has nothing to say about them. This is the
// one exclusion, and it is a directory rather than a file list on purpose.
const NOT_SOURCE = ["src/dict/"];
const SOURCE = /\.(?:js|mjs|cjs|ts)$/;

const owned = execFileSync("git", ["ls-files"], { encoding: "utf8", cwd: REPO })
  .split("\n")
  .filter((f) => SOURCE.test(f) && !NOT_SOURCE.some((prefix) => f.startsWith(prefix)))
  .sort();

// The floor. A broken enumeration reports zero orphans just as convincingly as
// full coverage does, which is the failure this whole file is about.
if (owned.length < 150) {
  console.error(`check-ts-coverage: only ${owned.length} source files found — the enumeration is broken, not the coverage`);
  process.exit(1);
}

const configs = readdirSync(join(REPO, "config"))
  .filter((f) => f.startsWith("tsconfig") && f.endsWith(".json")).sort();
if (configs.length < 5) {
  console.error(`check-ts-coverage: found only ${configs.length} tsconfigs — this is reading the wrong directory`);
  process.exit(1);
}

const covered = new Set();
for (const config of configs) {
  let listing = "";
  try {
    listing = execFileSync(process.execPath, [TSC, "-p", join(REPO, "config", config), "--listFilesOnly"], { encoding: "utf8", cwd: REPO });
  } catch (e) {
    // A program that cannot run contributes nothing, and the orphan report below
    // is what surfaces that. Failing here instead would make this check the
    // reporter for every unrelated tsconfig problem.
    listing = String(e.stdout || "");
  }
  for (const line of listing.split("\n")) {
    if (line.startsWith(`${REPO}/`)) covered.add(line.slice(REPO.length + 1));
  }
}

const orphans = owned.filter((f) => !covered.has(f));
if (orphans.length) {
  console.error(`check-ts-coverage: ${orphans.length} file(s) belong to no tsc program:\n  ${orphans.join("\n  ")}\n` +
    `\nAdd each to the program whose GLOBALS match how it runs — see the headers in config/. ` +
    `A node-runtime file that imports Worker source needs check-test-types.mjs's filtering rather than a wider include.`);
  process.exit(1);
}

console.log(`check-ts-coverage: ${owned.length} source files, all held by one of ${configs.length} programs`);
