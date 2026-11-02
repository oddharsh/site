// `bun run lint` is Bun's built-in linter since 2026-10-15, reached through a
// package.json script that is ALSO named lint. Bun lets a script shadow the
// built-in of the same name (every flag but --doctor runs the script), and it
// runs the built-in only when the script body itself says `bun lint`
// (gotcha 67). These tests hold that on the RUNNING bun, which in CI is the
// pin: a pin without the linter, or a script that stops saying `bun lint`,
// fails here rather than as a lint step that quietly ran something else. A Bun
// without the linter makes the script call itself, so check-bun-lint.ts runs
// first and stops it with one message; the last two tests hold that guard.
import { ROOT, assert, readFile, test } from "./contract-shared.ts";
import { bunLintProblem } from "../check-bun-lint.ts";

import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";

async function project(lintScript) {
  const dir = await mkdtemp(join(tmpdir(), "bun-lint-"));
  await writeFile(join(dir, "package.json"), JSON.stringify({ private: true, scripts: { lint: lintScript } }));
  await writeFile(join(dir, "pre.ts"), 'console.log("pre ran");\n');
  await writeFile(join(dir, "a.ts"), "debugger;\nexport const a = 1;\n");
  return dir;
}

// The script's own `bun` resolves through PATH, so put the running bun first.
// `bun run test:node` runs this file under node, where process.execPath is node
// and the bun to test is the one on PATH.
const bun = process.versions.bun ? process.execPath : "bun";
const lint = (cwd) =>
  spawnSync(bun, ["lint"], {
    cwd,
    encoding: "utf8",
    env: process.versions.bun ? { ...process.env, PATH: `${dirname(bun)}${delimiter}${process.env.PATH ?? ""}` } : process.env,
    timeout: 60_000,
  });

test("the repo's lint script checks for the linter, runs the generator, then Bun's own linter, type-aware", async () => {
  const pkg = JSON.parse(await readFile(new URL("package.json", ROOT), "utf8"));
  assert.equal(pkg.scripts.lint, "bun tools/check-bun-lint.ts && bun tools/gen-runtime-types.ts && bun lint --type-aware");
  for (const name of ["oxlint", "oxlint-tsgolint"]) {
    assert.equal(pkg.devDependencies?.[name], undefined, `${name} left with the move to bun lint; a second linter is a second set of findings`);
  }
});

test("a lint script whose body says `bun lint` reaches the built-in, after its prefix", async () => {
  const dir = await project("bun pre.ts && bun lint --type-aware");
  try {
    const out = lint(dir);
    const text = `${out.stdout}\n${out.stderr}`;
    assert.match(text, /pre ran/, "the prefix runs first");
    assert.match(text, /no-debugger/, `the built-in linter reported the planted debugger statement; got:\n${text.slice(0, 800)}`);
    assert.equal(out.status, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("CONTROL: a lint script that says anything else shadows the built-in", async () => {
  const dir = await project("echo shadowed");
  try {
    const out = lint(dir);
    assert.match(out.stdout, /shadowed/);
    assert.doesNotMatch(`${out.stdout}\n${out.stderr}`, /no-debugger/);
    assert.equal(out.status, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the guard finds the built-in linter on the running bun", () => {
  assert.equal(bunLintProblem(bun), null);
});

test("CONTROL: the guard names gotcha 67 and the installer for a bun without the linter", async () => {
  // A stand-in that answers the probe the way 1.4.3 and +6c1eb067e did on
  // 2026-10-17, so the guard is shown to fail without installing an old Bun.
  const dir = await mkdtemp(join(tmpdir(), "bun-no-lint-"));
  const fake = join(dir, "bun");
  try {
    await writeFile(
      fake,
      '#!/bin/sh\nif [ "$1" = "--revision" ]; then echo 1.4.3+26aa4e1a9; exit 0; fi\necho \'error: Script not found "lint"\' >&2\nexit 1\n',
    );
    await chmod(fake, 0o755);
    const problem = bunLintProblem(fake);
    assert.ok(problem, "a bun that cannot lint was reported as able to");
    assert.match(problem, /1\.4\.3\+26aa4e1a9/);
    assert.match(problem, /gotcha 67/);
    assert.match(problem, /Script not found "lint"/);
    assert.match(problem, /\.github\/install-bun\.sh/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
