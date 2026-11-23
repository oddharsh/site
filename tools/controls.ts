#!/usr/bin/env bun
// Can each guard still fail? Plant the defect it exists to catch and find out.
//
//   bun run controls                 every control in tools/lib/controls.ts
//   bun run controls -- floor fonts  only ids containing "floor" or "fonts"
//   bun run controls -- --list       print the registry and stop
//
// Each control runs in its own copy-on-write clone of this tree (one
// clonefile(2), ~130 ms for the whole worktree on 2026-10-29), so a planted
// conflict marker never lands where another session can commit it. Off macOS
// there is no clonefile, and the runner refuses unless CI=true, where the
// checkout is private. There each pool worker owns one tree, the checkout or
// a copy of it made once (node_modules linked back), and plants in place,
// restoring every touched file after each control.
//
// Before any control, each distinct check runs once on an unplanted clone and
// must pass. A check that is already red proves nothing by going red again.
//
// Verdicts: CAUGHT (red, and it said `expect`), BLIND (passed with the defect
// in place: the thing this exists to find), WRONG REASON (red, but not with
// its own words, so a crash or another guard got there first), STALE (the
// anchor moved; contract-controls-still-apply catches that one in validate).
// Gotcha 90 is why this exists.

import { execFileSync, spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { cloneTree } from "./lib/clone-tree.ts";
import { CONTROLS, plant } from "./lib/controls.ts";
import type { Control } from "./lib/controls.ts";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const args = process.argv.slice(2);
const filters = args.filter((a) => !a.startsWith("--"));
const selected = CONTROLS.filter((c) => !filters.length || filters.some((f) => c.id.includes(f)));

if (args.includes("--list")) {
  for (const c of CONTROLS) console.log(`${c.id.padEnd(36)} ${c.gotcha ? `gotcha ${c.gotcha}`.padEnd(11) : "".padEnd(11)} ${c.plants}`);
  process.exit(0);
}
if (!selected.length) {
  console.error(`controls: no id matches ${filters.join(", ")}; --list prints them`);
  process.exit(2);
}

interface Run {
  code: number | null;
  out: string;
  ms: number;
}

function exec(argv: string[], cwd: string, env: Record<string, string> = {}): Promise<Run> {
  const t0 = performance.now();
  return new Promise((done) => {
    const child = spawn(argv[0], argv.slice(1), { cwd, env: { ...process.env, ...env, FORCE_COLOR: "0", NO_COLOR: "1" } });
    let out = "";
    child.stdout.on("data", (b) => (out += b));
    child.stderr.on("data", (b) => (out += b));
    // a planted defect can make a check hang rather than fail; that is BLIND too
    const timer = setTimeout(() => child.kill("SIGKILL"), 300_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      done({ code, out, ms: performance.now() - t0 });
    });
  });
}

// Git in a clone. The clone's .git file still points at this worktree's gitdir,
// so `git status` there would refresh THIS worktree's index (an opportunistic
// write, and a lock another session can trip on). Each clone gets a private
// gitdir instead: its own HEAD and a copy of the index, sharing objects and refs
// through commondir, the way `git worktree add` lays one out. Until 2026-11-22
// the private index came through GIT_INDEX_FILE, which every process the check
// spawns inherits: a test that runs `git add` in its own temp repo wrote its
// fixtures into the clone's index, and the whole suite read 21 failures in a
// clone before anything was planted.
const gitText = (...args: string[]) => execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim();
const absolute = (p: string) => (isAbsolute(p) ? p : join(ROOT, p));
const realIndex = absolute(gitText("rev-parse", "--git-path", "index"));
const commonDir = absolute(gitText("rev-parse", "--git-common-dir"));
const head = gitText("rev-parse", "HEAD");

const scratch = mkdtempSync(join(tmpdir(), "aadhar-controls-"));
process.on("exit", () => rmSync(scratch, { recursive: true, force: true }));
process.on("SIGINT", () => process.exit(130));

let seq = 0;
async function inClone<T>(fn: (root: string, env: Record<string, string>) => Promise<T>): Promise<T> {
  const dir = join(scratch, `t${seq++}`);
  if (!(await cloneTree(ROOT, dir))) throw new Error("clonefile failed");
  // A main checkout's .git is a directory, which clonefile already copied.
  const gitdir = `${dir}.git`;
  if (statSync(join(dir, ".git")).isFile()) {
    mkdirSync(gitdir);
    writeFileSync(join(gitdir, "commondir"), `${commonDir}\n`);
    writeFileSync(join(gitdir, "HEAD"), `${head}\n`);
    if (existsSync(realIndex)) copyFileSync(realIndex, join(gitdir, "index"));
    writeFileSync(join(dir, ".git"), `gitdir: ${gitdir}\n`);
  }
  try {
    return await fn(dir, { GIT_OPTIONAL_LOCKS: "0" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(gitdir, { recursive: true, force: true });
  }
}

// CI only: plant in a worker's tree, then put every touched file back.
async function inPlace<T>(root: string, c: Control | null, fn: (root: string, env: Record<string, string>) => Promise<T>): Promise<T> {
  const saved = new Map<string, string | null>();
  for (const m of c?.mutations ?? []) {
    const p = join(root, m.file);
    saved.set(p, existsSync(p) ? readFileSync(p, "utf8") : null);
  }
  try {
    return await fn(root, {});
  } finally {
    for (const [p, text] of saved) {
      if (text === null) {
        rmSync(p, { force: true });
        execFileSync("git", ["reset", "-q", "--", p], { cwd: root });
      } else writeFileSync(p, text);
    }
  }
}

const cloning = await (async () => {
  const probe = join(scratch, "probe");
  const ok = await cloneTree(join(ROOT, "config"), probe);
  rmSync(probe, { recursive: true, force: true });
  return ok;
})();
if (!cloning && process.env.CI !== "true") {
  console.error("controls: no clonefile here, and planting defects in a shared tree is how one ends up committed. Run on macOS, or under CI=true.");
  process.exit(2);
}
// Cap concurrency: each build is itself parallel, and four at once already
// saturates a 12-core M3.
const JOBS = cloning ? Math.max(1, Math.min(4, Math.floor(availableParallelism() / 3))) : Math.max(1, Number(process.env.CONTROLS_JOBS ?? 1));

// One tree per worker when planting in place. The copy carries .git, so each
// tree has its own index for the controls that stage files.
const trees = [ROOT];
if (!cloning)
  for (let w = 1; w < JOBS; w++) {
    const dir = join(scratch, `w${w}`);
    execFileSync("rsync", ["-a", "--exclude=/node_modules", "--exclude=/.build", `${ROOT}/`, `${dir}/`]);
    symlinkSync(join(ROOT, "node_modules"), join(dir, "node_modules"));
    trees.push(dir);
  }
const isolate = <T>(c: Control | null, fn: (root: string, env: Record<string, string>) => Promise<T>, w: number) =>
  cloning ? inClone(fn) : inPlace(trees[w], c, fn);

async function pool<T, R>(items: T[], fn: (t: T, w: number) => Promise<R>, jobs = JOBS): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(jobs, items.length) }, async (_, w) => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i], w);
      }
    }),
  );
  return out;
}

const tail = (s: string, n = 12) =>
  s
    .trimEnd()
    .split("\n")
    .slice(-n)
    .map((l) => `      ${l}`)
    .join("\n");
const secs = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
const t0 = performance.now();

// 1. Baselines: every distinct check passes on the unplanted tree.
const checks = [...new Map(selected.map((c) => [c.run.join(" "), c.run])).values()];
// Each baseline may spawn its own parallel build or test workers. Keep these
// measurements free of competing checks: the minifier oracle has a 500 ms VM
// limit, and nav-pipes parity passed validate but failed both loaded CI runs.
const baselines = new Map(await pool(checks, async (argv, w) => [argv.join(" "), await isolate(null, (root, env) => exec(argv, root, env), w)] as const, 1));
let failed = 0;
for (const [cmd, r] of baselines) {
  if (r.code === 0) continue;
  failed++;
  // The last few lines of a test suite omit the assertion that failed.
  console.log(`BASELINE RED  ${cmd} fails before anything is planted (exit ${r.code}), so its controls prove nothing\n${r.out}`);
}

// 2. Controls, each against a check whose baseline passed.
const runnable = selected.filter((c) => baselines.get(c.run.join(" "))?.code === 0);
const results = await pool(runnable, (c, w) =>
  isolate(
    c,
    async (root, env) => {
      const stale = plant(root, c);
      if (stale.length) return { c, verdict: "STALE", detail: stale.join("; "), r: null as Run | null };
      // A created file is untracked. CI sees it committed, so mark it
      // intent-to-add (in the clone's private index) and test what CI tests,
      // unless the control is about the local run before `git add`, which a
      // git census that reads only the index can't see (gotcha 91).
      const created = c.mutations.filter((m) => "create" in m && !m.untracked).map((m) => m.file);
      if (created.length) execFileSync("git", ["add", "-N", "--", ...created], { cwd: root, env: { ...process.env, ...env } });
      const r = await exec(c.run, root, env);
      if (r.code === 0) return { c, verdict: "BLIND", detail: "the check passed with the defect in place", r };
      if (!c.expect.test(r.out)) return { c, verdict: "WRONG REASON", detail: `red (exit ${r.code}) but never printed ${c.expect}`, r };
      return { c, verdict: "CAUGHT", detail: r.out.match(c.expect)![0], r };
    },
    w,
  ),
);

for (const { c, verdict, detail, r } of results) {
  const label = verdict.padEnd(13);
  console.log(`${label} ${c.id}${r ? ` (${secs(r.ms)})` : ""}: ${detail}`);
  if (verdict !== "CAUGHT") {
    failed++;
    console.log(`      plants: ${c.plants}`);
    if (r && verdict === "WRONG REASON") console.log(tail(r.out));
  }
}
const caught = results.filter((x) => x.verdict === "CAUGHT").length;
const gotchas = [...new Set(selected.map((c) => c.gotcha).filter(Boolean))].sort((a, b) => a! - b!);
console.log(
  `controls: ${caught}/${selected.length} caught across ${checks.length} checks in ${secs(performance.now() - t0)} (${cloning ? "clones" : "in place, CI"}, ${JOBS} at a time); gotchas covered: ${gotchas.join(", ") || "none"}`,
);
process.exit(failed ? 1 : 0);
