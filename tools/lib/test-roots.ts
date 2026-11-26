// test-roots.ts: where the contract suite lives, read back from the one place
// that says so.
//
// package.json's "test" script ends in the ./-anchored directories bun collects
// from: tools/tests/ for the suite's cross-cutting contracts, and src/ for the
// tests that sit in a local tests/ directory beside the one module directory
// they cover. The tools that list or narrow the suite (test-inputs.ts, the
// harness-test gate, the controls) read the roots from the script instead of
// naming a directory each, so moving a test or adding a root is one edit.
//
// Reads files and nothing else, under bun or node, so a contract test can point
// it at a fixture tree.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, sep } from "node:path";

/** A path inside a tests/ directory: suite code beside the module it covers,
 *  which the build never stages, scans as served bytes, or ships. */
export const inTestsDir = (rel: string) => /(?:^|[\\/])tests[\\/]/.test(rel);

/** The "test" script split into its command and the roots it ends in. A root is
 *  a ./-anchored directory (it ends in "/"), so the ./tools/lib/no-network.ts
 *  preload ahead of them is a flag's value, not a root. Throws when the script
 *  ends in no root, since a guessed command would test something else. */
export function splitTestScript(script: string): { argv: string[]; roots: string[] } {
  const argv = script.trim().split(/\s+/);
  let at = argv.length;
  while (at > 2 && /^\.\/.+\/$/.test(argv[at - 1])) at--;
  if (argv[0] !== "bun" || argv[1] !== "test" || at === argv.length)
    throw new Error(`package.json's "test" is ${JSON.stringify(script)}, which doesn't end in ./-anchored roots like ./tools/tests/`);
  return { argv: argv.slice(0, at), roots: argv.slice(at).map((root) => root.slice(2, -1)) };
}

/** The roots of the "test" script in `repo`'s package.json. */
export function testRoots(repo: string): string[] {
  const script = String(JSON.parse(readFileSync(join(repo, "package.json"), "utf8")).scripts?.test ?? "");
  return splitTestScript(script).roots;
}

/** Every *.test.ts under `roots` in `repo`, as sorted repo-relative paths. */
export function suiteFiles(repo: string, roots: readonly string[] = testRoots(repo)): string[] {
  return roots
    .filter((root) => existsSync(join(repo, root)))
    .flatMap((root) =>
      readdirSync(join(repo, root), { recursive: true, encoding: "utf8" })
        .filter((rel) => rel.endsWith(".test.ts"))
        .map((rel) => `${root}/${rel.split(sep).join("/")}`),
    )
    .sort();
}
