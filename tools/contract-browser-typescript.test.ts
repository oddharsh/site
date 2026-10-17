// Owned programs stay TypeScript. Browser erasure must preserve the served
// JavaScript contract in the build, local staging, and subsequent dev edits.
import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { browserJavaScript, browserJavaScripts } from "./lib/browser-source.ts";
import { copyServedTree, linkServedTree, planServedTree } from "./lib/served-tree.ts";
import { watchClientSources } from "./dev-stage.ts";

const authoredJs = (files: string[]) => files.filter((file) =>
  !file.startsWith("src/dict/") && !file.startsWith("tools/fixtures/") && file !== "src/client/garage/pretext.lib.js");

test("owned JavaScript has migrated; dictionaries, byte fixtures and vendored code keep their bytes", () => {
  const files = execFileSync("git", ["ls-files", "*.js", "*.mjs", "*.cjs"], { encoding: "utf8" }).trim().split("\n");
  assert.ok(files.length > 50, "the dictionary inventory must not disappear");
  assert.deepEqual(authoredJs(files), []);
  assert.deepEqual(authoredJs([...files, "tools/stale.mjs"]), ["tools/stale.mjs"], "control: a new owned JS file is rejected");
});

test("erasure retains readable comments and rejects syntax that requires runtime transformation", () => {
  const source = '// The visitor can read this decision.\ntype Label = string;\nconst label: Label = `ready\n   \n`;\nglobalThis.label = label;\n';
  const js = browserJavaScript(source, "fixture.ts");
  assert.ok(js.includes("// The visitor can read this decision."));
  assert.ok(!js.includes(": Label"));
  assert.ok(js.includes("\n   \n"), "whitespace inside a template literal is data");
  assert.equal(js.split("\n")[1], "", "an erased type line has no trailing whitespace");
  const unicode = "雪😀".repeat(12000);
  const large = browserJavaScript(`const text: string = ${JSON.stringify(unicode)};`, "unicode.ts");
  assert.ok(large.includes(JSON.stringify(unicode)), "UTF-8 source survives pipe chunk boundaries");
  assert.equal(browserJavaScripts(new Map([["vendor.js", source]])).get("vendor.js"), source, "vendored bytes are untouched");
  assert.throws(() => browserJavaScript("enum Mode { Ready }", "invalid.ts"), /erasure failed/, "control: unsupported syntax cannot silently ship");
});

test("both staging adapters serve JavaScript URLs and dev edits recompile and remove their output", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "browser-typescript-"));
  let watcher: ReturnType<typeof watchClientSources> | undefined;
  try {
    await mkdir(join(cwd, "src/client"), { recursive: true });
    const source = join(cwd, "src/client/nav.ts");
    await writeFile(source, 'const state: string = "before";');
    const plan = await planServedTree({ cwd, roots: ["src/client"] });
    assert.equal(plan.files.get("nav.js"), "src/client/nav.ts");
    assert.equal(plan.files.has("nav.ts"), false);
    await copyServedTree(plan, "built", { cwd });
    await linkServedTree(plan, "dev", { cwd });
    const before = await readFile(join(cwd, "built/nav.js"), "utf8");
    assert.equal(await readFile(join(cwd, "dev/nav.js"), "utf8"), before);
    assert.ok(!before.includes(": string"));
    watcher = watchClientSources("dev", cwd);
    const waitFor = async (predicate: () => Promise<boolean>) => {
      for (let i = 0; i < 100; i++) {
        if (await predicate()) return;
        await setTimeout(25);
      }
      assert.fail("client watcher did not publish the edit");
    };
    await writeFile(source, 'const state: string = "after";');
    await waitFor(async () => (await readFile(join(cwd, "dev/nav.js"), "utf8")).includes('"after"'));
    await rm(source);
    await waitFor(async () => readFile(join(cwd, "dev/nav.js")).then(() => false, () => true));
    watcher.close();
    watcher = undefined;
    await writeFile(source, 'const state: string = "collision";');
    await mkdir(join(cwd, "public"));
    await writeFile(join(cwd, "public/nav.js"), "other owner");
    await assert.rejects(planServedTree({ cwd, roots: ["public", "src/client"] }), /authored by both/, "control: TS-to-JS mapping still detects collisions");
  } finally {
    watcher?.close();
    await rm(cwd, { recursive: true, force: true });
  }
});
