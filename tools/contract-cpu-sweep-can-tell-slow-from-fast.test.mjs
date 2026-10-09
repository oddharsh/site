// ── cpu-sweep can tell a slow route from a fast one ─────────────────────────
// tools/cpu-sweep.ts reports CPU per request on a cold isolate, route by route.
// A sweep that read every route as fast would report a clean site forever, so
// this runs it against a fixture Worker whose /spin burns 12 ms of CPU: report
// mode lists it as over 8 ms and still exits 0, --gate fails on it, and the
// allowlist and the calibration in its budget file each change that verdict.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const ROOT = new URL("../", import.meta.url);
const BUNDLE = new URL("fixtures/cpu-sweep/worker.mjs", import.meta.url).pathname;
// node, whatever runs this test: the sweep times V8, workerd's engine
const node = process.versions.bun ? "node" : process.execPath;
const UNCALIBRATED = { calibration: null, routes: {} };

function sweep(routes, budget, ...flags) {
  const dir = mkdtempSync(join(tmpdir(), "cpu-sweep-"));
  try {
    const out = join(dir, "sweep.json"), file = join(dir, "budget.json");
    writeFileSync(file, JSON.stringify(budget));
    const run = spawnSync(node, ["tools/cpu-sweep.ts", "--bundle", BUNDLE, "--routes", routes, "--budget", file, "--out", out, ...flags], { cwd: ROOT, encoding: "utf8", timeout: 60_000 });
    return { code: run.status, stderr: run.stderr, report: run.status === 2 ? null : JSON.parse(readFileSync(out, "utf8")) };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
const row = (report, route) => report.rows.find((r) => r.route === route);

// The first sweep's calibration reading and digest, which the calibrated case reuses.
let first;

test("a 12 ms route reads over the gate, and report mode still passes", { timeout: 90_000 }, () => {
  const { code, report } = sweep("/spin,/still", UNCALIBRATED);
  assert.equal(code, 0, "report-only never fails the build");
  const spin = row(report, "/spin"), still = row(report, "/still");
  assert.ok(spin.ms > report.gateMs, `/spin read ${spin.ms} ms`);
  assert.ok(spin.samples > 1, "a route near its ceiling is sampled again before it's judged");
  assert.equal(still.samples, 1, "a route far under its ceiling isn't");
  assert.ok(still.ms < 4, `/still read ${still.ms} ms`);
  assert.equal(report.calibration.calibrated, false);
  assert.ok(report.calibration.ms > 0, "the calibration workload ran");
  first = report.calibration;
});

test("--gate fails on the slow route, and passes once the allowlist gives it a ceiling", { timeout: 90_000 }, () => {
  assert.equal(sweep("/spin,/still", UNCALIBRATED, "--gate").code, 1);
  const allowed = sweep("/spin,/still", { calibration: null, routes: { "/spin": { ceilingMs: 1000, why: "the fixture's spin" } } }, "--gate");
  assert.equal(allowed.code, 0);
  assert.equal(row(allowed.report, "/spin").ceilingMs, 1000);
});

test("the calibration scales every reading, and an unknown allowlist entry still fails", { timeout: 90_000 }, () => {
  assert.ok(first, "runs after the first case, which reads the calibration");
  // A reference a hundredth of this machine's reading: a runner 100x faster, so
  // /spin's 12 ms here is about 0.12 reference ms, and only the stray entry fails.
  const budget = { calibration: { referenceMs: first.ms / 100, digest: first.digest, machine: "test" }, routes: { "/nope": { ceilingMs: 20, why: "a route that doesn't exist" } } };
  const { code, report } = sweep("/spin,/still", budget, "--gate");
  assert.equal(report.calibration.calibrated, true);
  const spin = row(report, "/spin");
  assert.ok(Math.abs(spin.ms - spin.rawMs * report.calibration.scale) < 1e-9, "the reported reading is the raw one, scaled");
  assert.ok(spin.ms < report.gateMs, `/spin read ${spin.ms} reference ms`);
  assert.deepEqual(report.unknown, ["/nope"]);
  assert.equal(code, 1, "an entry for a route the sweep doesn't know fails the gate");
});

test("--gate refuses a reference taken on a different calibration workload, before sampling", { timeout: 30_000 }, () => {
  const { code, stderr } = sweep("/spin", { calibration: { referenceMs: 5, digest: "0000000000000000", machine: "test" }, routes: {} }, "--gate");
  assert.equal(code, 2);
  assert.match(stderr, /Measure referenceMs again/);
});

// The warm-up has to be what makes /icu cheap, so --cold-icu, which skips it,
// must read it heavy again. Raw milliseconds, uncalibrated.
test("a route's first date format is cheap in a warm process, and --cold-icu shows the cold one", { timeout: 90_000 }, () => {
  const warm = row(sweep("/icu", UNCALIBRATED).report, "/icu"), cold = row(sweep("/icu", UNCALIBRATED, "--cold-icu").report, "/icu");
  assert.ok(warm.ms < 2, `warm process: /icu read ${warm.ms} ms`);
  assert.ok(cold.ms > 5, `cold process: /icu read ${cold.ms} ms, so the warm-up proves nothing`);
});
