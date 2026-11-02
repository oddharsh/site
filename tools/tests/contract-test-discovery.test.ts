// Keep bare Bun, the scripted suite, and the timing plan on the same test set.
// A moved file's old timing entry survives --update-timings unless the plan is
// regenerated from scratch; it then silently stops influencing test ordering (gotcha 87).
import { ROOT, assert, existsSync, readFile, readdir, test } from "./contract-shared.ts";
import { parse } from "../lib/toml.ts";

test("bare and scripted test discovery target the contract directory", async () => {
  const config = parse(await readFile(new URL("bunfig.toml", ROOT), "utf8"));
  const pkg = JSON.parse(await readFile(new URL("package.json", ROOT), "utf8"));
  assert.equal((config.test as Record<string, unknown>).root, "tools/tests");
  assert.equal(pkg.scripts.test.trim().split(/\s+/).at(-1), "tools/tests/");
  assert.match(pkg.scripts["test:node"], /tools\/tests\/\*\.test\.ts$/);
  assert.deepEqual(
    (await readdir(new URL("tools/", ROOT))).filter((name) => name.endsWith(".test.ts")),
    [],
  );
});

test("the timing plan names live contract tests", async () => {
  const timings = JSON.parse(await readFile(new URL("config/test-timings.json", ROOT), "utf8"));
  const files = Object.keys(timings.files);
  assert.ok(files.length > 200, `only ${files.length} timing entries; expected the contract suite`);
  for (const file of files) {
    assert.ok(file.startsWith("tools/tests/") && file.endsWith(".test.ts"), `timing entry outside the suite: ${file}`);
    assert.ok(existsSync(new URL(file, ROOT)), `timing entry names a removed test: ${file}`);
  }
});
