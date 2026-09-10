import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";
import { assert, test } from "./contract-shared.ts";
import { ratchet } from "./lib/tsc-scope.ts";

const tsc = fileURLToPath(new URL("../node_modules/typescript/bin/tsc", import.meta.url));
const scopedTsc = new URL("./lib/tsc-scope.ts", import.meta.url).href;

/**
 * @param {Record<string, unknown>} compilerOptions
 * @param {Record<string, string>} sources
 * @param {string | null} compilerSource
 * @param {Record<string, unknown>} [baseline]
 */
function check(compilerOptions = {}, sources = { "owned/source.ts": "export const value = 1;" }, compilerSource = null, baseline) {
  // CANONICAL root. tsc reports diagnostics under the resolved path, so a
  // fixture rooted at a symlink scopes `owns` against an unresolved one, every
  // owned file reads as clean, and the check passes over the errors it exists
  // to catch. Fails on macOS alone, where $TMPDIR reaches /private/var through
  // /var. Linux CI cannot see it.
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "scoped-typecheck-")));
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
    const baselinePath = join(repo, "baseline.json");
    if (baseline !== undefined) writeFileSync(baselinePath, JSON.stringify(baseline));
    writeFileSync(driver, `import { runScopedTsc, ratchet } from ${JSON.stringify(scopedTsc)};
const result = runScopedTsc(${JSON.stringify({ repo, tsc: compiler, config, owns: ["owned/"], label: "scoped-control" })});
${baseline === undefined ? "" : `const gate = ratchet({ baselinePath: ${JSON.stringify(baselinePath)}, byFile: result.byFile, updateCommand: "record baseline" });
if (gate.problems.length) { console.error(gate.problems.join("\\n")); process.exit(1); }`}
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

test("type baselines cannot hide real compiler errors behind coerced counts", () => {
  const source = { "owned/source.ts": 'export const one: number = "wrong"; export const two: string = 2;' };
  const accepted = check({}, source, null, { files: { "owned/source.ts": 2 } });
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.equal(JSON.parse(accepted.stdout).mine.length, 2, "the real compiler supplies both errors");
  for (const count of ["not-a-count", "2", {}, [2]]) {
    const rejected = check({}, source, null, { files: { "owned/source.ts": count } });
    assert.equal(rejected.status, 1, `malformed baseline ${JSON.stringify(count)} accepted: ${rejected.stdout}`);
    assert.match(rejected.stderr, /owned\/source\.ts: baseline count must be a positive integer/);
  }
});

test("type baselines record only per-file counts and preserve every ratchet direction", () => {
  const repo = mkdtempSync(join(tmpdir(), "type-baseline-"));
  const baselinePath = join(repo, "baseline.json");
  try {
    const byFile = new Map([["b.ts", 1], ["a.ts", 2]]);
    const run = (update = false) => ratchet({ baselinePath, byFile, updateCommand: "record baseline", update });
    // Deliberately stale legacy total: the updater must discard it. It must
    // also be able to create its output from the compiler census alone.
    writeFileSync(baselinePath, JSON.stringify({ files: { "a.ts": 2, "b.ts": 1 }, total: 999 }));
    assert.deepEqual(run(), { rewritten: false, problems: [] });
    assert.deepEqual(run(true), { rewritten: true, problems: [] });
    const expected = '{\n  "files": {\n    "a.ts": 2,\n    "b.ts": 1\n  }\n}\n';
    assert.equal(readFileSync(baselinePath, "utf8"), expected);
    rmSync(baselinePath);
    run(true);
    assert.equal(readFileSync(baselinePath, "utf8"), expected);

    for (const count of [0, -1, 1.5, null, true, Number.MAX_SAFE_INTEGER + 1]) {
      writeFileSync(baselinePath, JSON.stringify({ files: { "a.ts": count, "b.ts": 1 } }));
      assert.match(run().problems.join("\n"), /a\.ts: baseline count must be a positive integer/);
    }
    writeFileSync(baselinePath, expected);

    byFile.set("a.ts", 3);
    assert.match(run().problems.join("\n"), /a\.ts: 3 error\(s\), up from 2/);
    byFile.set("a.ts", 1);
    assert.match(run().problems.join("\n"), /a\.ts: 1 error\(s\), DOWN from 2/);
    byFile.delete("a.ts");
    assert.match(run().problems.join("\n"), /a\.ts: now clean/);
    byFile.set("new.ts", 1);
    assert.match(run().problems.join("\n"), /new\.ts: 1 error\(s\), and this file is not in the baseline/);
    assert.equal(readFileSync(baselinePath, "utf8"), expected, "checks never rewrite the baseline");
    byFile.clear();
    run(true);
    assert.deepEqual(run(), { rewritten: false, problems: [] }, "a recorded clean program passes");
    assert.deepEqual(JSON.parse(readFileSync(baselinePath, "utf8")), { files: {} });
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

test("coverage rejects a failed compiler census even when it prints all owned files", () => {
  // Canonical for the reason above: the census asserts on paths tsc printed.
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "coverage-typecheck-")));
  try {
    for (const dir of ["tools", "src", "config"]) mkdirSync(join(repo, dir));
    symlinkSync(fileURLToPath(new URL("../node_modules", import.meta.url)), join(repo, "node_modules"), "dir");
    copyFileSync(new URL("./check-ts-coverage.ts", import.meta.url), join(repo, "tools/check-ts-coverage.ts"));
    // Satisfy the real census floors without altering the checker. Source
    // diagnostics and unavailable imports are deliberately outside its job.
    for (let i = 0; i < 150; i++) writeFileSync(join(repo, "src", `fixture${i}.ts`), "export {};\n");
    writeFileSync(join(repo, "src/fixture0.ts"), 'import "./unavailable.ts"; export const value: number = "wrong";\n');
    const config = { compilerOptions: { noEmit: true, types: [] }, include: ["../src/**/*.ts", "../tools/**/*.ts"] };
    for (let i = 0; i < 5; i++) writeFileSync(join(repo, "config", `tsconfig.fixture${i}.json`), JSON.stringify(config));
    execFileSync("git", ["init", "-q", repo], { stdio: "pipe" });
    execFileSync("git", ["add", "src", "tools", "config"], { cwd: repo, stdio: "pipe" });
    const run = () => spawnSync(process.execPath, ["tools/check-ts-coverage.ts"],
      { cwd: repo, encoding: "utf8", timeout: 20_000 });
    const healthy = run();
    assert.equal(healthy.status, 0, healthy.stderr);
    assert.match(healthy.stdout, /151 source files, all held by one of 5 programs/);

    const broken = "config/tsconfig.fixture0.json";
    writeFileSync(join(repo, broken), JSON.stringify({ ...config,
      compilerOptions: { ...config.compilerOptions, invalidCompilerOption: true } }));
    const compiler = spawnSync(process.execPath, [tsc, "-p", broken, "--listFilesOnly"],
      { cwd: repo, encoding: "utf8", timeout: 20_000 });
    assert.ok(compiler.status !== null && compiler.status > 0, compiler.stderr);
    assert.match(compiler.stdout, /TS5023/);
    assert.ok(compiler.stdout.includes(join(repo, "src/fixture149.ts")), "the failed compiler still emitted owned paths");
    const failed = run();
    assert.equal(failed.status, 1, `${failed.stdout}\n${failed.stderr}`);
    assert.match(failed.stderr, /TS5023/);
    assert.doesNotMatch(failed.stdout, /all held/);

    writeFileSync(join(repo, broken), JSON.stringify(config));
    writeFileSync(join(repo, "orphan.ts"), "export {};\n");
    execFileSync("git", ["add", "orphan.ts"], { cwd: repo, stdio: "pipe" });
    const orphan = run();
    assert.equal(orphan.status, 1, orphan.stderr);
    assert.match(orphan.stderr, /orphan\.ts/);
    assert.match(orphan.stderr, /belong to no tsc program/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
