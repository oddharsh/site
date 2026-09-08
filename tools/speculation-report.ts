#!/usr/bin/env node
// speculation-report.ts — which links does the speculation ledger say are worth
// prerendering earlier? (bun run speculation:report)
//
// The shell's Speculation Rules prerender every same-origin link on hover
// ("moderate", tools/photos/shell-data.ts). Chrome caps eager and moderate rules
// at two prefetches and two prerenders at a time, so promoting a link to an
// earlier eagerness is a budget decision, and the ledger is the only evidence
// that says which links get NAVIGATED after being speculated rather than merely
// speculated. This reads /ledger/speculation.json from production and prints
// the table that decision needs. It writes nothing: the promotion itself is an
// edit to SPECULATION in shell-data.ts, gated on tools/speculation-probe.ts
// showing the promoted rule actually fetches (an eager prefetch rule was
// measured fetching NOTHING twice before it was deleted; see that file).
//
//   bun run speculation:report                # last 30 days, from aadhar.sh
//   bun run speculation:report -- --min 20    # only paths speculated 20+ times

const ORIGIN = process.env.SPECULATION_ORIGIN || "https://aadhar.sh";
const minArg = process.argv.indexOf("--min");
const MIN = minArg === -1 ? 10 : Number(process.argv[minArg + 1] || 10);

type Row = { path: string; prefetch: number; prerender: number; activated: number; speculated: number; rate: number | null };
type LedgerReport = { ok: boolean; reason?: string; window_days?: number; rows?: Row[] };
export {};

const res = await fetch(`${ORIGIN}/ledger/speculation.json`, { headers: { accept: "application/json" } });
const report = (await res.json()) as LedgerReport;
if (!report.ok) {
  console.error(`speculation:report — ${ORIGIN} answered ${res.status}: ${report.reason || "unreadable"}`);
  process.exit(1);
}
const rows = (report.rows || []).filter((r) => r.speculated >= MIN);
console.log(`speculation ledger, last ${report.window_days} days, paths speculated ${MIN}+ times (${rows.length} of ${report.rows?.length || 0})\n`);
console.log("path".padEnd(34), "prefetch".padStart(9), "prerender".padStart(10), "activated".padStart(10), "rate".padStart(7));
for (const r of rows) {
  console.log(r.path.slice(0, 34).padEnd(34), String(r.prefetch).padStart(9), String(r.prerender).padStart(10), String(r.activated).padStart(10), (r.rate === null ? "n/a" : `${(r.rate * 100).toFixed(0)}%`).padStart(7));
}
// The recommendation is deliberately narrow. A high activation rate on a
// moderate rule says the hover already predicts the click; promoting that link
// to "eager" buys the time between the link scrolling into view and the hover,
// and costs one of Chrome's two concurrent prerender slots. A LOW rate is the
// louder finding: it is a link the site is rendering for nobody, and the fix is
// an exclusion, which costs nothing.
const hot = rows.filter((r) => r.rate !== null && r.rate >= 0.5);
const cold = rows.filter((r) => r.rate !== null && r.rate <= 0.05 && r.speculated >= MIN * 3);
console.log(`\ncandidates to promote (rate >= 50%): ${hot.length ? hot.map((r) => r.path).join(", ") : "none"}`);
console.log(`candidates to exclude (rate <= 5% on ${MIN * 3}+ speculations): ${cold.length ? cold.map((r) => r.path).join(", ") : "none"}`);
console.log("\nA promotion is an edit to SPECULATION in tools/photos/shell-data.ts, and it ships only after\n`bun run speculation:probe` shows the promoted rule reaching the origin. Read that file's note first.");
