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
const WORKER = `export default { async fetch(request) {
  const path = new URL(request.url).pathname;
  if (path === "/spin") { const t0 = process.cpuUsage(); while (true) { const d = process.cpuUsage(t0); if (d.user + d.system >= 12000) break; } }
  return new Response("ok", { status: 200 });
} };`;

function run(routes, strict) {
  const dir = mkdtempSync(join(tmpdir(), "route-cpu-"));
  try {
    writeFileSync(join(dir, "worker.mjs"), WORKER);
    const json = join(dir, "out.json");
    const args = [TOOL, "--worker", join(dir, "worker.mjs"), "--assets", dir, "--routes", routes, "--jobs", "2", "--json", json];
    if (strict) args.push("--strict");
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
