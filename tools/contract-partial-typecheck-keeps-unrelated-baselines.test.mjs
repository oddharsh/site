import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const root = new URL("../", import.meta.url);

test("a partial program with unrestricted ownership leaves unrelated baseline debt alone", () => {
  const baseline = new URL("config/ts-baseline.json", root);
  const before = readFileSync(baseline, "utf8");
  const run = spawnSync("node", ["tools/typecheck.ts", "config/tsconfig.sw.json"], {
    cwd: root,
    encoding: "utf8",
    timeout: 15000,
  });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.match(run.stdout, /typecheck: 1 program\(s\)/);
  assert.equal(readFileSync(baseline, "utf8"), before, "checking must preserve the diagnostic baseline");
});
