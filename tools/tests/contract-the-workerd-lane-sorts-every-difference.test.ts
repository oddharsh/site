// ── the workerd lane: who belongs in it, and what each miss means ────────────
// tools/test-workerd.ts runs the contract tests of shipped code a second time
// inside workerd. These pin the two decisions it makes from tools/lib/workerd-lane.ts:
// membership (which tests exercise Worker code) and the verdict on each result.
import { assert, test } from "./contract-shared.ts";
import { inLane, namedImports, reachable, staleGaps, verdict } from "../lib/workerd-lane.ts";
import type { Gap } from "../lib/workerd-lane.ts";

const WORKER = new Set(["src/worker/index.ts", "src/worker/lib/html.ts"]);
const SHARED = new Map([
  ["assert", "node:assert/strict"],
  ["test", "node:test"],
  ["handleHit", "src/worker/lib/html.ts"],
  ["readManifest", "tools/gen-manifest.ts"],
]);
const gap: Gap = { test: "a.test.ts :: dict", cause: "workerd", why: "zstd drops the dictionary" };
const gaps = new Map([[gap.test, gap]]);
const pass = { name: "t", status: "pass" as const, touched: [] };
const fail = (error: string, touched: string[] = []) => ({ name: "t", status: "fail" as const, error, touched });

test("reachable walks every import once, through a cycle, and stops at the graph's edge", () => {
  const graph = { a: ["b"], b: ["c", "a"], c: ["missing"], d: ["a"] };
  assert.deepEqual([...reachable(graph, ["a"])], ["a", "b", "c", "missing"]);
  assert.deepEqual([...reachable(graph, ["d"])], ["d", "a", "b", "c", "missing"]);
});

test("namedImports maps each local name to its resolved module, across lines, renames and types", () => {
  const source = `import def, { a, b as c } from "./x.ts";\nimport {\n  type T,\n  d,\n} from "../y.ts";\nimport z from "./z.ts";`;
  const names = namedImports(source, (spec) => `R(${spec})`);
  assert.deepEqual(Object.fromEntries(names), { a: "R(./x.ts)", c: "R(./x.ts)", T: "R(../y.ts)", d: "R(../y.ts)" });
});

test("a test is in the lane when it imports Worker code, directly or through contract-shared", () => {
  const base = { sharedSource: SHARED, workerModules: WORKER };
  assert.equal(inLane({ ...base, directImports: ["src/worker/lib/html.ts"], sharedNames: [] }), true);
  assert.equal(inLane({ ...base, directImports: ["tools/tests/contract-shared.ts"], sharedNames: ["assert", "handleHit"] }), true);
});

test("a test of build output or tools stays out of the lane, even through contract-shared", () => {
  const base = { sharedSource: SHARED, workerModules: WORKER };
  assert.equal(inLane({ ...base, directImports: ["tools/lib/quiz-data.ts"], sharedNames: ["assert", "test"] }), false);
  assert.equal(inLane({ ...base, directImports: [], sharedNames: ["readManifest", "unknownName"] }), false);
});

test("a pass in workerd agrees, and so does any result bun didn't pass", () => {
  const input = { key: gap.test, fileTouched: [], gaps };
  assert.deepEqual(verdict({ ...input, workerd: pass, bun: "pass" }), { kind: "agree" });
  assert.deepEqual(verdict({ ...input, workerd: fail("boom"), bun: "skip" }), { kind: "agree" });
  assert.deepEqual(verdict({ ...input, workerd: fail("boom"), bun: undefined }), { kind: "agree" });
});

test("a miss that touched a host stub, or hit a node API workerd stubs, needs a host", () => {
  const input = { key: "b.test.ts :: t", bun: "pass" as const, gaps };
  assert.deepEqual(verdict({ ...input, workerd: fail("x is not an object", ["wrangler"]), fileTouched: [] }), { kind: "host", via: "wrangler" });
  assert.deepEqual(verdict({ ...input, workerd: fail("x"), fileTouched: ["tools/lib/site-config.ts"] }), {
    kind: "host",
    via: "tools/lib/site-config.ts",
  });
  assert.deepEqual(verdict({ ...input, workerd: fail("Error: The child_process.spawnSync method is not implemented"), fileTouched: [] }), {
    kind: "host",
    via: "method is not implemented",
  });
});

test("any other miss is a known gap when listed and new when not, skips included", () => {
  const input = { bun: "pass" as const, fileTouched: [], gaps };
  assert.deepEqual(verdict({ ...input, key: gap.test, workerd: fail("3334 B against 8465 B") }), { kind: "known", gap });
  assert.deepEqual(verdict({ ...input, key: "b.test.ts :: t", workerd: fail("Error: wrong\n    at x") }), {
    kind: "new",
    status: "fail",
    error: "Error: wrong",
  });
  assert.deepEqual(verdict({ ...input, key: "b.test.ts :: t", workerd: { name: "t", status: "skip", touched: [] } }), {
    kind: "new",
    status: "skip",
    error: "",
  });
});

test("a listed gap that stopped differing is stale, and one that still differs is not", () => {
  const other: Gap = { test: "c.test.ts :: cwd", cause: "workerd", why: "cwd" };
  const both = new Map([...gaps, [other.test, other]]);
  assert.deepEqual(staleGaps(both, new Set([gap.test])), [other]);
  assert.deepEqual(staleGaps(both, new Set([gap.test, other.test])), []);
});
