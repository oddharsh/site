#!/usr/bin/env bun
// bun run canary:bun [--json <path>] [--keep] [--url <zip>]
//
// `--version` ON A CANARY PRINTS THE PLAIN TRIPLE. Measured 2026-09-14: the
// binary under the `canary` tag answers `1.4.3` to `--version` and
// `1.4.3-canary.1+b820c70d6` to `--revision`. The revision is the identity a
// bug report needs, so it is what the JSON and the issue carry.

import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { BUN_WATCHES, ensureTimbradoEngine, runWatch, type WatchResult, watchMoved, watchRow, watchSignature } from "./lib/upstream-watches.ts";
import { canaryUrl, compareVersions, npmVersion, readPin, releaseAsset, installedMatchesPin } from "./lib/bun-pin.ts";
import {
  type Gate,
  bunIdentity,
  byteIdenticalBuildGate,
  calSuiteGate,
  contractSuiteGate,
  downloadBun,
  lockfileFormatGate,
  lockfileReadGate,
  zstdGate,
} from "./lib/bun-gates.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const WORK = join(ROOT, ".bun-canary");

const argv = process.argv.slice(2);
const has = (name: string) => argv.includes(name);
const flag = (name: string): string | null => {
  const i = argv.indexOf(name);
  return i === -1 ? null : argv[i + 1];
};

const jsonPath = flag("--json");
const gates: Gate[] = [];
const watches: WatchResult[] = [];
const started = Date.now();

const print = (g: Gate) => {
  console.log(`${g.ok ? "  ok  " : " FAIL "} ${g.name} — ${g.detail}`);
  for (const n of g.notes ?? []) console.log(`       ${n}`);
};

type Report = {
  leg: "bun";
  verdict: "green" | "changed" | "red" | "instrument";
  subject: { version: string; revision: string; url: string; pin: string };
  signature: string;
  gates: Gate[];
  watches: WatchResult[];
  reason?: string;
  ms: number;
};

const emit = (verdict: Report["verdict"], subject: Report["subject"], reason?: string) => {
  const failing = gates.filter((g) => !g.ok).map((g) => g.name);
  const moved = watches.filter(watchMoved).map(watchSignature);
  const report: Report = {
    leg: "bun",
    verdict,
    subject,
    signature: verdict === "green" ? "green" : `${verdict}:${[...failing, ...moved].join("|") || reason || "unknown"}`,
    gates,
    watches,
    reason,
    ms: Date.now() - started,
  };
  if (jsonPath) writeFileSync(jsonPath, JSON.stringify(report, null, 2) + "\n");
  return report;
};

const pin = readPin(ROOT);
const asset = releaseAsset();
const url = flag("--url") ?? canaryUrl(asset);
const bare = { version: "", revision: "", url, pin: pin.version };

if (!process.versions.bun) {
  console.error("canary:bun must run under bun: the pinned runtime is the baseline half of the comparison");
  emit("instrument", bare, "not running under bun");
  process.exit(2);
}
{
  // A release pin proves itself by version, a canary pin by revision (its
  // --version is the next release's number); lib/bun-pin.ts knows which.
  const baseline = installedMatchesPin(pin.version, process.execPath, { version: process.versions.bun, revision: Bun.revision });
  if (!baseline.ok) {
    console.error(`${baseline.why}; this bun is not the pin. install the pin first`);
    emit("instrument", bare, `baseline is not the pin: ${baseline.why}`);
    process.exit(2);
  }
}

try {
  ensureTimbradoEngine();
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  emit("instrument", bare, "timbrado's Rust engine could not be built");
  process.exit(2);
}

console.log(`pinned:    bun@${pin.version}`);
console.log(`canary:    ${url}\n`);

let candidate: string;
try {
  candidate = await downloadBun(url, WORK);
} catch (err) {
  console.error(String(err instanceof Error ? err.message : err));
  emit("instrument", bare, "download failed");
  process.exit(2);
}

const identity = bunIdentity(candidate);
const subject = { ...bare, ...identity };
if (!identity.version || !identity.revision) {
  console.error("the downloaded binary answered neither --version nor --revision");
  emit("instrument", subject, "binary does not run");
  if (!has("--keep")) rmSync(WORK, { recursive: true, force: true });
  process.exit(2);
}
console.log(`revision:  ${identity.revision}`);
if (compareVersions(identity.version, pin.version === "canary" ? process.versions.bun : npmVersion(pin.version).replace(/-canary\..*$/, "")) <= 0) {
  console.log(`           (reports ${identity.version}, not ahead of the pin's release line; a canary cut right after a release looks like this)`);
}
console.log("");

const step = (g: Gate) => { gates.push(g); print(g); };

step(zstdGate(candidate));
step(lockfileReadGate(candidate, ROOT));
step(lockfileFormatGate(candidate, process.execPath, ROOT, WORK));

try {
  step(byteIdenticalBuildGate(candidate, process.execPath, ROOT));
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  if (message.startsWith("pinned build failed")) {
    console.error(message);
    emit("instrument", subject, "the PINNED build failed, so there is no baseline");
    if (!has("--keep")) rmSync(WORK, { recursive: true, force: true });
    process.exit(2);
  }
  step({ name: "build output is byte-identical", ok: false, detail: "the candidate build FAILED", notes: message.split("\n").slice(1) });
}

step(contractSuiteGate(candidate, ROOT));
step(calSuiteGate(candidate, ROOT));

console.log("\nwatches (pinned -> canary):");
const mark = (v: boolean | null) => (v === null ? "?" : v ? "landed" : "not yet");
for (const w of BUN_WATCHES) {
  const row = watchRow(w, runWatch(process.execPath, w), runWatch(candidate, w));
  watches.push(row);
  const note = watchMoved(row) ? "  <-- moved" : row.pinned && row.candidate ? "  (in the pin too: retire this watch)" : "";
  console.log(`  ${row.name.padEnd(46)} ${mark(row.pinned).padEnd(8)} -> ${mark(row.candidate).padEnd(8)}${note}`);
  if (row.pinned === null || row.candidate === null) console.log(`       ${row.detail}`);
}

if (!has("--keep")) rmSync(WORK, { recursive: true, force: true });

const failed = gates.filter((g) => !g.ok);
console.log("");
if (failed.length) {
  emit("red", subject);
  console.log(`canary:bun: ${identity.revision} is RED — ${failed.map((g) => g.name).join("; ")}`);
  process.exit(1);
}
const movedWatches = watches.filter(watchMoved);
if (movedWatches.length) {
  emit("changed", subject);
  console.log(`canary:bun: ${identity.revision} clears every gate and ${movedWatches.length} watch(es) moved: ${movedWatches.map((w) => `${w.name} ${mark(w.pinned)} -> ${mark(w.candidate)}`).join("; ")}. Nothing written; a canary is never proposed.`);
  process.exit(1);
}
emit("green", subject);
console.log(`canary:bun: ${identity.revision} clears every gate. Nothing written; a canary is never proposed.`);
