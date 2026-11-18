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
  assert.deepEqual(restrictedLines("src/worker/lib/parse.ts"), [1, 2, 5], drift);
  assert.deepEqual(restrictedLines("tools/tests/lint-selector-probe.test.ts"), [1, 2, 5], drift);
});
