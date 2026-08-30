// check-observability.ts: how much of the daily observability-event budget is
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
//                  block does not echo what was asked, buckets that
//                  do not describe the window asked for, a malformed
//                  probe payload, a sampled or unreadably-sampled
//                  dataset, or a count of 0 while an event probe
//                  returns a row                                    exit 1
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
// A SECOND PASS FOUND THE SAME FAILURE CLASS THROUGH DOORS THE FIRST LEFT OPEN,
// and the shape of that is the lesson rather than the five bugs. Each first fix
// was correct and each was written as ONE PATH: the sampling check read one
// nesting of one field, the day check read the run echo and not the rows, the
// partial-day rule read one side of one clock. A reading that goes wrong has as
// many doors as the response has shapes, so a fix keyed on a path closes the
// door it was written for and leaves the corridor.
//
//   sampling      the interval was read at `series[].data[]` alone. Reported on
//                 `calculations[].aggregates[]` instead, a 1-in-100 dataset
//                 exited 0 at "0.9% of ceiling". `sampledAt` walks the whole
//                 result by FIELD NAME now, over all four nestings Cloudflare's
//                 schema puts it in.
//   the interval  `Number(v) || 1` read 0, -100, null and "abc" as unsampled.
//                 0.01 is the dangerous member, because head_sampling_rate is a
//                 RATE in 0..1 and this field is its reciprocal. Anything that
//                 is not a positive integer is unreadable and refuses.
//   folding       the table emitted one row per SERIES ENTRY and peaked per row,
//                 so two buckets stamped one day halved it: a day at 100% of the
//                 ceiling printed as 50%, exit 0. Rows come from the DAYS asked
//                 for now, buckets are summed into them, and a day carrying two
//                 buckets under a daily granularity echo refuses outright.
//   the clocks    `partial` was `stamp >= todayStart`, comparing Cloudflare's
//                 stamps against this machine's `Date.now()` with no upper bound
//                 and no reconciliation, so a slow clock marked a real day
//                 partial and dropped it from the peak in silence. Bucket stamps
//                 are checked against the window that was ASKED for.
//   the gap       rows returned were never counted against days requested, so a
//                 3-day window answered with one bucket printed a confident peak
//                 and full headroom. Unanswered days render as such, cannot be
//                 the peak, and suppress the headroom sentence.
//
// A THIRD PASS FOUND THE ROOMS OFF THAT CORRIDOR, and round 3 is a STRUCTURAL
// fix rather than a fourth patch. Rounds 1 and 2 both keyed their repairs on the
// TOTAL, and the four defects that survived were all in the tiers beside it: the
// dataset split rendered `0` for a day the split query never answered, because
// the cell asked the TOTAL whether that day was answered; the breakdown coerced
// `"lots"` to 0 under a comment claiming it was held to the same rule; a bucket
// whose `data` was an object crashed out of `checkBuckets` with a TypeError; and
// the count guard admitted `true` as 1 event and `[7]` as 7.
//
// One pattern under all three rounds: EVERY TIER DID ITS OWN CHECKING, so the
// newest tier inherited nothing. The repair is one gate. `readCount` is the only
// function that turns a wire value into a number, `render` is the only one that
// turns a number into text, and it takes a branded Figure that no other file can
// forge. Absence is not a number, so `?? 0` has nothing left to default. The
// long argument, and what stops a fifth tier repeating this, is at THE GATE
// below; `readSeriesByDay` is the one parse both the refusal and the renderer
// read, so those two can no longer disagree about whether a day was answered.
//
// A FOURTH PASS MET THE SAME CLASS AGAIN, and the answer is a DELETION rather
// than a fifth door closed. Four rounds found one shape between them, a printed
// number that is not a measurement, and every single instance was AN INFERRED
// ZERO. Round 3's brand holds where it is applied: 22 mutations against it were
// all caught. What the design claimed was wider than what it had. Exactly FOUR
// call sites minted a Figure. Three were the gate's own internals and the fourth
// was `measured` with a literal 0, standing in for a dataset column the split
// query had not answered, defended by a decomposition check written to license
// exactly that zero.
//
// So the dataset split and the two breakdowns are GONE, with the check that
// licensed them, and nothing left mints a Figure outside the gate. That is a
// stronger guarantee than any of the three previous rounds attempted, because it
// is a property of the file rather than a rule at a call site: a fifth tier
// cannot reopen this class without a new construction site, and a contract test
// fails on one.
//
// The event probe is the part that earns its call. A count of 0 is only
// believable next to a second query that also finds nothing; if `view: events`
// returns a row over the same window the count is wrong, and Cloudflare's forum
// has a standing report of telemetry/query returning rows_read: 0 while data
// exists. A contradiction is reported as a contradiction.
//
// ONE COUNT IS CORROBORATED THAT WAY, THE WINDOW TOTAL, and #667 claimed all of
// them were. The per-day counts are not, because `view: events` answers "does
// any event exist in this window" and nothing finer: corroborating a single day
// needs its own query per day, which multiplies calls against a rate-limited API
// to answer a question the day's own `run` echo already settles. So the per-day
// tier is defended by asserting the GRANULARITY the API says it used, and the
// claim here is narrowed to match.
//
// `--control` proves the separation by pointing the same code at a bad account
// and a malformed query and showing it refuses. It needs no token, because an
// unauthenticated request is refused too and a refusal is the thing under test.
// Its two live cases assert an HTTP RESPONSE ARRIVED, since a transport failure
// refuses just as loudly while proving nothing about the endpoint.
//
// ── WHAT THIS DOES NOT ANSWER ─────────────────────────────────────────────
// It reports ONE thing: whether this account is near the 200,000 events/day
// ceiling, as a window total and a row per whole UTC day. It does NOT break that
// number down by dataset (spans versus logs) and it does NOT break it down by
// Worker or by span name.
//
// Those three tiers existed and were REMOVED on 2026-08-30, after four
// adversarial reviews, because each of them inferred a zero: a dataset column
// stood in for a day the split query never answered, and a breakdown row read a
// value that was not a count. The Observability dashboard answers the
// by-dataset and by-Worker question, and is where to take it.
//
// A future reader must not add them back without meeting the same bar. The bar
// is the one this file already states: a printed number is a measurement, so
// each tier owes a reading per cell it prints and may not borrow another tier's
// answer for a cell of its own. Note also that the three group-by keys were
// never exercised against an authorized call, because no credential on this
// workstation carries the grant, so a tier built on them starts unverified.

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
 * missing result is an ERROR rather than an empty reading, and that distinction is
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
  // THROUGH THE GATE, like every other wire value. This read
  // `Number(run.granularity)` until 2026-08-30, which is the exact construct
  // round 3 removed from four other tiers, surviving inside the refusal written
  // to catch a wrong bucket size. `granularity: true` coerced to 1 and printed
  // "the API used 1ms, so each row is 86400000.00x smaller than a day": a
  // fabricated measurement, quoted back to a reader, inside a refusal. It also
  // made the file's own claim that `Number()` is never called on a wire value
  // false. `readCount` is declared below and hoists; it is the only door.
  const got = readCount(run.granularity);
  if (got.state !== "measured" || got.value < 1) {
    return `granularity came back as ${shown(run.granularity)} rather than a positive whole number of milliseconds`;
  }
  if (got.value !== expect.granularity) {
    return `asked for ${expect.granularity}ms buckets and the API used ${got.value}ms, so each row is ${(expect.granularity / got.value).toFixed(2)}x smaller than a day`;
  }
  return null;
}

type Timeframe = { from: number; to: number };

/**
 * A count query. IT CARRIES NO GROUP-BY, and that is the shape of the whole tool
 * since the split and the breakdowns were removed: a count asked with no
 * `groupBys` cannot fail because a key name was wrong, and there is no second
 * tier whose cells could disagree with it. `granularity` stays optional because
 * the control asks the same question without buckets.
 */
function countQuery(timeframe: Timeframe, granularity?: number) {
  const parameters: Record<string, unknown> = {
    calculations: [{ operator: "count", alias: "events" }],
  };
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

// `value` is UNKNOWN on purpose, and the change from `number` is load-bearing
// rather than pedantic. Typing a wire field as the thing you hope it is makes
// `Number(a.value)` compile everywhere, which is how `true` came to print as 1
// event. Typed as unknown, arithmetic on it does not compile at all, so the gate
// below is the only way through and the compiler is what enforces that.
type Aggregate = { value: unknown; sampleInterval?: number };
type Series = { time: string; data: Aggregate[] };

const n = (v: number) => v.toLocaleString("en-US");

// ── THE GATE ─────────────────────────────────────────────────────────────────
// EVERY NUMBER THIS TOOL PRINTS IS A FIGURE, and a Figure can only be made by
// reading one off the wire here. That is the design, and it is an answer to
// three rounds of one defect rather than a fourth patch to it.
//
// THREE CALL SITES MINT A MEASURED FIGURE AND ALL THREE ARE IN THIS BLOCK:
// `readCount` (the parse), `add` (two readings summed) and `derive` (arithmetic
// on a reading). There is no fourth, and
// `contract-obs-check-prints-only-measurements.test.mjs` fails on one, naming
// the enclosing function so a new site cannot hide behind a familiar-looking
// line. That pin is the structural close on this whole defect class, and it is
// worth more than the three repairs above it: the brand stops a raw value being
// PRINTED, and this stops one being MINTED, which is the door round 4 came
// through. `absent` and `unreadable` are deliberately outside the pin, because
// neither carries a number: the worst a new one can do is suppress a reading,
// which is the direction this file already errs in.
//
// WHAT THE THREE ROUNDS SHARE. Round 1 fixed sampling, granularity and retention
// on the TOTAL. Round 2 found the sample interval reported at a nesting the
// guard never visited, and the table peaking per ROW so two buckets on one day
// halved it, and fixed both by keying on FIELDS and on DAYS ASKED FOR. Round 3
// found the rooms off that corridor, all four in the secondary tiers:
//
//   the split      a day the split query never answered rendered `0` in every
//                  dataset column beside a total of 100,000, because the cell
//                  asked the TOTAL whether that day was answered. Exit 0, and
//                  wrong in the worst direction: tracing contributed nothing on
//                  a day nobody measured.
//   the breakdown  `Number(a.value) || 0` under a comment saying these rows were
//                  held to the same rule. `"lots"` printed as 0.
//   the payload    a bucket whose `data` was an object rather than a list threw
//                  a TypeError out of checkBuckets and exited 2 on a stack
//                  trace, where every other malformed payload gets a sentence.
//   the count      `Number.isFinite(Number(v))` accepted `true` as 1 event and
//                  `[7]` as 7.
//
// Every one of those is A TIER THAT DID ITS OWN CHECKING. The tool grew from one
// printed number to five (window total, per-day cell, split column, and two
// breakdowns) and each new tier inherited nothing from the last, because there
// was nothing to inherit: a guard was a rule a caller had to remember, and the
// newest caller is the one who was not there when the rule was written.
//
// ROUND 4 CUT THAT LIST BACK TO TWO. The split column and the two breakdowns are
// gone, so the tool prints the window total and the per-day cell and nothing
// else. Both come from `readSeriesByDay`, which is one parse rather than a tier
// apiece, and neither can borrow the other's answer for a cell of its own.
//
// So there is one gate now, and skipping it is not on the menu. `readCount` is
// the only function that turns a wire value into a number. `render` is the only
// function that turns a number into text, and it takes a Figure. A Figure
// carries a module-private symbol, so no other file, no test and no future tier
// can build one by hand, and `render` THROWS on anything unbranded rather than
// printing it. A fourth tier has two options: call the gate, or print nothing.
//
// WHY A TAGGED TYPE RATHER THAN ONE VALIDATOR EVERYBODY CALLS. A validator is
// what was already here, four times over, and the fourth tier is precisely the
// one that does not call it. The tag makes the UNMEASURED STATE UNPRINTABLE
// instead: `?? 0` has nothing left to default, because absent is not a number
// and never becomes one. That is the difference between a rule and a type.
//
// WHERE THIS STOPS, stated so the boundary is not guesswork. A constant declared
// in this file is not a reading, so `n(DAILY_CEILING)` prints directly. A number
// that came off the wire is a Figure, and anything computed from one stays a
// Figure through `derive`. A number STOOD IN FOR one that was never read is the
// thing with no place at all: that is what the removed `measured` with a literal
// 0 was, and it is why the count above is a pinned three rather than a habit.
const FIGURE = Symbol("obs-check.figure");

type Figure =
  | { [FIGURE]: true; state: "measured"; value: number }
  | { [FIGURE]: true; state: "absent"; why: string }
  | { [FIGURE]: true; state: "unreadable"; why: string };

const measured = (value: number): Figure => ({ [FIGURE]: true, state: "measured", value });
/** Nothing was read here. Not a zero, and there is no path that turns it into one. */
const absent = (why: string): Figure => ({ [FIGURE]: true, state: "absent", why });
/** Something WAS read and it is not a count, which is a different failure from absence. */
const unreadable = (why: string): Figure => ({ [FIGURE]: true, state: "unreadable", why });

/** A wire value quoted back inside a refusal, without throwing on a cycle. */
const shown = (v: unknown): string => {
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
  }
};

/**
 * THE ONE PARSE. An untyped wire value becomes an event count or a named
 * refusal, and nothing else in this file may do that job.
 *
 * `Number()` is the trap this replaces and it is worth naming each member,
 * because the coercion reads as a validation. `Number(true)` is 1, `Number([7])`
 * is 7, `Number("12")` is 12 and `Number(null)` is 0, so the round-2 guard
 * `Number.isFinite(Number(v))` admitted all four and `Number(v) || 0` printed
 * the last two as counts. An event count is a non-negative whole NUMBER on the
 * wire; anything else is a payload change, and a payload change is the one thing
 * this file must never render as a quiet reading.
 */
export function readCount(raw: unknown): Figure {
  // The rule wants a parse at the I/O boundary and a branch on the domain value.
  // This IS that parse: there is no earlier place to put it, because the wire is
  // where the value came from and `unknown` is what it arrives as.
  // oxlint-disable-next-line anti-slop/no-runtime-typeof
  if (typeof raw !== "number") {
    return unreadable(`${shown(raw)} is not a number; \`Number()\` would have read true as 1, [7] as 7 and null as 0`);
  }
  if (!Number.isInteger(raw)) {
    return unreadable(`${shown(raw)} is not a whole number, and an event count counts events`);
  }
  if (raw < 0) {
    // "non-negative" is load-bearing wording rather than prose: the contract
    // suite pins this refusal by that phrase, because a negative count is what
    // rendered as -25.0% used and 125.0% headroom.
    return unreadable(`${shown(raw)} is negative, and an event count is a non-negative whole number`);
  }
  return measured(raw);
}

/** Two figures added. Unreadable poisons, absent yields to a reading. */
function add(a: Figure, b: Figure): Figure {
  if (a.state === "unreadable") return a;
  if (b.state === "unreadable") return b;
  if (a.state === "absent") return b;
  if (b.state === "absent") return a;
  return measured(a.value + b.value);
}

/** Arithmetic on a reading stays a reading. Anything else stays what it was. */
function derive(f: Figure, fn: (v: number) => number): Figure {
  return f.state === "measured" ? measured(fn(f.value)) : f;
}

const isFigure = (f: unknown): f is Figure =>
  // The brand check IS the enforcement, so it has to run against whatever it was
  // handed rather than against a parsed domain value.
  // oxlint-disable-next-line anti-slop/no-runtime-typeof
  f !== null && typeof f === "object" && (f as Record<symbol, unknown>)[FIGURE] === true;

/**
 * THE ONLY WAY A WIRE NUMBER BECOMES TEXT. Measured prints, absent prints `-`,
 * unreadable prints `?`, and each of the last two carries its reason to a note
 * line rather than into the column a reader scans.
 *
 * IT THROWS ON A RAW VALUE, which is the enforcement rather than defensiveness.
 * TypeScript already refuses a `number` here, and TypeScript does not run: the
 * contract suite is `.mjs`, and a future tier holding `a.value` as `unknown` can
 * cast its way past the compiler. The symbol is module-private, so a hand-built
 * `{ state: "measured", value: 5 }` fails this check, and the throw lands in
 * main()'s catch as exit 2 with no table above it. Printing a marker instead
 * would be the warning-over-wrong-numbers shape this whole file refuses.
 */
export function render(f: unknown): string {
  if (!isFigure(f)) {
    throw new Error(
      `render() was handed ${shown(f)} rather than a Figure. Every number printed here comes from readCount(); an unchecked value may not reach a reader.`,
    );
  }
  if (f.state === "measured") return n(f.value);
  return f.state === "absent" ? "-" : "?";
}

/**
 * The reason a figure carries no number, for the note under the table.
 *
 * A `?` cell with no explanation beneath it would be this file's own failure in
 * miniature: a mark a reader has to guess at, printed where a number goes.
 */
const gapWhy = (f: Figure): string | null => (f.state === "measured" ? null : f.why);

/** What the response says about sampling, or why that could not be read. */
export type Sampling =
  | { state: "unsampled" }
  | { state: "sampled"; interval: number }
  | { state: "unreadable"; why: string };

function calculation(result: Record<string, unknown>): { series: Series[] } | null {
  const calcs = result.calculations;
  if (!Array.isArray(calcs) || calcs.length === 0) return null;
  const first = calcs[0] as Record<string, unknown>;
  return { series: Array.isArray(first.series) ? (first.series as Series[]) : [] };
}

/**
 * One bucket's aggregates, summed through the gate.
 *
 * A `data` that is not a list is a PAYLOAD CHANGE and says so. Round 2's version
 * iterated it directly, so an object there threw `{} is not iterable` out of
 * checkBuckets and the tool exited 2 on a stack trace, which is the one
 * malformed payload in this file that got no sentence.
 *
 * An EMPTY list is `absent` rather than 0, on the rule the whole file serves. A
 * bucket carrying no aggregate row carries no count, and the day it lands on
 * reads as unanswered instead of as a quiet zero.
 */
function bucketTotal(data: unknown): Figure {
  if (!Array.isArray(data)) {
    return unreadable(`a bucket's \`data\` came back as ${shown(data)} rather than a list of aggregates, so its payload has changed`);
  }
  if (data.length === 0) return absent("the bucket carried no aggregate row, and nothing is not a zero");
  let sum = absent("no aggregate read");
  for (const a of data) sum = add(sum, readCount((a as Aggregate)?.value));
  return sum;
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
 *
 * WHY THIS WALKS THE WHOLE RESULT RATHER THAN NAMING PATHS. Round 1 read
 * `calculations[0].series[].data[]` and nothing else, so an interval reported on
 * the WINDOW AGGREGATE rather than on the buckets was invisible: a 1-in-100
 * dataset exited 0 and printed "0.9% of ceiling" with full headroom, which is
 * the exact output this refusal exists to prevent. Adding `aggregates[]` as a
 * second case would have closed that one door and left the shape intact.
 *
 * Cloudflare's schema is why a path list can never be complete here. The field
 * is declared ONCE, on `zAggregateResult` (cloudflare/mcp-server-cloudflare,
 * apps/workers-observability/src/types/workers-logs.types.ts:124-130, read
 * 2026-08-29), and that object is then reused: `zQueryRunCalculationsV2` embeds
 * it at `aggregates[]` AND at `series[].data[]`, and `zReturnedQueryRunResult`
 * embeds that array twice, at `calculations` and at `compare`. One declaration
 * is already FOUR live paths, and every future reuse of `zAggregateResult` mints
 * another without touching the field. A checker keyed on the FIELD NAME is
 * complete over all four by construction and stays complete when a fifth
 * appears. A checker keyed on paths is a list that goes stale in silence, which
 * is the one failure mode this file may not have.
 *
 * So the walk visits every key named `sampleInterval` at any depth. It needs no
 * knowledge of the nesting and cannot be outrun by a change to it, and it costs
 * one traversal of a response already in memory.
 */
export function sampledAt(result: unknown): Sampling {
  let worst = 1;
  const notIntervals: string[] = [];
  // A WeakSet rather than a depth cap. A cap is the special-case habit this
  // function exists to break: it would silently stop looking at whatever depth
  // somebody guessed, which is the failure mode again one level down. JSON has
  // no cycles, so the set is belt and braces against a hand-built fixture.
  const seen = new WeakSet<object>();
  const walk = (node: unknown): void => {
    // The rule asks for a parse at the I/O boundary and a branch on the domain
    // value. Parsing is exactly what this function may not do: the shape is the
    // unknown, and a walk keyed on the field name is what survives Cloudflare
    // reusing `zAggregateResult` somewhere nobody here modelled. A parser would
    // reintroduce the path list this replaced.
    // oxlint-disable-next-line anti-slop/no-runtime-typeof
    if (node === null || typeof node !== "object") return;
    if (seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) {
      for (const v of node) walk(v);
      return;
    }
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (key !== "sampleInterval") {
        walk(value);
        continue;
      }
      // POSITIVE INTEGER OR NOTHING. `Number(v) || 1` read 0, -100, null and
      // "abc" as unsampled, and the dangerous member of that set is 0.01:
      // Cloudflare's own knob is `head_sampling_rate`, documented as a RATE in
      // 0..1 where 0.01 means one request in a hundred is kept
      // (developers.cloudflare.com/workers/observability/logs/workers-logs/,
      // read 2026-08-29), while this field is an INTERVAL where 100 means the
      // same thing. The two spellings are reciprocals, so an API that ever
      // reports the rate here hands 0.01 to a reader of intervals and 1% of
      // ingestion renders as none of it. Neither shape is assumed: an interval
      // that is not a positive integer is unreadable and refuses.
      // This IS the boundary parse the rule asks for: it turns an untyped wire
      // value into a positive integer or a refusal, and there is no earlier
      // place to put it, because the walk is what found the value.
      // oxlint-disable-next-line anti-slop/no-runtime-typeof
      if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
        notIntervals.push(JSON.stringify(value) ?? String(value));
      } else {
        worst = Math.max(worst, value);
      }
    }
  };
  walk(result);
  if (notIntervals.length > 0) {
    return {
      state: "unreadable",
      why: `sampleInterval came back as ${notIntervals.slice(0, 3).join(", ")}, which is not a 1-in-N interval; a rate (head_sampling_rate is 0..1) and an interval are reciprocals, so this cannot be read either way`,
    };
  }
  return worst > 1 ? { state: "sampled", interval: worst } : { state: "unsampled" };
}

/**
 * Share of the daily ceiling and the headroom beside it, ROUNDED ONCE and then
 * complemented, so the pair always sums to 100.0. Computing each from the raw
 * value rounds twice: 1,500 events printed 0.8% used and 99.3% left in #667.
 *
 * IT TAKES A FIGURE AND RETURNS NULL FOR ANYTHING UNMEASURED, which is the gate
 * arriving at the derived numbers. A percentage of an unread day is the exact
 * output the tool exists to refuse, and round 1 printed `100.0%` headroom over
 * a day past retention because this took a bare number and every bare number
 * divides.
 */
function shareOf(f: Figure): { used: string; left: string } | null {
  if (f.state !== "measured") return null;
  const used = Number(((f.value / DAILY_CEILING) * 100).toFixed(1));
  return { used: `${used.toFixed(1)}%`, left: `${(100 - used).toFixed(1)}%` };
}
const pctOf = (f: Figure) => shareOf(f)?.used ?? "?";

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

/** The UTC calendar day a bucket stamp falls in, as YYYY-MM-DD. */
const dayKey = (stamp: number): string => new Date(stamp).toISOString().slice(0, 10);

/**
 * A bucket's `time`, which the schema types as a string and which arrives as
 * either epoch milliseconds or an ISO stamp. Returns null when it is neither,
 * because a bucket that cannot be placed on a day cannot be summed into one.
 */
function bucketStamp(time: string): number | null {
  const asNumber = String(time).trim() === "" ? Number.NaN : Number(time);
  const stamp = Number.isFinite(asNumber) ? asNumber : Date.parse(String(time));
  return Number.isFinite(stamp) ? stamp : null;
}

/** Every UTC day a window touches, oldest first. */
export function windowDayKeys(from: number, to: number): string[] {
  const out: string[] = [];
  for (let d = Math.floor(from / DAY_MS) * DAY_MS; d <= to; d += DAY_MS) out.push(dayKey(d));
  return out;
}

/** One day's count. It was `{ total, groups }` while the split existed. */
type DayReading = { total: Figure };

/**
 * THE ONE PARSE OVER SERIES. Every count in this file is read here, once, and
 * comes out as a Figure keyed by the UTC day it belongs to. `checkBuckets` and
 * `dailyTable` are both projections of this, which is round 3's structural half:
 * previously the two walked the response separately, so `checkBuckets` could
 * decide a day was unanswered while the renderer printed a number for it.
 *
 * Does the set of buckets that came back match the window that was asked for?
 * `checkRun` reads the API's ECHO of the query; this reads the ROWS, and the two
 * can disagree. Five ways, each of which some earlier round rendered as a number:
 *
 *  1. AN UNREADABLE STAMP. A bucket that cannot be placed on a day was being
 *     silently placed on 1970-01-01 by `Number(t) || Date.parse(t)`.
 *  2. A STAMP OUTSIDE THE WINDOW, which is the clock reconciliation. `partial`
 *     was `stamp >= todayStart` with `todayStart` from this workstation's
 *     `Date.now()` and the stamps from Cloudflare, and nothing bounded it above
 *     or compared it to the window at all. A workstation clock a day behind
 *     therefore marked a real complete day partial and dropped it from the peak,
 *     quietly. The two clocks are reconciled HERE, once: the days this tool
 *     asked for are the only days it will accept an answer for, so skew in
 *     either direction is a named refusal rather than a missing row.
 *  3. TWO BUCKETS ON ONE DAY. Deliberate choice, and it REFUSES. The query asks
 *     for `granularity: 86400000` and `checkRun` has already confirmed the API
 *     echoed that back, so a second bucket on the same day is the response
 *     contradicting its own echo. It cannot be benign paging either: at day
 *     granularity a day is one bucket by definition. Folding alone would produce
 *     the right arithmetic and leave a response nothing can vouch for, and this
 *     file may only print numbers it can vouch for. `dailyTable` folds anyway,
 *     as defence in depth, so a caller that skips this check still gets a
 *     correct sum rather than round 1's per-row peak, which halved a day that
 *     had consumed the whole ceiling.
 *  4. A COUNT THAT IS NOT A COUNT. `Number(v) || 0` read "abc" and null as zero
 *     and passed -50,000 straight through, which rendered as `-25.0%` used and
 *     `125.0%` headroom. Round 2 replaced that with `Number.isFinite(Number(v))`,
 *     which still admitted `true` as 1 event and `[7]` as 7. `readCount` is the
 *     gate now and neither coercion happens anywhere.
 *  5. A `data` THAT IS NOT A LIST. Round 2 iterated it directly, so an object
 *     there threw `{} is not iterable` and exited 2 on a stack trace where every
 *     other malformed payload gets a sentence. `bucketTotal` names it.
 *
 * A refusal no longer stops the walk, which matters because `dailyTable` folds
 * from this same result: it records the FIRST reason and keeps reading, so the
 * arithmetic stays correct on a response nothing can vouch for. main() prints no
 * table when `problem` is set, so a correct fold of a bad response never ships.
 *
 * `unanswered` is reported rather than refused, and that split is the point.
 * 1 to 5 are the response disagreeing with itself, which is never normal. A day
 * with no row may just be the API omitting an empty bucket, which no authorized
 * call has been made from here to settle, so refusing would be blanket-red on
 * precisely the quiet account this tool is meant to reassure. The caller marks
 * it instead, and prints no headroom over it.
 */
export function readSeriesByDay(
  series: Series[],
  days: string[],
): { problem: string | null; byDay: Map<string, DayReading>; unanswered: string[] } {
  const wanted = new Set(days);
  const bucketsPerDay = new Map<string, number>();
  const byDay = new Map<string, DayReading>();
  const span = days.length > 0 ? `${days[0]}..${days[days.length - 1]}` : "(empty window)";
  let problem: string | null = null;
  const refuse = (why: string) => {
    problem ??= why;
  };
  const reading = (day: string): DayReading => {
    const existing = byDay.get(day);
    if (existing) return existing;
    const fresh: DayReading = { total: absent("no bucket read for this day") };
    byDay.set(day, fresh);
    return fresh;
  };

  for (const s of series) {
    const stamp = bucketStamp(s.time);
    if (stamp === null) {
      refuse(`a bucket carried ${shown(s.time)} as its time, which places it on no day at all`);
      continue;
    }
    const day = dayKey(stamp);
    if (!wanted.has(day)) {
      refuse(
        `a bucket landed on ${day}, outside the ${span} window this run asked for; the API's clock and this machine's do not agree, so no row can be trusted to the day it claims`,
      );
      continue;
    }
    bucketsPerDay.set(day, (bucketsPerDay.get(day) ?? 0) + 1);
    const row = reading(day);
    const bucket = bucketTotal(s.data);
    if (bucket.state === "unreadable") {
      refuse(`${day} is not a reading: ${bucket.why}`);
    }
    row.total = add(row.total, bucket);
  }

  const doubled = [...bucketsPerDay.entries()].find(([, count]) => count > 1);
  if (doubled) {
    refuse(
      `${doubled[0]} came back as ${doubled[1]} buckets while the API echoed one bucket per day, so the response disagrees with its own granularity`,
    );
  }
  return {
    problem,
    byDay,
    unanswered: days.filter((d) => byDay.get(d)?.total.state !== "measured"),
  };
}

/**
 * The shape round 2 shipped, kept because main() and the control both ask this
 * exact question and because narrowing an exported signature buys nothing here.
 * It is a projection of `readSeriesByDay` rather than a second walk, so the
 * refusal it reports and the Figures the table renders can no longer disagree.
 */
export function checkBuckets(series: Series[], days: string[]): { problem: string | null; unanswered: string[] } {
  const { problem, unanswered } = readSeriesByDay(series, days);
  return { problem, unanswered: problem ? [] : unanswered };
}

/**
 * The daily table, pure so `--control` can render a synthetic reading and show
 * what a real one looks like without a credential.
 *
 * ROWS COME FROM `days`, NEVER FROM THE SERIES, which is what makes the row
 * count and the day count independent. Round 1 emitted one row per SERIES ENTRY
 * and took `Math.max` per row, so two buckets stamped the same day halved that
 * day: a day that had spent 100% of the ceiling printed as 50%, exit 0. Every
 * bucket is summed into its UTC day here before anything is rendered or peaked,
 * so the arithmetic is right even where `checkBuckets` was not consulted.
 *
 * IT RENDERS FIGURES AND NOTHING ELSE. The parse at the top is the last place a
 * wire value is read, so below it there is no `Number(`, no `?? 0` and no bare
 * count to default: an unread cell is `absent` and `render` prints `-` for it.
 *
 * IT ALSO MINTS NOTHING. Round 4 removed the dataset columns that used to sit
 * left of `total`, and with them the one `measured` call outside the gate: an
 * empty cell in an answered split bucket was rendered as a literal 0 on the
 * argument that a group-by returns only groups that carried events. That
 * argument is fine and the zero was still an inference rather than a reading,
 * which is the class every round of review found. There is no cell here now that
 * any query but the total answers for.
 *
 * THREE KINDS OF DAY CARRY NO NUMBER, for one reason: nothing was read for them.
 * TODAY is marked partial, because a day three hours old always looks like
 * headroom. A day older than `retentionFrom` is marked past retention, which
 * round 1 of #667 gave only to today: `--days 7` on a 3-day plan rendered four
 * unanswerable days as `0  0  0.0%  100.0%`, in the column and format a measured
 * zero uses. A day the API returned NO BUCKET for is marked as such rather than
 * shown as 0, on the same argument that nothing is not a zero.
 *
 * A past-retention day carrying events still prints them, since that is data and
 * also evidence the retention assumption is wrong. None of the three is scored
 * and none can become the peak.
 *
 * THE HEADROOM SENTENCE IS SUPPRESSED WHEN A DAY WENT UNANSWERED, and the line
 * between what still prints and what does not is the governing rule itself. The
 * largest answered day is a measurement and prints, labelled with the number of
 * days it was taken over. "N to spare" and "M more /lens scans" are claims about
 * the whole window's worst case, which the unanswered day can falsify, and they
 * are the figures a reader acts on. So the measured number survives and the
 * extrapolated comfort does not.
 */
export function dailyTable(opts: {
  series: Series[];
  /** The UTC days asked for, oldest first. One row each, answered or not. */
  days: string[];
  /** The day holding the end of the window: marked partial, never scored. */
  todayKey: string;
  /** Oldest day inside retention. Older days are unreadable by construction. */
  retentionFrom?: string;
}): string[] {
  const { series, days, todayKey, retentionFrom } = opts;

  // ONE parse, so the renderer holds Figures and never a wire value. There is no
  // `Number(` and no `?? 0` below this line, by construction. The decomposition
  // check that used to sit here went with the split it licensed: it compared the
  // grouped query's per-day sum against the total's and dropped the columns on a
  // mismatch, which existed to make the fabricated `measured` with a literal 0
  // defensible. Removing the inference removed the reason to check it.
  const total = readSeriesByDay(series, days);

  const lines = [
    `  ${"day".padEnd(12)}${"total".padStart(12)}${"of ceiling".padStart(12)}${"headroom".padStart(11)}`,
  ];
  let peak = absent("no day scored");
  let scored = 0;
  let expired = 0;
  let unanswered = 0;
  const unreadable: string[] = [];
  for (const day of days) {
    const past = retentionFrom !== undefined && day < retentionFrom;
    const partial = day === todayKey;
    const row = total.byDay.get(day);
    const readable = row?.total ?? absent("the API returned no bucket for this day");
    const answered = readable.state === "measured";
    if (readable.state === "unreadable") unreadable.push(`${day}: ${gapWhy(readable)}`);
    if (past) expired++;
    // TODAY is excluded from the gap count on purpose. It is never scored and
    // so can never be the peak, which means an unanswered today cannot falsify
    // the headroom sentence. Counting it would suppress that sentence for the
    // first few hours of every UTC day on a quiet account, which is the
    // blanket-red failure the refusals here are written to avoid.
    else if (!answered && !partial) unanswered++;
    if (answered && !partial && !past) {
      scored++;
      if (peak.state !== "measured" || readable.value > peak.value) peak = readable;
    }
    // A past-retention day carrying events still prints, since that is data and
    // also evidence the retention assumption is wrong. A past-retention ZERO is
    // what the plan predicts and is not a reading, so it renders as unread.
    const hidden = !answered || (past && readable.value === 0);
    const shownTotal = hidden ? absent("past retention, so nothing was read") : readable;

    const s2 = shareOf(shownTotal);
    const tail = past
      ? "  past retention"
      : partial
        ? "     partial"
        : !answered
          ? "  no row returned"
          : s2
            ? `${s2.used.padStart(12)}${s2.left.padStart(11)}`
            : "  not a reading";
    lines.push(`  ${day.padEnd(12)}${render(shownTotal).padStart(12)}${tail}`);
  }

  lines.push("");
  if (unreadable.length > 0) {
    // A `?` cell says something WAS read and is not a count, which is a
    // different state from a dash, so the reason has to reach the reader. main()
    // refuses before printing a table in this case; the renderer is also called
    // directly by the control, where the note is the whole output.
    lines.push(`  ..    ${unreadable.length} day(s) carried something that is not an event count:`);
    for (const line of unreadable.slice(0, 3)) lines.push(`        ${line}`);
  }
  if (expired > 0) {
    lines.push(`  ..    ${expired} day(s) sit past the ${RETENTION_DAYS}-day ${PLAN} retention window and are NOT a reading:`);
    lines.push("        no count, no share, no headroom. Ask for a window inside retention instead.");
  }
  if (unanswered > 0) {
    lines.push(`  ..    ${unanswered} of the ${days.length} day(s) asked for came back with no bucket at all, and nothing is not a zero:`);
    lines.push("        they carry no count, no share and no headroom, and none of them can be the peak below.");
  }
  if (peak.state === "measured" && unanswered === 0) {
    const spare = derive(peak, (v) => DAILY_CEILING - v);
    const scans = derive(spare, (v) => Math.floor(v / SPANS_PER_LENS_SCAN));
    lines.push(`  worst COMPLETE day: ${render(peak)} events, ${pctOf(peak)} of the ${n(DAILY_CEILING)} ${PLAN} ceiling, ${render(spare)} to spare.`);
    lines.push(`  that headroom is about ${render(scans)} more /lens scans at ~${SPANS_PER_LENS_SCAN} spans each.`);
  } else if (peak.state === "measured") {
    lines.push(`  worst ANSWERED day: ${render(peak)} events, ${pctOf(peak)} of the ${n(DAILY_CEILING)} ${PLAN} ceiling, over the ${scored} day(s) that returned one.`);
    lines.push(`  NO headroom figure: ${unanswered} day(s) returned nothing and any of them could have been worse.`);
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

  if (checkRun({ run: { dry: false, granularity: true } }, { granularity: DAY_MS })?.includes("positive whole number")) {
    ok("a boolean granularity refuses as unreadable rather than coercing to a fabricated 1ms");
  } else { bad("Number(true) made a granularity of 1ms and an 86400000.00x ratio to quote"); failures++; }

  if (checkRun({ run: { dry: false, granularity: DAY_MS } }, { granularity: DAY_MS }) === null) {
    ok("a run block echoing exactly what was asked passes, so the check is not blanket-red");
  } else { bad("a correct run block was rejected"); failures++; }

  // Sampling, over the FOUR nestings Cloudflare's schema puts the field in.
  // Each of these passed round 1 while printing a full table of headroom.
  const withInterval = (interval: unknown) => ({ value: 5, sampleInterval: interval });
  if (sampledAt({ calculations: [{ aggregates: [withInterval(100)], series: [] }] }).state === "sampled") {
    ok("an interval on the WINDOW AGGREGATE refuses, which is the nesting round 1 never read");
  } else { bad("a sampled window aggregate read as unsampled"); failures++; }
  if (sampledAt({ calculations: [{ aggregates: [], series: [{ time: "0", data: [withInterval(4)] }] }] }).state === "sampled") {
    ok("an interval on a bucket refuses");
  } else { bad("a sampled bucket read as unsampled"); failures++; }
  if (sampledAt({ compare: [{ aggregates: [withInterval(7)], series: [] }] }).state === "sampled") {
    ok("an interval under `compare` refuses, which no path list here had ever named");
  } else { bad("a sampled compare block read as unsampled"); failures++; }
  for (const value of [0, -100, null, "abc", 0.01]) {
    if (sampledAt({ calculations: [{ aggregates: [withInterval(value)], series: [] }] }).state === "unreadable") continue;
    bad(`sampleInterval ${JSON.stringify(value)} read as unsampled rather than unreadable`);
    failures++;
  }
  ok("0, -100, null, \"abc\" and 0.01 are all unreadable intervals rather than 'no sampling'");
  if (sampledAt({ calculations: [{ aggregates: [{ value: 5, sampleInterval: 1 }], series: [] }] }).state === "unsampled") {
    ok("an interval of exactly 1 is not sampling, so the check is not blanket-red");
  } else { bad("an unsampled response refused"); failures++; }

  // The same renderer main() uses, over a fixture whose MIDDLE day is a real
  // zero. It has to print `0` beside two days that carried events, because a
  // measured zero and an unreadable window are the two things this file exists
  // to keep apart, and only one of them is allowed to look calm.
  const todayStart = Math.floor(Date.now() / DAY_MS) * DAY_MS;
  const day = (back: number) => String(todayStart - back * DAY_MS);
  const key = (back: number) => new Date(todayStart - back * DAY_MS).toISOString().slice(0, 10);
  const bucket = (v: number): Aggregate => ({ value: v });

  // Two buckets stamped ONE day, with the granularity echo honest. Round 1 took
  // Math.max per ROW, so a day that spent the whole ceiling printed as half of
  // it. It refuses here, and the renderer folds it correctly regardless.
  const doubled = checkBuckets(
    [{ time: day(1), data: [bucket(100_000)] }, { time: day(1), data: [bucket(100_000)] }],
    [key(1)],
  );
  if (doubled.problem) ok("two buckets stamped the same day refuse rather than being peaked one at a time");
  else { bad("a day split across two buckets passed, so its peak reads half its real value"); failures++; }
  const foldedRows = dailyTable({
    series: [{ time: day(1), data: [bucket(100_000)] }, { time: day(1), data: [bucket(100_000)] }],
    days: [key(1)],
    todayKey: key(0),
  });
  if (foldedRows.some((l) => l.includes("200,000") && l.includes("100.0%"))) {
    ok("and the renderer folds both buckets into one day, so its arithmetic holds without that check");
  } else { bad("the renderer did not fold two buckets of one day into a single row"); failures++; }

  // A stamp outside the asked-for window, which is how clock skew arrives.
  if (checkBuckets([{ time: day(9), data: [bucket(1)] }], [key(1), key(0)]).problem) {
    ok("a bucket outside the requested window refuses rather than being dropped from the peak");
  } else { bad("a bucket from outside the window was accepted"); failures++; }
  if (checkBuckets([{ time: "not-a-time", data: [bucket(1)] }], [key(0)]).problem) {
    ok("a bucket whose time cannot be read refuses rather than landing on 1970-01-01");
  } else { bad("an unreadable bucket time was accepted"); failures++; }
  if (checkBuckets([{ time: day(0), data: [bucket(-50_000)] }], [key(0)]).problem) {
    ok("a negative count refuses rather than rendering -25.0% used and 125.0% headroom");
  } else { bad("a negative event count was accepted as a reading"); failures++; }
  const gap = checkBuckets([{ time: day(1), data: [bucket(12_000)] }], [key(2), key(1), key(0)]);
  if (gap.problem === null && gap.unanswered.length === 2) {
    ok("a 3-day window answered with one bucket names the 2 days that went unanswered");
  } else { bad("days requested and days answered were never reconciled"); failures++; }

  // ROUND 3, and each of these exited 0 printing a number under round 2's repair.
  for (const [label, value] of [["true", true], ["[7]", [7]], ['"12"', "12"]] as const) {
    if (readCount(value).state === "unreadable") continue;
    bad(`a count of ${label} read as a reading; Number() would have made it 1, 7 and 12`);
    failures++;
  }
  ok('true, [7] and "12" are unreadable counts rather than 1, 7 and 12 events');
  if (bucketTotal({ value: 12 }).state === "unreadable") {
    ok("a bucket whose `data` is not a list refuses in a sentence rather than a TypeError");
  } else { bad("a non-list `data` was accepted"); failures++; }
  try {
    // The gate itself. A hand-built lookalike carries no brand, so it cannot
    // reach a reader even from a caller the compiler never saw.
    render({ state: "measured", value: 5 });
    bad("render printed an unbranded value, so the gate is not a gate");
    failures++;
  } catch {
    ok("render refuses a value that did not come through readCount, so no tier can print around it");
  }

  const rendered = dailyTable({
    series: [
      // Outside the retention window: unread, and it must not read as a zero.
      { time: day(5), data: [bucket(0)] },
      { time: day(2), data: [bucket(48_120)] },
      { time: day(1), data: [bucket(0)] },
      { time: day(0), data: [bucket(9_004)] },
    ],
    days: [key(5), key(2), key(1), key(0)],
    todayKey: key(0),
    retentionFrom: key(RETENTION_DAYS - 1),
  });
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

  // The gap case rendered, since the headroom sentence is what a reader acts on
  // and an unanswered day is exactly the thing that can falsify it.
  const withGap = dailyTable({
    series: [{ time: day(1), data: [bucket(12_000)] }],
    days: [key(2), key(1), key(0)],
    todayKey: key(0),
  });
  console.log("\nthe same renderer over a 3-day window the API answered with ONE bucket:");
  for (const line of withGap) console.log(line);
  if (withGap.some((l) => l.includes("no row returned")) && !withGap.some((l) => /to spare|more \/lens scans|worst COMPLETE day/.test(l))) {
    ok("an unanswered day prints no count and suppresses the headroom sentence entirely");
  } else { bad("a window with an unanswered day still printed headroom"); failures++; }
  if (withGap.some((l) => l.includes("worst ANSWERED day") && l.includes("12,000"))) {
    ok("the largest answered day still prints, named as a peak over the days that returned one");
  } else { bad("the measured maximum was dropped along with the claim it could not support"); failures++; }

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
  // ONE reading of this machine's clock, and everything downstream is derived
  // from it. The window is what gets reconciled against Cloudflare's bucket
  // stamps in `checkBuckets`, so the two clocks meet at exactly one comparison
  // rather than at a fresh `Date.now()` inside the renderer.
  const now = Date.now();
  const todayStart = Math.floor(now / DAY_MS) * DAY_MS;
  const timeframe = { from: todayStart - (days - 1) * DAY_MS, to: now };

  const dayKeys = windowDayKeys(timeframe.from, timeframe.to);
  const todayKey = dayKeys[dayKeys.length - 1];
  const retentionFrom = dayKey(todayStart - (RETENTION_DAYS - 1) * DAY_MS);

  console.log(`observability events, account <elided>, ${days} day(s) to ${new Date(now).toISOString()}`);
  console.log(`ASSUMES ${PLAN}: ${n(DAILY_CEILING)} events/day, spans and logs sharing one quota.`);
  console.log(`Nothing here reads the plan. On Workers Paid the allowance is ${PAID_MONTHLY}, a different`);
  console.log("figure over a different period, and every percentage below would be meaningless.");
  if (days > RETENTION_DAYS) {
    info(`${PLAN} retains ${RETENTION_DAYS} days; older days are marked past retention and carry no numbers.`);
  }
  console.log("");

  const totals = await post(account, token, "query", countQuery(timeframe, DAY_MS));
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

  // The echo said one bucket per day. This asks the ROWS whether they agree,
  // which is a different question and the one round 1 never put.
  const buckets = checkBuckets(totalCalc.series, dayKeys);
  if (buckets.problem) {
    bad(`the buckets that came back do not describe the window that was asked for: ${buckets.problem}`);
    info("Every per-day number below would rest on that, so none is printed.");
    process.exit(1);
  }

  // Through the gate like every other number. `checkBuckets` has already refused
  // any unreadable count, so this cannot be unreadable here; going through
  // `bucketTotal` anyway is what keeps that true if the order ever changes.
  const windowFigure = totalCalc.series.reduce<Figure>((sum, s) => add(sum, bucketTotal(s.data)), absent("no bucket read"));
  if (windowFigure.state === "unreadable") {
    bad(`the window total is not a reading: ${windowFigure.why}`);
    process.exit(1);
  }


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

  // The WHOLE result, not one nesting of it: an interval on the window
  // aggregate says as much about these counts as one on a bucket does.
  const sampling = sampledAt(totals.result);
  if (sampling.state === "unreadable") {
    bad(`this response says something about sampling that cannot be read: ${sampling.why}`);
    info("An interval that is not a positive integer leaves every count below scaled by an unknown factor.");
    info("No table is printed. Read the Observability dashboard, and check head_sampling_rate in wrangler.jsonc.");
    process.exit(1);
  }
  const sample = sampling.state === "sampled" ? sampling.interval : 1;

  // AN UNREAD WINDOW IS NOT A WINDOW OF ZERO, and it refuses here rather than
  // becoming one. This was `windowFigure.state === "measured" ? windowFigure.value
  // : 0`, which is the `?? 0` this file says has nothing left to default, written
  // as a ternary. It fed `classify` and then `n()` on the sampled path below, so
  // an empty `series` printed "the window sampled to 0 events, which is a floor"
  // over a window nothing had been read for. The state is reachable: `reduce`
  // over an empty series returns the seed, and the unreadable arm above has
  // already exited, so what lands here is `absent`.
  if (windowFigure.state !== "measured") {
    bad(`no window total came back: ${windowFigure.why}`);
    info(
      probeFoundEvent
        ? "The event probe DID return a row over the same window, so events exist and no count arrived."
        : "The event probe found nothing either, so this is an unread window rather than a quiet one.",
    );
    // The wording avoids the word the contract suite sweeps refusal output for.
    // That sweep is blunt on purpose, since a refusal that mentions room to
    // spare is the failure it exists to catch, and it may not be softened.
    info("Nothing is not a zero, so no count and no share of the ceiling is printed.");
    process.exit(1);
  }
  const windowTotal = windowFigure.value;

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

  // ── the daily table, and it is the last thing printed ───────────────────
  // A dataset split and two breakdowns used to follow. They were removed on
  // 2026-08-30: see WHAT THIS DOES NOT ANSWER at the top for why, and read the
  // Observability dashboard for the by-dataset and by-Worker question.
  for (const line of dailyTable({ series: totalCalc.series, days: dayKeys, todayKey, retentionFrom })) {
    console.log(line);
  }
  // Today is left out for the reason `dailyTable` gives: it is never scored, so
  // an unanswered today is an incomplete day rather than a gap in the reading.
  const gaps = buckets.unanswered.filter((d) => d !== todayKey);
  if (gaps.length > 0) {
    info(`the API returned no bucket for ${gaps.join(", ")}, so those days are not a reading.`);
    info("A day the API did not answer for and a day with no events look identical from here.");
  }

  console.log("\nThis is the window total and the days in it, and nothing finer: no split by");
  console.log("dataset and none by Worker. The Observability dashboard answers that question.");
  console.log("Tracing is free until 2026-10-01. After that each span is one of these events.");
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
