// ── ci:trend: a job that got slower, a main that stays red, a job that reruns green ──
import { assert, test } from "./contract-shared.ts";
import { FLOOR_S, MIN_RUNS, brokenMain, regressions, rerunFlakes, type Run } from "../ci-trend.ts";

// tools/ci-trend.ts judges the Actions API's runs and jobs. These fixtures are
// that shape, trimmed: a main push every 4 hours, so a 3-day stretch holds 18.

const UNTIL = Date.parse("2026-10-31T23:00:00Z");
const HOUR = 3600_000;
const iso = (ms: number) => new Date(ms).toISOString();

/** Successful CI pushes, newest first, each with one `validate` job of the given seconds. */
function pushes(seconds: (i: number) => number, count = 100): Run[] {
  return Array.from({ length: count }, (_, i) => {
    const at = UNTIL - i * 4 * HOUR;
    const took = seconds(i);
    const step = (name: string, s: number) => ({ name, started: iso(at), completed: iso(at + s * 1000) });
    return {
      id: 1000 + i,
      workflow: "CI",
      event: "push",
      branch: "main",
      sha: `sha${i}`.padEnd(40, "0"),
      attempt: 1,
      conclusion: "success",
      created: iso(at),
      jobs: [
        {
          name: "validate",
          conclusion: "success",
          started: iso(at),
          completed: iso(at + took * 1000),
          steps: [step("Run the contract suite", took - 40), step("Lint", 6)],
        },
      ],
    };
  });
}

test("ci:trend: a job that gives back a recent win reads slower, against its fastest stretch", () => {
  // 90 s, then 60 s for four days, then 82 s for the last three: what validate
  // did around #1203 and #1260. The plain 14-day median is 90 s, so only the
  // fastest stretch shows the regression.
  const runs = pushes((i) => (i < 18 ? 82 : i < 42 ? 60 : 90));
  const [found, ...rest] = regressions(runs, UNTIL);
  assert.deepEqual(rest, []);
  assert.equal(found.job, "validate");
  assert.equal(found.baselineS, 60);
  assert.equal(found.recentS, 82);
  assert.deepEqual(found.steps, [{ name: "Run the contract suite", deltaS: 22 }]);
  assert.equal(found.slowest.length, 3);
});

test("ci:trend: under 20% or under the seconds floor isn't a regression", () => {
  assert.deepEqual(
    regressions(
      pushes((i) => (i < 18 ? 71 : 60)),
      UNTIL,
    ),
    [],
    "18% slower",
  );
  assert.deepEqual(
    regressions(
      pushes((i) => (i < 18 ? 20 - 1 + FLOOR_S : 20)),
      UNTIL,
    ),
    [],
    "20% but 4 s",
  );
  assert.equal(
    regressions(
      pushes((i) => (i < 18 ? 75 : 60)),
      UNTIL,
    ).length,
    1,
    "25% and 15 s",
  );
});

test("ci:trend: a window with too few runs judges nothing", () => {
  // Keep MIN_RUNS - 1 of the recent 18, all of them slow.
  const runs = pushes((i) => (i < 18 ? 120 : 60)).filter((_, i) => i >= 18 || i < MIN_RUNS - 1);
  assert.deepEqual(regressions(runs, UNTIL), []);
  assert.equal(
    regressions(
      pushes((i) => (i < 18 ? 120 : 60)),
      UNTIL,
    ).length,
    1,
  );
});

const mainRun = (id: number, workflow: string, conclusion: string, hoursAgo: number): Run => ({
  id,
  workflow,
  event: "push",
  branch: "main",
  sha: `c${id}`.padEnd(40, "0"),
  attempt: 1,
  conclusion,
  created: iso(UNTIL - hoursAgo * HOUR),
});

test("ci:trend: two red main runs in a row name the first one and the last green", () => {
  const found = brokenMain([
    mainRun(1, "CI", "success", 5),
    mainRun(2, "CI", "failure", 4),
    mainRun(3, "CI", "cancelled", 3),
    mainRun(4, "CI", "failure", 2),
    mainRun(5, "Canary tripwire", "failure", 1),
    mainRun(6, "Canary tripwire", "success", 6),
  ]);
  assert.deepEqual(found, [
    {
      workflow: "CI",
      failing: [
        { id: 4, sha: "c4000000", created: iso(UNTIL - 2 * HOUR) },
        { id: 2, sha: "c2000000", created: iso(UNTIL - 4 * HOUR) },
      ],
      first: { id: 2, sha: "c2000000" },
      lastGreen: { id: 1, sha: "c1000000" },
    },
  ]);
  assert.deepEqual(brokenMain([mainRun(1, "CI", "failure", 2), mainRun(2, "CI", "success", 1), mainRun(3, "CI", "failure", 3)]), [], "green at the head");
});

const rerun = (id: number, conclusion: string, firstFailed: string[]): Run => ({
  ...mainRun(id, "CI", conclusion, 1),
  branch: `claude/b${id}`,
  attempt: 2,
  firstFailed,
});

test("ci:trend: a job that keeps passing only on a rerun is named, once it has done so three times", () => {
  const found = rerunFlakes([
    rerun(1, "success", ["CPU per route"]),
    rerun(2, "success", ["CPU per route", "validate"]),
    rerun(3, "success", ["CPU per route"]),
    rerun(4, "failure", ["validate"]),
    rerun(5, "success", ["validate"]),
  ]);
  assert.deepEqual(found, [
    {
      job: "CPU per route",
      runs: [
        { id: 1, sha: "c1000000", branch: "claude/b1" },
        { id: 2, sha: "c2000000", branch: "claude/b2" },
        { id: 3, sha: "c3000000", branch: "claude/b3" },
      ],
    },
  ]);
});
