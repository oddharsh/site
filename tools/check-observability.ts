// check-observability.ts — how much of the daily observability-event budget is
// this account actually spending, and where does it go?
//
// WHY THIS EXISTS. Workers tracing is free during the beta and stops being free
// on 2026-10-01, when EACH SPAN becomes one observability event drawing on the
// SAME daily quota as Workers logs: 200,000 events per day on Workers Free
// (https://developers.cloudflare.com/workers/observability/traces/, read
// 2026-08-29). This account stays on Workers Free, and OTLP export, which is
// what would move spans off that quota, is documented as unavailable on Free.
// So the lever is knowing the number.
//
// The number is not the request count. wrangler.jsonc's observability comment
// budgets in SPANS and says so: one /lens scan is 33-46 spans, which puts the
// ceiling at roughly 5,000 scans a day. That is the sentence this tool turns
// into a measurement.
//
// DO NOT reach for head_sampling_rate when the number gets close. Sampling is
// per-WORKER, not per-route, so a fractional rate thins the rare expensive
// events tracing was turned on for (a stalled /lens fan-out, a cron target
// skipped for weeks) at exactly the same rate as the cheap ones. Cut spans on
// the surface that emits them instead.
//
// ── the endpoint, and how it was settled ──────────────────────────────────
// POST /accounts/<id>/workers/observability/telemetry/query, the same endpoint
// the Observability dashboard calls. Two other doors were checked and rejected:
//
//   GraphQL Analytics   introspected 2026-08-29. The account type carries 231
//                       fields and NONE of them is an observability-events
//                       dataset: workersInvocationsAdaptive counts REQUESTS,
//                       and logExplorerIngestionAdaptiveGroups is Log Explorer.
//                       A request count cannot answer a question about spans.
//   /cdn-cgi/local/…    the local explorer CLAUDE.md documents is wrangler dev
//                       only. It reads the isolate's own spans, not the account.
//
// The request schema is not in the prose docs. It is pinned by Cloudflare's own
// clients: the `cloudflare` SDK bundled into wrangler 4.127.0 posts this path,
// and cloudflare/mcp-server-cloudflare's apps/workers-observability declares the
// body as a zod schema (src/types/workers-logs.types.ts). Both were read rather
// than guessed.
//
// `dry` DEFAULTS TO TRUE in that schema. A dry run returns no rows, and a run
// that returns no rows is indistinguishable from a quiet day, so every body
// here sets it false explicitly.
//
// ── the credential ────────────────────────────────────────────────────────
// CLOUDFLARE_API_TOKEN carrying WORKERS OBSERVABILITY : READ. That is a SEVENTH
// read scope and it is deliberately NOT added to the CI token: this is a
// workstation command, it is wired into no workflow, and it gates nothing.
//
// The permission is its own thing rather than a corner of Workers Scripts.
// Measured 2026-08-29 against the real endpoint: wrangler's own OAuth token,
// holding account:read + workers_scripts:write + workers_tail:read and 25 more,
// answers 403 on /telemetry/query and 403 `10104
// workers_observability.api.error.authentication.no_access_to_workers_observability`
// on /telemetry/keys. Cloudflare's observability MCP server names the OAuth
// spelling of the same grant, `workers_observability:read`, in
// src/workers-observability.app.ts. Note that wrangler 4.127.0 DOES request that
// scope at login, so `wrangler login` again is the other way to get it; this
// tool reads the env var, in the shape check-infra.ts's api tier uses.
//
//     CLOUDFLARE_API_TOKEN=... bun run obs:check
//     CLOUDFLARE_API_TOKEN=... bun run obs:check --days 3
//     bun run obs:check --control        # needs no credential
//
// ── the failure this is built around ──────────────────────────────────────
// "0 events today, plenty of headroom" is the most dangerous line this tool
// could print, because a broken read and a quiet day look identical and only one
// of them is reassurance. Four states are separated, and each prints
// differently:
//
//   cannot run    no credential, or the transport threw            exit 2
//   query error   any non-2xx, success!=true, or a 200 whose
//                 count says 0 while an event probe returns a row  exit 1
//   no data       200, well formed, zero across the window, and
//                 the event probe finds nothing either             exit 1
//   zero          one day at 0 inside a window with data           exit 0, "0"
//
// The event probe is the part that earns its call. A count of 0 is only
// believable next to a second query that also finds nothing; if `view: events`
// returns a row over the same window the count is wrong, and Cloudflare's forum
// has a standing report of telemetry/query returning rows_read: 0 while data
// exists. A contradiction is reported as a contradiction.
//
// `--control` proves the separation by pointing the same code at a bad account
// and a malformed query and showing it refuses. It needs no token, because an
// unauthenticated request is refused too and a refusal is the thing under test.
//
// ── what is NOT verified here, and it is the breakdowns ────────────────────
// The three group-by keys — `dataset` for the spans/logs split,
// `$metadata.service` for the Worker, `$metadata.spanName` for the span — are
// read off the event schema those same Cloudflare clients declare. NONE of them
// has been exercised against an authorized call, because no credential on this
// workstation carries the grant. That is why the TOTAL is asked with no group-by
// at all: a wrong key can cost a breakdown and structurally cannot cost the
// number the ceiling is about. A key the API rejects prints its own reason and
// the run continues.

import { readFile } from "node:fs/promises";
import path from "node:path";

import { parseJsonc } from "./lib/jsonc.ts";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

// The published Workers Free ceiling. Printed in the output so the table still
// explains itself a month from now, and named here so there is one copy.
const DAILY_CEILING = 200_000;

// Workers Free retains 3 days. Asking for more returns nothing for the days past
// it, and four empty days read as four zeros that drag every average down, so
// the default window is the retention window rather than a round number.
const RETENTION_DAYS = 3;
const MAX_DAYS = 7;

const DAY_MS = 86_400_000;
const API = "https://api.cloudflare.com/client/v4";

// wrangler.jsonc's observability comment records the per-scan span cost. Quoted
// here to turn the ceiling into a number of scans.
const SPANS_PER_LENS_SCAN = 40;

const ok = (m: string) => console.log(`  ok    ${m}`);
const info = (m: string) => console.log(`  ..    ${m}`);
const bad = (m: string) => console.log(`  FAIL  ${m}`);

type QueryOutcome =
  | { state: "ok"; result: Record<string, unknown> }
  | { state: "error"; why: string };

/**
 * One POST to the telemetry API. Every non-2xx, every success:false, and every
 * missing result is an ERROR rather than an empty reading — that distinction is
 * the whole point of the file.
 */
async function post(
  account: string,
  token: string,
  route: string,
  body: unknown,
): Promise<QueryOutcome> {
  const headers = new Headers({ "content-type": "application/json" });
  // No token is a real case: --control runs unauthenticated on purpose, and an
  // `authorization: Bearer ` with nothing after it is a different request from
  // one with no header at all.
  if (token) headers.set("authorization", `Bearer ${token}`);

  let response: Response;
  try {
    response = await fetch(`${API}/accounts/${account}/workers/observability/telemetry/${route}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
  } catch (e) {
    return { state: "error", why: `transport: ${e instanceof Error ? e.message : String(e)}` };
  }

  const text = await response.text();
  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    parsed = null;
  }

  if (!response.ok) {
    const errors = parsed && Array.isArray(parsed.errors) ? parsed.errors : [];
    const named = errors
      .map((e) => {
        const rec = e as Record<string, unknown>;
        return [rec.code, rec.message].filter(Boolean).join(" ");
      })
      .filter(Boolean)
      .join("; ");
    // A rejected BODY comes back without an `errors` array at all: measured
    // 2026-08-29, an invalid calculation operator answers 400 with
    // {success:false,_e,_i,_c} echoing the request. So the raw body is the
    // fallback, labelled as raw rather than dressed up as a message.
    return { state: "error", why: `HTTP ${response.status} ${named || `raw: ${text.slice(0, 100)}`}` };
  }
  if (!parsed || parsed.success !== true) {
    return { state: "error", why: `HTTP ${response.status} but success is not true: ${text.slice(0, 200)}` };
  }
  const result = parsed.result as Record<string, unknown> | null | undefined;
  if (!result) {
    return { state: "error", why: `HTTP 200 carrying no result object: ${text.slice(0, 200)}` };
  }
  return { state: "ok", result };
}

type Timeframe = { from: number; to: number };

/**
 * A count query. `groupBy` and `granularity` are both optional so the TOTAL can
 * be asked with neither: a total that carries no groupBy cannot fail because a
 * key name was wrong, which keeps the load-bearing number independent of the
 * breakdowns beside it.
 */
function countQuery(timeframe: Timeframe, groupBy?: string, granularity?: number) {
  const parameters: Record<string, unknown> = {
    calculations: [{ operator: "count", alias: "events" }],
  };
  if (groupBy) {
    parameters.groupBys = [{ type: "string", value: groupBy }];
    parameters.limit = 25;
  }
  const query: Record<string, unknown> = {
    queryId: "obs-check",
    view: "calculations",
    // The SDK schema defaults this to true and a dry run returns nothing.
    dry: false,
    parameters,
    timeframe,
  };
  if (granularity) query.granularity = granularity;
  return query;
}

type Aggregate = { groups?: { key: string; value: unknown }[]; value: number; sampleInterval?: number };
type Series = { time: string; data: Aggregate[] };

function calculation(result: Record<string, unknown>): { aggregates: Aggregate[]; series: Series[] } | null {
  const calcs = result.calculations;
  if (!Array.isArray(calcs) || calcs.length === 0) return null;
  const first = calcs[0] as Record<string, unknown>;
  return {
    aggregates: Array.isArray(first.aggregates) ? (first.aggregates as Aggregate[]) : [],
    series: Array.isArray(first.series) ? (first.series as Series[]) : [],
  };
}

/** Sum every aggregate in one bucket. */
function bucketTotal(data: Aggregate[]): number {
  return data.reduce((n, a) => n + (Number(a.value) || 0), 0);
}

/**
 * Cloudflare samples ingestion once an account is over quota, so the rows that
 * come back UNDERSTATE what was ingested — precisely when the answer matters
 * most. A sampleInterval above 1 is that state, and it is surfaced rather than
 * multiplied away.
 */
function sampledAt(series: Series[]): number {
  let worst = 1;
  for (const s of series) for (const d of s.data) worst = Math.max(worst, Number(d.sampleInterval) || 1);
  return worst;
}

const n = (v: number) => v.toLocaleString("en-US");
const pct = (v: number) => `${((v / DAILY_CEILING) * 100).toFixed(1)}%`;

/**
 * The classifier, kept pure so the control can exercise it without a network.
 * `total` is the window's event count, `probeFoundEvent` is whether a second
 * `view: events` query returned a row over the same window.
 */
export function classify(total: number, probeFoundEvent: boolean): "data" | "no-data" | "contradiction" {
  if (total > 0) return "data";
  if (probeFoundEvent) return "contradiction";
  return "no-data";
}

/**
 * The daily table, pure so `--control` can render a synthetic reading and show
 * what a real one looks like without a credential. TODAY is marked partial
 * rather than scored: a day three hours old always looks like headroom, and the
 * peak is taken over COMPLETE days alone for the same reason.
 */
export function dailyTable(series: Series[], split: Series[] | null, todayStart: number): string[] {
  const perDay = new Map<string, Map<string, number>>();
  for (const s of split ?? []) {
    const day = new Date(Number(s.time) || Date.parse(s.time)).toISOString().slice(0, 10);
    const row = perDay.get(day) ?? new Map<string, number>();
    for (const a of s.data) {
      const key = a.groups?.[0] ? String(a.groups[0].value) : "unknown";
      row.set(key, (row.get(key) ?? 0) + (Number(a.value) || 0));
    }
    perDay.set(day, row);
  }
  const datasets = [...new Set([...perDay.values()].flatMap((m) => [...m.keys()]))].sort();

  const lines = [
    `  ${"day".padEnd(12)}${datasets.map((d) => d.padStart(20)).join("")}${"total".padStart(12)}${"of ceiling".padStart(12)}${"headroom".padStart(11)}`,
  ];
  let peak = 0;
  for (const s of series) {
    const stamp = Number(s.time) || Date.parse(s.time);
    const day = new Date(stamp).toISOString().slice(0, 10);
    const total = bucketTotal(s.data);
    const partial = stamp >= todayStart;
    if (!partial) peak = Math.max(peak, total);
    const cells = datasets.map((d) => n(perDay.get(day)?.get(d) ?? 0).padStart(20)).join("");
    const tail = partial
      ? "     partial"
      : `${pct(total).padStart(12)}${`${(100 - (total / DAILY_CEILING) * 100).toFixed(1)}%`.padStart(11)}`;
    lines.push(`  ${day.padEnd(12)}${cells}${n(total).padStart(12)}${tail}`);
  }

  lines.push("");
  if (peak > 0) {
    lines.push(`  worst COMPLETE day: ${n(peak)} events, ${pct(peak)} of the ${n(DAILY_CEILING)} ceiling, ${n(DAILY_CEILING - peak)} to spare.`);
    lines.push(`  that headroom is about ${n(Math.floor((DAILY_CEILING - peak) / SPANS_PER_LENS_SCAN))} more /lens scans at ~${SPANS_PER_LENS_SCAN} spans each.`);
  } else {
    lines.push("  ..    no complete day in the window carried events, so nothing here is measured against a daily ceiling.");
  }
  return lines;
}

async function readAccount(): Promise<string> {
  const wrangler = parseJsonc(await readFile(path.join(ROOT, "wrangler.jsonc"), "utf8")) as Record<string, unknown>;
  return process.env.CLOUDFLARE_ACCOUNT_ID || (wrangler.account_id as string) || "";
}

function windowDays(): number {
  const i = process.argv.indexOf("--days");
  if (i === -1) return RETENTION_DAYS;
  const v = Number(process.argv[i + 1]);
  if (!Number.isInteger(v) || v < 1 || v > MAX_DAYS) {
    bad(`--days wants an integer 1..${MAX_DAYS}; Workers Free retains ${RETENTION_DAYS} days`);
    process.exit(2);
  }
  return v;
}

// ── the control ───────────────────────────────────────────────────────────
// Four cases. The first two are live and need no credential, because an
// unauthenticated request is refused and a refusal is the thing under test.
async function control(): Promise<never> {
  console.log("control: does a failed or empty read ever render as a comfortable zero?\n");
  const account = await readAccount();
  const token = process.env.CLOUDFLARE_API_TOKEN || "";
  const timeframe = { from: Date.now() - DAY_MS, to: Date.now() };
  let failures = 0;

  console.log("live, against the real endpoint:");
  const badAccount = await post("0".repeat(32), token, "query", countQuery(timeframe));
  if (badAccount.state === "error") ok(`bad account id -> refused: ${badAccount.why}`);
  else { bad("bad account id returned a result; the tool would read another account's silence as ours"); failures++; }

  const badQuery = await post(account, token, "query", {
    ...countQuery(timeframe),
    parameters: { calculations: [{ operator: "not-an-operator", alias: "events" }] },
  });
  if (badQuery.state === "error") ok(`malformed query -> refused: ${badQuery.why}`);
  else { bad("a malformed query returned a result rather than an error"); failures++; }

  // WITHOUT a credential both live cases stop at the auth layer and come back
  // byte-identical, so they prove one thing (an unauthenticated read is refused)
  // rather than two. Saying so is the point: a control that reports more
  // coverage than it has is the failure this whole file is about.
  const stoppedAtAuth = (o: QueryOutcome) =>
    o.state === "error" && /9106|Authentication error|Missing X-Auth/.test(o.why);
  if (!token) {
    info("no CLOUDFLARE_API_TOKEN, so both live cases stopped at auth and are ONE assertion, not two.");
    info("Neither the account id nor the query body reached a validator. Re-run with a token for the rest.");
  } else if (stoppedAtAuth(badAccount) && stoppedAtAuth(badQuery)) {
    // An EXPIRED credential lands here and looks exactly like a server that
    // validates nothing, so it is named rather than scored. Both are still
    // refusals, which is the property under test.
    info("the credential did not authenticate, so both live cases stopped at auth and are ONE assertion.");
    info("Check the token before reading this as a finding about the endpoint.");
  } else if (badAccount.state === "error" && badQuery.state === "error") {
    if (badAccount.why !== badQuery.why) {
      ok("the two live refusals DIFFER, so the account id and the query body are both being read");
    } else {
      bad("both live cases returned the same refusal past auth, so neither was validated");
      failures++;
    }
  }

  console.log("\noffline, over the classifier:");
  if (classify(0, false) === "no-data") ok("zero across the window with no event found -> no data");
  else { bad("an empty window classified as data"); failures++; }

  if (classify(0, true) === "contradiction") ok("zero across the window while an event exists -> contradiction");
  else { bad("a count of 0 next to a real event did not read as a contradiction"); failures++; }

  if (classify(12, false) === "data") ok("a real count reads as data, so a genuine 0 for one day still prints as 0");
  else { bad("a real count did not read as data"); failures++; }

  // The same renderer main() uses, over a fixture whose MIDDLE day is a real
  // zero. It has to print `0` beside two days that carried events, because a
  // measured zero and an unreadable window are the two things this file exists
  // to keep apart, and only one of them is allowed to look calm.
  const todayStart = Math.floor(Date.now() / DAY_MS) * DAY_MS;
  const day = (back: number) => String(todayStart - back * DAY_MS);
  const bucket = (v: number, label?: string): Aggregate =>
    label ? { value: v, groups: [{ key: "dataset", value: label }] } : { value: v };
  const rendered = dailyTable(
    [
      { time: day(2), data: [bucket(48_120)] },
      { time: day(1), data: [bucket(0)] },
      { time: day(0), data: [bucket(9_004)] },
    ],
    [
      // The two labels are illustrative. What the API actually calls its
      // datasets is whatever it returns; nothing here asserts the names.
      { time: day(2), data: [bucket(41_010, "traces"), bucket(7_110, "cloudflare-workers")] },
      { time: day(0), data: [bucket(8_000, "traces"), bucket(1_004, "cloudflare-workers")] },
    ],
    todayStart,
  );
  console.log("\nthe same renderer over a SYNTHETIC reading whose middle day is a real zero:");
  for (const line of rendered) console.log(line);
  const zeroRow = rendered.find((l) => l.includes(new Date(todayStart - DAY_MS).toISOString().slice(0, 10)));
  if (zeroRow && /\s0\s/.test(zeroRow) && /100\.0%/.test(zeroRow)) ok("the zero day printed as 0 with full headroom, beside days that carried events");
  else { bad("a measured zero did not render as a zero row"); failures++; }
  if (rendered.some((l) => l.includes("partial"))) ok("today is marked partial rather than scored against a full-day ceiling");
  else { bad("the incomplete current day was scored as if it were a whole day"); failures++; }

  console.log("");
  if (failures === 0) {
    console.log("VERDICT: every failure mode refuses. A zero printed by this tool is a measured zero.");
    process.exit(0);
  }
  console.log(`VERDICT: ${failures} case(s) failed. Do not trust a reading until they pass.`);
  process.exit(1);
}

async function main(): Promise<void> {
  if (process.argv.includes("--control")) await control();

  const days = windowDays();
  const token = process.env.CLOUDFLARE_API_TOKEN;
  if (!token) {
    bad("CLOUDFLARE_API_TOKEN is unset.");
    info("This wants an account token carrying Workers Observability : Read and nothing else.");
    info("It is workstation-only: the CI token's six read scopes do not include it and must not.");
    info("wrangler's own OAuth token does not carry it either (measured 2026-08-29, 403).");
    info("  CLOUDFLARE_API_TOKEN=... bun run obs:check");
    info("Run `bun run obs:check --control` to exercise the failure paths with no credential.");
    process.exit(2);
  }
  const account = await readAccount();
  if (!account) {
    bad("no account id: wrangler.jsonc has no account_id and CLOUDFLARE_ACCOUNT_ID is unset");
    process.exit(2);
  }

  // Whole UTC days, plus however much of today has elapsed. Today is marked
  // partial rather than compared against a full-day ceiling: a day three hours
  // old always looks like headroom.
  const now = Date.now();
  const todayStart = Math.floor(now / DAY_MS) * DAY_MS;
  const timeframe = { from: todayStart - (days - 1) * DAY_MS, to: now };

  console.log(`observability events, account <elided>, ${days} day(s) to ${new Date(now).toISOString()}`);
  console.log(`Workers Free ceiling: ${n(DAILY_CEILING)} events/day, spans and logs sharing one quota.`);
  if (days > RETENTION_DAYS) {
    info(`Workers Free retains ${RETENTION_DAYS} days; anything older reads as empty rather than as zero.`);
  }
  console.log("");

  const totals = await post(account, token, "query", countQuery(timeframe, undefined, DAY_MS));
  if (totals.state === "error") {
    bad(`could not read the event total: ${totals.why}`);
    info("This is a failed query, not a quiet account. Nothing below would be a reading.");
    // A 403 here is one thing in practice. Measured 2026-08-29: a token that
    // authenticates but lacks the grant answers a bare `Forbidden` on /query and
    // `10104 …no_access_to_workers_observability` on /keys, so the endpoint
    // names the permission on one path and not the other.
    if (totals.why.startsWith("HTTP 403")) {
      info("A 403 here means the token authenticated and lacks Workers Observability : Read.");
    }
    process.exit(1);
  }
  const totalCalc = calculation(totals.result);
  if (!totalCalc) {
    bad("the API returned 200 with no calculation block; that is a broken read, not zero events");
    process.exit(1);
  }

  const windowTotal = totalCalc.series.reduce((sum, s) => sum + bucketTotal(s.data), 0);

  // The corroborating probe. A count of 0 is only believable beside a second
  // query that also finds nothing.
  const probe = await post(account, token, "query", {
    queryId: "obs-check-probe",
    view: "events",
    dry: false,
    parameters: {},
    timeframe,
    limit: 1,
  });
  if (probe.state === "error") {
    bad(`the corroborating event probe failed: ${probe.why}`);
    info("Without it a zero cannot be told apart from a broken read, so no total is printed.");
    process.exit(1);
  }
  const probeEvents = (probe.result as { events?: { events?: unknown[] } }).events?.events;
  const probeFoundEvent = Array.isArray(probeEvents) && probeEvents.length > 0;

  const verdict = classify(windowTotal, probeFoundEvent);
  if (verdict === "contradiction") {
    bad("the count says 0 events while an event probe returned a row over the same window");
    info("Cloudflare has a standing report of telemetry/query reading 0 against real data.");
    info("Treat this as a broken instrument and read the dashboard instead.");
    process.exit(1);
  }
  if (verdict === "no-data") {
    bad(`no data: ${days} day(s) returned no events and the event probe found none either`);
    info("Either nothing was recorded, or ingestion is not reaching this account's dataset.");
    info("This is NOT 100% headroom. Confirm in the dashboard before reading it as room to spare.");
    process.exit(1);
  }

  const sample = sampledAt(totalCalc.series);
  if (sample > 1) {
    bad(`Cloudflare is sampling this dataset at 1 in ${sample}: the numbers below UNDERSTATE ingestion`);
    info("Sampling starts when the account is over quota, so read this as already past the ceiling.");
  }

  // ── the daily table ─────────────────────────────────────────────────────
  const split = await post(account, token, "query", countQuery(timeframe, "dataset", DAY_MS));
  const splitCalc = split.state === "ok" ? calculation(split.result) : null;
  for (const line of dailyTable(totalCalc.series, splitCalc?.series ?? null, todayStart)) console.log(line);
  if (!splitCalc) {
    info(`spans/logs split unavailable: ${split.state === "error" ? split.why : "the API returned no grouped calculation"}`);
    info("The totals above are unaffected: they are asked with no group-by at all.");
  }

  // ── where the events come from ──────────────────────────────────────────
  for (const [label, key] of [["worker", "$metadata.service"], ["span name", "$metadata.spanName"]] as const) {
    const by = await post(account, token, "query", countQuery(timeframe, key));
    console.log(`\nevents by ${label} (${days} day window):`);
    if (by.state === "error") { info(`unavailable: ${by.why}`); continue; }
    const calc = calculation(by.result);
    const rows = (calc?.aggregates ?? [])
      .map((a) => ({ name: a.groups?.[0] ? String(a.groups[0].value) : "(none)", value: Number(a.value) || 0 }))
      .sort((a, b) => b.value - a.value)
      .slice(0, 15);
    if (rows.length === 0) { info(`no groups came back for ${key}; the breakdown is missing, not empty`); continue; }
    for (const r of rows) console.log(`  ${r.name.padEnd(34)}${n(r.value).padStart(12)}`);
  }

  console.log("\nTracing is free until 2026-10-01. After that each span is one of these events.");
  process.exit(0);
}

main().catch((e) => {
  bad(e instanceof Error ? (e.stack ?? e.message) : String(e));
  process.exit(2);
});
