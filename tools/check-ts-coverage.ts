#!/usr/bin/env node
// check-ts-coverage.ts — every JavaScript and TypeScript file this repository
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
// IT ASKS TWO QUESTIONS, never "which program". Is this file REACHABLE by some
// program, and is it NAMED by that program's include globs. Which program a file
// belongs in is the individual tsconfig headers' argument to make.
//
// THE SECOND TIER EXISTS BECAUSE THE FIRST ONE PASSED THROUGH A REAL BUG. This
// header used to say a file could be covered by a glob or pulled in
// transitively and that "both are real coverage", naming serendipity.ts as the
// transitive case. Both are real coverage FOR TSC and only the first is real
// for tsgolint, which oxlint's type-aware pass runs on. tsgolint walks up from
// each file looking for a config that NAMES it; finding none above
// serendipity/, it built a default program with the DOM lib, so `bun run lint`
// checked 2,546 lines against browser globals from the day type-aware linting
// landed. Measured 2026-09-22 on an unchanged tree: `oxlint --type-aware
// --type-check` reported 308 errors there against tsc's 0, and the plain lint
// reported 0 findings where naming the tree reports 5. Fixed in #882.
//
// So reachable and named are separate properties and the gap between them is
// silent in the worst direction: the symptom is a LINT REPORTING ZERO. Nothing
// else in this repo can see it. `bun run typecheck` is happy because tsc
// resolved the imports, this file's orphan tier was happy for the same reason,
// and the lint is green because it has nothing to say about types it never had.
//
// It holds at ZERO with no exemption list, which is deliberate. Every one of the
// 374 owned files is named today, so an exemption mechanism would only be a
// place to record the next one instead of fixing it. If a file ever genuinely
// cannot be named, that is an argument to make in a tsconfig header, and this
// check should be the thing that forces the argument.
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
import { programFileSets } from "./lib/tsc-scope.ts";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const TSC = join(REPO, "node_modules", "typescript", "bin", "tsc");

// src/dict holds the PREVIOUSLY SHIPPED BYTES of each client asset, so the .js
// files in it are compression dictionary input rather than source: a build
// cannot derive them and a checker has nothing to say about them. tools/fixtures
// is the same standing from the other direction: FROZEN copies of client files
// that a measurement runs over (the minifier parity watch in
// lib/upstream-watches.ts), kept byte-stable on purpose so a recorded constant
// keeps meaning what it meant. Both are directories rather than file lists on
// purpose, and there are no others.
const NOT_SOURCE = ["src/dict/", "tools/fixtures/"];
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

const { covered, named } = programFileSets({
  repo: REPO,
  tsc: TSC,
  configs: configs.map((c) => join(REPO, "config", c)),
});

const orphans = owned.filter((f) => !covered.has(f));
if (orphans.length) {
  console.error(`check-ts-coverage: ${orphans.length} file(s) belong to no tsc program:\n  ${orphans.join("\n  ")}\n` +
    `\nAdd each to the program whose GLOBALS match how it runs — see the headers in config/. ` +
    `A node-runtime file that imports Worker source needs check-test-types.ts's filtering rather than a wider include.`);
  process.exit(1);
}

// The second tier. Every file here is one tsc reaches and no include names, so
// it type-checks correctly and lints against whatever globals tsgolint guesses.
const unnamed = owned.filter((f) => covered.has(f) && !named.has(f));
if (unnamed.length) {
  console.error(`check-ts-coverage: ${unnamed.length} file(s) are reachable but NAMED BY NO INCLUDE GLOB:\n  ${unnamed.join("\n  ")}\n` +
    `\nThese pass the orphan check above, because tsc reaches them through another file's imports. ` +
    `oxlint's type-aware pass does not: tsgolint walks up from each file looking for a config that names it, ` +
    `and builds a default DOM-lib program when it finds none. So the LINT on these files is running against ` +
    `the wrong globals and reporting zero.\n` +
    `\nAdd each to the include of the program that already reaches it. Confirm with ` +
    `\`oxlint --type-aware --type-check\`, whose per-tree counts should match each \`tsc -p\`.`);
  process.exit(1);
}

console.log(`check-ts-coverage: ${owned.length} source files, all held by one of ${configs.length} programs and all named by an include`);
