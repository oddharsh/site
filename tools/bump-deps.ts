#!/usr/bin/env bun
// bun run deps:pin [--json <plan.json>] [--group <name> --write [--body <pr.md>]]
//
// The npm half of Dependabot, run by this repo, because Dependabot can no longer
// read it. tools/lib/deps-plan.ts says why and holds the policy; this file
// fetches the registry, prints the plan, and with --write carries ONE group into
// the tree: package.json pins, bun.lock, lens-reader/bun.lock, and the version
// claims in docs/DEPENDENCIES.md. .github/workflows/deps-pin.yml runs it nightly
// and opens one PR per group.
//
// With no flags it only reads, so it is safe to run anywhere. --write edits the
// CURRENT tree, which is what the workflow wants (a fresh checkout per group);
// locally, run it on a clean branch.
//
// --ignore-scripts ON EVERY INSTALL, for the reason the old relock tool gave.
// The packages being bumped ARE the toolchain (oxlint, oxc-minify, wrangler's
// neighbours), and the workflow later holds a token that can push. bun runs
// lifecycle scripts only for `trustedDependencies` (esbuild, sharp, workerd),
// and this flag shuts that last door, so no newly published code executes in
// the job. Resolution does not depend on scripts, so the lockfile is
// byte-identical either way. The gates that DO execute the bump (lint,
// typecheck, tests, build) are `validate`'s, on the PR, holding no credential.

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { minimumReleaseAgeSeconds } from "./lib/bun-pin.ts";
import { DOC_ALIASES, SUB_MANIFEST_POLICY, VERSIONLESS, parseCargoDeps, planDocPinRewrites } from "./lib/dependency-docs.ts";
import type { Bump, Manifest, RegistryDoc } from "./lib/deps-plan.ts";
import { branchFor, exactPins, planBumps, rewriteManifest } from "./lib/deps-plan.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const REGISTRY = "https://registry.npmjs.org";

const args = process.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const WRITE = args.includes("--write");
const GROUP = opt("--group");
const JSON_OUT = opt("--json");
const BODY_OUT = opt("--body");
if (WRITE && !GROUP) {
  console.error("--write needs --group <name>: one group per branch, so each PR can be merged or closed alone");
  process.exit(2);
}

const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

// The root, its workspaces, and lens-reader, which sits OUTSIDE the workspace
// with its own bun.lock. Dependabot watched `/` and `/lens-reader`; the
// workspaces were reached through the root block.
function manifestPaths(): string[] {
  const root = JSON.parse(read("package.json"));
  return ["package.json", ...(root.workspaces ?? []).map((w: string) => `${w}/package.json`), "lens-reader/package.json"];
}

async function fetchDoc(pkg: string): Promise<RegistryDoc | null> {
  // The FULL document, because the abbreviated install document carries no
  // per-version `time`, and age is the one field the policy cannot do without.
  // A scoped name is `@scope/name`, and the registry wants the slash encoded.
  const res = await fetch(`${REGISTRY}/${pkg.replaceAll("/", "%2F")}`, { headers: { accept: "application/json" } });
  if (!res.ok) {
    console.error(`  registry ${res.status} for ${pkg}; skipped`);
    return null;
  }
  const doc = (await res.json()) as RegistryDoc;
  return { versions: doc.versions, time: doc.time };
}

async function registryFor(names: string[]) {
  const registry = new Map<string, RegistryDoc>();
  // Eight at a time: enough to finish in seconds, few enough not to look like
  // a scrape.
  for (let i = 0; i < names.length; i += 8) {
    const batch = names.slice(i, i + 8);
    const docs = await Promise.all(batch.map(fetchDoc));
    batch.forEach((n, j) => docs[j] && registry.set(n, docs[j]!));
  }
  return registry;
}

function install(dir: string, frozen: boolean) {
  const flags = frozen ? ["install", "--frozen-lockfile", "--ignore-scripts"] : ["install", "--ignore-scripts"];
  const r = spawnSync(process.execPath, flags, { cwd: path.join(ROOT, dir), encoding: "utf8" });
  if (r.status !== 0) {
    throw new Error(`bun ${flags.join(" ")} in ${dir || "."} failed:\n${(r.stderr || r.stdout).trim().split("\n").slice(-15).join("\n")}`);
  }
}

// docs/DEPENDENCIES.md states versions in sentences, and a contract test holds
// them against the manifests, so a relocked branch is still red until the prose
// moves. planDocPinRewrites shares the READER's pattern, which is why this is
// not a line-oriented sweep: a wrapped mention would slip past one.
function rewriteDocPins() {
  const pkg = JSON.parse(read("package.json"));
  const subManifests = SUB_MANIFEST_POLICY.flatMap((entry) => {
    let raw: string;
    try {
      raw = read(entry.manifest);
    } catch {
      return [];
    }
    const m = entry.kind === "cargo" ? null : JSON.parse(raw);
    const pins = entry.kind === "cargo" ? parseCargoDeps(raw) : { ...m.dependencies, ...m.devDependencies };
    return [{ ...entry, pins }];
  });
  const { updated, edits } = planDocPinRewrites({
    doc: read("docs/DEPENDENCIES.md"),
    pins: { ...pkg.dependencies, ...pkg.devDependencies },
    aliases: DOC_ALIASES,
    versionless: VERSIONLESS,
    subManifests,
  });
  if (edits.length) writeFileSync(path.join(ROOT, "docs/DEPENDENCIES.md"), updated);
  return edits;
}

function prBody(group: string, bumps: Bump[]) {
  const rows = bumps.map((b) =>
    `| [\`${b.pkg}\`](https://www.npmjs.com/package/${b.pkg}?activeTab=versions) | ${b.from} | **${b.to}** | ${b.type} | ${b.manifests.map((m) => `\`${m}\``).join(", ")} |`);
  return [
    `Moves the \`${group}\` group to the newest versions that are at least as old as \`bunfig.toml\`'s \`minimumReleaseAge\`.`,
    "",
    "| package | from | to | update | manifests |",
    "|---|--:|--:|---|---|",
    ...rows,
    "",
    "`bun.lock` (and `lens-reader/bun.lock` when it is touched) was relocked with `--ignore-scripts`, and the version claims in `docs/DEPENDENCIES.md` moved with the pins. Nothing from the new versions ran in the job that pushed this branch; `validate` on this PR is the first thing that executes them.",
    "",
    "Read the release notes linked above for anything that changes output bytes, target browsers, lint rules or native installs. `perf-diff.yml` reports wire bytes on this PR.",
    "",
    `Reproduce with \`bun run deps:pin -- --group ${group} --write\`. Opened by \`.github/workflows/deps-pin.yml\`, because Dependabot cannot read bun.lock v2.`,
  ].join("\n");
}

const manifests: Manifest[] = manifestPaths().map((p) => ({ path: p, json: JSON.parse(read(p)) }));
// Exact pins only: a git or URL spec (timbrado, wrangler) has no registry
// document worth fetching, and planBumps would skip it anyway.
const names = [...exactPins(manifests).keys()].sort();

const registry = await registryFor(names);
const bumps = planBumps({ manifests, registry, nowMs: Date.now(), minAgeSeconds: minimumReleaseAgeSeconds(ROOT) });
const groups = [...new Set(bumps.map((b) => b.group))];

for (const g of groups) {
  console.log(`${g}  (${branchFor(g)})`);
  for (const b of bumps.filter((x) => x.group === g)) console.log(`  ${b.pkg} ${b.from} -> ${b.to}  ${b.type}  [${b.manifests.join(", ")}]`);
}
if (!groups.length) console.log(`nothing to bump: ${names.length} packages checked`);

if (JSON_OUT) {
  writeFileSync(JSON_OUT, JSON.stringify({ groups: groups.map((g) => ({ name: g, branch: branchFor(g), bumps: bumps.filter((b) => b.group === g) })) }, null, 2) + "\n");
}

if (WRITE) {
  const mine = bumps.filter((b) => b.group === GROUP);
  if (!mine.length) {
    console.log(`group ${GROUP} has nothing to bump`);
    process.exit(0);
  }
  const touched = new Set<string>();
  for (const b of mine) {
    for (const m of b.manifests) {
      const before = read(m);
      const after = rewriteManifest(before, b.pkg, b.from, b.to);
      if (after === before) throw new Error(`${m}: found no "${b.pkg}": "${b.from}" to rewrite`);
      writeFileSync(path.join(ROOT, m), after);
      touched.add(m);
    }
  }
  install("", false);
  const lensReader = [...touched].some((m) => m.startsWith("lens-reader/"));
  if (lensReader) install("lens-reader", false);
  for (const e of rewriteDocPins()) console.log(`  prose: ${e.prose} ${e.from} -> ${e.to}`);
  // The frozen install is its own assertion: it is the exact command CI runs
  // first, and a plain install succeeding does not prove it.
  install("", true);
  if (lensReader) install("lens-reader", true);
  if (BODY_OUT) writeFileSync(BODY_OUT, prBody(GROUP!, mine) + "\n");
  console.log(`wrote ${GROUP}: ${mine.length} bump(s)`);
}
