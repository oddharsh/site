#!/usr/bin/env bun
// bun run deps:relock [<pr>...] [--all] [--push] [--no-build] [--no-gates] [--keep]
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
// another session's uncommitted work gets lost. That worktree lives OUTSIDE the
// repository for a second reason, measured rather than assumed; see the note at
// its path.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DocPinEdit } from "./lib/dependency-docs.ts";
import { DOC_ALIASES, SUB_MANIFEST_POLICY, VERSIONLESS, parseCargoDeps, planDocPinRewrites } from "./lib/dependency-docs.ts";

const REPO = path.resolve(import.meta.dirname, "..");

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const PUSH = flag("--push");
const ALL = flag("--all");
const BUILD = !flag("--no-build");
const KEEP = flag("--keep");
// `--no-gates` DROPS THE TOOLCHAIN GATES, and it exists for one caller:
// .github/workflows/dependabot-relock.yml, where skipping them is a SECURITY
// property rather than a shortcut.
//
// lint, typecheck, test and build all EXECUTE the version being bumped, because
// the things being bumped ARE the toolchain (oxlint, wrangler, oxc-minify,
// lightningcss). Running them in the job that holds the push credential puts a
// package published yesterday in the same process tree as a token that can
// write to this repository. On a workstation that trade is right and the gates
// are the point. In Actions it buys nothing, because `validate` re-runs on the
// pushed commit and is the ONLY required check on main, so the bump is gated
// either way — by a job holding no credential.
//
// THE FROZEN INSTALL SURVIVES THE FLAG, deliberately. It is the exact assertion
// this script exists to satisfy, and it is the one gate that executes no
// dependency code: --frozen-lockfile compares the lockfile against the
// manifests and stops. A --no-gates run that skipped it would push a lockfile
// having proven nothing about it.
const GATES = !flag("--no-gates");
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

type Pr = { number: number; headRefName: string; author: string; state: string; files: string[] };

function openDependabotPrs(): Pr[] {
  const raw = JSON.parse(gh(["pr", "list", "--json", "number,headRefName,author", "--limit", "50"]));
  return raw
    .filter((p: any) => (p.author?.login ?? "").startsWith("app/dependabot") || p.author?.login === "dependabot")
    .map((p: any) => ({ number: p.number, headRefName: p.headRefName, author: p.author.login, state: "OPEN", files: [] }));
}

function prDetail(n: number): Pr {
  const p = JSON.parse(gh(["pr", "view", String(n), "--json", "number,headRefName,author,state,files"]));
  return {
    number: p.number,
    headRefName: p.headRefName,
    author: p.author?.login ?? "",
    state: p.state ?? "",
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

async function rewritePins(tree: string): Promise<DocPinEdit[]> {
  const read = (p: string) => readFile(path.join(tree, p), "utf8");
  const doc = await read("docs/DEPENDENCIES.md");
  const pkg = JSON.parse(await read("package.json"));

  const subManifests: { manifest: string; kind: string; aliases: { prose: string; pkg: string }[]; versionless: Map<string, unknown>; pins: Record<string, string> }[] = [];
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

  // A merged or closed PR usually has no branch left, and without this the run
  // dies at `git worktree add` on an "invalid reference" that reads like a
  // broken checkout rather than a PR that is already done. Found by pointing
  // the control at the most recently merged PR.
  if (pr.state !== "OPEN") {
    console.log(`  refusing: PR is ${pr.state || "(unknown)"}, not OPEN`);
    return false;
  }
  if (!pr.author.startsWith("app/dependabot") && pr.author !== "dependabot") {
    console.log(`  refusing: author is ${pr.author || "(unknown)"}, not dependabot`);
    return false;
  }
  const odd = unexpectedFiles(pr.files);
  if (odd.length) {
    console.log(`  refusing: diff touches more than manifests -> ${odd.join(", ")}`);
    return false;
  }

  // OUTSIDE THE REPOSITORY, and that is a correctness property rather than
  // tidiness. Node resolution walks UP, so a worktree nested anywhere under the
  // repo root falls through to the PARENT's node_modules. Measured 2026-08-26 at
  // .git/relock-worktrees/probe: `bun run lint` exited 0 in a worktree holding no
  // node_modules at all, resolving oxlint from the parent checkout, while the
  // same command in a worktree under the system temp dir exits 127. Nested, every
  // gate would run against the versions ALREADY INSTALLED HERE and report on a
  // bump it never loaded — the exact failure this script exists to prevent, in
  // the direction that stays quiet.
  const tree = path.join(tmpdir(), "aadhar-sh-relock", `pr-${n}`);
  // The tripwire for the paragraph above. Relocating this path back under the
  // repo is a one-word edit that breaks nothing visibly, so it fails loudly here
  // rather than reporting green gates on the wrong dependency tree.
  if (tree.startsWith(REPO + path.sep)) {
    throw new Error(`relock worktree ${tree} is inside ${REPO}; node resolution would leak the parent's node_modules`);
  }
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

    // --ignore-scripts completes the isolation argued at GATES. bun already runs
    // dependency lifecycle scripts only for `trustedDependencies` (esbuild,
    // sharp, workerd here), so those three are the last door through which a
    // bumped package could execute beside the token; this shuts it. Resolution
    // does not depend on scripts having run, so the lockfile is byte-identical
    // either way, which is why the flag is safe to make conditional at all.
    const installArgs = GATES ? ["install"] : ["install", "--ignore-scripts"];
    const install = run("bun", installArgs, tree);
    if (install.code !== 0) { console.log(`  bun install failed:\n${install.err || install.out}`); return false; }

    // lens-reader SITS OUTSIDE THE WORKSPACE and keeps its own bun.lock, and
    // .github/dependabot.yml watches it as a SECOND npm block. A root install
    // resolves the root package.json alone, so before this the script relocked
    // nothing on a lens-reader bump, reported success, and left
    // lens-reader/bun.lock stale — the quiet direction of the failure it exists
    // to fix. Conditional on the diff rather than unconditional because the
    // install is ~22 MB of defuddle + linkedom that no root bump can touch.
    if (pr.files.some((f) => f.startsWith("lens-reader/"))) {
      const sub = run("bun", installArgs, path.join(tree, "lens-reader"));
      if (sub.code !== 0) { console.log(`  lens-reader install failed:\n${sub.err || sub.out}`); return false; }
      console.log("  installed in lens-reader/ too");
    }

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
    const frozen = GATES
      ? ["install", "--frozen-lockfile"]
      : ["install", "--frozen-lockfile", "--ignore-scripts"];
    const toolchainGates: [string, string[]][] = [
      ["lint", ["run", "lint"]],
      ["typecheck", ["run", "typecheck"]],
      ["test", ["run", "test"]],
      ["test:node", ["run", "test:node"]],
      ...(BUILD ? [["build", ["run", "build"]] as [string, string[]]] : []),
    ];
    const gates: [string, string[]][] = [
      ["bun install --frozen-lockfile", frozen],
      ...(GATES ? toolchainGates : []),
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
      // Named rather than `git add -A`, because the allowlist above is what makes
      // this script safe to point at a branch it is about to force-push.
      const staged = ["bun.lock", "lens-reader/bun.lock", "docs/DEPENDENCIES.md"]
        .filter((f) => existsSync(path.join(tree, f)));
      run("git", ["add", ...staged], tree);
      const subject = "chore(deps-dev): relock bun.lock for this bump";
      const body = [
        "Dependabot's npm updater writes package.json and never a bun.lock, so the",
        "PR opens red at `bun install --frozen-lockfile`. This is the hand commit",
        ".github/dependabot.yml describes, applied by `bun run deps:relock`.",
        edits.length ? `\nProse pins moved in docs/DEPENDENCIES.md: ${edits.map((e) => `${e.prose} ${e.from} -> ${e.to}`).join("; ")}.` : "",
        GATES
          ? `\nGates on the rebased tree: frozen install, lint, typecheck, contract tests under bun and node${BUILD ? ", build" : ""}.`
          : "\nGate on the rebased tree: frozen install. The toolchain gates are deliberately left to `validate`, which re-runs on this commit and is the required check; see --no-gates in tools/relock-dependabot.ts.",
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
