// The wrangler pin's gates run every contract test that boots wrangler's
// createTestHarness, since 2026-09-30.
//
// workers-sdk@ddaa558 cleared the three gates the nightly bumper held it to
// (dry-run bundle, route oracle, cal's suite), was proposed as #1037, and then
// failed `validate` on three contract tests that boot a Worker through that
// same harness. lib/harness-tests.ts has the mechanism. The control, run with
// canary-wrangler.ts against that exact ref from a tree carrying this gate but
// not the underNode() repair, came back RED on the new gate alone:
//
//   bun run canary:wrangler -- --ref ddaa558
//    FAIL  harness contract tests pass on the candidate harness — 1 pass, 3 fail across 3 files
//
// and the same command with the repair in the tree came back without that
// FAIL. So the gate would have refused #1037, and does not refuse the fix.
//
// What is asserted here is what can go stale without failing: the collector
// finding the files (a floor, plus the two prose-only files as its control),
// the command matching `bun run test`, and the leg wiring the gate as HARD.
// The measurement itself needs pkg.pr.new and an install, so it lives in the
// leg rather than in a suite that runs with the network tripwire armed.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ROOT, assert, test } from "./contract-shared.ts";
import { HARNESS_TEST_FLOOR, bootsHarness, harnessTests, testArgv } from "./lib/harness-tests.ts";

const root = fileURLToPath(ROOT);
const read = (rel) => readFileSync(new URL(rel, ROOT), "utf8");

test("the harness collector finds every contract test that boots createTestHarness, and only those", () => {
  const found = harnessTests(root);
  assert.ok(found.length >= HARNESS_TEST_FLOOR, `found ${found.length}; the collector has stopped matching`);
  for (const rel of [
    "tools/contract-census-duplicate-id-in-workerd.test.mjs",
    "tools/contract-encodebody-survives-a-rebuild-in-workerd.test.mjs",
    "tools/contract-every-cron-fires-in-workerd.test.mjs",
  ]) assert.ok(found.includes(rel), `${rel} boots the harness and the collector missed it`);

  // The controls: the first two name createTestHarness in prose, and this file
  // quotes the import and the call as fixtures. None of them boots anything,
  // and the first draft of the collector took this file for a harness test.
  for (const rel of [
    "tools/contract-every-wrangler-entry-point-exists.test.mjs",
    "tools/contract-the-typescript-quarantine.test.mjs",
    "tools/contract-wrangler-gate-runs-the-harness-tests.test.mjs",
  ]) {
    assert.match(read(rel), /createTestHarness/, `${rel} no longer mentions the harness, so it has stopped being a control`);
    assert.ok(!found.includes(rel), `${rel} only mentions the harness and was collected anyway`);
  }
});

test("bootsHarness needs the import AND the call, outside a comment", () => {
  assert.equal(bootsHarness('import { createTestHarness } from "wrangler";\nconst s = createTestHarness({});'), true);
  assert.equal(bootsHarness('const { createTestHarness } = await import("wrangler");\ncreateTestHarness({});'), true);
  assert.equal(bootsHarness('import { createTestHarness } from "wrangler";'), false, "an import alone boots nothing");
  assert.equal(bootsHarness('// import { createTestHarness } from "wrangler";\n// createTestHarness({});'), false, "commented out is prose");
  assert.equal(bootsHarness('import { unstable_dev } from "wrangler";\n// createTestHarness({})'), false);
});

test("the gate runs those files with `bun run test`'s own flags", () => {
  const script = JSON.parse(read("package.json")).scripts.test;
  const argv = testArgv(script, ["tools/a.test.mjs", "tools/b.test.mjs"]);
  assert.equal(argv[0], "test");
  assert.ok(!argv.includes("tools/"), "the whole-suite target must be swapped out, or the gate runs every test");
  assert.deepEqual(argv.slice(-2), ["tools/a.test.mjs", "tools/b.test.mjs"]);
  assert.deepEqual(argv.slice(1, -2), script.trim().split(/\s+/).slice(2, -1), "every flag validate passes, in order");
  assert.throws(() => testArgv("node --test tools/", []), /re-anchor/);
  assert.throws(() => testArgv("bun test tools/ extra", []), /re-anchor/);
});

test("canary-wrangler.ts wires the harness tests as a HARD gate, before the watches", () => {
  const leg = read("tools/canary-wrangler.ts");
  assert.match(leg, /from "\.\/lib\/harness-tests\.ts"/);
  const start = leg.indexOf("the contract tests that boot that harness, run the way validate does");
  const end = leg.indexOf("the watches, read on the pinned tree");
  assert.ok(start > 0 && end > start, "the gate's section moved, or now sits after the watches");
  const gate = leg.slice(start, end);
  assert.match(gate, /name: "harness contract tests pass on the candidate harness"/, "the gate is gone from the leg");
  assert.match(gate, /harnessTests\(wt\)/, "discovered in the candidate's worktree");
  assert.match(gate, /testArgv\(/, "run with validate's own command");
  assert.match(gate, /hard: true/, "a soft gate would still propose the pin");
  assert.match(gate, /step\(\{/, "a gate that is never stepped never reaches the verdict");
});
