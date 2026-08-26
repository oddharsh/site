#!/usr/bin/env bun
// bun run deps:relock [<pr>...] [--all] [--push] [--no-build] [--keep]
//
// Carries a Dependabot bump into bun.lock, because DEPENDABOT CANNOT.
//
// .github/dependabot.yml runs `package-ecosystem: npm` against a bun tree,
// deliberately, and the npm updater writes package.json and has never written a
// bun.lock. So every dependency PR here opens RED at the first CI step:
//
//   error: lockfile had changes, but lockfile is frozen
//
// That is the expected first state of a dependency PR rather than a broken
// branch, and the fix has always been a hand commit. This is that hand commit,
// as one command, with the two steps that are easy to forget done by the same
// code that checks them.
//
// SWITCHING TO `package-ecosystem: bun` IS THE REFLEX AND IT IS STILL A
// DOWNGRADE, re-measured 2026-08-26 rather than inherited from the config
// comment. dependabot-core pins `BUN_VERSION=1.3.14` in bun/Dockerfile and
// declares `BunPackageManager::MAX_SUPPORTED_LOCKFILE_VERSION = 1`; both
// lockfiles here are `"lockfileVersion": 2`, which bun 1.4 made the default.
// Over that ceiling the updater raises DependencyFileNotSupported and opens
// NOTHING, so the trade is red PRs for no PRs. dependabot-core#16026 tracks it,
// still open with zero comments. THE NUMBER TO WATCH IS THE RUBY CONSTANT, not
// the bundled bun version: #15896 moved the two independently, bumping the
// binary while explicitly leaving the ceiling at 1, so a repo watching the
// version would read a closed gate as an open one. When that constant reaches
// 2, this script is deletable.
//
// TWO THINGS BEYOND `bun install`, and both were learned by getting them wrong:
//
//   1. THE PROSE PINS. docs/DEPENDENCIES.md states versions in sentences and a
//      contract test holds them against package.json, so a relocked branch is
//      still red until the prose moves. The rewrite goes through
//      planDocPinRewrites, which shares the READER's pattern; see the argument
//      at that function for why a line-oriented sweep misses a wrapped mention.
//   2. THE REBASE. Two bumps in flight both edit the head of bun.lock, so
//      whichever merges second conflicts. Relocking against a stale base
//      produces a lockfile that installs cleanly on the branch and not on main.
//
// THE GATES ARE THE POINT, not a courtesy. `bun install` exits 0 on a tree the
// build then rejects, and a bump that re-mints a hashed asset costs every
// returning visitor the shell dictionary tier until dictionary-roll catches up.
// So the frozen install is re-run as its own assertion (it is the exact command
// CI failed on) and the ordinary gates follow.
//
// CONTROL: point it at an already-relocked branch. It must report NOTHING to do
// rather than an empty success, which is the difference between this and a
// script that reports a pass because it looked at nothing.
//
// It works in a THROWAWAY WORKTREE and never in the current one, because
// several sessions share this tree and a checkout under one of them is how
// another session's uncommitted work gets lost.

import { spawnSync } from "node:child_process";
import { readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { DOC_ALIASES, SUB_MANIFEST_POLICY, VERSIONLESS, parseCargoDeps, planDocPinRewrites } from "./lib/dependency-docs.ts";

const REPO = path.resolve(import.meta.dirname, "..");

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const PUSH = flag("--push");
const ALL = flag("--all");
const BUILD = !flag("--no-build");
const KEEP = flag("--keep");
const prNums = args.filter((a) => /^\d+$/.test(a));

function run(cmd: string, cmdArgs: string[], cwd = REPO, quiet = false) {
  const r = spawnSync(cmd, cmdArgs, { cwd, encoding: "utf8", stdio: quiet ? "pipe" : ["ignore", "pipe", "pipe"] });
  return { code: r.status ?? 1, out: (r.stdout ?? "").trim(), err: (r.stderr ?? "").trim() };
}

// `gh` is the only door to "is this branch Dependabot's". Asking git would read
// the commit author, which anyone can set.
function gh(ghArgs: string[]) {
  const r = run("gh", ghArgs, REPO, true);
  if (r.code !== 0) throw new Error(`gh ${ghArgs.join(" ")} failed: ${r.err || r.out}`);
  return r.out;
}

type Pr = { number: number; headRefName: string; author: string; files: string[] };

function openDependabotPrs(): Pr[] {
  const raw = JSON.parse(gh(["pr", "list", "--json", "number,headRefName,author", "--limit", "50"]));
  return raw
    .filter((p: any) => (p.author?.login ?? "").startsWith("app/dependabot") || p.author?.login === "dependabot")
    .map((p: any) => ({ number: p.number, headRefName: p.headRefName, author: p.author.login, files: [] }));
}

function prDetail(n: number): Pr {
  const p = JSON.parse(gh(["pr", "view", String(n), "--json", "number,headRefName,author,files"]));
  return {
    number: p.number,
    headRefName: p.headRefName,
    author: p.author?.login ?? "",
    files: (p.files ?? []).map((f: any) => f.path),
  };
}

// A guard rather than a formality: this script PUSHES, so it must refuse to run
// against a branch whose diff is anything but a manifest bump. Dependabot's npm
// updater touches package.json alone; the lock and the doc are what WE add on a
// re-run, so all three are allowed and nothing else is.
const ALLOWED = new Set(["package.json", "bun.lock", "docs/DEPENDENCIES.md"]);
function unexpectedFiles(files: string[]) {
  return files.filter((f) => !ALLOWED.has(f) && !f.endsWith("/package.json") && !f.endsWith("/bun.lock"));
}

async function rewritePins(tree: string) {
  const read = (p: string) => readFile(path.join(tree, p), "utf8");
  const doc = await read("docs/DEPENDENCIES.md");
  const pkg = JSON.parse(await read("package.json"));

  const subManifests = [];
  for (const entry of SUB_MANIFEST_POLICY) {
    let raw: string;
    try {
      raw = await read(entry.manifest);
    } catch {
      continue;
    }
    const pins = entry.kind === "cargo"
      ? parseCargoDeps(raw)
      : (() => { const m = JSON.parse(raw); return { ...m.dependencies, ...m.devDependencies }; })();
    subManifests.push({ ...entry, pins });
  }

  const { updated, edits } = planDocPinRewrites({
    doc,
    pins: { ...pkg.dependencies, ...pkg.devDependencies },
    aliases: DOC_ALIASES,
    versionless: VERSIONLESS,
    subManifests,
  });
  if (edits.length) await writeFile(path.join(tree, "docs/DEPENDENCIES.md"), updated);
  return edits;
}

async function relock(n: number) {
  const pr = prDetail(n);
  console.log(`\n=== PR #${pr.number}  ${pr.headRefName}`);

  if (!pr.author.startsWith("app/dependabot") && pr.author !== "dependabot") {
    console.log(`  refusing: author is ${pr.author || "(unknown)"}, not dependabot`);
    return false;
  }
  const odd = unexpectedFiles(pr.files);
  if (odd.length) {
    console.log(`  refusing: diff touches more than manifests -> ${odd.join(", ")}`);
    return false;
  }

  const tree = path.join(REPO, ".git", "relock-worktrees", `pr-${n}`);
  await rm(tree, { recursive: true, force: true });
  run("git", ["worktree", "prune"]);
  run("git", ["fetch", "--prune", "origin"]);

  let ok = false;
  try {
    const add = run("git", ["worktree", "add", "--detach", tree, `origin/${pr.headRefName}`]);
    if (add.code !== 0) { console.log(`  worktree failed: ${add.err}`); return false; }

    // Rebase FIRST. Installing against a stale base produces a lockfile that
    // is correct on this branch and wrong the moment it lands.
    const rebase = run("git", ["rebase", "origin/main"], tree);
    if (rebase.code !== 0) {
      run("git", ["rebase", "--abort"], tree);
      console.log("  refusing: rebase onto origin/main conflicts; resolve by hand");
      return false;
    }

    const install = run("bun", ["install"], tree);
    if (install.code !== 0) { console.log(`  bun install failed:\n${install.err || install.out}`); return false; }

    const edits = await rewritePins(tree);
    for (const e of edits) console.log(`  prose: ${e.prose} ${e.from} -> ${e.to}`);

    const dirty = run("git", ["status", "--porcelain"], tree).out;
    const behind = run("git", ["rev-list", "--count", "origin/main..HEAD"], tree).out;
    if (!dirty && behind === run("git", ["rev-list", "--count", `origin/main..origin/${pr.headRefName}`], tree).out) {
      console.log("  nothing to do: lockfile and prose already agree with package.json");
      ok = true;
      return true;
    }
    console.log(`  changed: ${dirty.split("\n").filter(Boolean).map((l) => l.slice(3)).join(", ") || "(rebase only)"}`);

    // The frozen install is re-run as its own gate because it is the EXACT
    // command CI died on. A plain `bun install` succeeding does not prove it.
    const gates: [string, string[]][] = [
      ["bun install --frozen-lockfile", ["install", "--frozen-lockfile"]],
      ["lint", ["run", "lint"]],
      ["typecheck", ["run", "typecheck"]],
      ["test", ["run", "test"]],
      ["test:node", ["run", "test:node"]],
      ...(BUILD ? [["build", ["run", "build"]] as [string, string[]]] : []),
    ];
    for (const [label, gateArgs] of gates) {
      const g = run("bun", gateArgs, tree);
      console.log(`  ${g.code === 0 ? "ok  " : "FAIL"} ${label}`);
      if (g.code !== 0) {
        console.log((g.out || g.err).split("\n").slice(-25).join("\n"));
        return false;
      }
    }

    if (dirty) {
      run("git", ["add", "bun.lock", "docs/DEPENDENCIES.md"], tree);
      const subject = "chore(deps-dev): relock bun.lock for this bump";
      const body = [
        "Dependabot's npm updater writes package.json and never a bun.lock, so the",
        "PR opens red at `bun install --frozen-lockfile`. This is the hand commit",
        ".github/dependabot.yml describes, applied by `bun run deps:relock`.",
        edits.length ? `\nProse pins moved in docs/DEPENDENCIES.md: ${edits.map((e) => `${e.prose} ${e.from} -> ${e.to}`).join("; ")}.` : "",
        "\nGates on the rebased tree: frozen install, lint, typecheck, contract tests",
        `under bun and node${BUILD ? ", build" : ""}.`,
      ].filter(Boolean).join("\n");
      const c = run("git", ["commit", "-m", subject, "-m", body], tree);
      if (c.code !== 0) { console.log(`  commit failed: ${c.err || c.out}`); return false; }
    }

    if (PUSH) {
      const p = run("git", ["push", "--force-with-lease", "origin", `HEAD:${pr.headRefName}`], tree);
      console.log(p.code === 0 ? "  pushed" : `  push failed: ${p.err}`);
      if (p.code !== 0) return false;
      // A force-push restarts CI, so any check currently green belongs to the
      // OLD sha. Say so: reading a stale pass is how a branch gets merged on
      // evidence from a tree that no longer exists.
      console.log(`  NOTE: CI restarts on the new head; ignore checks from the previous sha`);
    } else {
      console.log(`  not pushed (pass --push). Branch is ready in ${tree}`);
    }
    ok = true;
    return true;
  } finally {
    if (!KEEP && ok && PUSH) {
      await rm(tree, { recursive: true, force: true });
      run("git", ["worktree", "prune"]);
    }
  }
}

const targets = ALL ? openDependabotPrs().map((p) => p.number) : prNums.map(Number);
if (!targets.length) {
  const open = openDependabotPrs();
  console.log(open.length
    ? `open dependabot PRs: ${open.map((p) => `#${p.number}`).join(", ")}\nrelock with: bun run deps:relock ${open.map((p) => p.number).join(" ")} --push`
    : "no open dependabot PRs");
  process.exit(0);
}

let failed = 0;
for (const n of targets) {
  try {
    if (!await relock(n)) failed++;
  } catch (err) {
    console.log(`  #${n} errored: ${(err as Error).message}`);
    failed++;
  }
}
console.log(`\n${targets.length - failed}/${targets.length} relocked`);
process.exit(failed ? 1 : 0);
