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

// ── the driver definitions ───────────────────────────────────────────────────
// include.path is resolved relative to the config file holding it, which is
// always <main>/.git/config, so the relative form survives the repository being
// moved on disk in a way an absolute one would not.
if (!existsSync(join(mainRoot, "config", "gitconfig"))) {
  problems.push(`config/gitconfig is missing from ${mainRoot}; check out a branch that carries it.`);
} else if (!check) {
  const already = (gitOrNull(["config", "--local", "--get-all", "include.path"]) ?? "").split("\n");
  if (!already.includes(INCLUDE)) {
    git(["config", "--local", "--add", "include.path", INCLUDE]);
    did.push(`added include.path ${INCLUDE} to ${join(commonDir, "config")}`);
  }
}

// ── the hooks ────────────────────────────────────────────────────────────────
// core.hooksPath DISABLES .git/hooks wholesale, so refuse rather than silently
// unhook something somebody installed.
const existingHooks = gitOrNull(["config", "--get", "core.hooksPath"]);
if (existingHooks && existingHooks !== HOOKS) {
  problems.push(`core.hooksPath is already ${existingHooks}; merge-finish will not run. Resolve by hand.`);
} else if (!check && existingHooks !== HOOKS) {
  const live = existsSync(join(commonDir, "hooks"))
    ? readdirSync(join(commonDir, "hooks")).filter((f) => !f.endsWith(".sample"))
    : [];
  if (live.length > 0) {
    problems.push(`.git/hooks holds ${live.join(", ")}, which core.hooksPath would disable. Move them into ${HOOKS} first.`);
  } else {
    git(["config", "--local", "core.hooksPath", HOOKS]);
    did.push(`set core.hooksPath to ${HOOKS}`);
  }
}

// ── read it back, because a silent include is the failure this guards ────────
const wanted = ["json", "pin", "regen"];
const missing = wanted.filter((name) => !gitOrNull(["config", "--get", `merge.${name}.driver`]));
if (missing.length > 0) {
  problems.push(`merge driver(s) ${missing.join(", ")} did not resolve after wiring. The include is not taking effect.`);
}
if (gitOrNull(["config", "--get", "core.hooksPath"]) !== HOOKS) {
  problems.push(`core.hooksPath is not ${HOOKS}; regeneration after a merge will not run.`);
}

for (const line of did) console.log(`setup:merge: ${line}`);
if (problems.length > 0) {
  process.stderr.write("setup:merge: NOT wired.\n" + problems.map((p) => `  ${p}\n`).join(""));
  process.exit(1);
}
console.log(
  did.length > 0
    ? "setup:merge: wired. Every worktree of this repository is covered."
    : "setup:merge: already wired.",
);
