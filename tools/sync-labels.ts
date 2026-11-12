#!/usr/bin/env bun
// The write path for the label set declared in config/infra.json under
// `repository.triage`, plus the account's issue types and issue fields
// (`issue_types`, `issue_fields`), which need the classic `user` scope.
//
// check-infra.ts answers "did it drift". This answers "put it back". Same split
// as check-infra / apply-infra, and for the same reason: the check runs on every
// pull request and must never be able to write, so the write code does not live
// in the file CI executes.
//
//   bun tools/sync-labels.ts             plan only, no writes
//   bun tools/sync-labels.ts --confirm   create and update declared labels
//   bun tools/sync-labels.ts --confirm --prune   also DELETE undeclared labels
//
// WHY THIS EXISTS AT ALL, given that GitHub will happily invent a label on
// demand: that is precisely the failure. POST /issues/:n/labels creates any
// name it is handed, so a typo in a routing rule mints a near-duplicate label
// with a colour nobody chose and reports nothing. Declaring the set makes the
// typo a failed check instead of a second label named `area: garagee`.
//
// PRUNE DELETES, and a deletion takes the label off every issue and pull
// request carrying it, historically. There is no undo. It is off by default
// and needs --confirm alongside it.
//
// Refuses to run in CI, like apply-infra.ts. Nothing in the pipeline should
// hold a credential that can rewrite repository metadata.

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

// ------------------------------------------------------------- guardrails --

if (process.env.CI) {
  console.error("refusing to run in CI.");
  console.error("");
  console.error("A token that can rewrite repository metadata has no business in a workflow.");
  console.error("Run this from a workstation; CI's job is to notice the drift, not fix it.");
  process.exit(1);
}

// Being logged in buys nothing on its own is the trap check-infra's own docs
// record: it reads GITHUB_TOKEN and never shells out, so a machine with a
// perfectly good `gh auth login` still reports a tier as unverifiable. This is
// the writer, run by hand, so it asks gh directly when the variable is unset.
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

// ------------------------------------------------------------------- api ----

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

// ------------------------------------------------------------------ plan ----

type Step = { verb: string; name: string; detail: string; apply?: () => Promise<unknown> };
const plan: Step[] = [];
const scopeNotes: string[] = [];

const live = new Map((await liveLabels()).map((l) => [l.name, l]));
for (const want of triage.labels) {
  const { name, color, description } = want;
  const have = live.get(name);
  live.delete(name);
  if (!have) {
    plan.push({
      verb: "create",
      name,
      detail: `#${color}  ${description}`,
      apply: () => gh(`/repos/${slug}/labels`, { method: "POST", body: JSON.stringify({ name, color, description }) }),
    });
    continue;
  }
  const diffs: string[] = [];
  if (have.color.toLowerCase() !== color.toLowerCase()) diffs.push(`color #${have.color} -> #${color}`);
  if ((have.description ?? "") !== description) diffs.push(`description "${have.description ?? ""}" -> "${description}"`);
  if (diffs.length) {
    plan.push({
      verb: "update",
      name,
      detail: diffs.join(", "),
      apply: () =>
        gh(`/repos/${slug}/labels/${encodeURIComponent(name)}`, {
          method: "PATCH",
          body: JSON.stringify({ new_name: name, color, description }),
        }),
    });
  }
}

// Strays are reported whether or not --prune is set, because knowing they exist
// is the useful half and deleting them is the rare half.
for (const stray of live.values()) {
  plan.push({
    verb: PRUNE ? "delete" : "stray",
    name: stray.name,
    detail: PRUNE ? "removed from every issue and pull request carrying it" : "undeclared (pass --prune to delete)",
    apply: PRUNE ? () => gh(`/repos/${slug}/labels/${encodeURIComponent(stray.name)}`, { method: "DELETE" }) : undefined,
  });
}

// Issue types and fields live on the ACCOUNT, at /user/..., so these writes
// reach every repository oddharsh owns. Reading them needs `read:user` and
// writing needs `user`, neither of which a default `gh auth login` grants, so a
// 403 here is a note about the token rather than a failed sync of the labels.
async function readAccount(path: string) {
  try {
    return await gh(path);
  } catch (e) {
    scopeNotes.push(`${path}: ${(e as Error).message.slice(0, 120)}`);
    return null;
  }
}

const liveTypes = triage.issue_types ? await readAccount("/user/issue-types") : null;
if (liveTypes) {
  const byName = new Map<string, any>(liveTypes.map((t) => [t.name, t]));
  for (const want of triage.issue_types) {
    const body = JSON.stringify({ name: want.name, description: want.description, color: want.color, is_enabled: true });
    const have = byName.get(want.name);
    byName.delete(want.name);
    if (!have) {
      plan.push({
        verb: "create",
        name: `type ${want.name}`,
        detail: `${want.color}  ${want.description}`,
        apply: () => gh("/user/issue-types", { method: "POST", body }),
      });
      continue;
    }
    const diffs: string[] = [];
    if (have.color !== want.color) diffs.push(`color ${have.color} -> ${want.color}`);
    if ((have.description ?? "") !== want.description) diffs.push(`description "${have.description ?? ""}" -> "${want.description}"`);
    if (!have.is_enabled) diffs.push("disabled -> enabled");
    if (diffs.length) {
      plan.push({
        verb: "update",
        name: `type ${want.name}`,
        detail: diffs.join(", "),
        apply: () => gh(`/user/issue-types/${have.id}`, { method: "PUT", body }),
      });
    }
  }
  for (const stray of byName.values()) {
    plan.push({
      verb: PRUNE ? "delete" : "stray",
      name: `type ${stray.name}`,
      detail: PRUNE ? "permanently removed from the account" : "undeclared (pass --prune to delete)",
      apply: PRUNE ? () => gh(`/user/issue-types/${stray.id}`, { method: "DELETE" }) : undefined,
    });
  }
}

const liveFields = triage.issue_fields ? await readAccount("/user/issue-fields") : null;
if (liveFields) {
  const byName = new Map<string, any>(liveFields.map((f) => [f.name, f]));
  for (const want of triage.issue_fields) {
    const have = byName.get(want.name);
    byName.delete(want.name);
    // Option ids carry over by name, so an update keeps the values already set
    // on issues instead of replacing every option with a fresh one. An unset
    // `id` or `options` is undefined, which JSON.stringify leaves out.
    const options = want.options?.map((o, priority) => ({
      id: have?.options?.find((h) => h.name === o.name)?.id,
      name: o.name,
      color: o.color,
      priority,
    }));
    const fields = { name: want.name, description: want.description, visibility: "all", options };
    if (!have) {
      const body = JSON.stringify({ ...fields, data_type: want.data_type });
      plan.push({
        verb: "create",
        name: `field ${want.name}`,
        detail: `${want.data_type}  ${want.description}`,
        apply: () => gh("/user/issue-fields", { method: "POST", body }),
      });
      continue;
    }
    if (have.data_type !== want.data_type) {
      // PATCH cannot change a data type, and recreating the field deletes every
      // value set on it, so that call stays with a person.
      plan.push({ verb: "manual", name: `field ${want.name}`, detail: `is ${have.data_type}, declared ${want.data_type}; delete and recreate it by hand` });
      continue;
    }
    const diffs: string[] = [];
    if ((have.description ?? "") !== want.description) diffs.push(`description "${have.description ?? ""}" -> "${want.description}"`);
    if (have.visibility !== "all") diffs.push(`visibility ${have.visibility} -> all`);
    // The API lists options by name; `priority` is the order (seen 2026-11-11).
    const haveOptions = (have.options ?? [])
      .toSorted((a, b) => a.priority - b.priority)
      .map((o) => `${o.name}:${o.color}`)
      .join(",");
    const wantOptions = (want.options ?? []).map((o) => `${o.name}:${o.color}`).join(",");
    if (haveOptions !== wantOptions) diffs.push(`options [${haveOptions}] -> [${wantOptions}]`);
    if (diffs.length) {
      plan.push({
        verb: "update",
        name: `field ${want.name}`,
        detail: diffs.join(", "),
        apply: () => gh(`/user/issue-fields/${have.id}`, { method: "PATCH", body: JSON.stringify(fields) }),
      });
    }
  }
  for (const stray of byName.values()) {
    plan.push({
      verb: PRUNE ? "delete" : "stray",
      name: `field ${stray.name}`,
      detail: PRUNE ? "removed, with its value on every issue" : "undeclared (pass --prune to delete)",
      apply: PRUNE ? () => gh(`/user/issue-fields/${stray.id}`, { method: "DELETE" }) : undefined,
    });
  }
}

for (const note of scopeNotes) console.log(`unread ${note}`);
if (scopeNotes.length) console.log("       issue types and fields need the `user` scope: gh auth refresh -h github.com -s user");

if (!plan.length) {
  console.log(`${slug}: ${triage.labels.length} declared label(s) match, no strays.`);
  process.exit(0);
}

for (const step of plan) {
  console.log(`${step.verb.padEnd(6)} ${JSON.stringify(step.name).padEnd(22)} ${step.detail}`);
}

const writes = plan.filter((s) => s.apply);
if (!CONFIRM) {
  console.log("");
  console.log(`${writes.length} change(s) pending. Re-run with --confirm to apply.`);
  process.exit(0);
}

// ----------------------------------------------------------------- apply ----

let applied = 0;
for (const step of writes) {
  try {
    await step.apply!();
    applied++;
  } catch (e) {
    // Keep going. A partial sync is recoverable by re-running; stopping on the
    // first failure leaves the rest of the set in an unknown state and the
    // operator with one error instead of the list.
    console.error(`  ${step.verb} ${step.name} FAILED: ${(e as Error).message}`);
  }
}

console.log("");
console.log(`${applied}/${writes.length} change(s) applied. Run \`bun run infra:check\` to confirm.`);
process.exit(applied === writes.length ? 0 : 1);
