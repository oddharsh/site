// ── cpu-sweep can tell a slow route from a fast one ─────────────────────────
// tools/cpu-sweep.ts reports CPU per request on a cold isolate, route by route.
// A sweep that read every route as fast would report a clean site forever, so
// this runs it against a fixture Worker whose /spin burns 12 ms of CPU: report
// mode lists it as over 8 ms and still exits 0, --gate fails on it, and the
// allowlist and this CPU model's factor in the budget file each change that
// verdict. With no factor for the CPU model, --gate judges nothing.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { cpus, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const ROOT = new URL("../", import.meta.url);
// relative to the repo root, the sweep's cwd: a relative --bundle has to name a file
const BUNDLE = "tools/fixtures/cpu-sweep/worker.mjs";
// node, whatever runs this test: the sweep times V8, workerd's engine
const node = process.versions.bun ? "node" : process.execPath;
const MODEL = cpus()[0]?.model.trim() ?? "unknown";
const UNCALIBRATED = { machines: {}, routes: {} };
const atFactor = (factor, routes = {}) => ({ machines: { [MODEL]: { factor, runs: 1 } }, routes });

function sweep(routes, budget, ...flags) { return sweepIn({}, routes, budget, ...flags); }
function sweepIn(env, routes, budget, ...flags) {
  const dir = mkdtempSync(join(tmpdir(), "cpu-sweep-"));
  try {
    const out = join(dir, "sweep.json"), file = join(dir, "budget.json");
    writeFileSync(file, JSON.stringify(budget));
    const run = spawnSync(node, ["tools/cpu-sweep.ts", "--bundle", BUNDLE, "--routes", routes, "--budget", file, "--out", out, ...flags], { cwd: ROOT, encoding: "utf8", timeout: 60_000, env: { ...process.env, GITHUB_ACTIONS: "", GITHUB_STEP_SUMMARY: "", ...env } });
    return { code: run.status, stdout: run.stdout, stderr: run.stderr, report: run.status === 2 ? null : JSON.parse(readFileSync(out, "utf8")) };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
const row = (report, route) => report.rows.find((r) => r.route === route);

test("a 12 ms route reads over the gate, and report mode still passes", { timeout: 90_000 }, () => {
  const { code, report } = sweep("/spin,/still", atFactor(1));
  assert.equal(code, 0, "without --gate nothing fails");
  const spin = row(report, "/spin"), still = row(report, "/still");
  assert.ok(spin.ms > report.gateMs, `/spin read ${spin.ms} ms`);
  assert.ok(spin.samples > 1, "a route near its ceiling is sampled again before it's judged");
  assert.equal(still.samples, 1, "a route far under its ceiling isn't");
  assert.ok(still.ms < 4, `/still read ${still.ms} ms`);
});

test("--gate fails on the slow route with an annotation, and passes once the allowlist gives it a ceiling", { timeout: 90_000 }, () => {
  const failed = sweepIn({ GITHUB_ACTIONS: "true" }, "/spin,/still", atFactor(1), "--gate");
  assert.equal(failed.code, 1);
  assert.match(failed.stdout, /^::error title=CPU per route::\/spin read [\d.]+ ms, over the 8 ms gate$/m, "on CI the failure is an annotation");
  const allowed = sweep("/spin,/still", atFactor(1, { "/spin": { ceilingMs: 1000, why: "the fixture's spin" } }), "--gate");
  assert.equal(allowed.code, 0);
  assert.equal(row(allowed.report, "/spin").ceilingMs, 1000);
});

test("this CPU model's factor scales every reading, and an unknown allowlist entry still fails", { timeout: 90_000 }, () => {
  // A factor of a hundredth: a model 100x faster, so /spin's 12 ms here is about
  // 0.12 reference ms, and only the stray entry fails.
  const { code, report } = sweep("/spin,/still", atFactor(0.01, { "/nope": { ceilingMs: 20, why: "a route that doesn't exist" } }), "--gate");
  assert.equal(report.calibration.calibrated, true);
  const spin = row(report, "/spin");
  assert.ok(Math.abs(spin.ms - spin.rawMs * 0.01) < 1e-9, "the reported reading is the raw one, scaled");
  assert.ok(spin.ms < report.gateMs, `/spin read ${spin.ms} reference ms`);
  assert.deepEqual(report.unknown, ["/nope"]);
  assert.equal(code, 1, "an entry for a route the sweep doesn't know fails the gate");
});

test("--gate judges nothing on a CPU model with no factor, and says so", { timeout: 90_000 }, () => {
  const { code, stdout, report } = sweepIn({ GITHUB_ACTIONS: "true" }, "/spin", UNCALIBRATED, "--gate");
  assert.equal(report.calibration.calibrated, false);
  assert.ok(row(report, "/spin").ms > report.gateMs, "the raw reading is still over 8 ms");
  assert.equal(code, 0, "a reading in an unknown model's milliseconds can't fail the gate");
  assert.match(stdout, /^::warning title=CPU per route::--gate judged nothing: config\/cpu-budget\.json has no factor for /m);
});

// The warm-up has to be what makes /icu cheap, so --cold-icu, which skips it,
// must read it heavy again. Raw milliseconds, uncalibrated.
test("a route's first date format is cheap in a warm process, and --cold-icu shows the cold one", { timeout: 90_000 }, () => {
  const warm = row(sweep("/icu", UNCALIBRATED).report, "/icu"), cold = row(sweep("/icu", UNCALIBRATED, "--cold-icu").report, "/icu");
  assert.ok(warm.ms < 2, `warm process: /icu read ${warm.ms} ms`);
  assert.ok(cold.ms > 5, `cold process: /icu read ${cold.ms} ms, so the warm-up proves nothing`);
});

// A route measured without its bindings measures a crash: cal copies env, and a
// binding that lived only behind the env proxy was gone from the copy, so
// /coffee/slots.html threw on BOOKINGS. Every declared binding is an own property.
test("a declared binding survives a copy of env", { timeout: 60_000 }, () => {
  assert.equal(row(sweep("/copy", UNCALIBRATED).report, "/copy").status, 200, "/copy lost BOOKINGS or HOST_TIMEZONE");
});
