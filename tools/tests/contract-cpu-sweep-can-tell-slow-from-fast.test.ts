// ── cpu-sweep can tell a slow route from a fast one ─────────────────────────
// tools/cpu-sweep.ts reports CPU per request on a cold isolate, route by route.
// A sweep that read every route as fast would report a clean site forever, so
// this runs it against a fixture Worker whose /spin burns 12 ms of CPU: report
// mode lists it as over 8 ms and still exits 0, --gate fails on it, and the
// allowlist and this CPU model's factor in the budget file each change that
// verdict. With no factor for the CPU model, --gate judges nothing, and on a
// runner whose control reads off its model it judges nothing either. A ceiling
// re-fitted from CI runs has to clear the highest of them (gotcha 81).
//
// Two live sweeps, and every verdict about a budget is a --replay of the first.
// Ten live sweeps took this file to 43 s of CI's 44 s contract suite
// (2026-10-19), because each spawns a node process per sample; the verdicts
// below need the readings, not fresh ones. The first test proves a replay
// reaches the verdict a live run does.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { cpus, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const ROOT = new URL("../../", import.meta.url);
// relative to the repo root, the sweep's cwd: a relative --bundle has to name a file
const BUNDLE = "tools/fixtures/cpu-sweep/worker.mjs";
// node, whatever runs this test: the sweep times V8, workerd's engine
const node = process.versions.bun ? "node" : process.execPath;
const MODEL = cpus()[0]?.model.trim() ?? "unknown";
const UNCALIBRATED = { machines: {}, routes: {} };
const atFactor = (factor, routes: Record<string, any> = {}) => ({ machines: { [MODEL]: { factor, runs: 1 } }, routes });

// A live sweep takes `routes`; a replay passes `{ replay: report }` and takes no samples.
function sweep(routes, budget, ...flags: any[]) {
  return sweepIn({}, routes, budget, ...flags);
}
function sweepIn(env, routes, budget, ...flags: any[]) {
  const dir = mkdtempSync(join(tmpdir(), "cpu-sweep-"));
  try {
    const out = join(dir, "sweep.json"),
      file = join(dir, "budget.json"),
      recorded = join(dir, "recorded.json");
    writeFileSync(file, JSON.stringify(budget));
    if (typeof routes !== "string") writeFileSync(recorded, JSON.stringify(routes.replay));
    const what = typeof routes === "string" ? ["--routes", routes] : ["--replay", recorded];
    const run = spawnSync(node, ["tools/cpu-sweep.ts", "--bundle", BUNDLE, ...what, "--budget", file, "--out", out, ...flags], {
      cwd: ROOT,
      encoding: "utf8",
      timeout: 60_000,
      env: { ...process.env, GITHUB_ACTIONS: "", GITHUB_STEP_SUMMARY: "", ...env },
    });
    return { code: run.status, stdout: run.stdout, stderr: run.stderr, report: run.status === 2 ? null : JSON.parse(readFileSync(out, "utf8")) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const row = (report, route) => report.rows.find((r) => r.route === route);

// The one live sweep the budget verdicts share, at this model's factor of 1 with
// no allowlist, so /spin is re-sampled and the rest are not.
let live;
const recording = () => (live ??= sweep("/spin,/still,/icu,/copy", atFactor(1)));
const replay = (budget, ...flags) => sweep({ replay: recording().report }, budget, ...flags);
const replayIn = (env, budget, ...flags) => sweepIn(env, { replay: recording().report }, budget, ...flags);

test("a 12 ms route reads over the gate, and report mode still passes", { timeout: 90_000 }, () => {
  const { code, report } = recording();
  assert.equal(code, 0, "without --gate nothing fails");
  const spin = row(report, "/spin"),
    still = row(report, "/still");
  assert.ok(spin.ms > report.gateMs, `/spin read ${spin.ms} ms`);
  assert.ok(spin.samples > 1, "a route near its ceiling is sampled again before it's judged");
  assert.equal(still.samples, 1, "a route far under its ceiling isn't");
  assert.ok(still.ms < 4, `/still read ${still.ms} ms`);
});

// A replay that judged its own readings differently from the live run, or took
// fewer re-samples than this budget asks for, would make every test after this
// one prove the replay rather than the gate.
test("a replay against the run's own budget reproduces its report, and refuses a budget that wants samples it never took", { timeout: 90_000 }, () => {
  const again = replay(atFactor(1));
  assert.equal(again.code, 0);
  assert.deepEqual(again.report, recording().report);
  const short = replay(atFactor(1, { "/still": { ceilingMs: 0.01, why: "a ceiling /still is near" } }));
  assert.equal(short.code, 2, "/still was screened once, and this ceiling would re-sample it");
  assert.match(short.stderr, /re-samples \/still, which .* took once/);
});

test("--gate fails on the slow route with an annotation, and passes once the allowlist gives it a ceiling", { timeout: 90_000 }, () => {
  const failed = replayIn({ GITHUB_ACTIONS: "true" }, atFactor(1), "--gate");
  assert.equal(failed.code, 1);
  assert.match(failed.stdout, /^::error title=CPU per route::\/spin read [\d.]+ ms, over the 8 ms gate$/m, "on CI the failure is an annotation");
  const allowed = replay(atFactor(1, { "/spin": { ceilingMs: 1000, why: "the fixture's spin" } }), "--gate");
  assert.equal(allowed.code, 0);
  assert.equal(row(allowed.report, "/spin").ceilingMs, 1000);
});

test("this CPU model's factor scales every reading, and an unknown allowlist entry still fails", { timeout: 90_000 }, () => {
  // A factor of a hundredth: a model 100x faster, so /spin's 12 ms here is about
  // 0.12 reference ms, and only the stray entry fails.
  const { code, report } = replay(atFactor(0.01, { "/nope": { ceilingMs: 20, why: "a route that doesn't exist" } }), "--gate");
  assert.equal(report.calibration.calibrated, true);
  const spin = row(report, "/spin");
  assert.ok(Math.abs(spin.ms - spin.rawMs * 0.01) < 1e-9, "the reported reading is the raw one, scaled");
  assert.ok(spin.ms < report.gateMs, `/spin read ${spin.ms} reference ms`);
  assert.deepEqual(report.unknown, ["/nope"]);
  assert.equal(code, 1, "an entry for a route the sweep doesn't know fails the gate");
});

test("--gate judges nothing on a CPU model with no factor, and says so", { timeout: 90_000 }, () => {
  const { code, stdout, report } = replayIn({ GITHUB_ACTIONS: "true" }, UNCALIBRATED, "--gate");
  assert.equal(report.calibration.calibrated, false);
  assert.ok(row(report, "/spin").ms > report.gateMs, "the raw reading is still over 8 ms");
  assert.equal(code, 0, "a reading in an unknown model's milliseconds can't fail the gate");
  assert.match(stdout, /^::warning title=CPU per route::--gate judged nothing: config\/cpu-budget\.json has no factor for /m);
});

// A factor fits a model's usual runner. One runner, slow all over, read 33% high
// on its control and failed six routes on a PR that changed no Worker byte
// (#1273, gotcha 57). A control reference of 0.01 ms makes this machine that
// runner. A band too wide to cross is the control: the same run is judged again.
test("--gate judges nothing on a runner whose control reads off its model, and judges once the band allows it", { timeout: 90_000 }, () => {
  const off = replayIn({ GITHUB_ACTIONS: "true" }, { ...atFactor(1), control: { ms: 0.01, drift: 0.2 } }, "--gate");
  assert.ok(off.report.control.drift > 0.2, `drift read ${off.report.control.drift}`);
  assert.equal(off.report.inconclusive, true);
  assert.ok(row(off.report, "/spin").ms > off.report.gateMs, "the reading is still over 8 ms");
  assert.equal(off.code, 0, "a runner off its model can't fail the gate");
  assert.match(
    off.stdout,
    /^::warning title=CPU per route::--gate judged nothing, because the run was inconclusive: the control read [\d.]+ ms, \+\d+% off the 0\.01 ms this model's factor expects/m,
  );
  const within = replay({ ...atFactor(1), control: { ms: 0.01, drift: 1e9 } }, "--gate");
  assert.equal(within.report.inconclusive, false);
  assert.equal(within.code, 1, "inside the band, the slow route fails");
});

test("the committed budget names a control reference, so the drift check can't go missing", () => {
  const { control } = JSON.parse(readFileSync(new URL("config/cpu-budget.json", ROOT), "utf8"));
  assert.ok(control?.ms > 0, "config/cpu-budget.json needs control.ms");
  assert.ok(control.drift > 0 && control.drift < 1, `control.drift is ${control?.drift}`);
});

// A ceiling inside its route's own spread fails PRs that changed no Worker
// byte: after #1386 the 404 read up to 11.30 ms against a ceiling of 10, and 16
// of 54 runs failed (gotcha 81). A row re-fit from CI runs records them in
// `measured`, and its ceiling stays 20% over the highest, rounded up to the
// half millisecond, which is the rule every other ceiling was set by.
test("a re-fitted ceiling stays 20% over the highest CI run it was fit on", () => {
  const { routes } = JSON.parse(readFileSync(new URL("config/cpu-budget.json", ROOT), "utf8"));
  assert.ok(routes["/this-page-does-not-exist"]?.measured, "the 404's row lost the runs its ceiling was fit on");
  for (const [route, { ceilingMs, measured }] of Object.entries<any>(routes)) {
    if (!measured) continue;
    assert.match(measured.on, /^\d{4}-\d{2}-\d{2}$/, `${route}: measured.on`);
    assert.ok(measured.runs >= 30, `${route}: fit on ${measured.runs} runs, and a route spreads about 11% between runs`);
    assert.ok(measured.p50Ms <= measured.p99Ms && measured.p99Ms <= measured.highestMs, `${route}: measured is ${JSON.stringify(measured)}`);
    const needs = Math.ceil(measured.highestMs * 1.2 * 2) / 2;
    assert.ok(ceilingMs >= needs, `${route}: a ${ceilingMs} ms ceiling is inside 20% of its highest run, ${measured.highestMs} ms; it needs ${needs}`);
  }
});

// The warm-up has to be what makes /icu cheap, so --cold-icu, which skips it,
// must read it heavy again. Raw milliseconds: this model's factor is 1.
test("a route's first date format is cheap in a warm process, and --cold-icu shows the cold one", { timeout: 90_000 }, () => {
  const warm = row(recording().report, "/icu"),
    cold = row(sweep("/icu", UNCALIBRATED, "--cold-icu").report, "/icu");
  assert.ok(warm.ms < 2, `warm process: /icu read ${warm.ms} ms`);
  assert.ok(cold.ms > 5, `cold process: /icu read ${cold.ms} ms, so the warm-up proves nothing`);
});

// A route measured without its bindings measures a crash: cal copies env, and a
// binding that lived only behind the env proxy was gone from the copy, so
// /coffee/slots.html threw on BOOKINGS. Every declared binding is an own property.
test("a declared binding survives a copy of env", { timeout: 90_000 }, () => {
  assert.equal(row(recording().report, "/copy").status, 200, "/copy lost BOOKINGS or HOST_TIMEZONE");
});
