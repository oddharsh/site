// ── route-cpu can see a slow route ───────────────────────────────────────────
// tools/route-cpu.ts reports CPU per request on a cold isolate. A report that
// read every route as fast would look exactly like good news, so this feeds it
// a Worker with one route that spends 12 ms of CPU and one that spends none,
// and asks it to tell them apart: the slow one over the 8 ms line, measured
// with its full sample count, and the fast one under it.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assert,
  test,
} from "./contract-shared.ts";

const TOOL = new URL("route-cpu.ts", import.meta.url).pathname;

// Spins on CPU time, not wall time, so a busy machine can't shorten the work.
// /env answers 500 unless the run handed it the deployed bindings: --routes once
// skipped reading them, and every named route measured a crash.
const WORKER = `export default { async fetch(request, env) {
  const path = new URL(request.url).pathname;
  if (path === "/icu") { new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric" }).format(0); "b".localeCompare("a"); }
  if (path === "/env") return new Response(null, { status: env.BOOKINGS?.list && env.HOST_TIMEZONE ? 200 : 500 });
  if (path === "/spin") { const t0 = process.cpuUsage(); while (true) { const d = process.cpuUsage(t0); if (d.user + d.system >= 12000) break; } }
  return new Response("ok", { status: 200 });
} };`;

function run(routes, strict, extra = []) {
  const dir = mkdtempSync(join(tmpdir(), "route-cpu-"));
  try {
    writeFileSync(join(dir, "worker.mjs"), WORKER);
    const json = join(dir, "out.json");
    const args = [TOOL, "--worker", join(dir, "worker.mjs"), "--assets", dir, "--routes", routes, "--jobs", "2", "--json", json];
    if (strict) args.push("--strict");
    args.push(...extra);
    const p = spawnSync("node", args, { encoding: "utf8", timeout: 120_000 });
    const out = existsSync(json) ? JSON.parse(readFileSync(json, "utf8")) : null;
    return { status: p.status, stdout: p.stdout, stderr: p.stderr, out };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test("a route that spends 12 ms reads over the line, and a trivial one doesn't", { timeout: 180_000 }, () => {
  const { status, stdout, stderr, out } = run("/spin,/fast", true);
  assert.ok(out, `no report was written: ${stderr.slice(-400)}`);
  const spin = out.rows.find((r) => r.route === "/spin"), fast = out.rows.find((r) => r.route === "/fast");
  assert.ok(spin.cpu >= 12, `/spin measured ${spin.cpu} ms`);
  assert.equal(spin.samples, 9, "a route over the screening line gets the full sample count");
  assert.ok(fast.cpu < 2, `/fast measured ${fast.cpu} ms`);
  assert.equal(fast.samples, 1);
  assert.equal(status, 1, "--strict fails a run with a route over the line");
  assert.match(stdout, /\/spin {2}OVER/);
});

test("a run with nothing over the line passes --strict", { timeout: 180_000 }, () => {
  const { status, out } = run("/fast", true);
  assert.equal(out.rows[0].route, "/fast");
  assert.equal(status, 0);
});

test("a run that names its routes still gets the deployed env and bindings", { timeout: 180_000 }, () => {
  const { out, stderr } = run("/env", false);
  assert.ok(out, `no report was written: ${stderr.slice(-400)}`);
  assert.equal(out.rows[0].status, 200, "/env saw no BOOKINGS binding or HOST_TIMEZONE var");
});

// ICU keeps its data per process, and workerd's processes are shared, so each
// sample warms ICU in another isolate first. --cold-icu is the control: the
// same route must read heavy without the warm-up, or the instrument can't tell.
test("a route's first date format costs what a fresh isolate in a warm process pays", { timeout: 180_000 }, () => {
  const warm = run("/icu", false).out, cold = run("/icu", false, ["--cold-icu"]).out;
  assert.ok(warm.rows[0].cpu < 2, `warm process: /icu measured ${warm.rows[0].cpu} ms`);
  assert.ok(cold.rows[0].cpu > 5, `cold process: /icu measured ${cold.rows[0].cpu} ms, so the warm-up proves nothing`);
});
