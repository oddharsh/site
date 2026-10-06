import assert from "node:assert/strict";
import test from "node:test";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { baselineProblems, checkProgram, coverageProblems, programFiles } from "./typecheck.ts";

const BUN = process.versions.bun ? process.execPath : "bun";
const OPTIONS = { noEmit: true, target: "esnext", module: "esnext", moduleResolution: "bundler", strict: true, types: [], lib: ["esnext"] };

function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "bun-typecheck-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const write = (file, content) => {
    mkdirSync(join(root, file, ".."), { recursive: true });
    writeFileSync(join(root, file), typeof content === "string" ? content : JSON.stringify(content));
  };
  return { root, write };
}

test("Bun checks imported source, counts only its owner, and separates named files", (t) => {
  const { root, write } = fixture(t);
  write("tsconfig.json", { compilerOptions: OPTIONS, include: ["owned/main.ts"] });
  write("owned/main.ts", 'import { value } from "../shared/value"; export const count: number = value;');
  write("shared/value.ts", 'export const value: string = 1;');
  const checked = checkProgram(root, "tsconfig.json", ["owned/"], BUN);
  assert.deepEqual(checked.counts, { "owned/main.ts": 1 });
  assert.ok(checked.files.includes("shared/value.ts"));
  const named = new Set(programFiles(root, "tsconfig.json", true, BUN));
  assert.ok(named.has("owned/main.ts"));
  assert.ok(!named.has("shared/value.ts"), "an import must not satisfy the lint's include contract");
  assert.match(coverageProblems(["shared/value.ts"], new Set(checked.files), named)[0], /only through imports/);
  assert.match(coverageProblems(["uncovered.ts"], new Set(checked.files), named)[0], /belongs to no/);
  assert.deepEqual(coverageProblems(["owned/main.ts"], new Set(checked.files), named), []);

  write("owned/main.ts", 'import { value } from "../shared/value"; export const count: string = value;');
  write("shared/value.ts", 'export const value: string = "valid";');
  assert.deepEqual(checkProgram(root, "tsconfig.json", ["owned/"], BUN).counts, {});
});

test("Bun uses extends, include, exclude, and checkJs when discovering named source", (t) => {
  const { root, write } = fixture(t);
  write("base.json", { compilerOptions: { ...OPTIONS, allowJs: true, checkJs: true }, include: ["src/**/*"], exclude: ["src/excluded.ts"] });
  write("tsconfig.json", { extends: "./base.json" });
  write("src/main.js", '/** @type {number} */ export const value = "wrong";');
  write("src/excluded.ts", 'export const value: number = "wrong";');
  assert.deepEqual(programFiles(root, "tsconfig.json", true, BUN), ["src/main.js"]);
  assert.deepEqual(checkProgram(root, "tsconfig.json", ["src/"], BUN).counts, { "src/main.js": 1 });
});

test("the baseline rejects new errors, increases, and unrecorded fixes within its scope", () => {
  const scope = (file) => file.startsWith("owned/");
  assert.deepEqual(baselineProblems({ "owned/a.ts": 2 }, { "owned/a.ts": 2, "other/b.ts": 1 }, scope), []);
  assert.match(baselineProblems({ "owned/a.ts": 1 }, {}, scope)[0], /baseline has none/);
  assert.match(baselineProblems({ "owned/a.ts": 2 }, { "owned/a.ts": 1 }, scope)[0], /up from 1/);
  assert.match(baselineProblems({ "owned/a.ts": 1 }, { "owned/a.ts": 2 }, scope)[0], /down from 2/);
  assert.match(baselineProblems({}, { "owned/a.ts": 1 }, scope)[0], /now clean/);
});

for (const [name, options, code] of [
  ["invalid compiler option", { ...OPTIONS, strct: true }, "export const value = 1;"],
  ["syntax error", OPTIONS, "export const value: = ;"],
  ["missing global types", { ...OPTIONS, types: ["missing-global-types"] }, "export const value = 1;"],
]) {
  test(`an incomplete check fails closed: ${name}`, (t) => {
    const { root, write } = fixture(t);
    write("tsconfig.json", { compilerOptions: options, files: ["main.ts"] });
    write("main.ts", code);
    assert.throws(() => checkProgram(root, "tsconfig.json", [""], BUN), /could not complete|holds no files/);
  });
}

test("a missing checker and an empty program cannot report a clean check", (t) => {
  const { root, write } = fixture(t);
  write("tsconfig.json", { compilerOptions: OPTIONS, files: [] });
  assert.throws(() => checkProgram(root, "tsconfig.json", [""], BUN), /could not complete|holds no files/);
  assert.throws(() => checkProgram(root, "tsconfig.json", [""], join(root, "missing-bun")), /could not complete/);
});

test("a Bun without the checker is named, with the install command", (t) => {
  const { root, write } = fixture(t);
  write("tsconfig.json", { compilerOptions: OPTIONS, files: ["main.ts"] });
  write("main.ts", "export const value = 1;");
  // What a pre-checker Bun prints for `bun check` (09bb546, 2026-10-06).
  write("old-bun", "#!/bin/sh\necho 'error: Script not found \"check\"' >&2\nexit 1\n");
  chmodSync(join(root, "old-bun"), 0o755);
  assert.throws(() => checkProgram(root, "tsconfig.json", [], join(root, "old-bun")), /has no `bun check`.*install-bun\.sh/);
});

test("more than 50 identical errors are each counted", (t) => {
  const { root, write } = fixture(t);
  write("tsconfig.json", { compilerOptions: OPTIONS, files: ["main.ts"] });
  write("main.ts", Array.from({ length: 80 }, (_, i) => `export const v${i}: number = "x";`).join("\n"));
  assert.deepEqual(checkProgram(root, "tsconfig.json", ["main.ts"], BUN).counts, { "main.ts": 80 });
});

test("Reader's partial baseline update preserves errors owed by other programs", (t) => {
  const { root, write } = fixture(t);
  for (const file of ["tools/typecheck.ts", "tools/lib/jsonc.ts"]) {
    write(file, readFileSync(new URL(`../${file}`, import.meta.url), "utf8"));
  }
  write("tsconfig.json", { files: [], references: [{ path: "config/tsconfig.lens-reader.json" }] });
  write("config/tsconfig.lens-reader.json", { compilerOptions: OPTIONS, include: ["../lens-reader/src/*.ts"] });
  write("lens-reader/src/main.ts", 'export const value: number = "wrong";');
  write("config/ts-baseline.json", { files: { "src/worker/old.ts": 3, "tools/old.ts": 2 } });
  const result = spawnSync(BUN, [join(root, "tools/typecheck.ts"), "config/tsconfig.lens-reader.json", "--update"], { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.deepEqual(JSON.parse(readFileSync(join(root, "config/ts-baseline.json"), "utf8")).files, {
    "lens-reader/src/main.ts": 1, "src/worker/old.ts": 3, "tools/old.ts": 2,
  });
  const checked = spawnSync(BUN, [join(root, "tools/typecheck.ts"), "config/tsconfig.lens-reader.json"], { cwd: root, encoding: "utf8" });
  assert.equal(checked.status, 0, `${checked.stdout}\n${checked.stderr}`);
});
