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
// here sets it false explicitly AND every response is checked for the `run.dry`
// the API echoes back. Sending a flag is not the same as the server honouring
// it, and this is the one design point where the failure mode is precisely the
// empty reading the file exists to refuse.
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
// of them is reassurance. THE RULE THE WHOLE FILE SERVES: a number is printed
// only when it is a MEASUREMENT. Everything else refuses, loudly, non-zero. A
// warning line above a table of wrong numbers is not a refusal, because the
// numbers are what a reader acts on.
//
//   cannot run     no credential, no account id, or the transport
//                  never reached the API                            exit 2
//   query error    any non-2xx, success!=true, a result whose `run`
//                  block does not echo what was asked, a malformed
//                  probe payload, a sampled dataset, or a count of
//                  0 while an event probe returns a row             exit 1
//   no data        well formed, zero across the window, and the
//                  event probe finds nothing either                 exit 1
//   zero           one day at 0 inside a window with data           exit 0, "0"
//
// Three of those refusals were shipped as WARNINGS in #667 and each printed a
// full table of headroom underneath itself. Sampling read `0.9% of ceiling,
// 99.1% headroom` on a dataset sampled 1 in 100; an hourly `granularity` echo
// rendered 24 buckets as 24 days and understated the peak 24x; and a day past
// retention printed `0` with `100.0%` headroom in the same column as a measured
// zero. All three now refuse before anything numeric reaches the terminal.
//
// The event probe is the part that earns its call. A count of 0 is only
// believable next to a second query that also finds nothing; if `view: events`
// returns a row over the same window the count is wrong, and Cloudflare's forum
// has a standing report of telemetry/query returning rows_read: 0 while data
// exists. A contradiction is reported as a contradiction.
//
// ONE COUNT IS CORROBORATED THAT WAY, THE WINDOW TOTAL, and #667 claimed all of
// them were. The per-day counts, the dataset split and the two breakdowns are
// not, because `view: events` answers "does any event exist in this window" and
// nothing finer: corroborating a single day needs its own query per day, which
// multiplies calls against a rate-limited API to answer a question the day's own
// `run` echo already settles. So the per-day tier is defended by asserting the
// GRANULARITY the API says it used, and the claim here is narrowed to match.
//
// `--control` proves the separation by pointing the same code at a bad account
// and a malformed query and showing it refuses. It needs no token, because an
// unauthenticated request is refused too and a refusal is the thing under test.
// Its two live cases assert an HTTP RESPONSE ARRIVED, since a transport failure
// refuses just as loudly while proving nothing about the endpoint.
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
//
// NOTHING HERE READS THE PLAN, and the output says so on every run. The token
// this tool wants carries Workers Observability : Read alone, which cannot see a
// subscription, and widening it to find out would cost a scope for a sentence.
// So the assumption is DISCLOSED rather than checked, because every percentage
// below is a share of a plan-specific ceiling and the Paid figure is not a
// bigger version of this one: it is 20 million per MONTH (+$0.60/million), over
// a different period, with 7 days of retention rather than 3
// (developers.cloudflare.com/workers/observability/traces/, read 2026-08-29).
// A reader on Paid must not read these percentages at all. CLAUDE.md's KV note
// and gotcha 36 are both this same bill: a ceiling reasoned about without first
// asking which plan the account is on.
const PLAN = "Workers Free";
const DAILY_CEILING = 200_000;
const PAID_MONTHLY = "20 million events/month";

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

// THREE states, and the split between the last two is what makes the control
// worth running. A `transport` never reached Cloudflare: DNS, a dropped socket,
// an offline laptop, a stubbed fetch that throws. An `error` is the API itself
// refusing, which is the only outcome that proves anything about the endpoint.
// #667 collapsed both into one `error`, so `--control` printed two green
// "refused" lines with the network unreachable and the endpoint untouched.
type QueryOutcome =
  | { state: "ok"; result: Record<string, unknown> }
  | { state: "error"; why: string; status: number }
  | { state: "transport"; why: string };

/** Anything that is not a reading, rendered the same way wherever it is caught. */
const why = (o: QueryOutcome): string => (o.state === "ok" ? "" : o.why);

// A hung connection is a hung command. 20s is far above the ~1s this endpoint
// answers in and far below the patience of somebody who has walked away.
const REQUEST_TIMEOUT_MS = 20_000;

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
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (e) {
    return { state: "transport", why: `transport: ${e instanceof Error ? e.message : String(e)}` };
  }

  let text: string;
  try {
    text = await response.text();
  } catch (e) {
    // The status line arrived and the body did not. That is still a connection
    // that failed rather than an API that answered, so it lands as transport.
    return { state: "transport", why: `transport: body never arrived (${e instanceof Error ? e.message : String(e)})` };
  }
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
    return {
      state: "error",
      status: response.status,
      why: `HTTP ${response.status} ${named || `raw: ${text.slice(0, 100)}`}`,
    };
  }
  if (!parsed || parsed.success !== true) {
    return {
      state: "error",
      status: response.status,
      why: `HTTP ${response.status} but success is not true: ${text.slice(0, 200)}`,
    };
  }
  const result = parsed.result as Record<string, unknown> | null | undefined;
  if (!result) {
    return { state: "error", status: response.status, why: `HTTP 200 carrying no result object: ${text.slice(0, 200)}` };
  }
  return { state: "ok", result };
}

/**
 * Did the API run the query that was ASKED for? The response echoes the resolved
 * run back, and both fields it echoes are ones a caller can get silently wrong:
 * `dry` defaults to true in Cloudflare's own schema, and `granularity` is what
 * decides whether a bucket is an hour or a day.
 *
 * Returns null when the echo agrees, or the reason it does not. An ABSENT `run`
 * block is a reason too: unverifiable and verified are different states, and
 * this file may only print numbers it can vouch for.
 */
export function checkRun(
  result: Record<string, unknown>,
  expect: { granularity?: number } = {},
): string | null {
  const run = result.run as Record<string, unknown> | undefined;
  if (!run) return "the response carried no `run` block, so nothing echoes back what was executed";
  if (run.dry !== false) return `the API ran this as dry=${JSON.stringify(run.dry)}; a dry run returns no rows and reads as a quiet day`;
  if (expect.granularity === undefined) return null;
  const got = Number(run.granularity);
  if (!Number.isFinite(got)) return `granularity came back as ${JSON.stringify(run.granularity)} rather than a number`;
  if (got !== expect.granularity) {
    return `asked for ${expect.granularity}ms buckets and the API used ${got}ms, so each row is ${(expect.granularity / got).toFixed(2)}x smaller than a day`;
  }
  return null;
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
 * A `sampleInterval` above 1 says these rows are 1 in N of what was ingested, so
 * every count under them understates the real number by an unknown factor.
 *
 * WHY THIS REFUSES RATHER THAN SCALES. Multiplying by N produces an estimate,
 * and this file's rule is that a printed number is a measurement. The estimate
 * is also unverifiable from here in a way the window total is not: the event
 * probe answers "does a row exist", which cannot check a multiplied count, and
 * head-based sampling is applied per request at ingest, so the interval that
 * reaches one bucket need not be the one that reached another. Scaling would
 * therefore hand a reader a headroom figure with no error bar on the one axis
 * they act on. The dashboard is the place to read a sampled account.
 *
 * The ADVICE that used to sit at the refusal was wrong and is worth naming.
 * #667 printed "sampling starts when the account is over quota, so read this as
 * already past the ceiling." Cloudflare puts the trigger at 5 BILLION logs per
 * account per day, after which a 1% head-based sample applies for the remainder
 * of the day (developers.cloudflare.com/workers/observability/logs/workers-logs/,
 * Limits, footnote 1, read 2026-08-29). That is 25,000x the 200,000/day ceiling
 * this tool prints and has nothing to do with exceeding the Free quota. The
 * likelier source of a non-unit interval here is a configured
 * `head_sampling_rate`, which is a per-Worker setting rather than a symptom.
 */
function sampledAt(series: Series[]): number {
  let worst = 1;
  for (const s of series) for (const d of s.data) worst = Math.max(worst, Number(d.sampleInterval) || 1);
  return worst;
}

const n = (v: number) => v.toLocaleString("en-US");

/**
 * Share of the daily ceiling and the headroom beside it, ROUNDED ONCE and then
 * complemented, so the pair always sums to 100.0. Computing each from the raw
 * value rounds twice: 1,500 events printed 0.8% used and 99.3% left in #667.
 */
function share(v: number): { used: string; left: string } {
  const used = Number(((v / DAILY_CEILING) * 100).toFixed(1));
  return { used: `${used.toFixed(1)}%`, left: `${(100 - used).toFixed(1)}%` };
}
const pct = (v: number) => share(v).used;

/**
 * The classifier, kept pure so the control and the contract test can exercise it
 * without a network. `total` is the window's event count, `probeFoundEvent` is
 * whether a second `view: events` query returned a row over the same window, and
 * `sampleInterval` is the worst interval any bucket reported.
 *
 * SAMPLING IS TESTED FIRST and beats a real count, which is the ordering that
 * matters: #667 checked it AFTER deciding there was data, printed a FAIL line,
 * and then rendered the whole table anyway. A count that understates ingestion
 * by an unknown factor is not a reading no matter how large it is.
 */
export function classify(
  total: number,
  probeFoundEvent: boolean,
  sampleInterval = 1,
): "data" | "no-data" | "contradiction" | "sampled" {
  if (sampleInterval > 1) return "sampled";
  if (total > 0) return "data";
  if (probeFoundEvent) return "contradiction";
  return "no-data";
}

/**
 * The daily table, pure so `--control` can render a synthetic reading and show
 * what a real one looks like without a credential. TODAY is marked partial
 * rather than scored: a day three hours old always looks like headroom, and the
 * peak is taken over COMPLETE days alone for the same reason.
 *
 * A day older than `retentionStart` gets the SAME treatment for the same reason,
 * which #667 gave only to today. `--days 7` on a 3-day plan asked for four days
 * the API cannot answer for and rendered each as `0  0  0.0%  100.0%`, in the
 * column and the format a measured zero uses. An expired day carrying no events
 * prints `-`, because the honest statement is that nothing was read rather than
 * that nothing happened; one carrying events prints them, since that is data and
 * also evidence the retention assumption is wrong. Neither is scored, and
 * neither ever shows headroom: retention truncates from the start of the day, so
 * a surviving count understates in exactly the direction a headroom figure
 * would flatter.
 */
export function dailyTable(
  series: Series[],
  split: Series[] | null,
  todayStart: number,
  retentionStart = -Infinity,
): string[] {
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
  let expired = 0;
  for (const s of series) {
    const stamp = Number(s.time) || Date.parse(s.time);
    const day = new Date(stamp).toISOString().slice(0, 10);
    const total = bucketTotal(s.data);
    const partial = stamp >= todayStart;
    const past = stamp < retentionStart;
    if (past) expired++;
    if (!partial && !past) peak = Math.max(peak, total);
    const unread = past && total === 0;
    const cells = datasets.map((d) => (unread ? "-" : n(perDay.get(day)?.get(d) ?? 0)).padStart(20)).join("");
    const count = (unread ? "-" : n(total)).padStart(12);
    const s2 = share(total);
    const tail = past
      ? "  past retention"
      : partial
        ? "     partial"
        : `${s2.used.padStart(12)}${s2.left.padStart(11)}`;
    lines.push(`  ${day.padEnd(12)}${cells}${count}${tail}`);
  }

  lines.push("");
  if (expired > 0) {
    lines.push(`  ..    ${expired} day(s) sit past the ${RETENTION_DAYS}-day ${PLAN} retention window and are NOT a reading:`);
    lines.push("        no count, no share, no headroom. Ask for a window inside retention instead.");
  }
  if (peak > 0) {
    lines.push(`  worst COMPLETE day: ${n(peak)} events, ${pct(peak)} of the ${n(DAILY_CEILING)} ${PLAN} ceiling, ${n(DAILY_CEILING - peak)} to spare.`);
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

/**
 * A window this plan cannot answer for is REFUSED at the flag rather than
 * rendered with holes in it. #667 accepted `--days 7`, asked for four days
 * outside the 3-day retention window, and printed each as `0` with `100.0%`
 * headroom, which is the shape of a measured quiet day. The renderer marks an
 * expired row now (defence in depth, since a window edge or a clock skew can
 * still deliver one), and the flag no longer asks for a single one on purpose.
 *
 * MAX_DAYS stays as the parse bound because Workers Paid retains 7, so the
 * number is real; what refuses here is the retention of the plan this tool
 * prints ceilings for.
 */
function windowDays(): number {
  const i = process.argv.indexOf("--days");
  if (i === -1) return RETENTION_DAYS;
  const v = Number(process.argv[i + 1]);
  if (!Number.isInteger(v) || v < 1 || v > MAX_DAYS) {
    bad(`--days wants an integer 1..${MAX_DAYS}; ${PLAN} retains ${RETENTION_DAYS} days`);
    process.exit(2);
  }
  if (v > RETENTION_DAYS) {
    bad(`--days ${v} asks for ${v - RETENTION_DAYS} day(s) past the ${RETENTION_DAYS}-day ${PLAN} retention window`);
    info("Those days return nothing, and nothing is not a zero. Every count and share here assumes");
    info(`${PLAN}; Workers Paid retains ${MAX_DAYS} days and its allowance is ${PAID_MONTHLY} instead.`);
    info(`Run it inside retention: bun run obs:check --days ${RETENTION_DAYS}`);
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
  // A live case may only pass on an HTTP RESPONSE. #667 asserted `state ===
  // "error"` alone, which a stubbed or dead network satisfies, so with fetch
  // throwing this printed two green "refused: transport: Unable to connect"
  // lines under this very heading. A control that passes without reaching the
  // endpoint is decoration.
  const live = (label: string, o: QueryOutcome): boolean => {
    if (o.state === "error") { ok(`${label} -> refused by the API: ${o.why}`); return true; }
    if (o.state === "transport") { bad(`${label} -> the request never reached the API (${o.why}), so this case proved nothing`); return false; }
    bad(`${label} returned a result rather than an error`);
    return false;
  };

  const badAccount = await post("0".repeat(32), token, "query", countQuery(timeframe));
  if (!live("bad account id", badAccount)) failures++;

  const badQuery = await post(account, token, "query", {
    ...countQuery(timeframe),
    parameters: { calculations: [{ operator: "not-an-operator", alias: "events" }] },
  });
  if (!live("malformed query", badQuery)) failures++;

  // WITHOUT a credential both live cases stop at the auth layer and come back
  // byte-identical, so they prove one thing (an unauthenticated read is refused)
  // rather than two. Saying so is the point: a control that reports more
  // coverage than it has is the failure this whole file is about.
  const stoppedAtAuth = (o: QueryOutcome) =>
    o.state === "error" && /9106|Authentication error|Missing X-Auth/.test(o.why);
  if (badAccount.state === "transport" || badQuery.state === "transport") {
    info("At least one live case never left this machine, so the two rows above are about the network.");
    info("Re-run with the endpoint reachable before reading anything here as a fact about the API.");
  } else if (!token) {
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

  // The three refusals #667 shipped as warnings, each asserted at the function
  // that now makes them refusals.
  if (classify(181_000, true, 100) === "sampled") ok("a sampled dataset refuses even with a large count beside it");
  else { bad("a 1-in-100 sample classified as a reading"); failures++; }

  if (checkRun({ run: { dry: false, granularity: 3_600_000 } }, { granularity: DAY_MS })) {
    ok("an hourly granularity echo refuses when whole days were asked for");
  } else { bad("the API reporting hourly buckets passed as a daily table"); failures++; }

  if (checkRun({ run: { dry: true, granularity: DAY_MS } })) ok("a run the API executed as dry refuses");
  else { bad("a dry run passed as a quiet day"); failures++; }

  if (checkRun({}, { granularity: DAY_MS })) ok("a response carrying no run block refuses rather than being assumed fine");
  else { bad("an unverifiable response passed as verified"); failures++; }

  if (checkRun({ run: { dry: false, granularity: DAY_MS } }, { granularity: DAY_MS }) === null) {
    ok("a run block echoing exactly what was asked passes, so the check is not blanket-red");
  } else { bad("a correct run block was rejected"); failures++; }

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
      // Outside the retention window: unread, and it must not read as a zero.
      { time: day(5), data: [bucket(0)] },
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
    todayStart - (RETENTION_DAYS - 1) * DAY_MS,
  );
  console.log("\nthe same renderer over a SYNTHETIC reading whose middle day is a real zero:");
  for (const line of rendered) console.log(line);
  const rowFor = (back: number) => rendered.find((l) => l.startsWith(`  ${new Date(todayStart - back * DAY_MS).toISOString().slice(0, 10)}`));
  const zeroRow = rowFor(1);
  if (zeroRow && /\s0\s/.test(zeroRow) && /100\.0%/.test(zeroRow)) ok("the zero day printed as 0 with full headroom, beside days that carried events");
  else { bad("a measured zero did not render as a zero row"); failures++; }
  if (rendered.some((l) => l.includes("partial"))) ok("today is marked partial rather than scored against a full-day ceiling");
  else { bad("the incomplete current day was scored as if it were a whole day"); failures++; }
  const expiredRow = rowFor(5);
  if (expiredRow && expiredRow.includes("past retention") && !expiredRow.includes("%") && !/\s0\s/.test(expiredRow)) {
    ok("a day past retention prints no count, no share and no headroom");
  } else { bad("an expired day rendered in the same column and format as a measured zero"); failures++; }

  console.log("");
  if (failures === 0) {
    console.log("VERDICT: every failure mode refuses. A zero printed by this tool is a measured zero.");
    process.exit(0);
  }
  console.log(`VERDICT: ${failures} case(s) failed. Do not trust a reading until they pass.`);
  process.exit(1);
}

export async function main(): Promise<void> {
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

  const retentionStart = todayStart - (RETENTION_DAYS - 1) * DAY_MS;

  console.log(`observability events, account <elided>, ${days} day(s) to ${new Date(now).toISOString()}`);
  console.log(`ASSUMES ${PLAN}: ${n(DAILY_CEILING)} events/day, spans and logs sharing one quota.`);
  console.log(`Nothing here reads the plan. On Workers Paid the allowance is ${PAID_MONTHLY}, a different`);
  console.log("figure over a different period, and every percentage below would be meaningless.");
  if (days > RETENTION_DAYS) {
    info(`${PLAN} retains ${RETENTION_DAYS} days; older days are marked past retention and carry no numbers.`);
  }
  console.log("");

  const totals = await post(account, token, "query", countQuery(timeframe, undefined, DAY_MS));
  if (totals.state === "transport") {
    bad(`could not reach the telemetry API: ${totals.why}`);
    info("Nothing was read, so nothing below would be a reading. Check the network, then re-run.");
    process.exit(2);
  }
  if (totals.state === "error") {
    bad(`could not read the event total: ${totals.why}`);
    info("This is a failed query, not a quiet account. Nothing below would be a reading.");
    // A 403 here is one thing in practice. Measured 2026-08-29: a token that
    // authenticates but lacks the grant answers a bare `Forbidden` on /query and
    // `10104 …no_access_to_workers_observability` on /keys, so the endpoint
    // names the permission on one path and not the other.
    if (totals.status === 403) {
      info("A 403 here means the token authenticated and lacks Workers Observability : Read.");
    }
    process.exit(1);
  }

  // The daily table rests entirely on each bucket being a DAY. The response
  // echoes the granularity it used, so this is one comparison rather than an
  // inference from row labels, which is what #667 did: 24 hourly buckets all
  // stamped with today's date rendered as 24 daily rows and understated the
  // peak 24x while every figure beneath read as headroom.
  const runProblem = checkRun(totals.result, { granularity: DAY_MS });
  if (runProblem) {
    bad(`the API did not run the query that was asked for: ${runProblem}`);
    info("Every per-day number below would describe a bucket of a different size, so none is printed.");
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
  if (probe.state !== "ok") {
    bad(`the corroborating event probe failed: ${why(probe)}`);
    info("Without it a zero cannot be told apart from a broken read, so no total is printed.");
    process.exit(probe.state === "transport" ? 2 : 1);
  }
  const probeRun = checkRun(probe.result);
  if (probeRun) {
    bad(`the corroborating event probe did not run as asked: ${probeRun}`);
    info("A dry probe finds nothing by construction, which is the reading it exists to rule out.");
    process.exit(1);
  }

  // THE PAYLOAD IS VALIDATED, because `result.events?.events` being undefined is
  // indistinguishable from an empty array once it reaches `Array.isArray`. Both
  // read as "no event found", which silently disarms the contradiction detector
  // in exactly the case a payload change would cause. Asking for the LIST is the
  // whole check: a missing envelope, a renamed field and a non-array all arrive
  // here as "this is not a list of events" and all refuse.
  const probeEvents = (probe.result as { events?: { events?: unknown } }).events?.events;
  if (!Array.isArray(probeEvents)) {
    bad("the event probe returned a payload with no `events.events` array; its payload has changed");
    info("An unreadable probe is not a probe that found nothing, so the count it corroborates is not printed.");
    process.exit(1);
  }
  const probeFoundEvent = probeEvents.length > 0;

  const sample = sampledAt(totalCalc.series);
  const verdict = classify(windowTotal, probeFoundEvent, sample);
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

  if (verdict === "sampled") {
    bad(`this dataset is sampled at 1 in ${sample}, so every count returned understates ingestion`);
    info("No table is printed: scaling by the interval would be an estimate, and this tool prints measurements.");
    info(`The window sampled to ${n(windowTotal)} events, which is a floor and not a reading.`);
    info("Read the Observability dashboard for a sampled account, and check head_sampling_rate in wrangler.jsonc.");
    info("Sampling is NOT evidence of being over the daily quota: Cloudflare's own trigger is 5 billion");
    info("logs per account per day, 25,000x the ceiling above, after which 1% head-based sampling applies.");
    process.exit(1);
  }

  // ── the daily table ─────────────────────────────────────────────────────
  // The split is verified the same way and DROPPED rather than degraded when it
  // is not: a dry or wrongly bucketed split renders as a column of zeros beside
  // real totals, which reads as "no spans today".
  const split = await post(account, token, "query", countQuery(timeframe, "dataset", DAY_MS));
  const splitProblem = split.state === "ok" ? checkRun(split.result, { granularity: DAY_MS }) : why(split);
  const splitCalc = split.state === "ok" && !splitProblem ? calculation(split.result) : null;
  for (const line of dailyTable(totalCalc.series, splitCalc?.series ?? null, todayStart, retentionStart)) console.log(line);
  if (!splitCalc) {
    info(`spans/logs split unavailable: ${splitProblem || "the API returned no grouped calculation"}`);
    info("The totals above are unaffected: they are asked with no group-by at all.");
  }

  // ── where the events come from ──────────────────────────────────────────
  for (const [label, key] of [["worker", "$metadata.service"], ["span name", "$metadata.spanName"]] as const) {
    const by = await post(account, token, "query", countQuery(timeframe, key));
    console.log(`\nevents by ${label} (${days} day window):`);
    if (by.state !== "ok") { info(`unavailable: ${why(by)}`); continue; }
    const byProblem = checkRun(by.result);
    if (byProblem) { info(`unavailable: ${byProblem}`); continue; }
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

// GUARDED, because `classify` and `dailyTable` are exported to be tested and an
// unguarded call ran main() on IMPORT: a contract test importing this file got
// `process.exit(2)` for having no credential and took the runner down with it,
// which is why nothing in the suite touched either export until now.
if (import.meta.main) {
  main().catch((e) => {
    bad(e instanceof Error ? (e.stack ?? e.message) : String(e));
    process.exit(2);
  });
}
