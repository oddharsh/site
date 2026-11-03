// What CI is doing over time: jobs on main that got slower, workflows that
// keep failing on main, and jobs that failed and then passed on a rerun of the
// same commit.
//
// ci:census (failures by test) reads why runs fail. This reads how long the
// green ones take, because the slow drift is the failure nobody trips over:
// validate went from a 50 s median on 2026-10-06 (background steps, #1203) to
// 76 s by 2026-10-31, and nothing said so. `--until` replays an earlier date,
// which is how the thresholds below were checked against that history.
//
//   bun run ci:trend                     as of now
//   bun run ci:trend --until 2026-10-12  as it would have read that day
//   bun run ci:trend --json              the signals, for an agent to act on
//   bun run ci:trend --gate              exit 1 when there is any signal

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
const gh = async (args: string[]) => (await run("gh", args, { maxBuffer: 64 << 20 })).stdout;

export type Step = { name: string; started: string; completed: string };
export type Job = { name: string; conclusion: string; started: string; completed: string; steps: Step[] };
export type Run = {
  id: number;
  workflow: string;
  event: string;
  branch: string;
  sha: string;
  attempt: number;
  conclusion: string | null;
  created: string;
  jobs?: Job[];
  /** Jobs that failed on attempt 1, read only for a run that has a later attempt. */
  firstFailed?: string[];
};

const DAY = 86400_000;
// A job's last 3 days of main pushes against its FASTEST 3-day stretch of the
// 14 before. A plain baseline median can't see a regression that gives back a
// recent win: validate went 93 s to 63 s (#1203, 2026-10-06), then back to
// 86 s (#1260, 2026-10-09), and 7-vs-21-day or 3-vs-14-day medians never fired
// in October, because their baselines still held the slow week before #1203.
// This rule fired 2026-10-11 to 10-20 and went quiet after #1421.
// A stretch needs 15 runs: at 5 or 10, CPU per route's lucky 3 days (median
// 43 s) made 2026-10-30's ordinary 53 s a regression; that job spreads 32 to
// 60 s within a day, by runner. Tuned on one month with one real regression.
export const WINDOW_DAYS = 3;
export const LOOKBACK_DAYS = 14;
export const MIN_RUNS = 15;
export const SLOWER = 1.2;
export const FLOOR_S = 5;
// Replayed over October, some job reran green once or twice in nearly every
// 7-day window; at 3, only CPU per route's week to 2026-10-19 (5 reruns) is
// named. One-offs are ci:census's to group by the test that failed.
export const FLAKE_DAYS = 7;
export const FLAKE_RERUNS = 3;
// One red main run is usually the next PR's job. Two in a row is nobody's.
export const STREAK = 2;

const seconds = (from: string, to: string) => (Date.parse(to) - Date.parse(from)) / 1000;
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

export type Regression = {
  job: string;
  baselineS: number;
  recentS: number;
  /** The fastest stretch, as the day it ended. */
  baselineTo: string;
  runs: { recent: number; baseline: number };
  slowest: { id: number; sha: string; s: number }[];
  steps: { name: string; deltaS: number }[];
};

type Sample = { at: number; run: Run; job: Job };
const took = ({ job }: Sample) => seconds(job.started, job.completed);

/** Jobs of successful main pushes whose last WINDOW_DAYS ran SLOWER and FLOOR_S over their fastest stretch. */
export function regressions(runs: Run[], until: number): Regression[] {
  const samples = new Map<string, Sample[]>();
  for (const r of runs) {
    const at = Date.parse(r.created);
    if (r.conclusion !== "success" || at > until) continue;
    for (const job of r.jobs ?? []) if (job.conclusion === "success") samples.set(job.name, [...(samples.get(job.name) ?? []), { at, run: r, job }]);
  }
  const stretch = (of: Sample[], end: number) => of.filter((s) => s.at > end - WINDOW_DAYS * DAY && s.at <= end);
  const found: Regression[] = [];
  for (const [name, all] of samples) {
    const recent = stretch(all, until);
    if (recent.length < MIN_RUNS) continue;
    let baseline: Sample[] = [],
      baselineTo = 0;
    for (let end = until - WINDOW_DAYS * DAY; end >= until - (WINDOW_DAYS + LOOKBACK_DAYS) * DAY; end -= DAY) {
      const s = stretch(all, end);
      if (s.length >= MIN_RUNS && (!baseline.length || median(s.map(took)) < median(baseline.map(took)))) [baseline, baselineTo] = [s, end];
    }
    if (!baseline.length) continue;
    const recentS = median(recent.map(took)),
      baselineS = median(baseline.map(took));
    if (recentS < baselineS * SLOWER || recentS - baselineS < FLOOR_S) continue;
    const stepMedian = (of: typeof recent, step: string) =>
      median(of.flatMap(({ job }) => job.steps.filter((s) => s.name === step && s.started && s.completed).map((s) => seconds(s.started, s.completed))));
    const names = new Set(recent.flatMap(({ job }) => job.steps.map((s) => s.name)));
    found.push({
      job: name,
      baselineS,
      recentS,
      baselineTo: new Date(baselineTo).toISOString().slice(0, 10),
      runs: { recent: recent.length, baseline: baseline.length },
      slowest: recent
        .map((x) => ({ id: x.run.id, sha: x.run.sha.slice(0, 8), s: took(x) }))
        .sort((a, b) => b.s - a.s)
        .slice(0, 3),
      steps: [...names]
        .map((step) => ({ name: step, deltaS: stepMedian(recent, step) - stepMedian(baseline, step) }))
        .filter((s) => s.deltaS >= 1)
        .sort((a, b) => b.deltaS - a.deltaS)
        .slice(0, 3),
    });
  }
  return found.sort((a, b) => b.recentS - b.baselineS - (a.recentS - a.baselineS));
}

type At = { id: number; sha: string };
export type Broken = { workflow: string; failing: (At & { created: string })[]; first: At; lastGreen: At | null };

/** Workflows whose newest STREAK or more finished runs on main all failed. Cancelled and skipped runs say nothing. */
export function brokenMain(runs: Run[]): Broken[] {
  const by = new Map<string, Run[]>();
  for (const r of runs) {
    if (r.branch !== "main" || (r.conclusion !== "success" && r.conclusion !== "failure")) continue;
    by.set(r.workflow, [...(by.get(r.workflow) ?? []), r]);
  }
  const found: Broken[] = [];
  for (const [workflow, rs] of by) {
    rs.sort((a, b) => Date.parse(b.created) - Date.parse(a.created));
    const green = rs.findIndex((r) => r.conclusion === "success");
    const failing = green === -1 ? rs : rs.slice(0, green);
    const first = failing.at(-1);
    if (failing.length < STREAK || !first) continue;
    found.push({
      workflow,
      failing: failing.map((r) => ({ id: r.id, sha: r.sha.slice(0, 8), created: r.created })),
      first: { id: first.id, sha: first.sha.slice(0, 8) },
      lastGreen: green === -1 ? null : { id: rs[green].id, sha: rs[green].sha.slice(0, 8) },
    });
  }
  return found;
}

export type Flake = { job: string; runs: { id: number; sha: string; branch: string }[] };

/** Jobs that failed on attempt 1 and passed on a later attempt of the same commit, FLAKE_RERUNS or more times. */
export function rerunFlakes(runs: Run[]): Flake[] {
  const by = new Map<string, Flake["runs"]>();
  for (const r of runs) {
    if (r.attempt < 2 || r.conclusion !== "success") continue;
    for (const job of r.firstFailed ?? []) by.set(job, [...(by.get(job) ?? []), { id: r.id, sha: r.sha.slice(0, 8), branch: r.branch }]);
  }
  return [...by]
    .filter(([, rs]) => rs.length >= FLAKE_RERUNS)
    .map(([job, rs]) => ({ job, runs: rs }))
    .sort((a, b) => b.runs.length - a.runs.length);
}

async function pool<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  let i = 0;
  await Promise.all(
    Array.from({ length: n }, async () => {
      while (i < items.length) {
        const k = i++;
        out[k] = await fn(items[k]);
      }
    }),
  );
  return out;
}

const RUN_FIELDS = "{id, workflow: .name, event, branch: .head_branch, sha: .head_sha, attempt: .run_attempt, conclusion, created: .created_at}";
async function listRuns(query: string, select = ""): Promise<Run[]> {
  const out = await gh(["api", "--paginate", `repos/{owner}/{repo}/actions/runs?per_page=100&${query}`, "--jq", `.workflow_runs[] ${select}| ${RUN_FIELDS}`]);
  return out
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}
const JOB_FIELDS =
  ".jobs[] | {name, conclusion, started: .started_at, completed: .completed_at, steps: [.steps[] | {name, started: .started_at, completed: .completed_at}]}";
async function jobs(id: number, attempt: number): Promise<Job[]> {
  const out = await gh(["api", `repos/{owner}/{repo}/actions/runs/${id}/attempts/${attempt}/jobs?per_page=100`, "--jq", JOB_FIELDS]);
  return out
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

if (import.meta.main) {
  const arg = (flag: string) => (process.argv.includes(flag) ? process.argv[process.argv.indexOf(flag) + 1] : undefined);
  const untilArg = arg("--until");
  const until = untilArg ? Date.parse(`${untilArg}T23:59:59Z`) : Date.now();
  if (Number.isNaN(until)) throw new Error(`--until wants YYYY-MM-DD, got ${untilArg}`);
  const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  const flakeFrom = until - FLAKE_DAYS * DAY;
  const window = (from: number) => `created=${day(from)}..${day(until)}`;

  // Durations come from main pushes only: the same workflow on merged code,
  // about eight a day, so the jobs reads stay near 150 per run of this tool.
  const [main, reruns] = await Promise.all([
    listRuns(`branch=main&${window(until - (WINDOW_DAYS + LOOKBACK_DAYS) * DAY)}`),
    listRuns(window(flakeFrom), "| select(.run_attempt > 1) "),
  ]);
  const pushes = main.filter((r) => r.workflow === "CI" && r.event === "push" && r.conclusion === "success");
  await pool(pushes, 8, async (r) => (r.jobs = await jobs(r.id, r.attempt)));
  await pool(reruns, 8, async (r) => (r.firstFailed = (await jobs(r.id, 1)).filter((j) => j.conclusion === "failure").map((j) => j.name)));

  const signals = {
    until: day(until),
    regressions: regressions(pushes, until),
    broken: brokenMain(main.filter((r) => Date.parse(r.created) <= until)),
    flakes: rerunFlakes(reruns.filter((r) => Date.parse(r.created) > flakeFrom && Date.parse(r.created) <= until)),
  };
  const count = signals.regressions.length + signals.broken.length + signals.flakes.length;

  if (process.argv.includes("--json")) console.log(JSON.stringify(signals, null, 2));
  else {
    const s = (n: number) => `${Math.round(n)} s`;
    console.log(`## CI trend, as of ${day(until)}\n`);
    console.log(
      `Slower on main (median of the last ${WINDOW_DAYS} days against the fastest ${WINDOW_DAYS}-day stretch of the ${LOOKBACK_DAYS} before, ${MIN_RUNS}+ runs each):`,
    );
    for (const r of signals.regressions) {
      console.log(
        `- ${r.job}: ${s(r.baselineS)} to ${s(r.recentS)} (+${Math.round((r.recentS / r.baselineS - 1) * 100)}%, ${r.runs.recent} runs against ${r.runs.baseline} ending ${r.baselineTo})`,
      );
      console.log(`  - moved most: ${r.steps.map((x) => `${x.name} +${s(x.deltaS)}`).join(", ") || "no single step"}`);
      console.log(`  - slowest: ${r.slowest.map((x) => `run ${x.id} (${x.sha}) ${s(x.s)}`).join(", ")}`);
    }
    if (!signals.regressions.length) console.log("- none");
    console.log(`\nBroken on main (the newest ${STREAK} or more finished runs failed):`);
    for (const b of signals.broken)
      console.log(
        `- ${b.workflow}: ${b.failing.length} failed in a row, from run ${b.first.id} (${b.first.sha}); last green ${b.lastGreen ? `run ${b.lastGreen.id} (${b.lastGreen.sha})` : "not in the window"}`,
      );
    if (!signals.broken.length) console.log("- none");
    console.log(`\nFailed, then passed on a rerun of the same commit, ${FLAKE_RERUNS}+ times in the last ${FLAKE_DAYS} days:`);
    for (const f of signals.flakes) console.log(`- ${f.job}: ${f.runs.map((r) => `run ${r.id} (${r.branch})`).join(", ")}`);
    if (!signals.flakes.length) console.log("- none");
  }
  if (process.argv.includes("--gate") && count) {
    if (process.env.GITHUB_ACTIONS === "true") console.log(`::error title=CI trend::${count} signal(s); the step log names each with its runs`);
    process.exitCode = 1;
  }
}
