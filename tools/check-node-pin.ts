#!/usr/bin/env bun
// bun run node:pin [--json] [--warn-days N]

import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SCHEDULE = "https://raw.githubusercontent.com/nodejs/Release/main/schedule.json";

const argv = process.argv.slice(2);
const asJson = argv.includes("--json");
const warnDays = Number(argv[argv.indexOf("--warn-days") + 1]) || 180;

const pretend = argv.indexOf("--pretend") === -1 ? null : argv[argv.indexOf("--pretend") + 1];

const pinned = pretend ?? readFileSync(join(ROOT, ".node-version"), "utf8").trim();
const pinnedMajor = Number(pinned);
if (!Number.isInteger(pinnedMajor)) {
  console.error(`${pretend ? "--pretend" : ".node-version"} reads ${JSON.stringify(pinned)}, which is not a bare major`);
  process.exit(2);
}

const res = await fetch(SCHEDULE, { headers: { "user-agent": "aadhar.sh node:pin" } });
if (!res.ok) {
  console.error(`could not read nodejs/Release schedule.json: HTTP ${res.status}`);
  process.exit(2);
}
const schedule: Record<string, { start: string; lts?: string; maintenance?: string; end: string }> = await res.json();

const today = new Date();
const day = (iso: string | undefined) => (iso ? new Date(`${iso}T00:00:00Z`) : null);
const daysBetween = (a: Date, b: Date) => Math.round((b.getTime() - a.getTime()) / 86_400_000);

function phaseOf(entry: { start: string; lts?: string; maintenance?: string; end: string }) {
  const start = day(entry.start)!;
  const lts = day(entry.lts);
  const maintenance = day(entry.maintenance);
  const end = day(entry.end)!;
  if (today < start) return "unreleased";
  if (today >= end) return "end-of-life";
  if (maintenance && today >= maintenance) return "maintenance";
  // An ODD major never gets an `lts` date at all, so "before lts" and "never
  // lts" have to be told apart. Reading a missing date as "not yet" would call
  // node 25 a future LTS release, which it can never be.
  if (lts && today >= lts) return "active-lts";
  return lts ? "current" : "current-only";
}

const entry = schedule[`v${pinnedMajor}`];
if (!entry) {
  console.error(`the schedule carries no v${pinnedMajor}; .node-version names a major node has never shipped`);
  process.exit(2);
}

const phase = phaseOf(entry);
const end = day(entry.end)!;
const daysToEnd = daysBetween(today, end);
const maintenance = day(entry.maintenance);
const lts = day(entry.lts);

const newestLts = Object.entries(schedule)
  .filter(([, v]) => phaseOf(v) === "active-lts")
  .map(([k]) => Number(k.slice(1)))
  .sort((a, b) => b - a)[0];

// A workstation running a different major from the pin is not a failure, and it
// is worth saying: it is the same class of confusion as a dev server belonging
// to another checkout (gotcha 39), where every downstream reading is about a
// runtime nobody declared.
const localVersion = spawnSync("node", ["--version"], { encoding: "utf8" }).stdout?.trim() ?? null;
const localMajor = localVersion ? Number(localVersion.replace(/^v/, "").split(".")[0]) : null;

const due: string[] = [];
if (phase === "end-of-life") due.push(`node ${pinnedMajor} reached end of life on ${entry.end}, and it runs wrangler on the path that publishes production`);
else if (daysToEnd <= warnDays) due.push(`node ${pinnedMajor} reaches end of life on ${entry.end}, in ${daysToEnd} days`);
else if (phase === "maintenance") due.push(`node ${pinnedMajor} has been in maintenance since ${entry.maintenance}, so it takes security fixes only`);
else if (phase === "current-only") due.push(`node ${pinnedMajor} is an odd-numbered major and will never become LTS; it ends ${entry.end}`);

const report = {
  pinned: pinnedMajor,
  phase,
  lts: entry.lts ?? null,
  maintenance: entry.maintenance ?? null,
  end: entry.end,
  daysToEnd,
  newestLts: newestLts ?? null,
  local: localVersion,
  localMatchesPin: localMajor === pinnedMajor,
  due,
};

if (asJson) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`.node-version: ${pinnedMajor}  (${phase})${pretend ? "   [--pretend, the tree says " + readFileSync(join(ROOT, ".node-version"), "utf8").trim() + "]" : ""}`);
  if (phase === "current" && lts) console.log(`  enters Active LTS ${entry.lts}, in ${daysBetween(today, lts)} days`);
  if (phase === "active-lts" && maintenance) console.log(`  Active LTS until ${entry.maintenance}, ${daysBetween(today, maintenance)} days`);
  if (phase === "maintenance") console.log(`  security fixes only since ${entry.maintenance}`);
  console.log(`  end of life ${entry.end}, ${daysToEnd < 0 ? `${-daysToEnd} days ago` : `in ${daysToEnd} days`}`);
  console.log(`  newest Active LTS today: ${newestLts ?? "none"}`);
  console.log(`  local node: ${localVersion ?? "not on PATH"}${report.localMatchesPin ? "" : "  <-- a different major from the pin"}`);
}

if (!due.length) {
  if (!asJson) console.log("\nnode:pin: the pinned major is supported and no decision is due.");
  process.exit(0);
}

if (!asJson) {
  console.log("");
  for (const line of due) console.log(`node:pin: DUE — ${line}`);
  if (newestLts && newestLts !== pinnedMajor) {
    console.log(`  the move is to ${newestLts}, which is in Active LTS. Gates before taking it:`);
    console.log("    wrangler runs under it (it is the deploy path), `bun run test:node`, `bun run typecheck`,");
    console.log("    and gzip continuity: perf-budget's constants and every perf-history row were measured");
    console.log("    under this major, and a zlib change re-reads the whole series as a step nobody took.");
  }
}
process.exit(1);
