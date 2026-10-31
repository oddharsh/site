// ── observe:check verdicts (tools/lib/observe-signals.ts) ──────────────────
// The read-only half of the observability drill judges readings it cannot
// re-fetch in a test, so the judging is a pure function and pinned here. Each
// BROKEN case sits beside the same reading one step healthier, so a rule that
// cannot fire fails the healthy control rather than passing.
import { assert, test } from "./contract-shared.ts";
import { verdicts, type Reading, type Readings } from "../lib/observe-signals.ts";

const read = (count: number, last: string | null = null): Reading => ({ kind: "read", count, last });
const canary = (count: number, recent: number): Reading => ({ kind: "read", count, last: null, recent });
const denied: Reading = { kind: "unreadable", reason: "HTTP 403 Authorization error" };

// A healthy, quiet week: the shape of the 2026-10-30 run with an automation configured.
function week(over: Partial<Readings> = {}): Readings {
  return {
    days: 7,
    invocations: read(34178),
    exceptions: read(0),
    logs: read(51420),
    issues: read(0),
    automations: read(1),
    github: read(0),
    spans: canary(330, 4),
    perfProbe: canary(335, 4),
    botLedger: canary(6885, 980),
    ...over,
  };
}

const row = (r: Readings, signal: string) => verdicts(r).find((x) => x.signal === signal);

test("observe:check: a quiet healthy week reads FIRED for the canaries and SILENT for the chain", () => {
  assert.deepEqual(
    verdicts(week()).map((r) => `${r.verdict} ${r.signal}`),
    [
      "FIRED invocations",
      "SILENT exceptions",
      "FIRED workers logs",
      "SILENT workers issues",
      "FIRED issues automation",
      "SILENT github workers-issue",
      "FIRED span cron.home_probe",
      "FIRED ae PERF_PROBE",
      "FIRED ae BOT_LEDGER",
    ],
  );
});

test("observe:check: exceptions with no GitHub issue is BROKEN, and one updated issue clears it", () => {
  // Issues unreadable, as under the wrangler OAuth login: the rule falls back to the exception count.
  const dropped = week({ exceptions: read(13, "2026-10-14"), issues: denied, github: read(0) });
  assert.deepEqual(row(dropped, "github workers-issue"), { signal: "github workers-issue", verdict: "BROKEN", detail: "0, after 13 exceptions" });
  assert.deepEqual(row(dropped, "workers issues"), { signal: "workers issues", verdict: "UNREADABLE", detail: "HTTP 403 Authorization error" });
  const carried = week({ exceptions: read(13, "2026-10-14"), issues: denied, github: read(1, "2026-10-14T06:00:00Z") });
  assert.equal(row(carried, "github workers-issue")?.verdict, "FIRED");
});

test("observe:check: exception Issues, when readable, are what GitHub is held to", () => {
  const issuesOnly = week({ exceptions: read(0), issues: read(2, "2026-10-29T10:00:00.000Z"), github: read(0) });
  assert.equal(row(issuesOnly, "github workers-issue")?.detail, "0, after 2 exception Issues");
  const noIssues = week({ exceptions: read(4, "2026-10-29"), issues: read(0) });
  assert.deepEqual(row(noIssues, "workers issues"), { signal: "workers issues", verdict: "BROKEN", detail: "0, after 4 exceptions" });
});

test("observe:check: no Issues automation is BROKEN, and says how many Issues it stranded", () => {
  // The 2026-10-30 reading: three exception Issues in the week, nothing routing them.
  assert.deepEqual(row(week({ issues: read(3, "2026-10-30T13:23:55.950Z"), automations: read(0) }), "issues automation"), {
    signal: "issues automation",
    verdict: "BROKEN",
    detail: "0 configured, so 3 exception Issues went nowhere",
  });
  assert.equal(row(week({ automations: read(0) }), "issues automation")?.detail, "0 configured, so no Issue can reach the routine");
  assert.deepEqual(row(week({ issues: read(3, "2026-10-30T13:23:55.950Z"), automations: read(1) }), "issues automation"), {
    signal: "issues automation",
    verdict: "FIRED",
    detail: "1 configured",
  });
});

test("observe:check: a canary below half its cadence, or silent in its window, is BROKEN", () => {
  assert.deepEqual(row(week({ perfProbe: canary(100, 4) }), "ae PERF_PROBE"), {
    signal: "ae PERF_PROBE",
    verdict: "BROKEN",
    detail: "100 of 336 expected (floor 168)",
  });
  assert.equal(row(week({ perfProbe: canary(168, 4) }), "ae PERF_PROBE")?.verdict, "FIRED");
  assert.deepEqual(row(week({ spans: canary(330, 0) }), "span cron.home_probe"), {
    signal: "span cron.home_probe",
    verdict: "BROKEN",
    detail: "330 rows, but none in the last 2h: the canary stopped",
  });
  assert.deepEqual(row(week({ spans: canary(330, 1) }), "span cron.home_probe"), {
    signal: "span cron.home_probe",
    verdict: "FIRED",
    detail: "330 of 336 expected, 1 in the last 2h",
  });
  // No recent count at all fails closed: nothing proves the canary is alive.
  assert.equal(row(week({ spans: read(330) }), "span cron.home_probe")?.verdict, "BROKEN");
});

test("observe:check: a 30-day window holds traces to their 7 days of retention", () => {
  // The 2026-10-30 30-day read: 380 spans, which a 1440-span floor called BROKEN.
  const month = week({ days: 30, spans: canary(380, 4), perfProbe: canary(1526, 4) });
  assert.equal(row(month, "span cron.home_probe")?.detail, "380 of 336 expected, 4 in the last 2h");
  assert.equal(row(month, "ae PERF_PROBE")?.detail, "1526 of 1440 expected, 4 in the last 2h");
});

test("observe:check: a bot ledger with no row in a day is BROKEN", () => {
  assert.deepEqual(row(week({ botLedger: canary(6885, 0) }), "ae BOT_LEDGER"), {
    signal: "ae BOT_LEDGER",
    verdict: "BROKEN",
    detail: "6885 rows, 0 in the last 24h; organic traffic writes hundreds a day",
  });
  assert.equal(row(week({ botLedger: canary(6885, 1) }), "ae BOT_LEDGER")?.detail, "6885, 1 in the last 24h");
});

test("observe:check: a refused read is UNREADABLE, never a quiet SILENT", () => {
  assert.deepEqual(row(week({ logs: denied }), "workers logs"), { signal: "workers logs", verdict: "UNREADABLE", detail: "HTTP 403 Authorization error" });
  assert.deepEqual(row(week({ logs: read(0) }), "workers logs"), { signal: "workers logs", verdict: "BROKEN", detail: "0, after 34178 invocations" });
});
