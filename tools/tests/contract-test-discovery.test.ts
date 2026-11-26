// Keep bare Bun, the scripted suite, and the timing plan on the same test set.
// A moved file's old timing entry survives --update-timings unless the plan is
// regenerated from scratch; it then silently stops influencing test ordering (gotcha 87).
import { ROOT, assert, existsSync, readFile, readdir, test } from "./contract-shared.ts";
import { fileURLToPath } from "node:url";
import { parse } from "../lib/toml.ts";
import { repoFiles } from "../lib/repo-files.ts";
import { splitTestScript, suiteFiles } from "../lib/test-roots.ts";

// Each runs its own suite from its own directory and config.
const SEPARATE_SUITES = ["cal", "cf-garage", "lens-reader"];

test("bare and scripted test discovery collect the same files", async () => {
  const config = parse(await readFile(new URL("bunfig.toml", ROOT), "utf8"));
  const pkg = JSON.parse(await readFile(new URL("package.json", ROOT), "utf8"));
  const bare = config.test as Record<string, unknown>;
  assert.equal(bare.root, ".");
  for (const suite of SEPARATE_SUITES) assert.ok((bare.pathIgnorePatterns as string[]).includes(`${suite}/**`), `bare bun test would collect ${suite}'s suite`);
  assert.deepEqual(splitTestScript(pkg.scripts.test).roots, ["tools/tests", "src"]);
  assert.match(pkg.scripts["test:node"], /'tools\/tests\/\*\.test\.ts' 'src\/\*\*\/tests\/\*\.test\.ts'$/);
  assert.deepEqual(
    (await readdir(new URL("tools/", ROOT))).filter((name) => name.endsWith(".test.ts")),
    [],
  );
  // Every tracked test outside the separate suites is one the script collects,
  // so bare discovery from the repo root finds nothing more.
  const tracked = repoFiles()
    .filter((file) => file.endsWith(".test.ts") && !SEPARATE_SUITES.some((suite) => file.startsWith(`${suite}/`)))
    .sort();
  const suite = suiteFiles(fileURLToPath(ROOT));
  assert.deepEqual(tracked, suite);
  // test:node's glob reaches a src/ test only when it sits directly in a tests/ directory.
  const stray = suite.filter((file) => file.startsWith("src/") && !/\/tests\/[^/]+\.test\.ts$/.test(file));
  assert.deepEqual(stray, [], "a src/ test outside a tests/ directory, which test:node never runs");
});

test("the timing plan names live contract tests", async () => {
  const timings = JSON.parse(await readFile(new URL("config/test-timings.json", ROOT), "utf8"));
  const files = Object.keys(timings.files);
  const roots = splitTestScript(JSON.parse(await readFile(new URL("package.json", ROOT), "utf8")).scripts.test).roots;
  assert.ok(files.length > 200, `only ${files.length} timing entries; expected the contract suite`);
  for (const file of files) {
    assert.ok(roots.some((root) => file.startsWith(`${root}/`)) && file.endsWith(".test.ts"), `timing entry outside the suite: ${file}`);
    assert.ok(existsSync(new URL(file, ROOT)), `timing entry names a removed test: ${file}`);
  }
});
