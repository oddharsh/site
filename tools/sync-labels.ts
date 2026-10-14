#!/usr/bin/env bun
// The write path for the label set declared in config/infra.json under
// `repository.triage`.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const ROOT = new URL("../", import.meta.url).pathname;
const CONFIRM = process.argv.includes("--confirm");
const PRUNE = process.argv.includes("--prune");

const infra = JSON.parse(await readFile(join(ROOT, "config/infra.json"), "utf8"));
const repo = infra.repository;
const triage = repo?.triage;
if (!triage) {
  console.error("config/infra.json carries no repository.triage block.");
  process.exit(1);
}
const slug = `${repo.owner}/${repo.name}`;

if (process.env.CI) {
  console.error("refusing to run in CI.");
  console.error("");
  console.error("A token that can rewrite repository metadata has no business in a workflow.");
  console.error("Run this from a workstation; CI's job is to notice the drift, not fix it.");
  process.exit(1);
}

function token() {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  try {
    return execFileSync("gh", ["auth", "token"], { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

const TOKEN = token();
if (CONFIRM && !TOKEN) {
  console.error("no credential: set GITHUB_TOKEN or run `gh auth login`.");
  process.exit(1);
}

async function gh(path: string, init: RequestInit = {}) {
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    "user-agent": "AadharshBot/1.0 (+https://aadhar.sh/bot)",
  };
  if (init.body) headers["content-type"] = "application/json";
  if (TOKEN) headers.authorization = `Bearer ${TOKEN}`;
  const res = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers,
    signal: AbortSignal.timeout(15000),
  });
  if (res.status === 204) return null;
  const body = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status} on ${init.method ?? "GET"} ${path}: ${body.slice(0, 200)}`);
  return body ? JSON.parse(body) : null;
}

async function liveLabels() {
  const out: any[] = [];
  for (let page = 1; ; page++) {
    const batch = await gh(`/repos/${slug}/labels?per_page=100&page=${page}`);
    out.push(...batch);
    if (batch.length < 100) return out;
  }
}

const live = new Map((await liveLabels()).map((l) => [l.name, l]));
const plan: { verb: string; label: any; detail: string }[] = [];

for (const want of triage.labels) {
  const have = live.get(want.name);
  live.delete(want.name);
  if (!have) {
    plan.push({ verb: "create", label: want, detail: `#${want.color}  ${want.description}` });
    continue;
  }
  const diffs: string[] = [];
  if (have.color.toLowerCase() !== want.color.toLowerCase()) diffs.push(`color #${have.color} -> #${want.color}`);
  if ((have.description ?? "") !== want.description) diffs.push(`description "${have.description ?? ""}" -> "${want.description}"`);
  if (diffs.length) plan.push({ verb: "update", label: want, detail: diffs.join(", ") });
}

const strays = [...live.values()];
for (const stray of strays) {
  plan.push({
    verb: PRUNE ? "delete" : "stray",
    label: stray,
    detail: PRUNE ? "removed from every issue and pull request carrying it" : "undeclared (pass --prune to delete)",
  });
}

if (!plan.length) {
  console.log(`${slug}: ${triage.labels.length} declared label(s) match, no strays.`);
  process.exit(0);
}

for (const step of plan) {
  console.log(`${step.verb.padEnd(6)} ${JSON.stringify(step.label.name).padEnd(22)} ${step.detail}`);
}

const writes = plan.filter((s) => s.verb !== "stray");
if (!CONFIRM) {
  console.log("");
  console.log(`${writes.length} change(s) pending. Re-run with --confirm to apply.`);
  process.exit(0);
}

let applied = 0;
for (const step of writes) {
  const { name, color, description } = step.label;
  try {
    if (step.verb === "create") {
      await gh(`/repos/${slug}/labels`, { method: "POST", body: JSON.stringify({ name, color, description }) });
    } else if (step.verb === "update") {
      await gh(`/repos/${slug}/labels/${encodeURIComponent(name)}`, {
        method: "PATCH",
        body: JSON.stringify({ new_name: name, color, description }),
      });
    } else {
      await gh(`/repos/${slug}/labels/${encodeURIComponent(name)}`, { method: "DELETE" });
    }
    applied++;
  } catch (e) {
    console.error(`  ${step.verb} ${name} FAILED: ${(e as Error).message}`);
  }
}

console.log("");
console.log(`${applied}/${writes.length} change(s) applied. Run \`bun run infra:check\` to confirm.`);
process.exit(applied === writes.length ? 0 : 1);
