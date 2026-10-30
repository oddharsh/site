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
//     tighter floor would turn sampling noise into alarms.
//   CHAIN. A link downstream of an exception must have fired if the exception
//     did. Exceptions reached Cloudflare but no Issues occurrence exists, or
//     occurrences exist but no `workers-issue` GitHub issue was touched: BROKEN.
//     GitHub counts issues UPDATED in the window, because the routine comments
//     on an open issue for a recurrence instead of opening a second one.

export type Reading = { kind: "read"; count: number; last: string | null } | { kind: "unreadable"; reason: string };

export type Readings = {
  days: number;
  now: Date;
  invocations: Reading;
  exceptions: Reading;
  logs: Reading;
  issues: Reading;
  github: Reading;
  spans: Reading;
  perfProbe: Reading;
  botLedger: Reading;
};

export type Verdict = "FIRED" | "SILENT" | "BROKEN" | "UNREADABLE";
export type Row = { signal: string; verdict: Verdict; detail: string };

// The cron at :07 and :37 (src/worker/index.ts, job "home_probe").
export const HOME_PROBE_PER_DAY = 48;
// Two missed ticks plus slack. Older than this, the newest canary row is late.
const CADENCE_STALE_MS = 2 * 3600_000;
// The bot ledger has no schedule, but ClaudeBot alone averaged 303 hits a day
// over the 30 days to 2026-10-29 (/ledger.json), so a silent day is an outage.
const LEDGER_STALE_MS = 24 * 3600_000;

const ago = (now: Date, last: string | null) => (last === null ? Infinity : now.getTime() - Date.parse(last));
const lastSeen = (r: { last: string | null }) => (r.last === null ? "" : `, last ${r.last}`);

function cadence(signal: string, r: Reading, expected: number, now: Date): Row {
  if (r.kind === "unreadable") return { signal, verdict: "UNREADABLE", detail: r.reason };
  const floor = Math.ceil(expected / 2);
  if (r.count < floor) return { signal, verdict: "BROKEN", detail: `${r.count} of ${expected} expected (floor ${floor})${lastSeen(r)}` };
  if (ago(now, r.last) > CADENCE_STALE_MS) return { signal, verdict: "BROKEN", detail: `${r.count} rows, but the newest is ${r.last}: the canary stopped` };
  return { signal, verdict: "FIRED", detail: `${r.count} of ${expected} expected${lastSeen(r)}` };
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
  const { days, now } = r;

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
        : { signal: "exceptions", verdict: "SILENT", detail: "0, so the Issues and GitHub links had nothing to carry; only a drill proves them" },
  );

  // Workers Logs keeps an invocation log per invocation (invocation_logs is on
  // by default), so a week of invocations with zero log lines is a dead pipe.
  rows.push(chained("workers logs", r.logs, { name: "invocations", count: fired(r.invocations) }));
  rows.push(chained("workers issues", r.issues, { name: "exceptions", count: fired(r.exceptions) }));
  // Issues is the routine's trigger. When Issues is unreadable, fall back to the
  // exception count, which is the next-best evidence that it had work to send.
  const issuesUpstream = r.issues.kind === "read" ? { name: "Issues occurrences", count: r.issues.count } : { name: "exceptions", count: fired(r.exceptions) };
  rows.push(chained("github workers-issue", r.github, issuesUpstream));

  rows.push(cadence("span cron.home_probe", r.spans, days * HOME_PROBE_PER_DAY, now));
  rows.push(cadence("ae PERF_PROBE", r.perfProbe, days * HOME_PROBE_PER_DAY, now));

  const ledger = r.botLedger;
  if (ledger.kind === "unreadable") rows.push({ signal: "ae BOT_LEDGER", verdict: "UNREADABLE", detail: ledger.reason });
  else if (ledger.count === 0 || ago(now, ledger.last) > LEDGER_STALE_MS)
    rows.push({ signal: "ae BOT_LEDGER", verdict: "BROKEN", detail: `${ledger.count} rows${lastSeen(ledger)}; organic traffic writes hundreds a day` });
  else rows.push({ signal: "ae BOT_LEDGER", verdict: "FIRED", detail: `${ledger.count}${lastSeen(ledger)}` });

  return rows;
}

// Analytics Engine answers "2026-10-30 02:37:31" with no zone, and it is UTC.
// The SQL API's DateTime64 columns come back the same way. Normalize both to
// ISO so `ago` never reads a UTC time as local.
export function utcIso(value: string | null | undefined): string | null {
  if (!value) return null;
  const iso = /[zZ]|[+-]\d\d:?\d\d$/.test(value) ? value : `${value.replace(" ", "T")}Z`;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}
