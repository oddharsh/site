import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ROOT, assert, test } from "./contract-shared.ts";

const workflow = JSON.parse(execFileSync("bun", ["-e",
  "console.log(JSON.stringify(Bun.YAML.parse(require('node:fs').readFileSync(process.argv[1], 'utf8'))))",
  fileURLToPath(new URL(".github/workflows/perf-diff.yml", ROOT)),
], { encoding: "utf8" }));
const steps = workflow.jobs["wire-size"].steps;
const install = steps.find((step) => step.name === "Define the installer").run;
const record = steps.find((step) => step.name === "Record both revisions concurrently").run;

// Exercise the real workflow shell against a temporary git repository. Each
// fake measurement must see the other start before finishing: serial execution
// fails the barrier. Either measurement can then fail independently.
for (const failed of ["", "base", "head"]) {
  test(`parallel wire measurements wait for both and propagate ${failed || "no"} failure`, () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "perf parallel ")));
    try {
      const repo = join(root, "repo");
      const bin = join(root, "bin");
      const temp = join(root, "run");
      for (const dir of [repo, bin, temp]) mkdirSync(dir);
      const git = (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });
      git("init", "--quiet");
      writeFileSync(join(repo, "bun.lock"), "fixture\n");
      git("add", "bun.lock");
      git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "fixture");
      const sha = git("rev-parse", "HEAD").trim();
      mkdirSync(join(repo, ".perf-measure"));
      writeFileSync(join(repo, ".perf-measure", "marker"), "same measurement code\n");
      writeFileSync(join(bin, "bun"), `#!/bin/bash
set -eu
if [ "$PWD" = "$RUNNER_TEMP/perf-base" ]; then leg=base; other=head; else leg=head; other=base; fi
if [ "$1" = install ]; then
  echo "$PWD" > "$RUNNER_TEMP/base-install"
  exit 0
fi
test -f .perf-measure/marker
touch "$RUNNER_TEMP/$leg.started"
for unused in {1..100}; do
  if [ -f "$RUNNER_TEMP/$other.started" ]; then break; fi
  sleep 0.02
done
test -f "$RUNNER_TEMP/$other.started"
sleep 0.1
echo "$PWD" > "$3"
touch "$RUNNER_TEMP/$leg.finished"
if [ "$FAIL_LEG" = "$leg" ]; then exit 7; fi
`, { mode: 0o755 });
      const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, RUNNER_TEMP: temp, MERGE_BASE: sha, HEAD_SHA: sha, FAIL_LEG: failed };
      const setup = spawnSync("bash", ["-e", "-c", install], { cwd: repo, env, encoding: "utf8", timeout: 5000 });
      assert.equal(setup.status, 0, setup.stderr);
      const result = spawnSync("bash", ["-c", record], { cwd: repo, env, encoding: "utf8", timeout: 10000 });
      assert.equal(result.status, failed ? 1 : 0, result.stdout + result.stderr);
      for (const leg of ["base", "head"]) assert.ok(existsSync(join(temp, `${leg}.finished`)), `${leg} was not awaited`);
      assert.equal(readFileSync(join(temp, "base-install"), "utf8").trim(), join(temp, "perf-base"));
      assert.equal(readFileSync(join(temp, "base.json"), "utf8").trim(), join(temp, "perf-base"));
      assert.equal(readFileSync(join(temp, "head.json"), "utf8").trim(), repo);
      assert.equal(git("rev-parse", "HEAD").trim(), sha);
      assert.ok(!existsSync(join(temp, "perf-base")), "private worktree must be removed");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}
