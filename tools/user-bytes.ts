#!/usr/bin/env bun
// user-bytes.ts: `bun run user-bytes <A> <B>`. What deploying build B in place
// of build A does to the bytes real visitors download and the time they wait,
// weighted by last week's traffic. The model is tools/lib/user-bytes.ts.
//
//   bun run user-bytes ../main ../branch           # two checkouts, each built
//   bun run user-bytes a/.build/public b/.build/public --days 7 --mbps 50
//   bun run user-bytes A B --traffic rows.json     # replay saved log rows
//   bun run user-bytes A B --save-traffic rows.json
//   bun run user-bytes A B --verify                # check the load model in Chrome first
//
// Traffic is Workers Logs over the last --days (7 at most, the retention):
// every `Sec-Fetch-Dest: document` request, with the client's own
// Accept-Encoding and Available-Dictionary, which say who can take dcz and
// what they hold. Logs are head-sampled, so each row carries its weight
// (sampleInterval); the bootstrap interval says how much of the answer is
// that sampling. Saved rows hold UAs and network names, never an address, and
// belong outside the repo.
//
// --verify is the control on the load model. pageLoads reads a page's /a/
// files and their render-blocking status from the HTML; --verify serves the
// tree to Chrome and compares that list with what Chrome requested and what
// it reports as renderBlockingStatus. It first plants a page with one
// blocking sheet and one deferred script, and exits 2 ("blind") if Chrome's
// reading of that plant is wrong, so a broken reader can't pass the sweep.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { cf, CF_ACCOUNT } from "./lib/cf.ts";
import { aggregate, bootstrapDelta, compare, parseLogRow, readTree, rowsQuery } from "./lib/user-bytes.ts";
import type { AnalyticsRow } from "../src/worker/ledger.ts";
import type { LogRow, Traffic, Tree } from "./lib/user-bytes.ts";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    days: { type: "string", default: "7" },
    mbps: { type: "string", default: "50" },
    "rtt-ms": { type: "string" },
    traffic: { type: "string" },
    "save-traffic": { type: "string" },
    verify: { type: "boolean", default: false },
  },
});
if (positionals.length !== 2) {
  console.error("usage: bun run user-bytes <buildA> <buildB> [--days 7] [--mbps 50] [--rtt-ms N] [--traffic rows.json] [--save-traffic rows.json] [--verify]");
  process.exit(64);
}
const days = Number(values.days);
if (!(days >= 1 && days <= 7)) throw new Error("--days: 1 to 7 (Workers Logs keeps 7)");

/** A checkout root or a .build/public directory, either way. */
function treeRoot(arg: string): string {
  const built = join(resolve(arg), ".build/public");
  const root = existsSync(built) ? built : resolve(arg);
  if (!existsSync(join(root, "a")) || !existsSync(join(root, "index.html"))) throw new Error(`${arg}: not a built tree (run \`bun run build\` in it)`);
  return root;
}
const [rootA, rootB] = positionals.map(treeRoot);

// A saved file is the same rows, so it takes the same parse.
const rows: LogRow[] = values.traffic ? (JSON.parse(readFileSync(values.traffic, "utf8")) as AnalyticsRow[]).map(parseLogRow) : await fetchRows(days);
if (values["save-traffic"]) writeFileSync(values["save-traffic"], JSON.stringify(rows));

const paths = new Set(aggregate(rows, days, "loose").views.map((v) => v.path));
const a = readTree(rootA, paths);
const b = readTree(rootB, paths);

if (values.verify) {
  const { verifyLoads } = await import("./lib/user-bytes-verify.ts");
  const code = await verifyLoads(b, [...b.pages.keys()]);
  if (code !== 0) process.exit(code);
}

console.log(`A ${rootA}\nB ${rootB}`);
console.log(`traffic: ${rows.length} sampled document rows over ${days} days (Workers Logs)\n`);
for (const rule of ["strict", "loose"] as const) report(aggregate(rows, days, rule), a, b);

function report(t: Traffic, a: Tree, b: Tree) {
  const rttMs = values["rtt-ms"] ? Number(values["rtt-ms"]) : (t.rttMs ?? 50);
  const link = { mbps: Number(values.mbps), rttMs };
  const c = compare(t.views, a, b, link);
  const perDay = (n: number) => n / t.days;
  const kb = (n: number) => `${(n / 1000).toFixed(2)} KB`;
  const signed = (n: number, unit: string, digits = 0) => `${n >= 0 ? "+" : ""}${n.toFixed(digits)} ${unit}`;
  const bots = Object.entries(t.bots)
    .sort((x, y) => y[1] - x[1])
    .map(([r, n]) => `${r} ${n}`)
    .join(", ");
  console.log(`── bot rule: ${t.rule} ${"─".repeat(50)}`);
  console.log(
    `people: ${perDay(c.priced + c.unpriced).toFixed(0)} page views/day (${perDay(c.unpriced).toFixed(0)} on Worker-rendered pages no tree holds, left out)`,
  );
  console.log(`bots and tools left out: ${bots || "none"}; non-GET or non-200: ${t.skipped}`);
  console.log(`link: ${link.mbps} Mbps, ${link.rttMs} ms RTT${values["rtt-ms"] ? "" : " (median client TCP RTT of these views)"}\n`);
  const d = c.steady.b.bytes - c.steady.a.bytes;
  const ci = bootstrapDelta(t.rows, a, b, 2000, 1803);
  console.log(
    `steady state, per page view:  A ${kb(c.steady.a.bytes)}  B ${kb(c.steady.b.bytes)}  delta ${signed(d, "B")} (90% bootstrap ${signed(ci.lo, "B")} to ${signed(ci.hi, "B")})`,
  );
  console.log(
    `  first-paint network time:   A ${c.steady.a.ms.toFixed(2)} ms  B ${c.steady.b.ms.toFixed(2)} ms  delta ${signed(c.steady.b.ms - c.steady.a.ms, "ms", 3)}`,
  );
  const daily = d * perDay(c.priced);
  console.log(`  per day: ${signed(daily, "B")} over ${perDay(c.priced).toFixed(0)} views`);
  for (const k of c.byClass)
    console.log(`    ${k.label.padEnd(32)} ${perDay(k.views).toFixed(1).padStart(6)} views/day  ${signed((k.b - k.a) / k.views, "B/view")}`);
  const once = c.remint.first.bytes - c.remint.settled.bytes;
  const onceMs = c.remint.first.ms - c.remint.settled.ms;
  console.log(`\nre-mint, first visit after B replaces A, for a visitor holding a dictionary (${perDay(c.remint.returning).toFixed(1)} views/day):`);
  console.log(`  ${kb(c.remint.first.bytes)} against ${kb(c.remint.settled.bytes)} once settled: ${signed(once, "B")}, ${signed(onceMs, "ms", 2)} first paint`);
  // Every dictionary-holding view in week one counted as a different
  // visitor's first visit: the most the re-mint can cost. The log can't
  // join views into visitors (sampling breaks the sequence), so the true
  // figure sits between one visitor's cost and this.
  const weekOnce = once * c.remint.returning * (7 / t.days);
  const weekSteady = daily * 7;
  console.log(
    `first week after deploy: ${signed(weekSteady, "B")} steady + up to ${signed(weekOnce, "B")} re-mint = up to ${signed(weekSteady + weekOnce, "B")}`,
  );
  const holders = c.byClass.find((k) => k.label === "chromium, holds dictionary");
  const holderSaving = holders ? (holders.a - holders.b) / holders.views : 0;
  if (once > 0 && holderSaving >= 1)
    console.log(`  a returning visitor earns it back after ${Math.ceil(once / holderSaving)} more page views at ${holderSaving.toFixed(0)} B saved each`);
  else if (once > 0) console.log("  a returning visitor never earns it back: B saves them nothing per view once settled");
  console.log("");
}

async function fetchRows(days: number): Promise<LogRow[]> {
  const { data } = await cf(["analytics", "sql", "post", "--scope-account-tag", CF_ACCOUNT, "--query", rowsQuery(days)]);
  if (!Array.isArray(data)) throw new Error("Workers Logs: no rows array in the SQL API answer");
  if (data.length >= 100_000) throw new Error("Workers Logs: hit the 100,000-row limit; shorten --days");
  return data.map(parseLogRow);
}
