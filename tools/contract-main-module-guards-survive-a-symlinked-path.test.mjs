// A CLI module decides whether it is the entry point. Comparing process.argv[1]
// against import.meta.url is the reflexive way to ask and it is wrong through a
// symlink: node canonicalises the entry module and leaves argv[1] alone, so the
// two sides disagree and the guard reads FALSE. The CLI then exits 0 having done
// nothing, which is the worst available failure for a generator.
//
// It cost two tests in contract-page-generator-ownership, red on main under
// `bun test:node` and green everywhere else, because macOS reaches $TMPDIR
// through the /var symlink and bun resolves both sides. CLAUDE.md gotcha 45.
//
// `import.meta.main` is the runtime answering the question directly, so it has
// no path arithmetic to get wrong. This pins every module onto it, and pins the
// divergence itself so a runtime that closes the gap is noticed rather than
// silently making the structural half look unnecessary.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));

// The two spellings of the broken comparison this repo actually carried, plus
// the string-concatenated `file://` one, which is separately wrong on any path
// holding a space or a `#` because it never percent-encodes.
const BROKEN = [
  /process\s*\.\s*argv\s*\[\s*1\s*\][\s\S]{0,120}?import\s*\.\s*meta\s*\.\s*url/,
  /import\s*\.\s*meta\s*\.\s*url[\s\S]{0,120}?process\s*\.\s*argv\s*\[\s*1\s*\]/,
];

test("no module decides it is the entry point by comparing argv[1] to import.meta.url", async () => {
  // git ls-files rather than a walk: the question is about files this repo
  // OWNS, and a walk would have to re-learn every ignore rule to answer it.
  const files = execFileSync("git", ["ls-files", "*.ts", "*.mjs", "*.js"], { cwd: ROOT, encoding: "utf8" })
    .split("\n").filter(Boolean)
    // Test files are exempt: this one quotes both broken spellings above, and
    // the fixture below writes one on purpose. A rule that failed on its own
    // explanation could only be fixed by deleting the explanation.
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
    // Explicit, so this reproduces on Linux CI too rather than riding macOS's
    // /var symlink. The trap is a property of symlinks, not of one platform.
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

    // The current runtime is guaranteed, and the file runs under BOTH suites,
    // so one CI run covers node and bun even if neither is on PATH by name.
    const runtimes = new Set([process.execPath, "node", "bun"]);
    let checked = 0;
    for (const runtime of runtimes) {
      const direct = read(runtime, ["real/mod.mjs"]);
      if (direct === null) continue;
      checked++;
      assert.equal(direct.metaMain, true, `${runtime}: a directly run module is the entry point`);

      const linked = read(runtime, ["link/mod.mjs"]);
      assert.equal(linked.metaMain, true, `${runtime}: a symlinked path is still the entry point`);

      // The negative control. A guard that is simply always true would pass
      // every assertion above and let an imported module run its CLI.
      const imported = read(runtime, ["importer.mjs"]);
      assert.equal(imported.metaMain, false, `${runtime}: an imported module is NOT the entry point`);
    }
    assert.ok(checked > 0, "no runtime was exercised, so this test asserted nothing");

    // THE CONTROL FOR THE RULE ITSELF, and the reason the structural half is not
    // decoration: node still disagrees with itself through a symlink. Should a
    // release close this, that is worth knowing rather than absorbing quietly,
    // because this assertion is the whole evidence for the rule above.
    const node = read("node", ["link/mod.mjs"]);
    if (node !== null) assert.equal(node.comparison, false, "node no longer splits argv[1] and import.meta.url");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
