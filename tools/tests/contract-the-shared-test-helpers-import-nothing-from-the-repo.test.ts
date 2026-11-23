// ── contract-shared.ts imports node builtins and nothing from the repo ──────
// Every test file loads contract-shared.ts, so a repo module it imports is read
// by every test's trace, and traced selection (tools/test-inputs.ts) reruns the
// whole suite whenever that module changes (gotcha 111). A helper that needs a
// repo module gets its own file beside it, as contract-config.ts and
// contract-terminal.ts do, and the tests that need it import that file.
import { ROOT, assert, readFileSync, test } from "./contract-shared.ts";

const SPECIFIER = /^\s*(?:import|export)\b[^'"]*?\bfrom\s*["']([^"']+)["']|^\s*import\s*["']([^"']+)["']|\bimport\(\s*["']([^"']+)["']\s*\)/gm;

/** Every module `code` imports or re-exports from, in source order. */
export function specifiers(code: string): string[] {
  return [...code.matchAll(SPECIFIER)].map((m) => m[1] ?? m[2] ?? m[3]);
}

test("specifiers reads imports, side-effect imports, re-exports and import()", () => {
  const code = [
    'import assert from "node:assert/strict";',
    'import {\n  a,\n  b,\n} from "../../src/worker/a.ts";',
    'import "./side-effect.ts";',
    'export { c } from "../../src/worker/c.ts";',
    'export * from "../lib/d.ts";',
    'const e = await import("../../src/worker/e.ts");',
    "const f = 1;",
  ].join("\n");
  assert.deepEqual(specifiers(code), [
    "node:assert/strict",
    "../../src/worker/a.ts",
    "./side-effect.ts",
    "../../src/worker/c.ts",
    "../lib/d.ts",
    "../../src/worker/e.ts",
  ]);
  assert.deepEqual(specifiers("const g = 2;\n"), []);
});

test("contract-shared.ts imports node builtins and nothing from the repo", () => {
  const found = specifiers(readFileSync(new URL("tools/tests/contract-shared.ts", ROOT), "utf8"));
  assert.ok(found.includes("node:test"), `the scan read no node:test import from contract-shared.ts, so it has stopped matching: ${found.join(", ")}`);
  const repo = found.filter((s) => !s.startsWith("node:"));
  assert.deepEqual(
    repo,
    [],
    `contract-shared.ts imports ${repo.join(", ")}, which makes every test an input of it (gotcha 111); move the helper that needs it into its own file`,
  );
});

test("the narrow helper files are where the repo imports went", () => {
  assert.deepEqual(specifiers(readFileSync(new URL("tools/tests/contract-config.ts", ROOT), "utf8")), ["node:fs/promises", "../lib/site-config.ts"]);
  assert.deepEqual(specifiers(readFileSync(new URL("tools/tests/contract-terminal.ts", ROOT), "utf8")), [
    "../../src/worker/terminal.ts",
    "./contract-shared.ts",
  ]);
});
