#!/usr/bin/env node
// Does every committed derived artifact still describe the bytes it was derived
// from?
//
//   bun run derive:check              verify, exit 1 on anything stale
//   bun run derive:check -- --lock    re-record, AFTER regenerating by hand
//   bun run derive:check -- --only images/histograms
//
// The declaration is config/derivations.json and the argument for the whole idea
// is in its header. This file is the runner: it reads the graph, hashes what each
// artifact was made from, and prints what moved.
//
// It runs no generator and writes nothing outside config/ (and nothing at all
// without --lock). Both halves matter. Several sessions work in this tree at once,
// so a check that regenerated artifacts in place would be overwriting somebody
// else's uncommitted work, and one that needed a local pipeline state could not
// answer from a fresh worktree, which is where this repo says to start.
//
// --lock DOES NOT REGENERATE ANYTHING. It records that the current inputs are
// what the current outputs were made from, which is a CLAIM the person running it
// is making. Running it to clear a red check without re-baking is how the graph
// becomes decoration, so it prints the outputs it is vouching for and says so.

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { type Derivation, type Lock, record, relock, verify } from "./lib/derive.ts";
import { SHELL_FLOOR, WRITER_FLOOR, declaredBy, findShellTouchers, findWriters } from "./lib/derive-writers.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DECL = path.join(ROOT, "config/derivations.json");
const LOCK = path.join(ROOT, "config/derivations.lock.json");

const args = process.argv.slice(2);
const WRITE = args.includes("--lock");
const only = args[args.indexOf("--only") + 1];
const ONLY = args.includes("--only") ? only : null;

const readJson = async (file: string, fallback: unknown = null) => {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (err) {
    if (fallback !== null) return fallback;
    throw err;
  }
};

const declaration = await readJson(DECL);
const lock: Lock = ((await readJson(LOCK, {})) as { files?: Lock }).files ?? {};

/** config/tools.json's `recorded` versions, the ones that made today's bytes. */
const toolVersions: Record<string, string> = Object.fromEntries(
  ((await readJson(path.join(ROOT, "config/tools.json"), { tools: [] })).tools ?? [])
    .filter((t: { recorded?: string }) => t.recorded)
    .map((t: { bin: string; recorded: string }) => [t.bin, String(t.recorded)]),
);

const all: Derivation[] = declaration.derivations;
const graph = ONLY ? all.filter((d) => d.id === ONLY) : all;
if (ONLY && !graph.length) {
  console.error(`derive: no derivation named ${ONLY}. declared: ${all.map((d) => d.id).join(", ")}`);
  process.exit(2);
}

// A declaration that reaches zero pinned entries is a graph that has been emptied
// rather than a repository with nothing to check, and it would otherwise report a
// clean pass. Same floor the scanners in check-tools.ts carry.
const pinned = all.filter((d) => d.tier === "pinned");
if (!ONLY && pinned.length < 4) {
  console.error(`derive: only ${pinned.length} pinned derivations declared; the graph has been emptied`);
  process.exit(2);
}

const list = (files: string[], label: string, cap = 8) => {
  if (!files.length) return;
  const head = files.slice(0, cap);
  console.log(`      ${label} (${files.length}): ${head.join(", ")}${files.length > cap ? ", ..." : ""}`);
};

if (WRITE) {
  // Each derivation's rows are REPLACED rather than merged over, which relock()
  // argues at length: a merge-only rewrite carried every input forward forever, so
  // one full-library re-encode left 495 rows naming filenames nobody can open.
  let nextLock: Lock = { ...lock };
  let vouched = 0;
  let pruned = 0;
  for (const d of graph) {
    const made = await record(ROOT, d, toolVersions);
    if (!made) continue;
    d.recorded = made.recorded;
    const rolled = relock(nextLock, made.hashes, made.owns);
    const gone = rolled.pruned;
    nextLock = rolled.next;
    pruned += gone.length;
    vouched++;
    console.log(`recorded ${d.id}: ${made.recorded.count} inputs -> ${made.recorded.inputs.slice(0, 12)}`);
    if (gone.length) console.log(`      pruned ${gone.length} lock row(s) for inputs that are gone: ${gone.slice(0, 4).join(", ")}${gone.length > 4 ? ", ..." : ""}`);
    for (const out of d.outputs) console.log(`      vouching for ${out}`);
  }
  await writeFile(DECL, `${JSON.stringify(declaration, null, 2)}\n`);
  await writeFile(
    LOCK,
    `${JSON.stringify({ $comment: "Machine-owned. Per-input hashes for config/derivations.json, so a stale result can name what moved. Written by `bun run derive:check -- --lock`; do not hand-edit.", files: Object.fromEntries(Object.keys(nextLock).sort().map((k) => [k, nextLock[k]])) }, null, 2)}\n`,
  );
  console.log(
    `\nderive: recorded ${vouched} derivation(s), ${Object.keys(nextLock).length} lock rows${pruned ? `, ${pruned} pruned` : ""}. This asserts the committed outputs were made from these inputs.`,
  );
  process.exit(0);
}

let stale = 0;
let fresh = 0;
const notes: string[] = [];

for (const d of graph) {
  const v = await verify(ROOT, d, lock, toolVersions);
  if (v.state === "fresh") {
    fresh++;
    console.log(`  ok    ${d.id}  (${v.count} inputs)`);
  } else if (v.state === "unverifiable") {
    notes.push(`  note  ${d.id}: ${v.reason}`);
  } else if (v.state === "unrecorded") {
    stale++;
    console.log(`  NEW   ${d.id}  (${v.count} inputs, never recorded)`);
    console.log(`      run: bun run derive:check -- --lock --only ${d.id}`);
  } else {
    stale++;
    console.log(`  STALE ${d.id}`);
    console.log(`      outputs: ${d.outputs.join(", ")}`);
    list(v.changed, "changed");
    list(v.added, "added");
    list(v.removed, "removed");
    list(v.uncovered, "NO ENTRY for");
    list(v.orphaned, "entries for inputs that are gone");
    for (const t of v.tools) console.log(`      tool ${t.name}: recorded ${t.recorded}, now ${t.now}`);
    if (d.regenerate) console.log(`      regenerate: ${d.regenerate}`);
  }
}

for (const n of notes) console.log(n);

// ── the census: is there a generator nobody declared? ────────────────────────
// Skipped under --only, which is a single-derivation debugging mode rather than a
// statement about the repository.
let undeclared: string[] = [];
if (!ONLY) {
  const { roots, exempt } = declaration.writers;
  const writers = await findWriters(ROOT, roots);
  if (writers.length < WRITER_FLOOR) {
    console.error(`derive: the writer scan found ${writers.length} files, under the floor of ${WRITER_FLOOR}. It has stopped matching.`);
    process.exit(2);
  }
  // The shell tier asks a wider question than "does this write", because shell
  // has no exact answer to that one. See the header of derive-writers.ts.
  const shell = await findShellTouchers(ROOT, declaration.writers.shellRoots ?? roots);
  if (shell.length < SHELL_FLOOR) {
    console.error(`derive: the shell scan found ${shell.length} scripts, under the floor of ${SHELL_FLOOR}. It has stopped matching.`);
    process.exit(2);
  }

  const regenerates = all.map((d) => d.regenerate ?? "");
  const everything = [...writers, ...shell];
  undeclared = everything.filter((f) => !declaredBy(f, regenerates) && !(f in exempt));

  // An exemption for a file that no longer writes is stale bookkeeping, and left
  // alone it makes the list look more considered than it is.
  const stale = Object.keys(exempt).filter((f) => !everything.includes(f));
  for (const f of stale) console.log(`  note  ${f} is exempt but no longer writes; drop the entry`);

  for (const f of undeclared) {
    console.log(`  UNDECLARED ${f}`);
    console.log("      it writes, and no derivation names it. Declare what it produces, or exempt it with a reason in config/derivations.json.");
  }
  console.log(`  census: ${writers.length} writers + ${shell.length} shell, ${everything.length - undeclared.length} of ${everything.length} classified`);
}

const summary = `derive: ${fresh} fresh, ${stale} stale, ${notes.length} unverifiable, ${undeclared.length} undeclared`;
if (stale || undeclared.length) {
  console.error(`\n${summary}`);
  console.error("a stale artifact describes bytes this site no longer serves. regenerate it, then --lock.");
  process.exit(1);
}
console.log(`\n${summary}`);
