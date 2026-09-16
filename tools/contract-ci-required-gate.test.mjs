import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ROOT, assert, test } from "./contract-shared.ts";

// Parse the real workflow with Bun's YAML parser under both test runners, then
// execute its actual gate shell. Fixtures exercise job outcomes, not a second
// implementation of GitHub's success/failure predicate.
const workflow = JSON.parse(execFileSync("bun", [
  "-e", "console.log(JSON.stringify(Bun.YAML.parse(require('node:fs').readFileSync(process.argv[1], 'utf8'))))",
  fileURLToPath(new URL(".github/workflows/ci.yml", ROOT)),
], { encoding: "utf8" }));
const { validate, ...jobs } = workflow.jobs;
const gate = validate.steps.find((step) => step.env?.RESULTS);

test("manual CI keeps checkout and cache scope on the dispatched revision", () => {
  assert.ok(Object.hasOwn(workflow.on, "workflow_dispatch"));
  assert.equal(workflow.on.workflow_dispatch?.inputs, undefined);
  const checkouts = Object.values(jobs).flatMap((job) => job.steps)
    .filter((step) => step.uses?.startsWith("actions/checkout@"));
  assert.ok(checkouts.length > 0);
  for (const checkout of checkouts) {
    assert.equal(checkout.with?.ref, undefined, "checkout must use the event's revision and cache scope");
    assert.equal(checkout.with?.repository, undefined, "checkout must use the event's repository");
  }
});

test("the required validate job joins every validation job even after failure", () => {
  assert.equal(validate.name, "validate");
  assert.equal(validate.if, "${{ always() }}");
  assert.deepEqual([...validate.needs].sort(), Object.keys(jobs).sort());
  assert.equal(validate["continue-on-error"], undefined);
  assert.equal(gate.if, undefined);
  assert.equal(gate["continue-on-error"], undefined);
  assert.equal(gate.env.RESULTS, "${{ toJSON(needs) }}");
});

test("the real gate accepts success and rejects failed, cancelled or skipped dependencies", () => {
  const success = Object.fromEntries(validate.needs.map((job) => [job, { result: "success" }]));
  const run = (results) => spawnSync("bash", ["-e", "-o", "pipefail", "-c", gate.run], {
    env: { ...process.env, RESULTS: results }, encoding: "utf8", timeout: 5000,
  });
  assert.equal(run(JSON.stringify(success)).status, 0);
  for (const job of validate.needs) {
    for (const result of ["failure", "cancelled", "skipped", "pending", undefined]) {
      const out = run(JSON.stringify({ ...success, [job]: { result } }));
      assert.equal(out.status, 1, `${job}: ${result} must fail\n${out.stderr}`);
    }
  }
  for (const results of ["{}", "not JSON"]) {
    assert.notEqual(run(results).status, 0, "absent or unreadable results must fail");
  }
});
