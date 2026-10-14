#!/usr/bin/env node
// speculation-report.ts — which links does the speculation ledger say are worth
// prerendering earlier? (bun run speculation:report)
import type { SpeculationRow } from "../src/worker/speculation.ts";

const ORIGIN = process.env.SPECULATION_ORIGIN || "https://aadhar.sh";
const minArg = process.argv.indexOf("--min");
const MIN = minArg === -1 ? 10 : Number(process.argv[minArg + 1] || 10);

type LedgerReport = { ok: boolean; reason?: string; window_days?: number; rows?: SpeculationRow[] };

const res = await fetch(`${ORIGIN}/ledger/speculation.json`, { headers: { accept: "application/json" } });
const report = (await res.json()) as LedgerReport;
if (!report.ok) {
  console.error(`speculation:report — ${ORIGIN} answered ${res.status}: ${report.reason || "unreadable"}`);
  process.exit(1);
}
const isDocument = (p: string) => !p.startsWith("/a/") && !/\.[a-z0-9]+$/i.test(p.split("/").pop() || "");
const all = report.rows || [];
const hidden = all.filter((r) => !isDocument(r.path)).length;
const rows = all.filter((r) => isDocument(r.path) && r.speculated >= MIN);
console.log(`speculation ledger, last ${report.window_days} days, document paths speculated ${MIN}+ times (${rows.length} of ${all.length}; ${hidden} sub-resource rows hidden)\n`);
console.log("path".padEnd(34), "prefetch".padStart(9), "prerender".padStart(10), "activated".padStart(10), "rate".padStart(7));
for (const r of rows) {
  console.log(r.path.slice(0, 34).padEnd(34), String(r.prefetch).padStart(9), String(r.prerender).padStart(10), String(r.activated).padStart(10), (r.rate === null ? "n/a" : `${(r.rate * 100).toFixed(0)}%`).padStart(7));
}
const activations = all.reduce((n, r) => n + r.activated, 0);
if (!activations) {
  console.log(`\nno activations recorded on any of ${all.length} paths in ${report.window_days} days. That is a missing instrument, not a finding:`);
  console.log("nav.js's prerenderingchange beacon started recording on 2026-09-29, and before it the numerator could not move.");
  console.log("No promotion or exclusion follows from this window; re-run once activations appear.");
  process.exit(0);
}
const hot = rows.filter((r) => r.rate !== null && r.rate >= 0.5);
const cold = rows.filter((r) => r.rate !== null && r.rate <= 0.05 && r.speculated >= MIN * 3);
console.log(`\ncandidates to promote (rate >= 50%): ${hot.length ? hot.map((r) => r.path).join(", ") : "none"}`);
console.log(`candidates to exclude (rate <= 5% on ${MIN * 3}+ speculations): ${cold.length ? cold.map((r) => r.path).join(", ") : "none"}`);
console.log("\nA promotion is an edit to SPECULATION in tools/photos/shell-data.ts, and it ships only after\n`bun run speculation:probe` shows the promoted rule reaching the origin. Read that file's note first.");
