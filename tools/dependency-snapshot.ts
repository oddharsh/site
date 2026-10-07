#!/usr/bin/env bun
// bun run deps:snapshot [--out <snapshot.json>]
//
// Print, or write, the dependency snapshot for both bun lockfiles.
// tools/lib/dependency-snapshot.ts says why GitHub needs it.
// .github/workflows/dependency-snapshot.yml posts it on every push to main that
// moves a lockfile. Read-only, network-free, and installs nothing, so the job
// holding the write token runs no package code.

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { buildSnapshot } from "./lib/dependency-snapshot.ts";
import { parseJsonc } from "./lib/jsonc.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const LOCKFILES = ["bun.lock", "lens-reader/bun.lock"];

const args = process.argv.slice(2);
const outIndex = args.indexOf("--out");
const out = outIndex >= 0 ? args[outIndex + 1] : undefined;

const env = process.env;
const sha = env.GITHUB_SHA ?? execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();
const ref = env.GITHUB_REF ?? `refs/heads/${execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim()}`;

const { snapshot, declined } = buildSnapshot({
  lockfiles: LOCKFILES.map((p) => ({ path: p, parsed: parseJsonc(readFileSync(path.join(ROOT, p), "utf8")) })),
  sha,
  ref,
  runId: env.GITHUB_RUN_ID ?? "local",
  scanned: new Date().toISOString(),
  repoUrl: `${env.GITHUB_SERVER_URL ?? "https://github.com"}/${env.GITHUB_REPOSITORY ?? "oddharsh/site"}`,
});

for (const [p, m] of Object.entries(snapshot.manifests)) {
  const rows = Object.values(m.resolved);
  const direct = rows.filter((r) => r.relationship === "direct").length;
  const runtime = rows.filter((r) => r.scope === "runtime").length;
  console.error(`${p}: ${rows.length} packages (${direct} direct, ${runtime} runtime); left out ${declined[p].length}: ${declined[p].join(", ") || "none"}`);
}

const json = JSON.stringify(snapshot, null, 2);
if (out) writeFileSync(out, `${json}\n`);
else console.log(json);
