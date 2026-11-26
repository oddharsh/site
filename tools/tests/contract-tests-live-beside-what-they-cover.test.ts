// ── a test lives beside the module directory it covers ──────────────────────
// A test that covers one directory under src/ lives in that directory's tests/,
// where whoever edits the module sees it. A test that covers several, or none
// (it reads files, or covers tools/), is a cross-cutting contract and lives in
// tools/tests/. A test covers a directory when it imports from it and from
// nothing outside it: importing src/worker and src/worker/lib covers src/worker,
// while importing src/worker/lib and src/worker/lens alone covers neither. This is the placement rule
// of interfere-inc/landmines' colocated-tests, which put 121 of 293 tests in
// the wrong place on 2026-11-18. Here it's a contract test rather than a lint
// rule, because a JavaScript lint rule starts bun lint's JS engines on every
// run (docs/DEPENDENCIES.md, "Rules from dmmulroy/anti-slop").
//
// An owner is the directory of a src/ module the test imports by a relative
// path, statically or with import(). Type-only imports and other tests don't
// count: a type says nothing about behavior, and a shared helper isn't a subject.
import { ROOT, assert, test } from "./contract-shared.ts";

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { posix } from "node:path";
import { inTestsDir, suiteFiles } from "../lib/test-roots.ts";
import { planServedTree } from "../lib/served-tree.ts";

const repo = fileURLToPath(ROOT);

const STATIC = /^\s*import\s+(type\s+)?([^'"]*?)\s*from\s*["'](\.[^"']+)["']|^\s*import\s*["'](\.[^"']+)["']/gm;
// No quote ahead of import( on its line, so this file's own fixtures, which
// quote that shape, aren't read as imports (harness-tests.ts does the same).
const DYNAMIC = /^[^'"`\n]*\bimport\(\s*["'](\.[^"']+)["']\s*\)/gm;

const TYPE_SPECIFIER = /^type\s+[\w$]+(?:\s+as\s+[\w$]+)?$/;

/** Whether an import clause names only types: `{ type A, type B as C }`. */
function typeOnly(clause: string): boolean {
  const braced = clause.trim();
  if (!braced.startsWith("{") || !braced.endsWith("}")) return false;
  const names = braced
    .slice(1, -1)
    .split(",")
    .map((name) => name.trim());
  if (names.at(-1) === "") names.pop(); // a trailing comma
  return names.length > 0 && names.every((name) => TYPE_SPECIFIER.test(name));
}

/** The src/ directories whose modules `file` (repo-relative) imports, sorted. */
export function ownerDirs(file: string, code: string): string[] {
  const specs: string[] = [];
  for (const m of code.matchAll(STATIC)) {
    const [, typeKeyword, clause, from, bare] = m;
    if (bare) specs.push(bare);
    else if (!typeKeyword && !typeOnly(clause)) specs.push(from);
  }
  for (const m of code.matchAll(DYNAMIC)) specs.push(m[1]);
  const dirs = specs
    .map((spec) => posix.normalize(posix.join(posix.dirname(file), spec)))
    .filter((target) => target.startsWith("src/") && !inTestsDir(target))
    .map((target) => posix.dirname(target));
  return [...new Set(dirs)].sort();
}

/** The one directory `dirs` covers: their nearest common ancestor, when the test
 *  imports from that ancestor itself and it isn't src/. Null otherwise. */
export function coveredDir(dirs: readonly string[]): string | null {
  if (!dirs.length) return null;
  let covered = dirs[0];
  for (const dir of dirs) while (dir !== covered && !dir.startsWith(`${covered}/`)) covered = posix.dirname(covered);
  return covered !== "src" && dirs.includes(covered) ? covered : null;
}

/** Why `file` is in the wrong place, or null. A test in src/ must import from the
 *  directory its tests/ sits in; a test in tools/tests/ must cover no one directory. */
function misplaced(file: string): string | null {
  const dirs = ownerDirs(file, readFileSync(`${repo}/${file}`, "utf8"));
  if (file.startsWith("src/")) {
    const home = posix.dirname(posix.dirname(file));
    return dirs.includes(home)
      ? null
      : `${file} imports nothing from ${home}/, so it belongs in tools/tests/ or beside what it covers (${dirs.join(", ") || "no src/ imports"})`;
  }
  const covered = coveredDir(dirs);
  return covered ? `${file} covers ${covered}/ alone, so it belongs in ${covered}/tests/` : null;
}

test("ownerDirs counts value imports under src/ and skips types, tests and everything else", () => {
  const code = [
    'import { parse } from "../../src/worker/lib/parse.ts";',
    'import type { Env } from "../../src/worker/env.ts";',
    'import { type Album, type Photo as P } from "../../src/worker/albums.ts";',
    'import { ALBUMS, type Album } from "../../src/worker/albums.ts";',
    'import { assert } from "./contract-shared.ts";',
    'import { cf } from "../lib/cf.ts";',
    'import "../../src/client/nav.ts";',
    'const { worker } = await import("../../src/worker/index.ts");',
    'import { x } from "../../src/worker/tests/contract-other.test.ts";',
  ].join("\n");
  assert.deepEqual(ownerDirs("tools/tests/probe.test.ts", code), ["src/client", "src/worker", "src/worker/lib"]);
  assert.deepEqual(ownerDirs("tools/tests/probe.test.ts", 'import type { Env } from "../../src/worker/env.ts";\nimport { cf } from "../lib/cf.ts";'), []);
});

test("coveredDir is the imported ancestor of every import, and never src/ itself", () => {
  assert.equal(coveredDir(["src/worker", "src/worker/lib"]), "src/worker");
  assert.equal(coveredDir(["src/worker/lib"]), "src/worker/lib");
  assert.equal(coveredDir(["src/worker/lib", "src/worker/lens"]), null, "src/worker itself is never imported");
  assert.equal(coveredDir(["src/client", "src/worker"]), null, "their ancestor is src/");
  assert.equal(coveredDir([]), null);
});

test("every suite test lives beside the one module directory it covers, or in tools/tests/", () => {
  const files = suiteFiles(repo);
  assert.ok(files.length > 250, `only ${files.length} suite files; the collector has stopped matching`);
  const colocated = files.filter((file) => file.startsWith("src/"));
  assert.ok(colocated.length >= 100, `only ${colocated.length} colocated tests; were they moved back?`);
  assert.deepEqual(files.map(misplaced).filter(Boolean), [], "a test sits away from what it covers");
});

// gotcha 105: src/client/ is served from the site root, so a client test the served tree
// took in would ship as /garage/tests/<name>.test.js, Brotli twin and all. It
// did, on the first build of this layout (2026-11-18).
test("the served tree skips every tests/ directory under src/, so no colocated test ships", async () => {
  const plan = await planServedTree({ cwd: repo });
  assert.deepEqual([...plan.files.values()].filter(inTestsDir), [], "a colocated test would be served");
  assert.ok(plan.skipped.includes("src/client/garage/tests"), "the control: a client tests/ directory exists and is the one skipped");
});
