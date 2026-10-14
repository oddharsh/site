// harness-tests.ts: which contract tests boot wrangler's createTestHarness,
// and the one command the wrangler gate runs them with.
//
// WHY THE GATE NEEDS THEM. canary-wrangler.ts held a candidate wrangler to the
// dry-run bundle, the route oracle and cal's suite. All three passed on
// workers-sdk@ddaa558 (#1037), and `validate` then failed three contract tests
// that boot a Worker through the SAME harness: miniflare's dispatchFetch moved
// its URL rewrite into an undici Dispatcher (workers-sdk#15906), and bun's
// fetch ignores `{ dispatcher }`. The route oracle runs under node and cal
// never calls worker.fetch(), so neither gate could see it. These tests are the
// harness's other door, and a gate that skips a door approves whatever breaks
// behind it.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const HARNESS_TEST_FLOOR = 3;

const IMPORTS_WRANGLER = /^\s*import\s[^\n]*\bfrom\s*"wrangler"|^[^'"`\n]*\bimport\(\s*"wrangler"\s*\)/m;
const BOOTS_HARNESS = /^[^'"`\n]*\bcreateTestHarness\s*\(/m;

export function bootsHarness(source: string): boolean {
  const code = source.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
  return IMPORTS_WRANGLER.test(code) && BOOTS_HARNESS.test(code);
}

export function harnessTests(root: string): string[] {
  return readdirSync(join(root, "tools"))
    .filter((name) => name.endsWith(".test.mjs"))
    .filter((name) => bootsHarness(readFileSync(join(root, "tools", name), "utf8")))
    .map((name) => `tools/${name}`)
    .sort();
}

export function testArgv(testScript: string, files: string[]): string[] {
  const parts = testScript.trim().split(/\s+/);
  if (parts[0] !== "bun" || parts[1] !== "test" || parts.at(-1) !== "tools/") {
    throw new Error(`package.json's "test" is ${JSON.stringify(testScript)}, which is not \`bun test ... tools/\`; re-anchor testArgv()`);
  }
  return [...parts.slice(1, -1), ...files];
}
