#!/usr/bin/env bun
// bun run wrangler:pin [--write] [--ref main|<sha>] [--keep]
//
// Keeps the wrangler pin on a COMMIT of cloudflare/workers-sdk main, the way
// bump-bun-pin.ts keeps `packageManager` on a dated bun canary.
//
// THE PIN IS A URL, not a version: `https://pkg.pr.new/cloudflare/workers-sdk/
// wrangler@<sha>`. workers-sdk publishes every commit and PR to pkg.pr.new,
// the sha form is the only one that names bytes which never move (`@main`
// floats, and a floating pin breaks `--frozen-lockfile` the next morning), and
// bun.lock records the tarball's sha512 beside it. Dependabot cannot bump a
// URL, so this is the one updater the pin has, and `check-wrangler` holds the
// URL, the lockfile and the installed version together after every move.
//
// THE GATES ARE THE CANARY LEG'S. canary-wrangler.ts already installs a
// pkg.pr.new ref into a detached worktree and runs the dry-run bundle, the
// route oracle and cal's suite against it, so this spawns that script with
// the resolved sha and reads its JSON. A `changed` verdict (the bundle moved
// while every gate passed) is still proposable, and the PR body says by how
// many bytes; a `red` is not.
//
// WHAT IT NEVER DOES: install a floating ref, move the pin on a red gate, or
// touch anything but package.json and bun.lock. It refuses to run in CI
// without `--write`, and with it the workflow that calls it is the one that
// opens the PR; the pin is never pushed to a protected ref.
//
// RETENTION IS THE OPEN RISK, and it is worth reading before trusting this in
// the release path. pkg.pr.new is a stackblitz-run free service whose README
// states no retention policy. A tarball that vanishes fails `bun install
// --frozen-lockfile` loudly on the next build (the lockfile carries its
// sha512, so nothing can silently substitute), and the repair is one line:
// pin a release number again and relock. Advancing nightly keeps the pinned
// sha days old rather than months, which is the only mitigation available.
//
// Exit codes: 0 nothing to do or pin moved, 1 the candidate failed a gate, 2
// the instrument could not run.

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PKG_PR_NEW = "https://pkg.pr.new/cloudflare/workers-sdk";
const PIN = /^https:\/\/pkg\.pr\.new\/cloudflare\/workers-sdk\/wrangler@([0-9a-f]{7,40})$/;

const argv = process.argv.slice(2);
const has = (name: string) => argv.includes(name);
const flag = (name: string): string | null => {
  const i = argv.indexOf(name);
  return i === -1 ? null : argv[i + 1];
};

if (!process.versions.bun) {
  console.error("wrangler:pin must run under bun: it relocks with the runtime that owns bun.lock");
  process.exit(2);
}

const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const current = String(pkg.devDependencies?.wrangler ?? "");
const currentSha = PIN.exec(current)?.[1] ?? null;
if (!currentSha) {
  console.error(`the wrangler pin is ${JSON.stringify(current)}, which is not a pkg.pr.new commit URL.`);
  console.error("moving from a release to a commit (or back) is a hand edit plus `bun install`; this script only walks the commit channel.");
  process.exit(2);
}
console.log(`pinned:    wrangler@${currentSha}`);

// ---------------------------------------------------------------------------
// 1. resolve the ref to a commit, from the header pkg.pr.new itself sends
// ---------------------------------------------------------------------------
// `x-commit-key: cloudflare:workers-sdk:<sha>` on a HEAD of `@main` is the
// sha that tarball was built from, so the pin names a commit without
// trusting a branch name. A ref that is already a sha is checked the same way.
const ref = flag("--ref") ?? "main";
const head = await fetch(`${PKG_PR_NEW}/wrangler@${ref}`, { method: "HEAD", redirect: "follow" });
const key = head.headers.get("x-commit-key") ?? "";
const full = key.split(":")[2] ?? "";
if (!head.ok || !/^[0-9a-f]{40}$/.test(full)) {
  console.error(`pkg.pr.new answered ${head.status} for wrangler@${ref} with x-commit-key ${JSON.stringify(key)}; cannot resolve a commit`);
  process.exit(2);
}
const target = full.slice(0, 7);
console.log(`candidate: wrangler@${target}  (${ref}, ${full})\n`);

if (target === currentSha || full.startsWith(currentSha)) {
  console.log(`wrangler:pin: nothing to do. ${ref} is ${target} and the pin is already there.`);
  process.exit(0);
}

// ---------------------------------------------------------------------------
// 2. the canary leg's gates, against exactly that commit
// ---------------------------------------------------------------------------
const scratch = mkdtempSync(join(tmpdir(), "wrangler-pin-"));
const reportPath = join(scratch, "report.json");
const run = spawnSync(process.execPath, ["tools/canary-wrangler.ts", "--ref", target, "--json", reportPath], {
  cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 20 * 60_000,
});
process.stdout.write(run.stdout || "");
if (run.status !== 0 && run.status !== 1) {
  process.stderr.write(run.stderr || "");
  console.error(`\nwrangler:pin: the canary leg could not run (exit ${run.status}); nothing decided`);
  rmSync(scratch, { recursive: true, force: true });
  process.exit(2);
}
let report: { verdict: string; gates: { name: string; ok: boolean; hard: boolean; detail: string }[]; subject: Record<string, string> };
try {
  report = JSON.parse(readFileSync(reportPath, "utf8"));
} catch {
  console.error("\nwrangler:pin: the canary leg wrote no report; nothing decided");
  rmSync(scratch, { recursive: true, force: true });
  process.exit(2);
}
rmSync(scratch, { recursive: true, force: true });

if (report.verdict === "red" || report.verdict === "instrument") {
  console.log(`\nwrangler:pin: ${target} is NOT proposable — ${report.gates.filter((g) => !g.ok).map((g) => g.name).join("; ")}`);
  process.exit(1);
}

const bundle = report.gates.find((g) => !g.hard);
console.log(`\nwrangler:pin: ${target} (wrangler ${report.subject.wrangler}, ${report.subject.miniflare}, workerd ${report.subject.workerd}) clears every gate${bundle && !bundle.ok ? `; the bundle CHANGED (${bundle.detail})` : " and bundles the same bytes"}.`);

if (!has("--write")) {
  console.log("Re-run with --write to move the pin and relock.");
  process.exit(0);
}

// ---------------------------------------------------------------------------
// 3. write the pin, and relock with the runtime that owns the lockfile
// ---------------------------------------------------------------------------
// A surgical replace of one line rather than a JSON round trip, for the reason
// lib/bun-pin.ts gives: package.json carries paragraphs in its comment fields.
const url = `${PKG_PR_NEW}/wrangler@${target}`;
const text = readFileSync(join(ROOT, "package.json"), "utf8");
const next = text.replace(`"wrangler": "${current}"`, `"wrangler": "${url}"`);
if (next === text) {
  console.error("could not find the wrangler line to rewrite in package.json");
  process.exit(2);
}
writeFileSync(join(ROOT, "package.json"), next);

const relock = spawnSync(process.execPath, ["install"], { cwd: ROOT, encoding: "utf8" });
if (relock.status !== 0) {
  console.error(`bun install failed after moving the pin: ${(relock.stderr || relock.stdout || "").trim().split("\n").slice(-3).join(" ")}`);
  process.exit(2);
}
const check = spawnSync(process.execPath, ["tools/check-wrangler.ts"], { cwd: ROOT, encoding: "utf8" });
process.stdout.write(check.stdout || "");
if (check.status !== 0) {
  process.stderr.write(check.stderr || "");
  console.error("wrangler:pin: check-wrangler rejects the moved pin; not leaving it in place");
  process.exit(2);
}
console.log(`wrangler:pin: wrote wrangler = ${url} and relocked. Every gate green.`);
