// Drains what merge-driver.ts parked, and it exists because the driver CANNOT
// finish its own job.
//
// A derived file is a function of other files. Git hands paths to the driver one
// at a time, and `bun.lock` sorts before `package.json`, so at the moment the
// lockfile's conflict is resolved the package.json it describes may still be
// unresolved. Regenerating there would lock against inputs nobody kept. The
// driver therefore parks a defined side and writes the path to
// $GIT_DIR/site-merge-pending; this runs once the working tree is settled.
//
// WHICH HOOK CAN CARRY IT IS MEASURED, because the obvious one is wrong:
//
//     conflicted merge, resolved, committed  ->  post-commit      (NOT post-merge)
//     clean merge                            ->  post-merge
//     rebase, clean or continued             ->  post-rewrite
//
// `post-merge` does not run when a merge had conflicts, which is precisely the
// case the driver creates, so a design resting on it alone would regenerate
// nothing on the one path that needs it and say nothing about that. All three
// hooks call this, and it is idempotent, so the overlap costs a file-existence
// test per commit.
//
// It is a BELT, not the only line. A missed regeneration is caught loudly by a
// gate that already exists: CI installs with `--frozen-lockfile`, which fails on
// a bun.lock that disagrees with package.json. Nothing here is the last defence.
//
// TWO THINGS ARE DELIBERATELY NOT AUTOMATIC. config/derivations.lock.json is
// re-recorded by `derive:check --lock`, which VOUCHES for the artifacts it names,
// and a vouch nobody read is the shape gotcha 46 is about. A bun pin resolved to
// the newer of two candidates is owed its gate, since a pin here advances only
// after its gates pass on that candidate. Both are reported and left for a human.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";

const quiet = process.argv.includes("--quiet");
const check = process.argv.includes("--check");

const gitDir = execFileSync("git", ["rev-parse", "--absolute-git-dir"], { encoding: "utf8" }).trim();
const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
const ledger = join(gitDir, "site-merge-pending");

if (!existsSync(ledger)) {
  if (!quiet) console.log("merge-finish: nothing pending.");
  process.exit(0);
}

const rows = readFileSync(ledger, "utf8")
  .split("\n")
  .filter(Boolean)
  .map((line) => {
    const [path, ...rest] = line.split("\t");
    return { path, note: rest.join("\t") };
  });

// Several hooks can fire for one operation, and package.json marks bun.lock on
// every resolve, so collapse before doing any work.
const seen = new Map<string, string>();
for (const row of rows) if (!seen.has(row.path)) seen.set(row.path, row.note);

if (check) {
  console.log(`merge-finish: ${seen.size} path(s) pending regeneration:`);
  for (const [path, note] of seen) console.log(`  ${path}  ->  ${note}`);
  process.exit(seen.size === 0 ? 0 : 1);
}

const manual: string[] = [];
let ran = 0;

for (const [path, note] of seen) {
  if (path.endsWith("bun.lock")) {
    const cwd = path.includes("/") ? join(root, dirname(path)) : root;
    if (!quiet) console.log(`merge-finish: regenerating ${path} with bun install`);
    try {
      execFileSync("bun", ["install"], { cwd, stdio: quiet ? "ignore" : "inherit" });
      execFileSync("git", ["add", "--", path], { cwd: root, stdio: "ignore" });
      ran += 1;
    } catch {
      manual.push(`${path}  ->  ${note}   (bun install failed, run it yourself)`);
    }
    continue;
  }
  manual.push(`${path}  ->  ${note}`);
}

rmSync(ledger, { force: true });

if (manual.length > 0) {
  // Loud on purpose, and on stderr, because the caller is usually a git hook
  // whose output scrolls past the rebase summary.
  process.stderr.write(
    `\nmerge-finish: ${manual.length} resolution(s) still owe you something:\n` +
      manual.map((line) => `  ${line}`).join("\n") +
      "\n\n",
  );
} else if (!quiet && ran > 0) {
  console.log(`merge-finish: regenerated ${ran} file(s) and staged them.`);
}
