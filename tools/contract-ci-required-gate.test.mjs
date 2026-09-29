import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ROOT, assert, test } from "./contract-shared.ts";

// Parse the real workflow with Bun's YAML parser under both test runners.
// CI is ONE job since 2026-09-28, so the join job and its failure predicate
// are gone: a single job named `validate` fails the required check by itself.
const workflow = JSON.parse(execFileSync("bun", [
  "-e", "console.log(JSON.stringify(Bun.YAML.parse(require('node:fs').readFileSync(process.argv[1], 'utf8'))))",
  fileURLToPath(new URL(".github/workflows/ci.yml", ROOT)),
], { encoding: "utf8" }));

test("CI is one required job named validate that cannot be skipped or softened", () => {
  assert.deepEqual(Object.keys(workflow.jobs), ["validate"]);
  const { validate } = workflow.jobs;
  // The `main` ruleset requires a check with exactly this name.
  assert.equal(validate.name, "validate");
  // A skipped required job reads as passing on GitHub, so nothing may skip it.
  assert.equal(validate.if, undefined);
  assert.equal(validate["continue-on-error"], undefined);
  for (const step of validate.steps) {
    assert.equal(step["continue-on-error"], undefined, `${step.name} must be able to fail the job`);
  }
});

test("validate still runs the checks that protect what ships", () => {
  const runs = workflow.jobs.validate.steps.map((step) => step.run ?? "").join("\n");
  for (const command of ["bun run lint", "bun run typecheck", "bun run perf-budget", "bun run derive:check",
    "bun run routes:check", "bun run test", "bun run --filter cal-aadhar-sh test"]) {
    assert.ok(runs.includes(command), `validate no longer runs ${command}`);
  }
});

test("manual CI keeps checkout and cache scope on the dispatched revision", () => {
  assert.ok(Object.hasOwn(workflow.on, "workflow_dispatch"));
  assert.equal(workflow.on.workflow_dispatch?.inputs, undefined);
  const checkouts = Object.values(workflow.jobs).flatMap((job) => job.steps)
    .filter((step) => step.uses?.startsWith("actions/checkout@"));
  assert.ok(checkouts.length > 0);
  for (const checkout of checkouts) {
    assert.equal(checkout.with?.ref, undefined, "checkout must use the event's revision and cache scope");
    assert.equal(checkout.with?.repository, undefined, "checkout must use the event's repository");
  }
});
