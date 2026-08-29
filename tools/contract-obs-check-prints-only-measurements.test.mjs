// ── obs:check prints a number only when that number is a measurement ─────────
// Split-file suite; shared imports live in contract-shared.ts.
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ROOT, assert, readFile, test } from "./contract-shared.ts";
import { checkRun, classify, dailyTable } from "./check-observability.ts";

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
// Every case below is one of those three, held at the function that decides it
// and again end to end through main().

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const TOOL = "tools/check-observability.ts";

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

/** One day bucket, `back` days before the current UTC midnight. */
const bucket = (todayStart, back, value) => ({ time: String(todayStart - back * DAY_MS), data: [{ value }] });

test("dailyTable never scores a day it cannot vouch for", () => {
  const todayStart = Math.floor(Date.now() / DAY_MS) * DAY_MS;
  const retentionStart = todayStart - 2 * DAY_MS;
  const rows = dailyTable(
    [
      bucket(todayStart, 5, 0), // BLOCKING 3: past retention, unread
      bucket(todayStart, 2, 48_120),
      bucket(todayStart, 1, 0), // a MEASURED zero, which must still print as 0
      bucket(todayStart, 0, 9_004), // today, incomplete
    ],
    null,
    todayStart,
    retentionStart,
  );
  const rowFor = (back) => {
    const stamp = new Date(todayStart - back * DAY_MS).toISOString().slice(0, 10);
    const row = rows.find((l) => l.startsWith(`  ${stamp}`));
    // Every day handed in gets a row, so a missing one is the renderer dropping
    // a day rather than a test looking in the wrong place.
    assert.ok(row, `no row rendered for ${stamp}; nothing may disappear silently`);
    return row;
  };

  const expired = rowFor(5);
  assert.match(expired, /past retention/, "it says why it carries no numbers");
  assert.doesNotMatch(expired, /%/, "an expired day never shows a share or headroom");
  assert.doesNotMatch(expired, /\s0\s/, "an expired day must not render as a zero");

  const measuredZero = rowFor(1);
  assert.match(measuredZero, /\s0\s/, "a measured zero prints as 0");
  assert.match(measuredZero, /100\.0%/, "and keeps its headroom, because it is a reading");

  assert.match(rowFor(0), /partial/, "today is marked rather than scored against a full-day ceiling");

  const peak = rows.find((l) => l.includes("worst COMPLETE day"));
  assert.ok(peak, "a window with a complete day names its peak");
  assert.match(peak, /48,120/, "the peak is the worst complete day inside retention");
  assert.ok(!rows.some((l) => /worst COMPLETE day: 0 /.test(l)), "an expired 0 never becomes the peak");
});

test("the share and its headroom are complements, so the pair sums to 100.0", () => {
  const todayStart = Math.floor(Date.now() / DAY_MS) * DAY_MS;
  // 1,500 of 200,000 is 0.75%, the value that rounded to 0.8% used and 99.3%
  // left in #667 because each was computed from the raw number.
  for (const value of [1_500, 48_120, 1, 199_999, 123_456]) {
    const rows = dailyTable([bucket(todayStart, 1, value)], null, todayStart);
    const row = rows.find((l) => l.includes("%"));
    assert.ok(row, `no scored row rendered for ${value}`);
    const [used, left] = [...row.matchAll(/([\d.]+)%/g)].map((m) => Number(m[1]));
    assert.equal(used + left, 100, `${value} printed ${used}% + ${left}%`);
  }
});

// ── end to end, through main(), on a stubbed fetch ──────────────────────────
// The pure cases above prove each decision; these prove the EXIT CODE and that
// no headroom figure survives the refusal, which is the property #667 broke.
// The stub is written to a temp dir rather than committed: it exists to be a
// fake API for three runs, and a fixture in tools/ would be a second file to
// keep honest. Nothing here touches the network, since the stub replaces fetch
// before the tool loads.
const STUB = `
const DAY = ${DAY_MS}, HOUR = ${HOUR_MS};
const todayStart = Math.floor(Date.now() / DAY) * DAY;
const scenario = process.env.OBS_STUB;
const days = (vals, sampleInterval) => vals.map((v, i) => ({
  time: String(todayStart - (vals.length - 1 - i) * DAY),
  data: [sampleInterval ? { value: v, sampleInterval } : { value: v }],
}));
const hours = (total) => Array.from({ length: 24 }, (_, i) => ({ time: String(todayStart + i * HOUR), data: [{ value: total / 24 }] }));
const payload = (isProbe) => {
  if (isProbe) return { run: { dry: false }, events: { events: [{ id: "e1" }] } };
  if (scenario === "sampling") return { run: { dry: false, granularity: DAY }, calculations: [{ aggregates: [{ value: 5430 }], series: days([1810, 1810, 1810], 100) }] };
  if (scenario === "granularity") return { run: { dry: false, granularity: HOUR }, calculations: [{ aggregates: [{ value: 192000 }], series: hours(192000) }] };
  if (scenario === "healthy") return { run: { dry: false, granularity: DAY }, calculations: [{ aggregates: [{ value: 57124 }], series: days([48120, 0, 9004]) }] };
  if (scenario === "dry") return { run: { dry: true, granularity: DAY }, calculations: [{ aggregates: [{ value: 0 }], series: days([0, 0, 0]) }] };
  if (scenario === "unreadable-probe") return { run: { dry: false, granularity: DAY }, calculations: [{ aggregates: [{ value: 0 }], series: days([0, 0, 0]) }] };
  throw new Error("unknown scenario " + scenario);
};
globalThis.fetch = async (input, init) => {
  const sent = JSON.parse(String(init?.body ?? "{}"));
  const isProbe = sent.view === "events";
  // 'unreadable-probe' returns a probe payload whose events array is missing, which is
  // indistinguishable from an empty one once it reaches Array.isArray.
  const body = scenario === "unreadable-probe" && isProbe ? { run: { dry: false }, events: {} } : payload(isProbe);
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
  let refusals = 0;

  const sampled = runTool("sampling");
  assert.notEqual(sampled.code, 0, "a sampled dataset must not exit 0");
  assert.match(sampled.stdout, /sampled at 1 in 100/, "it names the interval it refused on");
  assert.match(sampled.stdout, /5 billion/, "it states Cloudflare's real sampling trigger");
  assert.doesNotMatch(sampled.stdout, /already past the ceiling/,
    "#667's advice ('sampling starts when the account is over quota, so read this as already past the ceiling') was false");
  refusals++;

  const hourly = runTool("granularity");
  assert.notEqual(hourly.code, 0, "an hourly granularity echo must not exit 0");
  assert.match(hourly.stdout, /did not run the query that was asked for/);
  refusals++;

  const expired = runTool("healthy", ["--days", "7"]);
  assert.notEqual(expired.code, 0, "a window past retention must not exit 0");
  assert.match(expired.stdout, /past the 3-day/, "it names the retention window it refused on");
  refusals++;

  const dry = runTool("dry");
  assert.notEqual(dry.code, 0, "a run the API executed as dry must not exit 0");
  refusals++;

  const unreadableProbe = runTool("unreadable-probe");
  assert.notEqual(unreadableProbe.code, 0, "an unreadable probe payload must not pass as a probe that found nothing");
  assert.match(unreadableProbe.stdout, /payload has changed/);
  refusals++;

  for (const { stdout } of [sampled, hourly, expired, dry, unreadableProbe]) {
    for (const phrase of HEADROOM) {
      assert.doesNotMatch(stdout, phrase, `a refusal printed ${phrase}, which is what a reader acts on`);
    }
  }

  // FLOOR: five refusal paths ran. A scenario silently failing to reach the
  // tool would otherwise report as a clean pass over zero assertions.
  assert.equal(refusals, 5, "every refusal scenario has to have run");
});

test("a healthy reading still renders, so the refusals are not blanket-red", () => {
  const { code, stdout } = runTool("healthy");
  assert.equal(code, 0, "a measured window exits 0");
  assert.match(stdout, /worst COMPLETE day: 48,120 events/);
  assert.match(stdout, /24\.1% of the 200,000 Workers Free ceiling/);
  assert.match(stdout, /ASSUMES Workers Free/, "the plan assumption is disclosed beside every percentage");
  assert.match(stdout, /20 million events\/month/, "and names what a Paid reader would need instead");
});

test("the tool has exactly one success exit, and the module does not run on import", async () => {
  const src = await readFile(new URL("check-observability.ts", import.meta.url), "utf8");

  // TWO success exits and no more, one per entry point: the reading at the end
  // of main(), and the control's green verdict. A third would be a refusal that
  // had quietly become a pass.
  const zero = [...src.matchAll(/process\.exit\(0\)/g)].length;
  const nonZero = [...src.matchAll(/process\.exit\((?:1|2|[a-z])/g)].length;
  assert.equal(zero, 2, "one success exit for the reading, one for the control verdict");
  assert.ok(nonZero >= 8, `expected at least 8 refusal exits, found ${nonZero}`);

  // classify and dailyTable are exported to be tested, and an unguarded main()
  // ran on import: this file could not have existed before the guard.
  assert.match(src, /if \(import\.meta\.main\)/, "main() runs only as the entry point");
});
