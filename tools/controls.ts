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
// checkout is private and it plants in place and restores after each control.
//
// Before any control, each distinct check runs once on an unplanted clone and
// must pass. A check that is already red proves nothing by going red again.
//
// Verdicts: CAUGHT (red, and it said `expect`), BLIND (passed with the defect
// in place: the thing this exists to find), WRONG REASON (red, but not with
// its own words, so a crash or another guard got there first), STALE (the
// anchor moved; contract-controls-still-apply catches that one in validate).
// Gotcha 89 is why this exists.

import { execFileSync, spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { cloneTree } from "./lib/clone-tree.ts";
import { CONTROLS, type Control, plant } from "./lib/controls.ts";

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
// copy of the index, and optional locks are off.
const realIndex = (() => {
  const p = execFileSync("git", ["rev-parse", "--git-path", "index"], { cwd: ROOT, encoding: "utf8" }).trim();
  return isAbsolute(p) ? p : join(ROOT, p);
})();

const scratch = mkdtempSync(join(tmpdir(), "aadhar-controls-"));
process.on("exit", () => rmSync(scratch, { recursive: true, force: true }));
process.on("SIGINT", () => process.exit(130));

let seq = 0;
async function inClone<T>(fn: (root: string, env: Record<string, string>) => Promise<T>): Promise<T> {
  const dir = join(scratch, `t${seq++}`);
  if (!(await cloneTree(ROOT, dir))) throw new Error("clonefile failed");
  const index = `${dir}.index`;
  if (existsSync(realIndex)) copyFileSync(realIndex, index);
  try {
    return await fn(dir, { GIT_INDEX_FILE: index, GIT_OPTIONAL_LOCKS: "0" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(index, { force: true });
  }
}

// CI only: plant in the checkout itself, then put every touched file back.
async function inPlace<T>(c: Control | null, fn: (root: string, env: Record<string, string>) => Promise<T>): Promise<T> {
  const saved = new Map<string, string | null>();
  for (const m of c?.mutations ?? []) {
    const p = join(ROOT, m.file);
    saved.set(p, existsSync(p) ? readFileSync(p, "utf8") : null);
  }
  try {
    return await fn(ROOT, {});
  } finally {
    for (const [p, text] of saved) {
      if (text === null) {
        rmSync(p, { force: true });
        execFileSync("git", ["reset", "-q", "--", p], { cwd: ROOT });
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
const isolate = <T>(c: Control | null, fn: (root: string, env: Record<string, string>) => Promise<T>) => (cloning ? inClone(fn) : inPlace(c, fn));

// Cap concurrency: each build is itself parallel, and four at once already
// saturates a 12-core M3.
const JOBS = cloning ? Math.max(1, Math.min(4, Math.floor(availableParallelism() / 3))) : 1;
async function pool<T, R>(items: T[], fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(JOBS, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
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
const baselines = new Map(await pool(checks, async (argv) => [argv.join(" "), await isolate(null, (root, env) => exec(argv, root, env))] as const));
let failed = 0;
for (const [cmd, r] of baselines) {
  if (r.code === 0) continue;
  failed++;
  console.log(`BASELINE RED  ${cmd} fails before anything is planted (exit ${r.code}), so its controls prove nothing\n${tail(r.out)}`);
}

// 2. Controls, each against a check whose baseline passed.
const runnable = selected.filter((c) => baselines.get(c.run.join(" "))?.code === 0);
const results = await pool(runnable, (c) =>
  isolate(c, async (root, env) => {
    const stale = plant(root, c);
    if (stale.length) return { c, verdict: "STALE", detail: stale.join("; "), r: null as Run | null };
    // A created file is untracked, and the checks built on git grep or ls-files
    // can't see an untracked file. CI sees it committed, so mark it
    // intent-to-add (in the clone's private index) and test what CI tests.
    const created = c.mutations.filter((m) => "create" in m).map((m) => m.file);
    if (created.length) execFileSync("git", ["add", "-N", "--", ...created], { cwd: root, env: { ...process.env, ...env } });
    const r = await exec(c.run, root, env);
    if (r.code === 0) return { c, verdict: "BLIND", detail: "the check passed with the defect in place", r };
    if (!c.expect.test(r.out)) return { c, verdict: "WRONG REASON", detail: `red (exit ${r.code}) but never printed ${c.expect}`, r };
    return { c, verdict: "CAUGHT", detail: r.out.match(c.expect)![0], r };
  }),
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
  `controls: ${caught}/${selected.length} caught across ${checks.length} checks in ${secs(performance.now() - t0)} (${cloning ? `clones, ${JOBS} at a time` : "in place, CI"}); gotchas covered: ${gotchas.join(", ") || "none"}`,
);
process.exit(failed ? 1 : 0);
