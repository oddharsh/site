// tools/lib/controls.ts plants defects by exact text, so a refactor that moves
// the text strands the control: `bun run controls` reads STALE, but that runs
// in its own CI job after the PR that caused it is already green. This dry-runs
// every plant against the tree in validate, in milliseconds, so the PR that
// moves an anchor is the PR that updates its control (gotcha 89).
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { CONTROLS, plant } from "../lib/controls.ts";
import { ROOT, assert, test } from "./contract-shared.ts";

const root = fileURLToPath(ROOT);

test("every control still plants its defect", () => {
  // the registry held 6 on 2026-10-29; an import that resolved to an empty
  // list would pass every check below
  assert.ok(CONTROLS.length >= 6, `only ${CONTROLS.length} controls registered`);
  const stale = CONTROLS.flatMap((c) => plant(root, c, true).map((p) => `${c.id}: ${p}`));
  assert.deepEqual(stale, [], "update the control's anchor in the same PR that moved it");
});

test("every control names a check that exists and words specific to it", () => {
  const ids = CONTROLS.map((c) => c.id);
  assert.deepEqual(
    ids.filter((id, i) => ids.indexOf(id) !== i),
    [],
    "control ids must be unique",
  );
  for (const c of CONTROLS) {
    assert.match(c.id, /^[a-z0-9]+(-[a-z0-9]+)*$/, `${c.id}: ids are kebab-case`);
    for (const arg of c.run.filter((a) => /^tools\/.*\.ts$/.test(a))) assert.ok(existsSync(new URL(arg, ROOT)), `${c.id}: ${arg} does not exist`);
    // A pattern that matches any red output can't tell a crash from a catch,
    // which is the WRONG REASON verdict this harness exists to separate.
    for (const generic of ["error", "failed", "FAILED", "exit 1", ""])
      assert.ok(!c.expect.test(generic), `${c.id}: expect ${c.expect} matches the generic output ${JSON.stringify(generic)}`);
  }
});

test("every gotcha a control claims is a real entry", () => {
  const md = readFileSync(new URL("docs/GOTCHAS.md", ROOT), "utf8");
  const nums = new Set([...md.matchAll(/^(\d+)\. \*\*/gm)].map((m) => Number(m[1])));
  for (const c of CONTROLS) if (c.gotcha !== undefined) assert.ok(nums.has(c.gotcha), `${c.id}: gotcha ${c.gotcha} has no entry`);
});
