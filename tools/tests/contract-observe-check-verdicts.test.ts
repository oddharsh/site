// ── observe:check verdicts (tools/lib/observe-signals.ts) ──────────────────
// The read-only half of the observability drill judges readings it cannot
// re-fetch in a test, so the judging is a pure function and pinned here. Each
// BROKEN case sits beside the same reading one step healthier, so a rule that
// cannot fire fails the healthy control rather than passing.
import { assert, test } from "./contract-shared.ts";
import { utcIso, verdicts, type Reading, type Readings } from "../lib/observe-signals.ts";

const NOW = new Date("2026-10-30T03:00:00.000Z");
const read = (count: number, last: string | null = null): Reading => ({ kind: "read", count, last });
const denied: Reading = { kind: "unreadable", reason: "HTTP 403 Authorization error" };

// A healthy, quiet week: the shape of the 2026-10-29 run once every link is readable.
function week(over: Partial<Readings> = {}): Readings {
  return {
    days: 7,
    now: NOW,
    invocations: read(33693),
    exceptions: read(0),
    logs: read(40000, "2026-10-30T02:58:00.000Z"),
    issues: read(0),
    github: read(0),
    spans: read(336, "2026-10-30T02:37:31.000Z"),
    perfProbe: read(336, "2026-10-30T02:37:31.000Z"),
    botLedger: read(4064, "2026-10-30T02:21:57.000Z"),
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

test("observe:check: Issues occurrences, when readable, are what GitHub is held to", () => {
  const issuesOnly = week({ exceptions: read(0), issues: read(2, "2026-10-29T10:00:00.000Z"), github: read(0) });
  assert.equal(row(issuesOnly, "github workers-issue")?.detail, "0, after 2 Issues occurrences");
  const noIssues = week({ exceptions: read(4, "2026-10-29"), issues: read(0) });
  assert.deepEqual(row(noIssues, "workers issues"), { signal: "workers issues", verdict: "BROKEN", detail: "0, after 4 exceptions" });
});

test("observe:check: a canary below half its cadence, or late, is BROKEN", () => {
  assert.deepEqual(row(week({ perfProbe: read(100, "2026-10-30T02:37:31.000Z") }), "ae PERF_PROBE"), {
    signal: "ae PERF_PROBE",
    verdict: "BROKEN",
    detail: "100 of 336 expected (floor 168), last 2026-10-30T02:37:31.000Z",
  });
  assert.equal(row(week({ perfProbe: read(168, "2026-10-30T02:37:31.000Z") }), "ae PERF_PROBE")?.verdict, "FIRED");
  assert.equal(row(week({ spans: read(336, "2026-10-30T00:30:00.000Z") }), "span cron.home_probe")?.verdict, "BROKEN");
  assert.equal(row(week({ spans: read(336, "2026-10-30T01:30:00.000Z") }), "span cron.home_probe")?.verdict, "FIRED");
});

test("observe:check: a refused read is UNREADABLE, never a quiet SILENT", () => {
  assert.deepEqual(row(week({ logs: denied }), "workers logs"), { signal: "workers logs", verdict: "UNREADABLE", detail: "HTTP 403 Authorization error" });
  assert.deepEqual(row(week({ logs: read(0) }), "workers logs"), { signal: "workers logs", verdict: "BROKEN", detail: "0, after 33693 invocations" });
});

test("observe:check: zoneless timestamps are read as UTC", () => {
  assert.equal(utcIso("2026-10-30 02:37:31"), "2026-10-30T02:37:31.000Z");
  assert.equal(utcIso("2026-10-14"), "2026-10-14T00:00:00.000Z");
  assert.equal(utcIso("2026-10-30T02:37:31.000Z"), "2026-10-30T02:37:31.000Z");
  assert.equal(utcIso(""), null);
});
