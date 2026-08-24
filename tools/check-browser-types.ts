#!/usr/bin/env node
// check-browser-types.ts — type-check the client islands against a ratchet.
//
// The third and last program to need one, after tools/ and the site Worker. The
// browser program carried 509 strictNullChecks diagnostics when the flag went
// on; 344 were fixed in the change that added this, and the rest are recorded
// per file in config/ts-browser-baseline.json where they can only fall.
//
// WHY THIS TIER IS DIFFERENT, and it is worth knowing before paying any of it
// down. These are CONTENT-HASHED assets: nav.js, lens.js, tooltip.js and the
// rest ship as /a/<name>.<hash8>.js, so a change to the built bytes re-mints the
// URL, every page reference to it, and every per-page compression dictionary
// (gotcha 35). That makes the usual "just fix it" instinct expensive.
//
// It is also why every fix in that change is JSDoc. A JSDoc type is a COMMENT,
// the minifier strips it, and the hash does not move — measured before starting
// and re-measured after every batch, all 44 hashed artifacts identical.
//
// THE SHARP EDGE: a JSDoc line is free, and SPLITTING A DECLARATION to host one
// is not. The first pass at nav.js turned `var a = null, b = null;` into two
// statements so each could take a leading @type, which is a change to the AST
// rather than to comments, and it moved nav.js from 1a220ba8 to 83ac378e — the
// one asset every page loads. An inline cast, `= /** @type {T} */ (null)`, keeps
// the statement intact and costs nothing. Prefer it here, always.
//
// public/garage/pretext.lib.js is in the baseline rather than fixed on purpose:
// it is 47KB of generated Unicode BiDi tables across four lines, so its
// diagnostics are a property of a generator rather than of code anyone edits.
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { ratchet, runScopedTsc } from "./lib/tsc-scope.ts";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const TSC = join(REPO, "node_modules", "typescript", "bin", "tsc");

// The three trees config/tsconfig.browser.json composes into the served root.
const OWNED = ["src/client/", "public/", "pipelines/"];

const { mine, ownedFiles, byFile } = runScopedTsc({
  repo: REPO, tsc: TSC, owns: OWNED, label: "check-browser-types",
  config: join(REPO, "config/tsconfig.browser.json"),
});

// The floor. tsc prints nothing when clean, so an empty diagnostic list is only
// trustworthy if the program actually held files.
const listed = ownedFiles.filter((f) => f.endsWith(".js")).length;
if (listed < 12) {
  console.error(`check-browser-types: the program holds only ${listed} client files — it has lost a tree, not the errors`);
  process.exit(1);
}

const BASELINE = join(REPO, "config/ts-browser-baseline.json");
const { rewritten, problems, owed } = ratchet({
  baselinePath: BASELINE, byFile, total: mine.length,
  updateCommand: "bun run typecheck:browser -- --update",
  update: process.argv.includes("--update"),
});

if (rewritten) {
  console.log(`check-browser-types: baseline rewritten — ${mine.length} error(s) across ${byFile.size} files`);
  process.exit(0);
}

for (const [f, n] of [...byFile].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(3)}  ${f}`);
console.log(`check-browser-types: ${mine.length} error(s) across ${byFile.size} of ${listed} client files`);

if (problems.length) {
  console.error(`\ncheck-browser-types: FAILED against config/ts-browser-baseline.json\n  - ${problems.join("\n  - ")}`);
  process.exit(1);
}
console.log(`check-browser-types: matches the baseline (${owed} owed)`);
