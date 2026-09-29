// A file can be REACHABLE by a tsc program and NAMED by none of its include
// globs, and the two differ in a way only the lint can see.
//
// tsc resolves imports, so a file pulled in transitively is checked correctly
// and `--listFilesOnly` lists it. tsgolint, which oxlint's type-aware pass runs
// on, discovers a config per file by walking UP and asking which one names it;
// finding none, it builds a default DOM-lib program. So the gap costs wrong
// globals and a lint reporting zero, which is what serendipity.ts did for
// months (#882).
//
// check-ts-coverage.ts gates the real tree on this. These are its CONTROLS,
// run against fixtures, because a gate that has only ever been green on one
// tree is a gate nobody has seen work. They drive the same `programFileSets`
// the check calls rather than restating its arithmetic.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { assert, test } from "./contract-shared.ts";
import { programFileSets } from "./lib/tsc-scope.ts";

const tsc = fileURLToPath(new URL("../node_modules/typescript/bin/tsc", import.meta.url));

/**
 * @param {string[]} include
 * @returns {{ covered: string[], named: string[] }}
 */
function sets(include) {
  // CANONICAL root, per gotcha 45: tsc reports under the resolved path, and on
  // macOS $TMPDIR reaches /private/var through /var, so an unresolved root
  // makes every comparison here miss and the controls pass over their own bug.
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "named-globs-")));
  try {
    const files = {
      // entry imports helper, so helper is reachable either way.
      "src/entry.ts": 'import { help } from "./deep/helper.ts";\nexport const run = () => help();\n',
      "src/deep/helper.ts": "export const help = () => 1;\n",
    };
    for (const [file, source] of Object.entries(files)) {
      mkdirSync(dirname(join(repo, file)), { recursive: true });
      writeFileSync(join(repo, file), source);
    }
    const config = join(repo, "config", "tsconfig.json");
    mkdirSync(dirname(config), { recursive: true });
    writeFileSync(config, JSON.stringify({
      compilerOptions: { noEmit: true, types: [], allowImportingTsExtensions: true, moduleResolution: "bundler", module: "esnext" },
      include,
    }));
    const { covered, named } = programFileSets({ repo, tsc, configs: [config] });
    return { covered: [...covered].sort(), named: [...named].sort() };
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

// The bug. helper.ts arrives through entry.ts's import alone, which is exactly
// serendipity's shape: tsc holds it, no glob names it.
test("a transitively imported file is covered and unnamed", () => {
  const { covered, named } = sets(["../src/entry.ts"]);
  assert(covered.includes("src/deep/helper.ts"), `tsc should reach the import: ${covered.join(", ")}`);
  assert(!named.includes("src/deep/helper.ts"), `no glob names it, yet named holds: ${named.join(", ")}`);
  // The entry itself is named, so a miss above is the gap rather than a broken fixture.
  assert(named.includes("src/entry.ts"), `the literal include should be named: ${named.join(", ")}`);
});

// The fix, and the positive control: widening the glob closes the gap.
test("a glob that names the tree closes the gap", () => {
  const { covered, named } = sets(["../src/**/*.ts"]);
  for (const file of ["src/entry.ts", "src/deep/helper.ts"]) {
    assert(covered.includes(file), `${file} missing from covered: ${covered.join(", ")}`);
    assert(named.includes(file), `${file} missing from named: ${named.join(", ")}`);
  }
});

// `named` has to come from tsc's own engine rather than a matcher written here,
// and `exclude` is the cheapest proof that it does.
test("exclude removes a file the include glob matched", () => {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "named-globs-x-")));
  try {
    mkdirSync(join(repo, "src"), { recursive: true });
    writeFileSync(join(repo, "src/kept.ts"), "export const a = 1;\n");
    writeFileSync(join(repo, "src/dropped.ts"), "export const b = 2;\n");
    const config = join(repo, "config", "tsconfig.json");
    mkdirSync(dirname(config), { recursive: true });
    writeFileSync(config, JSON.stringify({
      compilerOptions: { noEmit: true, types: [] },
      include: ["../src/**/*.ts"],
      exclude: ["../src/dropped.ts"],
    }));
    const { named } = programFileSets({ repo, tsc, configs: [config] });
    assert(named.has("src/kept.ts"), `kept.ts should be named: ${[...named].join(", ")}`);
    assert(!named.has("src/dropped.ts"), `exclude ignored, so this is not tsc's glob engine: ${[...named].join(", ")}`);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

// The real tree, which is the assertion the other three make trustworthy.
test("every file this repo owns is named by some include", () => {
  const repo = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
  const result = programFileSets({
    repo,
    tsc,
    configs: ["config/tsconfig.json"].map((c) => join(repo, c)),
  });
  // A floor, because an empty set satisfies every "is not in the gap" assertion.
  assert(result.named.size > 50, `the Worker program named only ${result.named.size} files, so this is measuring nothing`);
  assert(result.named.has("serendipity/serendipity.ts"), "serendipity must stay NAMED, not merely reachable (#882)");
});
