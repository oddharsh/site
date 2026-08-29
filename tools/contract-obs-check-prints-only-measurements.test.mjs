// ── obs:check prints a number only when that number is a measurement ─────────
// Split-file suite; shared imports live in contract-shared.ts.
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ROOT, assert, readFile, test } from "./contract-shared.ts";
import {
  checkBuckets,
  checkRun,
  classify,
  dailyTable,
  readCount,
  readGroups,
  readSeriesByDay,
  render,
  sampledAt,
  windowDayKeys,
} from "./check-observability.ts";

// THE DEFECT CLASS. #667 shipped three paths that printed a FAIL line and then
// rendered a full table of headroom underneath it, exit 0. A reader acts on the
// numbers, so a warning above wrong ones is not a refusal:
//
//   sampling      1-in-100 rows read "0.9% of ceiling, 99.1% headroom" on an
//                 account ingesting ~181,000/day, 90.5% of the ceiling
//   granularity   24 HOURLY buckets rendered as 24 daily rows, understating
//                 the peak 24x, on a response that echoed granularity back
//   retention     four days past the 3-day window printed "0  0.0%  100.0%",
//                 in the column and format a measured zero uses
//
// A SECOND PASS reached that same class through five doors the first left open,
// and every one of them was a fix written as ONE PATH. Those are the cases
// marked ROUND 2 below:
//
//   sampling      read at `series[].data[]` alone, so an interval on
//                 `calculations[].aggregates[]` exited 0 at "0.9% of ceiling"
//   the interval  `Number(v) || 1` read 0, -100, null, "abc" and 0.01 as
//                 unsampled, and 0.01 is head_sampling_rate's own spelling
//   folding       one row per SERIES ENTRY, peak per row, so two buckets on one
//                 day halved a day that had spent the whole ceiling
//   the clocks    `stamp >= todayStart` mixed this machine's clock with
//                 Cloudflare's, unbounded above and never checked against the
//                 window, so a slow clock dropped a real day from the peak
//   the gap       rows returned were never counted against days requested
//
// A THIRD PASS found the rooms off that corridor, all four in the SECONDARY
// tiers rounds 1 and 2 never keyed on. Those are marked ROUND 3:
//
//   the split     `checkBuckets` WAS run on the split series and only
//                 `.problem` was read, so a day the split never answered
//                 rendered `0` in every dataset column beside a total of
//                 100,000: tracing reported as contributing nothing on a day
//                 nobody measured, exit 0
//   the breakdown `Number(a.value) || 0` printed "lots" as 0, under a comment
//                 in the same block saying these rows were held to the rule
//   the payload   a bucket whose `data` was an object threw
//                 "{} is not iterable" and exited 2 on a stack trace
//   the count     `Number.isFinite(Number(v))` read `true` as 1 and `[7]` as 7
//
// The fix is one GATE rather than four patches, so the tests above are held at
// `readCount`, `render`, `readGroups` and `readSeriesByDay` themselves: a fifth
// tier that skips the gate cannot print at all, which is a property of the
// choke point rather than a rule anyone has to remember.
//
// Every case below is held at the function that decides it and again end to end
// through main().

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const TOOL = "tools/check-observability.ts";

// ── ROUND 3: the gate ───────────────────────────────────────────────────────
// Rounds 1 and 2 each fixed the tier they were shown and left the siblings open,
// because every tier did its own checking. These hold the CHOKE POINT instead:
// `readCount` is the only way a wire value becomes a number and `render` is the
// only way a number becomes text. A fourth tier that skips them cannot print.

test("readCount is the only door, and Number() opens four that it closes", () => {
  const measured = (v) => {
    const f = readCount(v);
    assert.equal(f.state, "measured", `${JSON.stringify(v)} is a count`);
    return f;
  };
  assert.equal(render(measured(0)), "0", "a real zero is a reading and prints as one");
  assert.equal(render(measured(200_000)), "200,000");

  // The four coercions. `Number.isFinite(Number(v))` said yes to all of them,
  // and `Number(v) || 0` printed the last two as counts.
  for (const [value, note] of [
    [true, "Number(true) is 1"],
    [[7], "Number([7]) is 7"],
    ["12", 'Number("12") is 12'],
    [null, "Number(null) is 0"],
    ["abc", "Number('abc') is NaN"],
    [undefined, "an absent field"],
    [-1, "a negative count rendered 125.0% headroom"],
    [1.5, "an event count counts events"],
    [Number.NaN, "NaN"],
    [Number.POSITIVE_INFINITY, "Infinity"],
  ]) {
    assert.equal(readCount(value).state, "unreadable", `${JSON.stringify(value) ?? "undefined"}: ${note}`);
  }
});

test("render refuses anything it cannot vouch for, which is what makes the gate structural", () => {
  // BLOCKING. TypeScript refuses a bare number here and TypeScript does not run:
  // this suite is .mjs, and a future tier holding `a.value` as unknown can cast
  // past the compiler. The brand is a module-private symbol, so a hand-built
  // lookalike fails too. Throwing lands in main()'s catch as exit 2 with no
  // table above it; printing a marker would be the warning-over-wrong-numbers
  // shape this whole file refuses.
  for (const raw of [0, 42, "42", null, undefined, { state: "measured", value: 5 }]) {
    assert.throws(
      () => render(raw),
      /rather than a Figure/,
      `${JSON.stringify(raw) ?? "undefined"} must not be printable`,
    );
  }
  assert.equal(render(readCount(1234)), "1,234", "and a real Figure still renders");

  // THE TWO UNMEASURED STATES ARE NOT THE SAME MARK, which is this file's own
  // rule one level down. A dash says nothing was read. A question mark says
  // something WAS read and is not a count, which is a payload change and a
  // different thing for a reader to do something about.
  const todayStart = Math.floor(Date.now() / DAY_MS) * DAY_MS;
  const key = new Date(todayStart - DAY_MS).toISOString().slice(0, 10);
  const nothingRead = readSeriesByDay([{ time: String(todayStart - DAY_MS), data: [] }], [key]);
  assert.equal(render(nothingRead.byDay.get(key)?.total), "-", "absent renders as a dash");
  assert.equal(render(readCount("abc")), "?", "unreadable renders as a question mark, never as a dash");
});

test("readGroups drops a breakdown whole rather than printing a hole in it", () => {
  const row = (name, value) => ({ value, groups: [{ key: "s", value: name }] });

  const good = readGroups([row("aadhar-sh", 12), row("cf-garage", 400)]);
  assert.equal(good.problem, null, "a clean breakdown is not blanket-red");
  assert.deepEqual(good.rows.map((r) => r.name), ["cf-garage", "aadhar-sh"], "sorted by the reading, descending");
  assert.equal(render(good.rows[0].events), "400");

  // MEDIUM. `Number(a.value) || 0` printed this as 0, under a comment in the
  // same block claiming these rows were held to the same rule as the total.
  const bad = readGroups([row("aadhar-sh", "lots"), row("cf-garage", 400)]);
  assert.match(bad.problem ?? "", /not a number/, "the bad row names itself");
  assert.equal(bad.rows.length, 0, "and the rows beside it are dropped, since the same code read them");
});

test("readSeriesByDay is one parse, so the refusal and the render cannot disagree", () => {
  const todayStart = Math.floor(Date.now() / DAY_MS) * DAY_MS;
  const key = (back) => new Date(todayStart - back * DAY_MS).toISOString().slice(0, 10);
  const time = (back) => String(todayStart - back * DAY_MS);

  // The declared type says `data` is a list of aggregates and the WIRE says
  // whatever it says, which is the lie this parse exists to catch, so a fixture
  // for it has to be cast rather than typed.
  const wire = (v) => /** @type {any} */ (v);

  // LOW. Round 2 iterated `data` directly, so this threw "is not iterable" and
  // exited 2 on a stack trace where every other bad payload got a sentence.
  const notList = readSeriesByDay(wire([{ time: time(1), data: { value: 12 } }]), [key(1)]);
  assert.match(notList.problem ?? "", /list of aggregates/, "a non-list `data` is a named payload change");

  // A refusal no longer stops the walk, so the fold stays correct on a response
  // nothing can vouch for. That is what lets dailyTable read from this result.
  const doubled = readSeriesByDay([{ time: time(1), data: [{ value: 100_000 }] }, { time: time(1), data: [{ value: 100_000 }] }], [key(1)]);
  assert.match(doubled.problem ?? "", /2 buckets/, "two buckets on one day still refuse");
  assert.equal(render(doubled.byDay.get(key(1))?.total), "200,000", "and the day still sums correctly");

  // An EMPTY aggregate list is absence rather than zero, on the rule the whole
  // file serves, so the day reads unanswered instead of quietly calm.
  const empty = readSeriesByDay([{ time: time(1), data: [] }], [key(1)]);
  assert.equal(empty.problem, null, "an empty bucket is not the response contradicting itself");
  assert.deepEqual(empty.unanswered, [key(1)], "but it is not a reading either");
  assert.equal(render(empty.byDay.get(key(1))?.total), "-");
});

test("classify separates its four states, and sampling beats a real count", () => {
  assert.equal(classify(0, false), "no-data", "an empty window is not data");
  assert.equal(classify(0, true), "contradiction", "a count of 0 next to a real event is a broken instrument");
  assert.equal(classify(12, false), "data", "a real count is a reading, so a genuine daily 0 still prints as 0");

  // BLOCKING 1. Ordering is the assertion: #667 tested the sample AFTER
  // deciding there was data, so a large count carried the render past it.
  assert.equal(classify(1810, true, 100), "sampled", "a 1-in-100 sample is not a reading");
  assert.equal(classify(181_000, false, 100), "sampled", "a large count does not make a sampled count measured");
  assert.equal(classify(0, false, 2), "sampled", "even a sampled zero refuses, since the zero is 1 in 2 of unknown");
  assert.equal(classify(5, true, 1), "data", "an interval of 1 is not sampling and must not refuse");
});

test("checkRun refuses a run the API did not execute as asked", () => {
  const day = { granularity: DAY_MS };

  // BLOCKING 2. The response echoes the resolved run, so this is a comparison
  // rather than an inference from row labels.
  const hourly = checkRun({ run: { dry: false, granularity: HOUR_MS } }, day);
  assert.ok(hourly, "hourly buckets must refuse when whole days were asked for");
  assert.match(hourly, /24\.00x/, "the message names how far off each row is");

  // Design point #2: `dry` defaults to TRUE in Cloudflare's schema and a dry run
  // returns nothing, which is indistinguishable from a quiet day.
  assert.ok(checkRun({ run: { dry: true, granularity: DAY_MS } }, day), "a dry run refuses");
  assert.ok(checkRun({ run: { granularity: DAY_MS } }, day), "an absent dry field refuses rather than being read as false");
  assert.ok(checkRun({}, day), "a response with no run block is unverifiable, which is not the same as verified");
  assert.ok(checkRun({ run: { dry: false, granularity: "day" } }, day), "a non-numeric granularity refuses");

  // It must not be blanket-red, or it would refuse every real reading.
  assert.equal(checkRun({ run: { dry: false, granularity: DAY_MS } }, day), null);
  assert.equal(checkRun({ run: { dry: false } }), null, "with no granularity asked for, dry alone decides");
});

// ── ROUND 2, BLOCKING 1: the sample interval has more than one home ──────────
// Cloudflare declares `sampleInterval` once, on `zAggregateResult`, and reuses
// that object at `aggregates[]` and `series[].data[]` inside
// `zQueryRunCalculationsV2`, which `zReturnedQueryRunResult` then embeds at both
// `calculations` and `compare`. One declaration, four live paths. A checker
// keyed on the field name covers all four; a path list covers whichever the
// author happened to think of.
const calcWith = (agg) => ({ calculations: [{ aggregates: agg, series: [] }] });

test("sampledAt finds an interval wherever the schema can put one", () => {
  assert.equal(sampledAt(calcWith([{ value: 5, sampleInterval: 100 }])).state, "sampled",
    "an interval on the WINDOW AGGREGATE is the door round 1 left open");
  assert.equal(sampledAt({ calculations: [{ aggregates: [], series: [{ time: "0", data: [{ value: 5, sampleInterval: 4 }] }] }] }).state,
    "sampled", "an interval on a bucket still refuses");
  assert.equal(sampledAt({ compare: [{ aggregates: [{ value: 5, sampleInterval: 7 }], series: [] }] }).state,
    "sampled", "`compare` reuses the same object and no path list here ever named it");
  assert.equal(sampledAt({ a: { b: { c: [{ deep: { sampleInterval: 3 } }] } } }).state, "sampled",
    "depth is not a limit: the walk is keyed on the field, not on a known nesting");

  // The WORST interval wins, since one sampled bucket makes the window's total
  // an understatement by an unknown factor.
  const mixed = sampledAt({
    calculations: [{ aggregates: [{ value: 1, sampleInterval: 2 }], series: [{ time: "0", data: [{ value: 1, sampleInterval: 50 }] }] }],
  });
  assert.equal(mixed.state, "sampled");
  assert.equal(mixed.interval, 50, "the worst interval anywhere in the response is the one reported");

  // Not blanket-red, or every real reading would refuse.
  assert.equal(sampledAt(calcWith([{ value: 5, sampleInterval: 1 }])).state, "unsampled", "an interval of exactly 1 is not sampling");
  assert.equal(sampledAt({ calculations: [{ aggregates: [{ value: 5 }], series: [] }] }).state, "unsampled",
    "a response that says nothing about sampling is not sampled");
});

// ── ROUND 2, MEDIUM 1: an unreadable interval is not "no sampling" ───────────
test("sampledAt refuses an interval that is not a positive integer", () => {
  // 0.01 is the dangerous member. head_sampling_rate is documented as a RATE in
  // 0..1 where 0.01 keeps one request in a hundred; this field is its
  // reciprocal, where 100 says the same thing. `Number(v) || 1` read 0.01 as
  // unsampled and rendered a full table with headroom.
  for (const value of [0, -100, null, "abc", 0.01, 1.5, Number.NaN, undefined]) {
    const got = sampledAt(calcWith([{ value: 5, sampleInterval: value }]));
    assert.equal(got.state, "unreadable", `sampleInterval ${JSON.stringify(value)} must refuse, not read as unsampled`);
  }
  const rate = sampledAt(calcWith([{ value: 5, sampleInterval: 0.01 }]));
  assert.ok(rate.state === "unreadable" && /head_sampling_rate/.test(rate.why),
    "the refusal names the rate-versus-interval ambiguity it cannot resolve");
});

// ── ROUND 2, BLOCKING 2 + HIGH 1 + MEDIUM 2 + LOW 1 ─────────────────────────
const key = (todayStart, back) => new Date(todayStart - back * DAY_MS).toISOString().slice(0, 10);
const at = (todayStart, back, value) => ({ time: String(todayStart - back * DAY_MS), data: [{ value }] });

/** A rendered row, asserted present: every day asked for gets one, so a missing
 *  row is the renderer dropping a day rather than a test looking in the wrong
 *  place. Narrowing it here also keeps `assert.match` off a possible undefined. */
const rowStarting = (rows, prefix) => {
  const row = rows.find((l) => l.startsWith(prefix));
  assert.ok(row, `no row rendered starting "${prefix.trim()}"; nothing may disappear silently`);
  return row;
};
const lineWith = (rows, needle) => {
  const row = rows.find((l) => l.includes(needle));
  assert.ok(row, `no line containing "${needle}"`);
  return row;
};
/** checkBuckets' refusal, asserted present before it is read. */
const refusal = (result, why) => {
  assert.ok(result.problem, why);
  return result.problem;
};

test("checkBuckets reconciles the buckets returned with the window asked for", () => {
  const todayStart = Math.floor(Date.now() / DAY_MS) * DAY_MS;
  const days = [key(todayStart, 2), key(todayStart, 1), key(todayStart, 0)];

  // BLOCKING 2. The query asked for daily granularity and checkRun confirmed the
  // API echoed it, so a second bucket on one day is the response contradicting
  // its own echo. Round 1 peaked per ROW, so this halved the day.
  const doubled = refusal(checkBuckets([at(todayStart, 1, 100_000), at(todayStart, 1, 100_000)], days),
    "two buckets stamped one day must refuse, not be silently peaked one at a time");
  assert.match(doubled, /2 buckets/, "the refusal names what it saw");

  // HIGH 1. The stamps come from Cloudflare and the window from this machine.
  // Nothing reconciled them and nothing bounded `partial` above.
  assert.ok(checkBuckets([at(todayStart, 9, 5)], days).problem, "a bucket older than the window refuses");
  const future = refusal(checkBuckets([at(todayStart, -3, 5)], days),
    "a bucket in the future refuses rather than being marked partial");
  assert.match(future, /outside the/, "and says it is outside the window asked for");
  assert.ok(checkBuckets([{ time: "not-a-time", data: [{ value: 1 }] }], days).problem,
    "an unreadable stamp refuses rather than landing on 1970-01-01");

  // LOW 1. `Number(v) || 0` passed -50,000 through, which rendered as -25.0%
  // used and 125.0% headroom, and read "abc" and null as a measured zero.
  assert.ok(checkBuckets([at(todayStart, 1, -50_000)], days).problem, "a negative event count is not a count");
  assert.ok(checkBuckets([at(todayStart, 1, "abc")], days).problem, "a non-numeric count refuses rather than reading as 0");

  // MEDIUM 2. A 3-day window answered with one bucket printed a confident peak
  // and full headroom, with the header still saying 3 days.
  const gap = checkBuckets([at(todayStart, 1, 12_000)], days);
  assert.equal(gap.problem, null, "an omitted empty bucket may be normal, so it is marked rather than refused");
  assert.deepEqual(gap.unanswered, [key(todayStart, 2), key(todayStart, 0)], "and both unanswered days are named");

  // Not blanket-red.
  const clean = checkBuckets([at(todayStart, 2, 1), at(todayStart, 1, 0), at(todayStart, 0, 3)], days);
  assert.equal(clean.problem, null);
  assert.deepEqual(clean.unanswered, [], "a fully answered window reports no gap");
});

test("windowDayKeys returns one key per UTC day the window touches", () => {
  const todayStart = Math.floor(Date.now() / DAY_MS) * DAY_MS;
  const keys = windowDayKeys(todayStart - 2 * DAY_MS, todayStart + HOUR_MS);
  assert.deepEqual(keys, [key(todayStart, 2), key(todayStart, 1), key(todayStart, 0)]);
  assert.equal(keys[keys.length - 1], key(todayStart, 0), "the last key is the day holding the window end");
});

test("dailyTable folds by UTC day, so the row count cannot decide the peak", () => {
  const todayStart = Math.floor(Date.now() / DAY_MS) * DAY_MS;
  // The BLOCKING 2 shape, rendered rather than refused: a day that consumed the
  // whole ceiling arriving as two buckets. Round 1 printed 100,000 and 50.0%.
  const rows = dailyTable({
    series: [at(todayStart, 1, 100_000), at(todayStart, 1, 100_000)],
    days: [key(todayStart, 1), key(todayStart, 0)],
    todayKey: key(todayStart, 0),
  });
  const day = rowStarting(rows, `  ${key(todayStart, 1)}`);
  assert.match(day, /200,000/, "both buckets are summed into it");
  assert.match(day, /100\.0%/, "so it scores as the full ceiling rather than half of it");
  assert.equal(rows.filter((l) => l.startsWith(`  ${key(todayStart, 1)}`)).length, 1, "one row per DAY, never per bucket");

  assert.match(lineWith(rows, "worst COMPLETE day"), /200,000/, "and the peak is the folded total");
});

test("dailyTable never scores a day it cannot vouch for", () => {
  const todayStart = Math.floor(Date.now() / DAY_MS) * DAY_MS;
  const rows = dailyTable({
    series: [
      at(todayStart, 5, 0), // past retention, unread
      at(todayStart, 2, 48_120),
      at(todayStart, 1, 0), // a MEASURED zero, which must still print as 0
      at(todayStart, 0, 9_004), // today, incomplete
    ],
    days: [key(todayStart, 5), key(todayStart, 2), key(todayStart, 1), key(todayStart, 0)],
    todayKey: key(todayStart, 0),
    retentionFrom: key(todayStart, 2),
  });
  const rowFor = (back) => rowStarting(rows, `  ${key(todayStart, back)}`);

  const expired = rowFor(5);
  assert.match(expired, /past retention/, "it says why it carries no numbers");
  assert.doesNotMatch(expired, /%/, "an expired day never shows a share or headroom");
  assert.doesNotMatch(expired, /\s0\s/, "an expired day must not render as a zero");

  const measuredZero = rowFor(1);
  assert.match(measuredZero, /\s0\s/, "a measured zero prints as 0");
  assert.match(measuredZero, /100\.0%/, "and keeps its headroom, because it is a reading");

  assert.match(rowFor(0), /partial/, "today is marked rather than scored against a full-day ceiling");

  const peak = lineWith(rows, "worst COMPLETE day");
  assert.match(peak, /48,120/, "the peak is the worst complete day inside retention");
  assert.ok(!rows.some((l) => /worst COMPLETE day: 0 /.test(l)), "an expired 0 never becomes the peak");
});

test("a split column answers for its OWN days, never for the total's", () => {
  // ROUND 3, HIGH, at the function that decides it. `checkBuckets` WAS called on
  // the split series, and only `.problem` was read: the `unanswered` array was
  // discarded and the cell asked `totals.has(day)` instead. So a day the split
  // query never returned rendered `0` in every dataset column beside a real
  // total, at exit 0, saying tracing contributed nothing on a day nobody
  // measured. The split is parsed by the same walk as the total now.
  const todayStart = Math.floor(Date.now() / DAY_MS) * DAY_MS;
  const key = (back) => new Date(todayStart - back * DAY_MS).toISOString().slice(0, 10);
  const time = (back) => String(todayStart - back * DAY_MS);
  const pair = (back, traces, logs) => ({
    time: time(back),
    data: [
      { value: traces, groups: [{ key: "dataset", value: "traces" }] },
      { value: logs, groups: [{ key: "dataset", value: "logs" }] },
    ],
  });

  const rows = dailyTable({
    series: [{ time: time(2), data: [{ value: 3000 }] }, { time: time(1), data: [{ value: 100_000 }] }],
    split: [pair(2, 2000, 1000)],
    days: [key(2), key(1), key(0)],
    todayKey: key(0),
  });
  const answered = rowStarting(rows, `  ${key(2)}`);
  const gap = rowStarting(rows, `  ${key(1)}`);

  assert.match(answered, /2,000/, "the day the split answered prints its real columns");
  assert.match(answered, /1,000/);
  assert.match(gap, /100,000/, "the total is a reading and still prints");
  assert.doesNotMatch(gap, /\s0\s/, "and the split columns must NOT read as a measured zero");
  // Count dashes past the date, since the day key carries two of its own.
  assert.equal((gap.slice(gap.indexOf(key(1)) + key(1).length).match(/-/g) ?? []).length, 2, "both dataset cells read as unread");
  assert.ok(
    rows.some((l) => l.includes("the split query returned no bucket")),
    "and the run says so out loud rather than leaving the dashes unexplained",
  );

  // A group MISSING from a bucket the split DID answer is a real zero, since a
  // group-by returns only groups that carried events.
  const partial = dailyTable({
    series: [{ time: time(1), data: [{ value: 5 }] }],
    split: [{ time: time(1), data: [{ value: 5, groups: [{ key: "dataset", value: "traces" }] }] }],
    days: [key(1)],
    todayKey: key(0),
  });
  assert.match(rowStarting(partial, `  ${key(1)}`), /\s5\s/, "the group that reported prints");
});

test("a split that does not add up to the total is dropped rather than printed beside it", () => {
  // The split is the same query plus a group-by, so on a day both answered the
  // groups must sum to the total. If they do not, the columns are not a
  // decomposition of the number beside them and a reader would take them as one.
  const todayStart = Math.floor(Date.now() / DAY_MS) * DAY_MS;
  const key = (back) => new Date(todayStart - back * DAY_MS).toISOString().slice(0, 10);
  const time = (back) => String(todayStart - back * DAY_MS);

  const rows = dailyTable({
    series: [{ time: time(1), data: [{ value: 100_000 }] }],
    split: [{ time: time(1), data: [{ value: 1, groups: [{ key: "dataset", value: "traces" }] }] }],
    days: [key(1)],
    todayKey: key(0),
  });
  assert.ok(rows.some((l) => l.includes("not a decomposition")), "the mismatch is named");
  assert.doesNotMatch(rowStarting(rows, `  ${key(1)}`), /\s1\s/, "the bogus column is gone");
  assert.match(rowStarting(rows, `  ${key(1)}`), /100,000/, "the total is unaffected: it carries no group-by");
});

test("dailyTable prints no headroom over a day the API never answered for", () => {
  const todayStart = Math.floor(Date.now() / DAY_MS) * DAY_MS;
  const rows = dailyTable({
    series: [at(todayStart, 1, 12_000)],
    days: [key(todayStart, 2), key(todayStart, 1), key(todayStart, 0)],
    todayKey: key(todayStart, 0),
  });

  const missing = rowStarting(rows, `  ${key(todayStart, 2)}`);
  assert.match(missing, /no row returned/, "an unanswered day says so");
  assert.doesNotMatch(missing, /%/, "and carries no share or headroom");
  assert.doesNotMatch(missing, /\s0\s/, "and is never rendered as a measured zero");

  // The measured maximum survives, labelled as a peak over the days that
  // returned a bucket. The extrapolated comfort does not, because an unanswered
  // day can falsify it and it is the figure a reader acts on.
  assert.ok(!rows.some((l) => /to spare|more \/lens scans|worst COMPLETE day/.test(l)),
    "no headroom sentence over an incomplete window");
  const answered = lineWith(rows, "worst ANSWERED day");
  assert.match(answered, /12,000/, "the largest answered day still prints, because it is measured");
  assert.match(answered, /1 day\(s\) that returned one/, "named with the denominator that makes the claim true");
  // TODAY is excluded from that count: it is never scored, so it cannot falsify
  // the peak, and counting it would suppress headroom every UTC morning.
  assert.ok(rows.some((l) => /1 of the 3 day\(s\) asked for/.test(l)), "and the gap itself is counted out loud");
  const today = rowStarting(rows, `  ${key(todayStart, 0)}`);
  assert.match(today, /partial/, "an unanswered today reads as incomplete rather than as a gap");
  assert.doesNotMatch(today, /\s0\s/, "and still never renders as a measured zero");
});

test("the share and its headroom are complements, so the pair sums to 100.0", () => {
  const todayStart = Math.floor(Date.now() / DAY_MS) * DAY_MS;
  // 1,500 of 200,000 is 0.75%, the value that rounded to 0.8% used and 99.3%
  // left in #667 because each was computed from the raw number.
  for (const value of [1_500, 48_120, 1, 199_999, 123_456]) {
    const rows = dailyTable({
      series: [at(todayStart, 1, value)],
      days: [key(todayStart, 1), key(todayStart, 0)],
      todayKey: key(todayStart, 0),
    });
    const row = rowStarting(rows, `  ${key(todayStart, 1)}`);
    const [used, left] = [...row.matchAll(/([\d.]+)%/g)].map((m) => Number(m[1]));
    assert.equal(used + left, 100, `${value} printed ${used}% + ${left}%`);
  }
});

// ── end to end, through main(), on a stubbed fetch ──────────────────────────
// The pure cases above prove each decision; these prove the EXIT CODE and that
// no headroom figure survives the refusal, which is the property #667 broke.
// The stub is written to a temp dir rather than committed: it exists to be a
// fake API for a dozen runs, and a fixture in tools/ would be a second file to
// keep honest. Nothing here touches the network, since the stub replaces fetch
// before the tool loads.
const STUB = `
const DAY = ${DAY_MS}, HOUR = ${HOUR_MS};
const todayStart = Math.floor(Date.now() / DAY) * DAY;
const scenario = process.env.OBS_STUB;
const days = (vals, sampleInterval) => vals.map((v, i) => ({
  time: String(todayStart - (vals.length - 1 - i) * DAY),
  data: [sampleInterval === undefined ? { value: v } : { value: v, sampleInterval }],
}));
const hours = (total) => Array.from({ length: 24 }, (_, i) => ({ time: String(todayStart + i * HOUR), data: [{ value: total / 24 }] }));
const at = (back, value) => ({ time: String(todayStart - back * DAY), data: [{ value }] });
const grouped = (back, pairs) => ({
  time: String(todayStart - back * DAY),
  data: pairs.map(([k, v]) => ({ value: v, groups: [{ key: "dataset", value: k }] })),
});
const calc = (aggregates, series) => ({ run: { dry: false, granularity: DAY }, calculations: [{ aggregates, series }] });
// ROUND 3 needs the three query shapes told apart, because its defects live in
// the SECONDARY tiers: the total, the daily split (groupBys + granularity) and
// the two breakdowns (groupBys, no granularity) all took one payload before, so
// no scenario could make the split disagree with the total.
const payload = (isProbe, isGrouped, isDaily) => {
  if (isProbe) return { run: { dry: false }, events: { events: [{ id: "e1" }] } };
  // ROUND 3, HIGH: the total answers all three days and the SPLIT answers one.
  // This exited 0 printing "traces 0" beside a total of 100,000.
  if (scenario === "split-gap") {
    if (isGrouped && isDaily) return calc([{ value: 3000 }], [grouped(2, [["traces", 3000]])]);
    if (isGrouped) return calc([{ value: 3000, groups: [{ key: "s", value: "aadhar-sh" }] }], []);
    return calc([{ value: 203000 }], [at(2, 3000), at(1, 100000), at(0, 100000)]);
  }
  // ROUND 3, MEDIUM: a breakdown row whose count is not one. Number(v) || 0
  // printed "lots" as 0 under a comment claiming the same rule applied here.
  if (scenario === "bad-breakdown") {
    if (isGrouped && !isDaily) return calc([{ value: "lots", groups: [{ key: "s", value: "aadhar-sh" }] }], []);
    if (isGrouped) return calc([{ value: 203000 }], [grouped(2, [["traces", 3000]]), grouped(1, [["traces", 100000]]), grouped(0, [["traces", 100000]])]);
    return calc([{ value: 203000 }], [at(2, 3000), at(1, 100000), at(0, 100000)]);
  }
  // ROUND 3, MEDIUM: the split disagrees with the total it decomposes.
  if (scenario === "split-mismatch") {
    if (isGrouped && isDaily) return calc([{ value: 1 }], [grouped(1, [["traces", 1]])]);
    if (isGrouped) return calc([{ value: 1, groups: [{ key: "s", value: "aadhar-sh" }] }], []);
    return calc([{ value: 100000 }], [at(1, 100000)]);
  }
  // ROUND 3, LOW: data is not a list, which threw "is not iterable".
  if (scenario === "data-not-array") return calc([{ value: 3000 }], [{ time: String(todayStart - DAY), data: { value: 12 } }]);
  // ROUND 3, HARDENING: Number(true) is 1 and Number([7]) is 7, and
  // Number.isFinite said yes to both.
  if (scenario === "bool-count") return calc([{ value: 1 }], [at(1, true)]);
  if (scenario === "boxed-count") return calc([{ value: 7 }], [at(1, [7])]);
  if (scenario === "string-count") return calc([{ value: 12 }], [at(1, "12")]);
  if (scenario === "sampling") return calc([{ value: 5430 }], days([1810, 1810, 1810], 100));
  // ROUND 2: the interval rides the WINDOW AGGREGATE, which round 1 never read.
  if (scenario === "aggregate-sampling") return calc([{ value: 5430, sampleInterval: 100 }], days([1810, 1810, 1810]));
  // ROUND 2: head_sampling_rate's own spelling arriving where an interval is expected.
  if (scenario === "rate-not-interval") return calc([{ value: 5430 }], days([1810, 1810, 1810], 0.01));
  // ROUND 2: granularity honestly echoed as daily, two buckets on one day.
  if (scenario === "two-buckets") return calc([{ value: 200000 }], [at(1, 100000), at(1, 100000)]);
  // ROUND 2: a stamp this window never asked for, which is how clock skew arrives.
  if (scenario === "skewed-clock") return calc([{ value: 12000 }], [at(-4, 12000)]);
  // ROUND 2: a negative count inside an otherwise positive window.
  if (scenario === "negative-count") return calc([{ value: 0 }], [at(2, 30000), at(1, -50000), at(0, 4000)]);
  // ROUND 2: three days asked for, one bucket returned.
  if (scenario === "missing-days") return calc([{ value: 12000 }], [at(1, 12000)]);
  if (scenario === "granularity") return { run: { dry: false, granularity: HOUR }, calculations: [{ aggregates: [{ value: 192000 }], series: hours(192000) }] };
  if (scenario === "healthy") return calc([{ value: 57124 }], days([48120, 0, 9004]));
  if (scenario === "dry") return { run: { dry: true, granularity: DAY }, calculations: [{ aggregates: [{ value: 0 }], series: days([0, 0, 0]) }] };
  if (scenario === "unreadable-probe") return calc([{ value: 0 }], days([0, 0, 0]));
  throw new Error("unknown scenario " + scenario);
};
globalThis.fetch = async (input, init) => {
  // The control's transport/API split: this one never reaches an endpoint.
  if (scenario === "offline") throw new TypeError("Unable to connect. Is the computer able to access the url?");
  const sent = JSON.parse(String(init?.body ?? "{}"));
  const isProbe = sent.view === "events";
  const isGrouped = Array.isArray(sent.parameters?.groupBys);
  const isDaily = Boolean(sent.granularity);
  // 'unreadable-probe' returns a probe payload whose events array is missing, which is
  // indistinguishable from an empty one once it reaches Array.isArray.
  const body = scenario === "unreadable-probe" && isProbe ? { run: { dry: false }, events: {} } : payload(isProbe, isGrouped, isDaily);
  return new Response(JSON.stringify({ success: true, errors: [], messages: [], result: body }), { status: 200, headers: { "content-type": "application/json" } });
};
`;

function runTool(scenario, args = []) {
  const dir = mkdtempSync(path.join(tmpdir(), "obs-check-"));
  const stub = path.join(dir, "stub.mjs");
  writeFileSync(stub, STUB);
  const repo = fileURLToPath(new URL(".", ROOT));
  try {
    const stdout = execFileSync("bun", ["--preload", stub, TOOL, ...args], {
      cwd: repo,
      encoding: "utf8",
      env: { ...process.env, OBS_STUB: scenario, CLOUDFLARE_API_TOKEN: "stub-token" },
    });
    return { code: 0, stdout };
  } catch (e) {
    return { code: e.status ?? -1, stdout: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

/** Every phrase that only belongs above a real reading. */
const HEADROOM = [/headroom/i, /to spare/, /more \/lens scans/, /worst COMPLETE day/, /of ceiling/];

test("a refusal prints no headroom and exits non-zero", () => {
  const refusals = [];
  const refuses = (label, run, ...patterns) => {
    assert.notEqual(run.code, 0, `${label} must not exit 0`);
    for (const p of patterns) assert.match(run.stdout, p, `${label} must say why`);
    refusals.push(label);
    return run;
  };

  const sampled = refuses("a sampled dataset", runTool("sampling"), /sampled at 1 in 100/, /5 billion/);
  assert.doesNotMatch(sampled.stdout, /already past the ceiling/,
    "#667's advice ('sampling starts when the account is over quota, so read this as already past the ceiling') was false");

  refuses("an hourly granularity echo", runTool("granularity"), /did not run the query that was asked for/);
  refuses("a window past retention", runTool("healthy", ["--days", "7"]), /past the 3-day/);
  refuses("a dry run", runTool("dry"), /dry/);
  refuses("an unreadable probe payload", runTool("unreadable-probe"), /payload has changed/);

  // ROUND 2. Each of these exited 0 under round 1's repair.
  refuses("an interval on the window aggregate", runTool("aggregate-sampling"), /sampled at 1 in 100/);
  refuses("a rate where an interval was expected", runTool("rate-not-interval"), /head_sampling_rate/);
  refuses("two buckets on one day", runTool("two-buckets"), /2 buckets/, /granularity/);
  refuses("a bucket outside the window", runTool("skewed-clock"), /outside the/);
  refuses("a negative count", runTool("negative-count"), /non-negative/);

  // ROUND 3. The count guard was `Number.isFinite(Number(v))`, which reads
  // `true` as 1 event and `[7]` as 7, and `data` that is not a list threw a
  // TypeError out of checkBuckets and exited 2 on a stack trace.
  refuses("a boolean where a count belongs", runTool("bool-count"), /true is not a number/);
  refuses("a boxed number where a count belongs", runTool("boxed-count"), /\[7\] is not a number/);
  refuses("a numeric string where a count belongs", runTool("string-count"), /"12" is not a number/);
  const notList = refuses("a bucket whose `data` is not a list", runTool("data-not-array"), /list of aggregates/);
  assert.doesNotMatch(notList.stdout, /TypeError|is not iterable/, "a malformed payload gets a sentence, not a stack trace");

  for (const scenario of ["sampling", "granularity", "dry", "unreadable-probe", "aggregate-sampling",
    "rate-not-interval", "two-buckets", "skewed-clock", "negative-count",
    "bool-count", "boxed-count", "string-count", "data-not-array"]) {
    const { stdout } = runTool(scenario);
    for (const phrase of HEADROOM) {
      assert.doesNotMatch(stdout, phrase, `${scenario} printed ${phrase}, which is what a reader acts on`);
    }
  }
  const expired = runTool("healthy", ["--days", "7"]);
  for (const phrase of HEADROOM) assert.doesNotMatch(expired.stdout, phrase);

  // FLOOR: fourteen refusal paths ran. A scenario silently failing to reach the
  // tool would otherwise report as a clean pass over zero assertions.
  assert.equal(refusals.length, 14, "every refusal scenario has to have run");
});

test("a secondary tier that cannot be read is dropped, and the total it sits beside still prints", () => {
  // ROUND 3 end to end, and both of these EXIT 0 on purpose. The window total
  // is asked with no group-by and no per-day tier can falsify it, so refusing
  // the run would be blanket-red on a reading that is sound. What they may not
  // do is print a number for the tier that was not read.
  const gap = runTool("split-gap");
  assert.equal(gap.code, 0, "the totals are a measurement and still stand");
  assert.match(gap.stdout, /100,000/, "and they print");
  assert.match(gap.stdout, /the split query returned no bucket/, "the missing split days say so");
  for (const line of gap.stdout.split("\n").filter((l) => /^ {2}\d{4}-\d{2}-\d{2}/.test(l))) {
    // The defect exactly: a day the split never answered rendered "traces 0"
    // next to "total 100,000". Any dataset cell here is either a real number
    // from the split or a dash.
    if (line.includes("100,000")) assert.doesNotMatch(line, /\s0\s/, `a fabricated zero survived: ${line}`);
  }

  const breakdown = runTool("bad-breakdown");
  assert.equal(breakdown.code, 0, "one bad breakdown row does not unwind a sound window total");
  assert.match(breakdown.stdout, /unavailable: aadhar-sh carried a count that is not one/, "the breakdown names its own refusal");
  assert.doesNotMatch(breakdown.stdout, /aadhar-sh\s+0\s*$/m, '"lots" must never render as 0');

  const mismatch = runTool("split-mismatch");
  assert.equal(mismatch.code, 0);
  assert.match(mismatch.stdout, /not a decomposition/, "a split that does not sum to the total is named and dropped");
});

test("a window with an unanswered day reads as incomplete rather than roomy", () => {
  // MEDIUM 2 end to end. This one EXITS 0, because an omitted empty bucket may
  // be ordinary API behaviour and refusing would be blanket-red on a quiet
  // account. What it may not do is print the figure a reader acts on.
  const { code, stdout } = runTool("missing-days");
  assert.equal(code, 0, "a partial answer is still a reading for the days that came back");
  assert.match(stdout, /no row returned/, "the days that went unanswered say so");
  assert.match(stdout, /no bucket at all/, "and the run counts them out loud");
  assert.match(stdout, /worst ANSWERED day: 12,000/, "the measured maximum prints, correctly named");
  for (const phrase of [/to spare/, /more \/lens scans/, /worst COMPLETE day/]) {
    assert.doesNotMatch(stdout, phrase, "no headroom claim over days nothing was read for");
  }
});

test("a healthy reading still renders, so the refusals are not blanket-red", () => {
  const { code, stdout } = runTool("healthy");
  assert.equal(code, 0, "a measured window exits 0");
  assert.match(stdout, /worst COMPLETE day: 48,120 events/);
  assert.match(stdout, /24\.1% of the 200,000 Workers Free ceiling/);
  assert.match(stdout, /ASSUMES Workers Free/, "the plan assumption is disclosed beside every percentage");
  assert.match(stdout, /20 million events\/month/, "and names what a Paid reader would need instead");
  assert.doesNotMatch(stdout, /no row returned/, "a fully answered window reports no gap");
});

// ── ROUND 2, HIGH 2: the control's transport split had no test ──────────────
// #667's control asserted `state === "error"` alone, which a dead network
// satisfies, so it printed two green "refused" lines with the endpoint
// untouched. Round 1 split transport from error and mutation testing then
// proved the split itself was uncovered: collapsing the two back left every
// test green. This is that test.
test("the control fails when its live cases never reach the API", () => {
  const { code, stdout } = runTool("offline", ["--control"]);
  assert.notEqual(code, 0, "a control whose requests never left the machine proves nothing and must not pass");
  assert.match(stdout, /never reached the API/, "it says the request did not arrive rather than calling it a refusal");
  assert.match(stdout, /proved nothing/, "and says what that costs");
  assert.doesNotMatch(stdout, /refused by the API/, "a transport failure must never render as an API refusal");
  assert.match(stdout, /VERDICT: \d+ case\(s\) failed/, "the verdict counts them");
});

test("the control passes its offline half against the real endpoint being unreachable", () => {
  // The same run proves the OTHER direction: the pure classifier and renderer
  // cases still ran and still passed, so the failure above is the two live
  // cases alone rather than a control that goes red on everything.
  const { stdout } = runTool("offline", ["--control"]);
  assert.match(stdout, /zero across the window with no event found -> no data/);
  assert.match(stdout, /an interval on the WINDOW AGGREGATE refuses/);
  assert.match(stdout, /two buckets stamped the same day refuse/);
  assert.match(stdout, /a bucket outside the requested window refuses/);
  assert.match(stdout, /VERDICT: 2 case\(s\) failed/, "exactly the two live cases failed");
});

test("the tool has exactly one success exit, and the module does not run on import", async () => {
  const src = await readFile(new URL("check-observability.ts", import.meta.url), "utf8");

  // TWO success exits and no more, one per entry point: the reading at the end
  // of main(), and the control's green verdict. A third would be a refusal that
  // had quietly become a pass.
  const zero = [...src.matchAll(/process\.exit\(0\)/g)].length;
  const nonZero = [...src.matchAll(/process\.exit\((?:1|2|[a-z])/g)].length;
  assert.equal(zero, 2, "one success exit for the reading, one for the control verdict");
  assert.ok(nonZero >= 10, `expected at least 10 refusal exits, found ${nonZero}`);

  // classify and dailyTable are exported to be tested, and an unguarded main()
  // ran on import: this file could not have existed before the guard.
  assert.match(src, /if \(import\.meta\.main\)/, "main() runs only as the entry point");

  // VOICE. Four em dashes were inherited from #667 and are not this file's to
  // keep. The character is written as an escape so that a tree-wide grep for it
  // does not find this assertion and read the checker as a violation.
  assert.equal(src.split("\u2014").length - 1, 0, "no em dashes");
});
