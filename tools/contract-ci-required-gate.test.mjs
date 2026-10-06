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
  // `attest` (2026-10-01) signs the served manifest on a push to main. It is
  // not a check anybody requires, it needs validate, and it cannot fail the run;
  // contract-production-serves-what-ci-built holds its shape.
  assert.deepEqual(Object.keys(workflow.jobs), ["validate", "attest"]);
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
  for (const command of ["bun run check-wrangler", "bun run lint", "bun run typecheck", "bun run perf-budget", "bun run derive:check",
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

// Steps run in the background since 2026-10-06 (gotcha 54). Concurrency is
// only safe along three edges, and breaking any of them weakens the gate
// without turning it red, so each is asserted here instead of trusted.
test("background steps keep the three ordering edges and all join before the job ends", () => {
  const { steps } = workflow.jobs.validate;
  const at = (run) => {
    const i = steps.findIndex((step) => step.run === run);
    assert.ok(i >= 0, `validate no longer runs \`${run}\` as its own step`);
    return i;
  };
  const waited = (id, before) => steps.slice(0, before).some((step) =>
    step.wait === id || (Array.isArray(step.wait) && step.wait.includes(id)));

  // A background step needs an id for anything to wait on or cancel it.
  for (const step of steps.filter((s) => s.background)) assert.ok(step.id, `${step.name} runs in the background without an id`);

  // The suite reads .build/, and two of its tests skip without one. The build
  // stays in the foreground so everything after it sees a finished tree.
  const build = at("bun run perf-budget");
  assert.notEqual(steps[build].background, true, "the build must finish before the manifest cut and the suite read .build/");
  assert.ok(at("bun run test") > build, "the suite must start after the build it reads");
  assert.ok(at("bun run routes:check --prebuilt .build/.perfbudget") > build, "the route oracle loads the build's bundle");

  // lint and typecheck both open with the generator; it runs once, first.
  const gen = at("bun tools/gen-runtime-types.ts");
  assert.notEqual(steps[gen].background, true);
  assert.ok(gen < at("bun run lint") && gen < at("bun run typecheck"), "generate the runtime types before lint and typecheck race to");

  // The suite needs timbrado's engine finished, not merely started.
  const engine = steps.find((step) => String(step.run ?? "").includes("ensureTimbradoEngine"));
  assert.ok(engine?.id, "the engine build needs an id to wait on");
  assert.ok(!engine.background || waited(engine.id, at("bun run test")), "the suite must wait for timbrado's engine");

  // Nothing ends the job unjoined: the last step waits for every background one.
  assert.ok(Object.hasOwn(steps.at(-1), "wait-all"), "validate must end with a wait-all, so a failed background check fails by name");
});
