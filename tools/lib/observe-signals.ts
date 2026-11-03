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
//     one nothing past Issues can fire. That was the whole break on
//     2026-10-30: 3 exception Issues in 7 days, one of them 353 occurrences
//     old, and no automation to send any of them. A count is too weak a
//     test, because an automation can exist and still send nowhere: it names
//     a Notifications policy, and the policy names the webhook it delivers
//     to. The route reads FIRED only when an enabled automation's enabled
//     policy delivers to a Claude Code routine's fire URL, and that webhook's
//     last delivery didn't fail (gotcha 93).

// `recent` is the count in the canary's freshness window, for the readings
// the cadence and ledger rules judge.
export type Reading = { kind: "read"; count: number; last: string | null; recent?: number } | { kind: "unreadable"; reason: string };

// The Issues route as three Cloudflare lists, in the shapes the API returns:
// `cf observability issues automations list`, `cf alerting policies list` and
// `cf alerting destinations webhooks list`.
export type Automation = { id: string; name?: string; enabled: boolean; policyId: string };
export type Policy = { id: string; name: string; enabled: boolean; mechanisms: { webhooks?: { id: string }[]; email?: { id: string }[] } };
export type Webhook = { id: string; name: string; url: string; last_success?: string | null; last_failure?: string | null };
export type Route = { kind: "read"; automations: Automation[]; policies: Policy[]; webhooks: Webhook[] } | { kind: "unreadable"; reason: string };

// A routine's API trigger, https://code.claude.com/docs/en/routines#add-an-api-trigger.
const ROUTINE_FIRE = /^https:\/\/api\.anthropic\.com\/v1\/claude_code\/routines\/(trig_[A-Za-z0-9]+)\/fire$/;

export type Readings = {
  days: number;
  invocations: Reading;
  exceptions: Reading;
  logs: Reading;
  issues: Reading;
  route: Route;
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

// Walk automation -> policy -> webhook and name the first link that drops.
function route(r: Route, issues: number): Row {
  const signal = "issues automation";
  if (r.kind === "unreadable") return { signal, verdict: "UNREADABLE", detail: r.reason };
  const broken = (detail: string): Row => ({ signal, verdict: "BROKEN", detail });
  if (r.automations.length === 0)
    return broken(issues > 0 ? `0 configured, so ${issues} exception Issues went nowhere` : "0 configured, so no Issue can reach the routine");
  const enabled = r.automations.filter((a) => a.enabled);
  if (enabled.length === 0) return broken(`${r.automations.length} configured, none enabled`);

  const sends: string[] = [];
  for (const a of enabled) {
    const policy = r.policies.find((p) => p.id === a.policyId);
    if (!policy) {
      sends.push(`${a.name ?? a.id} names policy ${a.policyId}, which doesn't exist`);
      continue;
    }
    if (!policy.enabled) {
      sends.push(`${a.name ?? a.id} sends through policy "${policy.name}", which is disabled`);
      continue;
    }
    const hooks = (policy.mechanisms.webhooks ?? []).map((m) => r.webhooks.find((w) => w.id === m.id)).filter((w) => w !== undefined);
    const routine = hooks.find((w) => ROUTINE_FIRE.test(w.url));
    if (!routine) {
      const to = [...hooks.map((w) => `webhook "${w.name}"`), ...(policy.mechanisms.email ?? []).map(() => "email")];
      sends.push(`${a.name ?? a.id} sends to ${to.length ? to.join(", ") : "nothing"}, not a Claude Code routine`);
      continue;
    }
    // Timestamps are ISO 8601 UTC, so they compare as strings.
    const failure = routine.last_failure ?? "";
    if (failure > (routine.last_success ?? "")) {
      sends.push(`${a.name ?? a.id} reaches webhook "${routine.name}", whose last delivery failed at ${failure}`);
      continue;
    }
    const trigger = ROUTINE_FIRE.exec(routine.url)?.[1];
    const delivered = routine.last_success ? `, last delivered ${routine.last_success}` : ", nothing delivered yet";
    return { signal, verdict: "FIRED", detail: `${a.name ?? a.id} reaches routine ${trigger}${delivered}` };
  }
  return broken(sends.join("; "));
}

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

  rows.push(route(r.route, fired(r.issues)));

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
