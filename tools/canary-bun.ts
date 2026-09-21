#!/usr/bin/env bun
// bun run canary:bun [--json <path>] [--keep] [--url <zip>]
//
// The bun CANARY, run through the same gates the pin bumper runs a release
// through, every night, proposing nothing.
//
// WHY A SECOND SCRIPT RATHER THAN A FLAG ON bump-bun-pin.ts. The bumper's
// whole design is that only a stable release can be proposed, and a contract
// test pins that: the target comes from `releases/latest`, the tag has to be a
// plain `bun-vX.Y.Z`, and it writes config/bun-pin.json. None of that applies to
// a rolling tag, and a canary that "clears every gate" must never be one flag
// away from being written into package.json. So this shares the GATES
// (lib/bun-gates.ts) and none of the decisions.
//
// WHAT IT BUYS. bun's main is a hundred-odd commits past each release and
// most of them are robobun's, so a regression in Bun.Image, the CSS minifier,
// zlib or the wrangler harness reaches `canary` weeks before it reaches a
// version this repo could pin. The byte-identical build gate is the strongest
// regression signal this repository can offer any runtime: every content
// addressed `/a/` and `/i/` URL is a hash of what the compiler emitted.
//
// THE WATCHES are the other half, since 2026-09-15. This repo has seven fixes
// of its own sitting in bun's review queue, and lib/upstream-watches.ts turns
// each one's reproduction into a probe that reads false on the pinned bun
// today. Every run answers each watch under the pin AND under the canary; a
// row that differs is a `changed` verdict naming the fix that arrived and the
// build it arrived in, which is the day this becomes a bun worth pinning. A
// row landed in both is the reader's cue to retire it.
//
// WHAT IT NEVER DOES. Write the pin, roll a dictionary, touch a credential.
// It is an instrument. `.github/workflows/canary.yml` runs it nightly and
// files one rolling issue per leg when the verdict flips; the workstation form
// prints the same table.
//
// THE CONTROL is the pinned bun itself, which builds first and is the
// baseline half of the byte comparison. A red canary whose baseline build
// also failed is the instrument, and the script says so with exit 2 rather
// than 1, because a tripwire that cannot tell "the canary broke" from "the
// runner has no unzip" trains the reader to ignore both.
//
// `--version` ON A CANARY PRINTS THE PLAIN TRIPLE. Measured 2026-09-14: the
// binary under the `canary` tag answers `1.4.3` to `--version` and
// `1.4.3-canary.1+b820c70d6` to `--revision`. The revision is the identity a
// bug report needs, so it is what the JSON and the issue carry.
//
// Exit codes: 0 green, 1 red (a gate failed), 2 the instrument could not run.

import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { BUN_WATCHES, ensureTimbradoEngine, runWatch, type WatchResult, watchMoved, watchRow, watchSignature } from "./lib/upstream-watches.ts";
import { canaryUrl, compareVersions, npmVersion, readPin, releaseAsset, runningMatchesPin } from "./lib/bun-pin.ts";
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
    // The signature is WHAT failed or moved, never which canary did it: the
    // issue dedupes on this, so a fresh canary carrying the same broken gate
    // (or the same landed fix) adds no comment, and a different one does.
    signature: verdict === "green" ? "green" : `${verdict}:${[...failing, ...moved].join("|") || reason || "unknown"}`,
    gates,
    watches,
    reason,
    ms: Date.now() - started,
  };
  if (jsonPath) writeFileSync(jsonPath, JSON.stringify(report, null, 2) + "\n");
  return report;
};

// The running bun is the baseline, so it has to BE the pin, for the reason
// the bumper gives: a stale bun on PATH would compare the canary against a
// third runtime and report a byte-identical build that says nothing.
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
  const baseline = runningMatchesPin(pin.version, { version: process.versions.bun, revision: Bun.revision });
  if (!baseline.ok) {
    console.error(`${baseline.why}; this bun is not the pin. install the pin first`);
    emit("instrument", bare, `baseline is not the pin: ${baseline.why}`);
    process.exit(2);
  }
}

// The watch runner is timbrado's Rust engine, built on demand from the
// installed package (lib/upstream-watches.ts says why a missing one has to
// throw). Asked for HERE, before the download and the two builds, so a runner
// without cargo is an instrument failure that costs seconds rather than one
// that surfaces after minutes of work as eight unmeasured rows.
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
if (compareVersions(identity.version, npmVersion(pin.version).replace(/-canary\..*$/, "")) <= 0) {
  console.log(`           (reports ${identity.version}, not ahead of the pin's release line; a canary cut right after a release looks like this)`);
}
console.log("");

// Cheapest disqualifier first, then the two that cost a minute, then the two
// that cost several. The order is the bumper's, for the bumper's reason.
const step = (g: Gate) => { gates.push(g); print(g); };

step(zstdGate(candidate));
step(lockfileReadGate(candidate, ROOT));
step(lockfileFormatGate(candidate, process.execPath, ROOT, WORK));

try {
  step(byteIdenticalBuildGate(candidate, process.execPath, ROOT));
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  // The pinned build failing is the instrument; the candidate build failing
  // is a finding. The message names which.
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

// The watches, each read under the pin and under the canary. A watch never
// makes a run red: it is a fix arriving, which is `changed`.
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
