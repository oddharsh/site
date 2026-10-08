// ── cpu-sweep can tell a slow route from a fast one ─────────────────────────
// tools/cpu-sweep.ts reports CPU per request on a cold isolate, route by route.
// A sweep that read every route as fast would report a clean site forever, so
// this runs it against a fixture Worker whose /spin burns 12 ms of CPU: report
// mode lists it as over 8 ms and still exits 0, and --gate fails on it and
// passes on a route that does nothing.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const ROOT = new URL("../", import.meta.url);
const BUNDLE = new URL("fixtures/cpu-sweep/worker.mjs", import.meta.url).pathname;
// node, whatever runs this test: the sweep times V8, workerd's engine
const node = process.versions.bun ? "node" : process.execPath;

function sweep(routes, ...flags) {
  const dir = mkdtempSync(join(tmpdir(), "cpu-sweep-"));
  try {
    const out = join(dir, "sweep.json");
    const run = spawnSync(node, ["tools/cpu-sweep.ts", "--bundle", BUNDLE, "--routes", routes, "--out", out, ...flags], { cwd: ROOT, encoding: "utf8", timeout: 60_000 });
    return { code: run.status, stdout: run.stdout, report: run.status === 2 ? null : JSON.parse(readFileSync(out, "utf8")) };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test("a 12 ms route reads over the gate, and report mode still passes", { timeout: 90_000 }, () => {
  const { code, report } = sweep("/spin,/still");
  assert.equal(code, 0, "report-only never fails the build");
  const spin = report.rows.find((r) => r.route === "/spin"), still = report.rows.find((r) => r.route === "/still");
  assert.ok(spin.ms > report.gateMs, `/spin read ${spin.ms} ms`);
  assert.ok(spin.samples > 1, "a heavy route is sampled again before it's judged");
  assert.ok(still.ms < 4, `/still read ${still.ms} ms`);
});

test("--gate fails on the slow route and passes without it", { timeout: 90_000 }, () => {
  assert.equal(sweep("/spin,/still", "--gate").code, 1);
  assert.equal(sweep("/still", "--gate").code, 0);
});
