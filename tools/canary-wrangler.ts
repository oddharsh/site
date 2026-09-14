#!/usr/bin/env bun
// bun run canary:wrangler [--ref main|<sha>|<pr>] [--json <path>] [--keep]
//
// Wrangler's MAIN, or any commit or pull request of it, run through the three
// gates this repository already holds a wrangler release to: the dry-run
// bundle, the route oracle, and cal's suite on wrangler's own test harness.
//
// WHERE THE BUILD COMES FROM. cloudflare/workers-sdk publishes every commit
// and every PR to pkg.pr.new (their CONTRIBUTING.md, "PR Previews"), so
// `https://pkg.pr.new/cloudflare/workers-sdk/wrangler@<ref>` is a tarball for
// main, for a 7-char sha, or for a PR number. Measured 2026-09-14: all three
// forms answer 200, `bun add` of the URL resolves in about 5s, and the tarball
// carries miniflare pinned to the same commit while `workerd` stays the npm
// release (workerd is a separate repository and is not on pkg.pr.new, so
// this leg cannot exercise a workerd branch; MINIFLARE_WORKERD_PATH can).
//
// WHAT IT BUYS OVER `npm view wrangler latest`. Addressability. A regression
// can be bisected between two shas, a fix in a PR can be run against this
// tree before it merges, and an issue filed upstream carries the `@<sha>` URL
// as its reproduction pointer rather than "the nightly from Tuesday".
//
// WHY A DETACHED WORKTREE. The candidate has to be INSTALLED to be tested: the
// route oracle imports `createTestHarness` from "wrangler" and cal's suite
// boots the same harness, so pointing an env var at another entry file would
// test the bundler and skip the two gates that matter. `bun add` in a
// throwaway checkout of HEAD is the honest install, and a detached worktree in
// the temp directory is the shape gotcha 44 prescribes for exactly this: it
// resolves nothing from this tree's node_modules. It is removed in `finally`.
//
// `@main` FLOATS, and the lockfile it writes records the sha512 of what it
// got, so that URL must never land in a committed package.json: the next
// day's `--frozen-lockfile` would refuse it. This script writes only into the
// worktree it deletes.
//
// THE BUNDLE COMPARISON IS A FINDING RATHER THAN A GATE. A wrangler that
// bundles the same source into different bytes has usually bumped esbuild,
// which is news (the next wrangler pin re-mints the bundle and perf-diff will
// say by how much) and not a failure. So it reports `changed` rather than
// `red`, and the workflow files it once and stays quiet until it changes
// again or goes back to identical.
//
// Exit codes: 0 green, 1 red or changed, 2 the instrument could not run.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { wranglerCommand } from "./lib/wrangler-bin.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

const argv = process.argv.slice(2);
const has = (name: string) => argv.includes(name);
const flag = (name: string): string | null => {
  const i = argv.indexOf(name);
  return i === -1 ? null : argv[i + 1];
};

const ref = flag("--ref") ?? "main";
const jsonPath = flag("--json");
const started = Date.now();

const PKG_PR_NEW = "https://pkg.pr.new/cloudflare/workers-sdk";
const url = `${PKG_PR_NEW}/wrangler@${ref}`;

type Gate = { name: string; ok: boolean; hard: boolean; detail: string; notes?: string[] };
const gates: Gate[] = [];
const print = (g: Gate) => {
  console.log(`${g.ok ? "  ok  " : g.hard ? " FAIL " : " DIFF "} ${g.name} — ${g.detail}`);
  for (const n of g.notes ?? []) console.log(`       ${n}`);
};
const step = (g: Gate) => { gates.push(g); print(g); };

type Subject = { ref: string; url: string; wrangler: string; miniflare: string; workerd: string; pin: string };
type Report = {
  leg: "wrangler";
  verdict: "green" | "changed" | "red" | "instrument";
  subject: Subject;
  signature: string;
  gates: Gate[];
  reason?: string;
  ms: number;
};

const emit = (verdict: Report["verdict"], subject: Subject, reason?: string) => {
  const failing = gates.filter((g) => !g.ok).map((g) => g.name);
  const report: Report = {
    leg: "wrangler",
    verdict,
    subject,
    signature: verdict === "green" ? "green" : `${verdict}:${failing.join("|") || reason || "unknown"}`,
    gates,
    reason,
    ms: Date.now() - started,
  };
  if (jsonPath) writeFileSync(jsonPath, JSON.stringify(report, null, 2) + "\n");
  return report;
};

const run = (cmd: string, args: string[], opts: Record<string, unknown> = {}) =>
  spawnSync(cmd, args, { encoding: "utf8", ...opts });
const tail = (out: { stdout?: string | null; stderr?: string | null }, lines = 4) =>
  `${out.stderr || ""}\n${out.stdout || ""}`.trim().split("\n").slice(-lines);

// Under bun this IS bun, which is the one installer that may write the
// worktree's lockfile: the tree is bun's and a manager that is not bun would
// refuse it (gotcha 29). Under node there is nothing to install with.
if (!process.versions.bun) {
  console.error("canary:wrangler must run under bun: it installs the candidate with the runtime that owns bun.lock");
  process.exit(2);
}
const BUN = process.execPath;
// wrangler runs under node, per command, and never under bun (gotcha 38).
const NODE = "node";

const pin = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).devDependencies?.wrangler ?? "?";
const bare: Subject = { ref, url, wrangler: "", miniflare: "", workerd: "", pin };
console.log(`pinned:    wrangler@${pin}`);
console.log(`candidate: ${url}\n`);

// realpath, because macOS hands mkdtemp a /var path that every canonicalising
// callee reports as /private/var (gotcha 45), and git prints worktree paths
// canonical.
const scratch = realpathSync(mkdtempSync(join(tmpdir(), "canary-wrangler-")));
const wt = join(scratch, "tree");
const pinnedOut = join(scratch, "pinned-bundle");
const candidateOut = join(wt, ".canary-bundle");

const sha256 = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");

let removed = false;
const cleanup = () => {
  if (removed || has("--keep")) return;
  run("git", ["worktree", "remove", "--force", wt], { cwd: ROOT });
  rmSync(scratch, { recursive: true, force: true });
  removed = true;
};

try {
  // ------------------------------------------------------------------------
  // a throwaway checkout of HEAD, installed fresh, with the candidate added
  // ------------------------------------------------------------------------
  const add = run("git", ["worktree", "add", "--detach", wt, "HEAD"], { cwd: ROOT });
  if (add.status !== 0) {
    console.error(`git worktree add failed: ${tail(add).join(" ")}`);
    emit("instrument", bare, "could not create the worktree");
    process.exit(2);
  }

  const install = run(BUN, ["install", "--frozen-lockfile"], { cwd: wt });
  if (install.status !== 0) {
    console.error(`bun install failed in the worktree: ${tail(install).join(" ")}`);
    emit("instrument", bare, "frozen install failed in a clean checkout of HEAD, which is this tree's problem rather than wrangler's");
    process.exit(2);
  }

  const added = run(BUN, ["add", "--dev", url], { cwd: wt });
  if (added.status !== 0) {
    console.error(`bun add ${url} failed: ${tail(added).join(" ")}`);
    emit("instrument", bare, `pkg.pr.new did not serve wrangler@${ref}`);
    process.exit(2);
  }

  const candidatePkg = JSON.parse(readFileSync(join(wt, "node_modules", "wrangler", "package.json"), "utf8"));
  const subject: Subject = {
    ...bare,
    wrangler: String(candidatePkg.version ?? "?"),
    miniflare: String(candidatePkg.dependencies?.miniflare ?? "?").replace(PKG_PR_NEW + "/", ""),
    workerd: String(candidatePkg.dependencies?.workerd ?? "?"),
  };
  console.log(`resolved:  wrangler ${subject.wrangler}, ${subject.miniflare}, workerd ${subject.workerd}\n`);
  const candidateEntry = join(wt, "node_modules", "wrangler", "bin", "wrangler.js");

  // ------------------------------------------------------------------------
  // 1. the dry-run bundle, and whether it moved a byte
  // ------------------------------------------------------------------------
  // Both dry-runs self-build through wrangler.jsonc's build command, so each
  // one stages its own tree with the PINNED bun; only the bundler differs.
  {
    const out = run(NODE, [candidateEntry, "deploy", "--dry-run", "--outdir", candidateOut], { cwd: wt, timeout: 10 * 60_000 });
    const ok = out.status === 0 && existsSync(join(candidateOut, "index.js"));
    step({ name: "deploy --dry-run bundles", ok, hard: true, detail: ok ? `index.js ${statSync(join(candidateOut, "index.js")).size} B` : tail(out).join(" ") });
    if (!ok) {
      emit("red", subject);
      process.exit(1);
    }
  }
  {
    const [cmd, args] = wranglerCommand(["deploy", "--dry-run", "--outdir", pinnedOut]);
    const out = run(cmd, args, { cwd: ROOT, timeout: 10 * 60_000 });
    if (out.status !== 0 || !existsSync(join(pinnedOut, "index.js"))) {
      console.error(`the PINNED dry-run failed: ${tail(out).join(" ")}`);
      emit("instrument", subject, "the pinned wrangler could not bundle this tree, so there is no baseline");
      process.exit(2);
    }
    // index.js alone. The sourcemap embeds paths, and the two trees sit at
    // different absolute paths by construction.
    const a = sha256(join(pinnedOut, "index.js"));
    const b = sha256(join(candidateOut, "index.js"));
    const sizeA = statSync(join(pinnedOut, "index.js")).size;
    const sizeB = statSync(join(candidateOut, "index.js")).size;
    step({
      name: "bundle is byte-identical to the pinned wrangler's",
      ok: a === b,
      hard: false,
      detail: a === b ? `${sizeA} B, sha256 ${a.slice(0, 12)}` : `pinned ${sizeA} B (${a.slice(0, 12)}) vs candidate ${sizeB} B (${b.slice(0, 12)}), ${sizeB - sizeA >= 0 ? "+" : ""}${sizeB - sizeA} B`,
    });
  }

  // ------------------------------------------------------------------------
  // 2. the route oracle, on the candidate's own createTestHarness
  // ------------------------------------------------------------------------
  {
    const out = run(NODE, ["tools/check-routes-harness.ts"], { cwd: wt, timeout: 10 * 60_000 });
    const text = `${out.stdout}\n${out.stderr}`;
    const timedOut = out.signal === "SIGTERM";
    const ok = !timedOut && out.status === 0;
    step({
      name: "route oracle passes on the candidate harness",
      ok,
      hard: true,
      detail: timedOut ? "hung past 10 minutes" : ok ? (text.match(/\d+ (?:routes?|rows?) (?:ok|passed|checked)[^\n]*/)?.[0] ?? "exit 0") : `exit ${out.status}`,
      notes: ok ? [] : text.split("\n").filter((l) => /FAIL|fail|Error/.test(l)).slice(0, 10).map((l) => l.trim()),
    });
  }

  // ------------------------------------------------------------------------
  // 3. cal's suite, which boots that harness under bun
  // ------------------------------------------------------------------------
  {
    const out = run(BUN, ["run", "--filter", "cal-aadhar-sh", "test"], { cwd: wt, timeout: 5 * 60_000 });
    const text = `${out.stdout}\n${out.stderr}`;
    const pass = Number(text.match(/(\d+) pass/)?.[1] ?? 0);
    const fail = Number(text.match(/(\d+) fail/)?.[1] ?? -1);
    const timedOut = out.signal === "SIGTERM";
    step({
      name: "cal suite passes on the candidate harness",
      ok: !timedOut && out.status === 0 && fail === 0 && pass > 0,
      hard: true,
      detail: timedOut ? "hung past 5 minutes" : `${pass} pass, ${fail} fail`,
      notes: text.split("\n").filter((l) => l.includes("(fail)")).slice(0, 10).map((l) => l.trim()),
    });
  }

  const hardFail = gates.some((g) => g.hard && !g.ok);
  const softDiff = gates.some((g) => !g.hard && !g.ok);
  console.log("");
  if (hardFail) {
    emit("red", subject);
    console.log(`canary:wrangler: wrangler@${ref} (${subject.wrangler}) is RED — ${gates.filter((g) => g.hard && !g.ok).map((g) => g.name).join("; ")}`);
    process.exit(1);
  }
  if (softDiff) {
    emit("changed", subject);
    console.log(`canary:wrangler: wrangler@${ref} (${subject.wrangler}) passes every gate and bundles DIFFERENT bytes. The next wrangler pin re-mints the bundle.`);
    process.exit(1);
  }
  emit("green", subject);
  console.log(`canary:wrangler: wrangler@${ref} (${subject.wrangler}) clears every gate and bundles the same bytes.`);
} finally {
  cleanup();
  if (has("--keep")) console.log(`kept ${wt}; remove it with: git worktree remove --force ${wt}`);
}
