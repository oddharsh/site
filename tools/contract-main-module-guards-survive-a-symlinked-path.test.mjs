// A CLI module decides whether it is the entry point. Comparing process.argv[1]
// against import.meta.url is the reflexive way to ask and it is wrong through a
// symlink: node canonicalises the entry module and leaves argv[1] alone, so the
// two sides disagree and the guard reads FALSE. The CLI then exits 0 having done
// nothing, which is the worst available failure for a generator.
//
// It cost two tests in contract-page-generator-ownership, red on main under
// `bun test:node` and green everywhere else, because macOS reaches $TMPDIR
// through the /var symlink and bun resolves both sides. docs/GOTCHAS.md gotcha 45.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));

const BROKEN = [
  /process\s*\.\s*argv\s*\[\s*1\s*\][\s\S]{0,120}?import\s*\.\s*meta\s*\.\s*url/,
  /import\s*\.\s*meta\s*\.\s*url[\s\S]{0,120}?process\s*\.\s*argv\s*\[\s*1\s*\]/,
];

test("no module decides it is the entry point by comparing argv[1] to import.meta.url", async () => {
  const files = execFileSync("git", ["ls-files", "*.ts", "*.mjs", "*.js"], { cwd: ROOT, encoding: "utf8" })
    .split("\n").filter(Boolean)
    .filter((f) => !f.includes(".test."));
  assert.ok(files.length > 200, `the census collapsed to ${files.length} files`);

  const offenders = [];
  for (const file of files) {
    const source = await readFile(path.join(ROOT, file), "utf8");
    if (!source.includes("argv")) continue;
    if (BROKEN.some((re) => re.test(source))) offenders.push(file);
  }
  assert.deepEqual(offenders, [], "use `import.meta.main`, which cannot disagree with itself");
});

test("a module run through a symlinked path still knows it is the entry point", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "main-module-guard-"));
  try {
    await mkdir(path.join(dir, "real"));
    await symlink("real", path.join(dir, "link"));
    await writeFile(path.join(dir, "real/mod.mjs"), `import { pathToFileURL } from "node:url";
const argv1 = process.argv[1];
console.log(JSON.stringify({
  metaMain: import.meta.main === true,
  comparison: Boolean(argv1) && import.meta.url === pathToFileURL(argv1).href,
}));
`);
    await writeFile(path.join(dir, "importer.mjs"), 'await import("./real/mod.mjs");\n');

    const read = (runtime, args) => {
      const out = spawnSync(runtime, args, { cwd: dir, encoding: "utf8", timeout: 20_000 });
      // A runtime that is not on PATH arrives as an errno on `error` rather
      // than a status. The cast is real here: JSDoc types are live in a .mjs
      // file and inert in a .ts one (gotcha 42).
      const failure = /** @type {{ code?: string } | undefined} */ (out.error);
      if (failure?.code === "ENOENT") return null;
      assert.equal(out.status, 0, `${runtime}: ${out.stderr}`);
      return JSON.parse(out.stdout);
    };

    const runtimes = new Set([process.execPath, "node", "bun"]);
    let checked = 0;
    for (const runtime of runtimes) {
      const direct = read(runtime, ["real/mod.mjs"]);
      if (direct === null) continue;
      checked++;
      assert.equal(direct.metaMain, true, `${runtime}: a directly run module is the entry point`);

      const linked = read(runtime, ["link/mod.mjs"]);
      assert.equal(linked.metaMain, true, `${runtime}: a symlinked path is still the entry point`);

      const imported = read(runtime, ["importer.mjs"]);
      assert.equal(imported.metaMain, false, `${runtime}: an imported module is NOT the entry point`);
    }
    assert.ok(checked > 0, "no runtime was exercised, so this test asserted nothing");

    const node = read("node", ["link/mod.mjs"]);
    if (node !== null) assert.equal(node.comparison, false, "node no longer splits argv[1] and import.meta.url");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
