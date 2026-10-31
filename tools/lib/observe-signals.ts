// observe-signals.ts — the verdicts behind `bun run observe:check`, which asks
// whether each production observability signal has fired at all in the last N
// days. The reads live in tools/observe-check.ts; this file only judges them,
// so the contract suite can pin every verdict without a network.
//
// It is the read-only half of the observability drill in
// docs/OBSERVABILITY-DRILL.md. "Fired" is a weaker claim than "works": a signal
// that fired last week proves the path was alive then, and a signal with nothing
// to carry (no exception all week) proves nothing either way. The drill is what
// closes that gap; this is what costs nothing to run.
//
// Two kinds of rule:
//   CADENCE. The :07/:37 cron writes one PERF_PROBE row and opens one
//     `cron.home_probe` span every 30 minutes, 48 a day, whether or not anyone
//     visits. Those are the canaries with a known expected count, so a shortfall
//     is BROKEN on its own. The floor is half the expected count: the job is to
//     catch a signal that stopped, and traces are adaptively sampled, so a
//     tighter floor would turn sampling noise into alarms. A canary is also
//     BROKEN when it wrote nothing in its recent window, read as a COUNT over
//     that window. The newest timestamp over the whole window can't be
//     trusted: on 2026-10-30, logs.traces answered 11:07 for the newest
//     `cron.home_probe` span over 7 days, on APPROX_MAX and on ORDER BY
//     LIMIT 1 alike, three reads running, while a 2-hour read listed spans at
//     11:37 through 14:07. Large trace reads are sampled.
//   CHAIN. A link downstream of an exception must have fired if the exception
//     did. Exceptions were thrown but no exception Issue was seen, or Issues
//     were seen but no `workers-issue` GitHub issue was touched: BROKEN.
//     GitHub counts issues UPDATED in the window, because the routine comments
//     on an open issue for a recurrence instead of opening a second one.
//   ROUTE. The Issues automation is configuration, not a signal, but without
//     one nothing past Issues can fire. Zero automations is BROKEN on its own.
//     That was the whole break on 2026-10-30: 3 exception Issues in 7 days,
//     one of them 353 occurrences old, and no automation to send any of them.

// `recent` is the count in the canary's freshness window, for the readings
// the cadence and ledger rules judge.
export type Reading = { kind: "read"; count: number; last: string | null; recent?: number } | { kind: "unreadable"; reason: string };

export type Readings = {
  days: number;
  invocations: Reading;
  exceptions: Reading;
  logs: Reading;
  issues: Reading;
  automations: Reading;
  github: Reading;
  spans: Reading;
  perfProbe: Reading;
  botLedger: Reading;
};

export type Verdict = "FIRED" | "SILENT" | "BROKEN" | "UNREADABLE";
export type Row = { signal: string; verdict: Verdict; detail: string };

// The cron at :07 and :37 (src/worker/index.ts, job "home_probe").
export const HOME_PROBE_PER_DAY = 48;
// Workers Traces keeps 7 days, so a 30-day window holds 7 days of spans. Read
// 2026-10-30: 380 `cron.home_probe` spans over 30 days, 330 over 7.
const TRACE_RETENTION_DAYS = 7;
// Freshness windows. Two hours is four ticks of the :07/:37 cron. The bot
// ledger has no schedule, but ClaudeBot alone averaged 303 hits a day over the
// 30 days to 2026-10-29 (/ledger.json), so a silent day is an outage.
export const CADENCE_FRESH_HOURS = 2;
export const LEDGER_FRESH_HOURS = 24;

const lastSeen = (r: { last: string | null }) => (r.last === null ? "" : `, last ${r.last}`);
// A reading with no recent count fails closed: nothing proves it is fresh.
const recentCount = (r: { recent?: number }) => r.recent ?? 0;

function cadence(signal: string, r: Reading, expected: number): Row {
  if (r.kind === "unreadable") return { signal, verdict: "UNREADABLE", detail: r.reason };
  const floor = Math.ceil(expected / 2);
  if (r.count < floor) return { signal, verdict: "BROKEN", detail: `${r.count} of ${expected} expected (floor ${floor})` };
  if (recentCount(r) === 0) return { signal, verdict: "BROKEN", detail: `${r.count} rows, but none in the last ${CADENCE_FRESH_HOURS}h: the canary stopped` };
  return { signal, verdict: "FIRED", detail: `${r.count} of ${expected} expected, ${recentCount(r)} in the last ${CADENCE_FRESH_HOURS}h` };
}

// A link that should have fired because `upstream` did.
function chained(signal: string, r: Reading, upstream: { name: string; count: number } | null): Row {
  if (r.kind === "unreadable") return { signal, verdict: "UNREADABLE", detail: r.reason };
  if (r.count > 0) return { signal, verdict: "FIRED", detail: `${r.count}${lastSeen(r)}` };
  if (upstream && upstream.count > 0) return { signal, verdict: "BROKEN", detail: `0, after ${upstream.count} ${upstream.name}` };
  return { signal, verdict: "SILENT", detail: "0, and nothing upstream fired, so this proves nothing either way" };
}

const fired = (r: Reading) => (r.kind === "read" ? r.count : 0);

export function verdicts(r: Readings): Row[] {
  const rows: Row[] = [];
  const { days } = r;

  rows.push(
    r.invocations.kind === "unreadable"
      ? { signal: "invocations", verdict: "UNREADABLE", detail: r.invocations.reason }
      : { signal: "invocations", verdict: r.invocations.count > 0 ? "FIRED" : "BROKEN", detail: `${r.invocations.count}` },
  );

  rows.push(
    r.exceptions.kind === "unreadable"
      ? { signal: "exceptions", verdict: "UNREADABLE", detail: r.exceptions.reason }
      : r.exceptions.count > 0
        ? { signal: "exceptions", verdict: "FIRED", detail: `${r.exceptions.count}${lastSeen(r.exceptions)}` }
        : { signal: "exceptions", verdict: "SILENT", detail: "0 thrown; Issues also records caught errors and 5xx responses" },
  );

  // Workers Logs keeps an invocation log per invocation (invocation_logs is on
  // by default), so a week of invocations with zero log lines is a dead pipe.
  rows.push(chained("workers logs", r.logs, { name: "invocations", count: fired(r.invocations) }));
  rows.push(chained("workers issues", r.issues, { name: "exceptions", count: fired(r.exceptions) }));

  const route = r.automations;
  if (route.kind === "unreadable") rows.push({ signal: "issues automation", verdict: "UNREADABLE", detail: route.reason });
  else if (route.count === 0)
    rows.push({
      signal: "issues automation",
      verdict: "BROKEN",
      detail: fired(r.issues) > 0 ? `0 configured, so ${fired(r.issues)} exception Issues went nowhere` : "0 configured, so no Issue can reach the routine",
    });
  else rows.push({ signal: "issues automation", verdict: "FIRED", detail: `${route.count} configured` });

  // Issues is the routine's trigger. When Issues is unreadable, fall back to the
  // exception count, which is the next-best evidence that it had work to send.
  const issuesUpstream = r.issues.kind === "read" ? { name: "exception Issues", count: r.issues.count } : { name: "exceptions", count: fired(r.exceptions) };
  rows.push(chained("github workers-issue", r.github, issuesUpstream));

  rows.push(cadence("span cron.home_probe", r.spans, Math.min(days, TRACE_RETENTION_DAYS) * HOME_PROBE_PER_DAY));
  rows.push(cadence("ae PERF_PROBE", r.perfProbe, days * HOME_PROBE_PER_DAY));

  const ledger = r.botLedger;
  if (ledger.kind === "unreadable") rows.push({ signal: "ae BOT_LEDGER", verdict: "UNREADABLE", detail: ledger.reason });
  else {
    const fresh = `${recentCount(ledger)} in the last ${LEDGER_FRESH_HOURS}h`;
    if (recentCount(ledger) === 0)
      rows.push({ signal: "ae BOT_LEDGER", verdict: "BROKEN", detail: `${ledger.count} rows, ${fresh}; organic traffic writes hundreds a day` });
    else rows.push({ signal: "ae BOT_LEDGER", verdict: "FIRED", detail: `${ledger.count}, ${fresh}` });
  }

  return rows;
}
