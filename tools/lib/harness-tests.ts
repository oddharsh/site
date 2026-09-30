// harness-tests.ts — which contract tests boot wrangler's createTestHarness,
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
//
// FOUND BY WHAT THEY DO, never by name. A test file counts when its code, with
// comment lines dropped, both imports "wrangler" and calls createTestHarness().
// Both halves matter: two other test files name createTestHarness in prose
// (the entry-point check and the TypeScript quarantine), and a scan on the word
// alone would put a test in the gate that boots nothing.
//
// This module reads files and nothing else, so the contract suite can point it
// at a fixture tree.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Below this, the collector has stopped matching (there were 3 on 2026-09-30). */
export const HARNESS_TEST_FLOOR = 3;

// Line-anchored, with no quote ahead of the match on its line, so a test that
// quotes these shapes as fixtures (this module's own contract test does) is
// not collected as one that boots the harness.
const IMPORTS_WRANGLER = /^\s*import\s[^\n]*\bfrom\s*"wrangler"|^[^'"`\n]*\bimport\(\s*"wrangler"\s*\)/m;
const BOOTS_HARNESS = /^[^'"`\n]*\bcreateTestHarness\s*\(/m;

/** True when `source` imports wrangler AND boots its harness outside a comment. */
export function bootsHarness(source: string): boolean {
  const code = source.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
  return IMPORTS_WRANGLER.test(code) && BOOTS_HARNESS.test(code);
}

/** The contract tests under `<root>/tools/` that boot the harness, as paths
 *  relative to `root`, sorted. */
export function harnessTests(root: string): string[] {
  return readdirSync(join(root, "tools"))
    .filter((name) => name.endsWith(".test.mjs"))
    .filter((name) => bootsHarness(readFileSync(join(root, "tools", name), "utf8")))
    .map((name) => `tools/${name}`)
    .sort();
}

/** `bun run test`'s own argv with its `tools/` target swapped for `files`, so
 *  the gate runs them exactly as `validate` does: the same flags, the same
 *  network tripwire, the same per-test timeout, and the same underNode() path
 *  a bun-collected harness test takes. Throws when the script no longer has
 *  the shape this edits, since a guessed command would gate on something else. */
export function testArgv(testScript: string, files: string[]): string[] {
  const parts = testScript.trim().split(/\s+/);
  if (parts[0] !== "bun" || parts[1] !== "test" || parts.at(-1) !== "tools/") {
    throw new Error(`package.json's "test" is ${JSON.stringify(testScript)}, which is not \`bun test ... tools/\`; re-anchor testArgv()`);
  }
  return [...parts.slice(1, -1), ...files];
}
