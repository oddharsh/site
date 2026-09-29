// Wires the committed merge-driver definitions into this clone. Run once:
//
//     bun run setup:merge
//
// WHY THIS STEP EXISTS AND CANNOT BE COMMITTED AWAY. `.gitattributes` says which
// driver a path uses and is committed; the DEFINITION of a driver is executable
// configuration, so git will only read it from .git/config, which is not a
// tracked file. That split is deliberate on git's part (a repository you clone
// must not be able to run a command at you), and it is why every merge-driver
// scheme in existence carries a bootstrap.
//
// The cost here is smaller than it looks: worktrees share one .git/config, so one
// run covers all of them, including the codex ones. Only a fresh clone needs it
// again. It is idempotent.
//
// WHAT IT VERIFIES, AND WHY THAT IS THE POINT. `include.path` naming a file that
// does not exist is SILENTLY IGNORED by git, so a mistyped path leaves a clone
// that reports success and then merges by hand forever. This reads the driver
// back out of the resolved configuration afterwards and fails if it is not
// there, which is the difference between wiring something and believing you did.

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";

const check = process.argv.includes("--check");
const INCLUDE = "../config/gitconfig";
const HOOKS = ".githooks";

function git(args: string[]): string {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}
function gitOrNull(args: string[]): string | null {
  try {
    return git(args);
  } catch {
    return null;
  }
}

const commonDir = git(["rev-parse", "--path-format=absolute", "--git-common-dir"]);
const mainRoot = dirname(commonDir);
const problems: string[] = [];
const did: string[] = [];

// ── preconditions, ALL of them, before anything is written ───────────────────
//
// This used to interleave checking and applying, and the first real run proved
// why that is wrong: it set core.hooksPath, then discovered config/gitconfig was
// missing from the main checkout, then exited 1 having half-configured the
// repository. A setup step that fails is common here (the definitions only
// arrive when the branch carrying them reaches main), so failing must leave the
// clone exactly as it was found.
//
// The include is resolved relative to the config file holding it, which is
// always <main>/.git/config, so the file has to exist THERE rather than in
// whichever worktree is running this.
const gitconfigPath = join(mainRoot, "config", "gitconfig");
if (!existsSync(gitconfigPath)) {
  problems.push(
    `${gitconfigPath} does not exist. include.path resolves against the main checkout's .git/config, ` +
      `so the branch carrying config/gitconfig has to be on main (or checked out at ${mainRoot}) before this can wire anything.`,
  );
}

const existingHooks = gitOrNull(["config", "--get", "core.hooksPath"]);
if (existingHooks && existingHooks !== HOOKS) {
  problems.push(`core.hooksPath is already ${existingHooks}; merge-finish will not run. Resolve by hand.`);
}
// core.hooksPath DISABLES .git/hooks wholesale, so refuse rather than silently
// unhooking something somebody installed.
const live = existsSync(join(commonDir, "hooks"))
  ? readdirSync(join(commonDir, "hooks")).filter((f) => !f.endsWith(".sample"))
  : [];
if (live.length > 0 && existingHooks !== HOOKS) {
  problems.push(`.git/hooks holds ${live.join(", ")}, which core.hooksPath would disable. Move them into ${HOOKS} first.`);
}

if (problems.length > 0) {
  process.stderr.write(
    "setup:merge: NOT wired, and nothing was changed.\n" + problems.map((p) => `  ${p}\n`).join(""),
  );
  process.exit(1);
}
if (check) {
  console.log("setup:merge: preconditions are met.");
  process.exit(0);
}

// ── apply ────────────────────────────────────────────────────────────────────
const already = (gitOrNull(["config", "--local", "--get-all", "include.path"]) ?? "").split("\n");
if (!already.includes(INCLUDE)) {
  git(["config", "--local", "--add", "include.path", INCLUDE]);
  did.push(`added include.path ${INCLUDE} to ${join(commonDir, "config")}`);
}
if (existingHooks !== HOOKS) {
  git(["config", "--local", "core.hooksPath", HOOKS]);
  did.push(`set core.hooksPath to ${HOOKS}`);
}

// ── read it back, because a silent include is the failure this guards ────────
//
// An include.path naming a missing file is IGNORED without a word, so wiring it
// and trusting that is how a clone ends up reporting success and then merging by
// hand forever.
const wanted = ["json", "pin", "regen", "prose"];
const missing = wanted.filter((name) => !gitOrNull(["config", "--get", `merge.${name}.driver`]));
if (missing.length > 0) {
  problems.push(`merge driver(s) ${missing.join(", ")} did not resolve after wiring. The include is not taking effect.`);
}
if (gitOrNull(["config", "--get", "core.hooksPath"]) !== HOOKS) {
  problems.push(`core.hooksPath is not ${HOOKS}; regeneration after a merge will not run.`);
}

for (const line of did) console.log(`setup:merge: ${line}`);
if (problems.length > 0) {
  // Undo what this run added, for the reason above: a half-wired clone is worse
  // than an unwired one, because it looks configured.
  for (const line of did) {
    if (line.startsWith("added include.path")) git(["config", "--local", "--unset", "include.path", INCLUDE]);
    if (line.startsWith("set core.hooksPath")) git(["config", "--local", "--unset", "core.hooksPath"]);
  }
  process.stderr.write("setup:merge: NOT wired; rolled back.\n" + problems.map((p) => `  ${p}\n`).join(""));
  process.exit(1);
}
console.log(
  did.length > 0
    ? "setup:merge: wired. Every worktree of this repository is covered."
    : "setup:merge: already wired.",
);
