import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ROOT, assert, test } from "./contract-shared.ts";

// Parse the real workflow with Bun's YAML parser under both test runners.
// CI is ONE job since 2026-09-28, so the join job and its failure predicate
// are gone: a single job named `validate` fails the required check by itself.
const workflow = JSON.parse(
  execFileSync(
    "bun",
    [
      "-e",
      "console.log(JSON.stringify(Bun.YAML.parse(require('node:fs').readFileSync(process.argv[1], 'utf8'))))",
      fileURLToPath(new URL(".github/workflows/ci.yml", ROOT)),
    ],
    { encoding: "utf8" },
  ),
);

// The suite step: `bun run test`, narrowed on a pull request to the files its
// diff can reach (tools/test-inputs.ts), and whole everywhere else.
const SUITE = "bun tools/test-inputs.ts run --map test-inputs.json";

test("only a pull request restores the map that narrows the suite, so main runs all of it", () => {
  const { steps } = workflow.jobs.validate;
  const restore = steps.findIndex((step) => String(step.uses ?? "").startsWith("actions/cache/restore@") && step.with?.path === "test-inputs.json");
  assert.ok(restore >= 0, "validate restores the test input map");
  assert.equal(steps[restore].if, "github.event_name == 'pull_request'", "a push to main must find no map and run the whole suite");
  assert.equal(steps[restore].with["restore-keys"], "test-inputs-");
  assert.ok(restore < steps.findIndex((step) => step.run === SUITE), "the map is in place before the suite reads it");
});

test("CI is one required job named validate that cannot be skipped or softened", () => {
  // `attest` (2026-10-01) signs the served manifest on a push to main. It is
  // not a check anybody requires, it needs validate, and it cannot fail the run;
  // contract-production-serves-what-ci-built holds its shape. `cpu-sweep`
  // checks CPU per route: inside validate it pushed the required check from
  // about 55 s to 116 s (route-cpu.ts, since folded into cpu-sweep.ts,
  // 2026-10-08) and to 83-86 s (cpu-sweep.ts, 2026-10-09), so it gets its own runner. From 2026-10-09 it runs with
  // --gate, so a route over its ceiling fails the JOB; continue-on-error keeps
  // the RUN's conclusion success, because promote-production releases only a
  // successful run and a CPU regression must never hold up a release.
  // `controls` (2026-10-29) plants each guard's defect and fails if the guard
  // misses it. A blind guard is a finding about the checks, not about the
  // commit, so it reports on the same terms as the CPU job.
  assert.deepEqual(Object.keys(workflow.jobs), ["validate", "cpu-sweep", "controls", "attest"]);
  for (const name of ["cpu-sweep", "controls"]) {
    const job = workflow.jobs[name];
    assert.equal(job["continue-on-error"], true, `${name} may fail its job, never the run promote-production waits on`);
    assert.equal(job.needs, undefined, `nothing waits on ${name}, and it waits on nothing`);
    assert.ok(
      !Object.values<{ needs?: string | string[]; steps: { uses?: string; with?: Record<string, string> }[] }>(workflow.jobs).some((other) =>
        [other.needs].flat().includes(name),
      ),
      `no job may need ${name}`,
    );
  }
  const report = workflow.jobs["cpu-sweep"];
  assert.ok(
    report.steps.some((step) => /cpu-sweep\.ts --gate/.test(step.run ?? "")),
    "the CPU job gates",
  );
  assert.ok(!workflow.jobs.validate.steps.some((step) => /cpu-sweep/.test(step.run ?? "")), "the sweep stays out of validate, which it slows");
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
  // pages:check is here because #1001 dropped it from validate and nothing
  // noticed for 16 days (gotcha 32).
  for (const command of [
    "bun run check-wrangler",
    "bun run lint",
    "bun run typecheck",
    "bun run perf-budget",
    "bun run derive:check",
    "bun run pages:check",
    "bun run routes:check",
    SUITE,
    "bun run --filter cal-aadhar-sh test",
  ]) {
    assert.ok(runs.includes(command), `validate no longer runs ${command}`);
  }
});

test("manual CI keeps checkout and cache scope on the dispatched revision", () => {
  assert.ok(Object.hasOwn(workflow.on, "workflow_dispatch"));
  assert.equal(workflow.on.workflow_dispatch?.inputs, undefined);
  const checkouts = Object.values<{ needs?: string | string[]; steps: { uses?: string; with?: Record<string, string> }[] }>(workflow.jobs)
    .flatMap((job) => job.steps)
    .filter((step) => step.uses?.startsWith("actions/checkout@"));
  assert.ok(checkouts.length > 0);
  for (const checkout of checkouts) {
    assert.equal(checkout.with?.ref, undefined, "checkout must use the event's revision and cache scope");
    assert.equal(checkout.with?.repository, undefined, "checkout must use the event's repository");
  }
});

// Steps run in the background since 2026-10-06 (gotcha 54). Concurrency is
// only safe along four edges, and breaking any of them weakens the gate
// without turning it red, so each is asserted here instead of trusted.
test("background steps keep the four ordering edges and all join before the job ends", () => {
  const { steps } = workflow.jobs.validate;
  const at = (run) => {
    const i = steps.findIndex((step) => step.run === run);
    assert.ok(i >= 0, `validate no longer runs \`${run}\` as its own step`);
    return i;
  };
  const waited = (id, before) => steps.slice(0, before).some((step) => step.wait === id || (Array.isArray(step.wait) && step.wait.includes(id)));

  // A background step needs an id for anything to wait on or cancel it.
  for (const step of steps.filter((s) => s.background)) assert.ok(step.id, `${step.name} runs in the background without an id`);

  // The suite reads .build/, and two of its tests skip without one. Since
  // 2026-11-09 the build runs in the background so the engine can start
  // beside it, which makes "after the build" mean "after a wait for it".
  const build = at("bun run perf-budget");
  const built = (i) => i > build && (!steps[build].background || waited(steps[build].id, i));
  assert.ok(built(at(SUITE)), "the suite must start after the build it reads has finished");
  assert.ok(built(at("bun run routes:check --prebuilt .build/.perfbudget")), "the route oracle loads the finished build's bundle");
  const cut = steps.findIndex((step) => /bun run served:manifest/.test(step.run ?? ""));
  assert.ok(cut >= 0 && built(cut), "the served manifest is cut from a finished .build/");

  // The engine's cargo build needs the toolchain the restore writes, so it
  // starts only once both Rust caches have landed. The engine key must not
  // run rustc either, since a rustup proxy call before the restore lands
  // would download the toolchain into the directory being restored.
  const engineAt = steps.findIndex((step) => String(step.run ?? "").includes("ensureTimbradoEngine"));
  for (const path of ["~/.rustup/toolchains/", "steps.timbrado.outputs.target"]) {
    const cache = steps.findIndex((step) => String(step.uses ?? "").startsWith("actions/cache@") && String(step.with?.path ?? "").includes(path));
    assert.ok(cache >= 0 && cache < engineAt, `validate restores ${path} before the engine builds`);
    assert.ok(!steps[cache].background || waited(steps[cache].id, engineAt), `the engine must wait for the ${path} cache it builds into`);
  }
  const key = steps.find((step) => step.id === "timbrado");
  assert.doesNotMatch(key?.run ?? "", /\brustc\b|\bcargo\b/, "the engine cache key must come from the pin, not a rustup proxy call");

  // lint and typecheck both open with the generator; it finishes, once, first.
  const gen = at("bun tools/gen-runtime-types.ts");
  for (const run of ["bun run lint", "bun run typecheck"]) {
    const i = at(run);
    assert.ok(gen < i && (!steps[gen].background || waited(steps[gen].id, i)), `generate the runtime types before \`${run}\` races to`);
  }

  // The suite needs timbrado's engine finished, not merely started.
  const engine = steps.find((step) => String(step.run ?? "").includes("ensureTimbradoEngine"));
  assert.ok(engine?.id, "the engine build needs an id to wait on");
  assert.ok(!engine.background || waited(engine.id, at(SUITE)), "the suite must wait for timbrado's engine");

  // Nothing ends the job unjoined: the last step waits for every background one.
  assert.ok(Object.hasOwn(steps.at(-1), "wait-all"), "validate must end with a wait-all, so a failed background check fails by name");
});
