// The three anti-slop rules and the `any`-return rule are `no-restricted-syntax`
// selectors in bunfig.toml's [lint] (docs/DEPENDENCIES.md, "Rules from
// dmmulroy/anti-slop"). An override replaces the whole selector list, so the
// typeof exemption restates the other three. These tests lint one planted file through the repo's config
// at an ordinary path and at an exempt one, so a selector that stops matching
// or an override copy that drifts fails here rather than reading as a clean tree.
import { ROOT, assert, test } from "./contract-shared.ts";

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(ROOT);
// `bun run test:node` runs this file under node, where process.execPath is node.
const bun = process.versions.bun ? process.execPath : "bun";

const PLANTED = [
  "export const userShape = 1;",
  "export const a = { ...(Math.random() > 0.5 ? { x: 1 } : {}) };",
  "export const t = typeof a;",
  "export const b = { ...(Math.random() > 0.5 ? { x: 1 } : { y: 2 }) };",
  "export function c(): Promise<any> { return Promise.resolve(1); }",
  "export const d = (x: any): number => Number(x);",
  'test("t", async () => { await new Promise((r) => setTimeout(r, 1)); });',
  'test("u", () => {}, { timeout: 5 });',
  "export const wait = async () => { await Bun.sleep(1); };",
  'globalThis.fetch = async () => new Response("x");',
  "testGlobals.fetch = realFetch;",
  'env.ASSETS.fetch = async () => new Response("x");',
  "",
].join("\n");

/** Lint PLANTED as if it lived at `path`, and return the lines no-restricted-syntax reported. */
function restrictedLines(path: string): number[] {
  const out = spawnSync(bun, ["lint", "--no-script", "--stdin", "--stdin-filename", path, "-f", "json"], {
    cwd: repo,
    input: PLANTED,
    encoding: "utf8",
    timeout: 60_000,
  });
  assert.equal(out.error, undefined, `bun lint did not run: ${out.error}`);
  // With the rules in bunfig.toml, `-f json` is ESLint's report: one entry per file.
  const report: { messages: { ruleId: string | null; line: number }[] }[] = JSON.parse(out.stdout);
  return report
    .flatMap((file) => file.messages)
    .filter((m) => m.ruleId === "no-restricted-syntax")
    .map((m) => m.line)
    .sort((x, y) => x - y);
}

test("the anti-slop selectors fire at an ordinary path", () => {
  assert.deepEqual(restrictedLines("src/worker/lint-selector-probe.ts"), [1, 2, 3, 5], "an anti-slop selector stopped matching at an ordinary path");
});

test("the typeof exemption keeps the other three selectors", () => {
  const drift = "the typeof override no longer restates the other three selectors";
  assert.deepEqual(restrictedLines("src/worker/lib/parse.ts"), [1, 2, 5, 7, 8, 10, 11], drift);
  assert.deepEqual(restrictedLines("tools/tests/lint-selector-probe.test.ts"), [1, 2, 5, 7, 8, 10, 11], drift);
});

// Lines 7 and 8 plant a sleep and a raised timeout inside test() calls; line 9
// sleeps in a module-level helper, which the sleep selector leaves alone.
test("the sleep and timeout selectors fire in a test file and nowhere else", () => {
  const late = (lines: number[]) => lines.filter((line) => line >= 7 && line <= 9);
  assert.deepEqual(late(restrictedLines("tools/tests/lint-selector-probe.test.ts")), [7, 8], "a sleep or timeout selector stopped matching in a test file");
  assert.deepEqual(late(restrictedLines("src/worker/lint-selector-probe.ts")), [], "a test-only selector reached ordinary source");
});

// Lines 10 and 11 replace the global fetch, directly and through an alias;
// line 12 replaces a binding's fetch, which is a member chain and stays legal.
test("the hand-assigned fetch selector fires in a test file and nowhere else", () => {
  const fetchLines = (lines: number[]) => lines.filter((line) => line >= 10);
  assert.deepEqual(
    fetchLines(restrictedLines("tools/tests/lint-selector-probe.test.ts")),
    [10, 11],
    "the hand-assigned fetch selector stopped matching in a test file",
  );
  assert.deepEqual(fetchLines(restrictedLines("src/worker/lint-selector-probe.ts")), [], "the hand-assigned fetch selector reached ordinary source");
});
