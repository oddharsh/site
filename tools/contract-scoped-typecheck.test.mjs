import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { assert, test } from "./contract-shared.ts";

const tsc = fileURLToPath(new URL("../node_modules/typescript/bin/tsc", import.meta.url));
const scopedTsc = new URL("./lib/tsc-scope.ts", import.meta.url).href;

/**
 * @param {Record<string, unknown>} compilerOptions
 * @param {Record<string, string>} sources
 * @param {string | null} compilerSource
 */
function check(compilerOptions = {}, sources = { "owned/source.ts": "export const value = 1;" }, compilerSource = null) {
  const repo = mkdtempSync(join(tmpdir(), "scoped-typecheck-"));
  try {
    for (const [file, source] of Object.entries(sources)) {
      mkdirSync(dirname(join(repo, file)), { recursive: true });
      writeFileSync(join(repo, file), source);
    }
    const config = join(repo, "tsconfig.json");
    writeFileSync(config, JSON.stringify({ compilerOptions: { noEmit: true, types: [], ...compilerOptions }, include: ["**/*.ts"] }));
    const compiler = compilerSource === null ? tsc : join(repo, "compiler.mjs");
    if (compilerSource !== null) writeFileSync(compiler, compilerSource);
    // Keep failures in a child: the CLI helper exits when the compiler cannot
    // establish a program. Both host-runtime suites exercise their own binary.
    const driver = join(repo, "check.mjs");
    writeFileSync(driver, `import { runScopedTsc } from ${JSON.stringify(scopedTsc)};
const result = runScopedTsc(${JSON.stringify({ repo, tsc: compiler, config, owns: ["owned/"], label: "scoped-control" })});
console.log(JSON.stringify(result));`);
    return spawnSync(process.execPath, [driver], { encoding: "utf8", timeout: 20_000 });
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

/** @type {Array<[string, Record<string, unknown>, string]>} */
const invalidPrograms = [
  ["unknown compiler option", { invalidCompilerOption: true }, "TS5023"],
  ["invalid option value", { target: "not-a-target" }, "TS6046"],
  ["missing type package", { types: ["not-a-real-type-package"] }, "TS2688"],
  ["missing global types", { noLib: true }, "TS2318"],
];
for (const [name, options, diagnostic] of invalidPrograms) {
  test(`scoped typechecking refuses ${name} even with owned source files`, () => {
    const result = check(options);
    assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stderr, /scoped-control: tsc could not/);
    assert.ok(result.stderr.includes(diagnostic), result.stderr);
    assert.equal(result.stdout, "", "a rejected program must not return scoped findings");
  });
}

test("scoped typechecking distinguishes owned and imported source errors", () => {
  const result = check({ pretty: true }, {
    "owned/source.ts": 'import "../foreign/source.ts"; export const value: number = "owned";',
    "foreign/source.ts": 'export const value: number = "foreign";',
  });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.mine.length, 1);
  assert.match(report.mine[0], /^owned\/source\.ts\(1,\d+\): error TS2322:/);
  assert.equal(report.foreign, 1);
  assert.deepEqual(report.ownedFiles, ["owned/source.ts"]);
});

test("scoped typechecking accepts a clean program with owned files", () => {
  const result = check();
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.deepEqual(report.mine, []);
  assert.equal(report.foreign, 0);
  assert.deepEqual(report.ownedFiles, ["owned/source.ts"]);
});

test("scoped typechecking refuses a compiler crash without TS diagnostics", () => {
  const result = check({}, undefined, 'process.stderr.write("compiler crashed\\n"); process.exit(1);');
  assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /scoped-control: tsc could not/);
  assert.match(result.stderr, /compiler crashed/);
  assert.equal(result.stdout, "");
});
