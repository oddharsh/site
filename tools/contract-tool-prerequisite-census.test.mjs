import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// Run the real CLI in a small Git repository. Five scripts exercise the scanner
// floors; a deliberately absent tool keeps the presence tier independent of the
// host. None of the fixture shell scripts are executed.
async function fixture(run) {
  const root = await mkdtemp(path.join(tmpdir(), "tool-census-"));
  const put = async (file, source) => {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), source);
  };
  const git = (...args) => execFileSync("git", args, { cwd: root, stdio: "pipe" });
  const cli = () => spawnSync(process.execPath, [path.join(root, "tools/check-tools.ts")], {
    cwd: tmpdir(), encoding: "utf8", env: { ...process.env, CI: "1" }, timeout: 10_000,
  });
  try {
    await put("tools/check-tools.ts", await readFile(new URL("./check-tools.ts", import.meta.url), "utf8"));
    await put("config/tools.json", JSON.stringify({ tools: [{
      bin: "fixture", path: "absent-fixture", install: "brew install fixture",
      why: "fixture prerequisite", min_version: "1.0.0",
    }] }));
    await put("CLAUDE.md", "fixture");
    await put("docs/MAINTENANCE.md", "fixture");
    await put(".gitignore", "vendor/\n");
    for (let i = 0; i < 5; i++) await put(`tools/photos/guard-${i}.sh`,
      'FIXTURE_MIN=1.0.0\nfor cmd in fixture; do\n  command -v "$cmd" || exit 1\ndone\n# brew install fixture\n');
    git("init", "-q");
    git("add", ".");
    const baseline = cli();
    assert.equal(baseline.status, 0, baseline.stderr);
    await run({ root, put, git, cli });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

for (const file of ["tools/photos/build inputs/line\nbreak.sh", ".github/check.sh"]) {
  test(`prerequisite census follows Git ownership at ${JSON.stringify(file)}`, async () => {
    await fixture(async ({ put, git, cli }) => {
      await put(file, "command -v undeclared-tool || exit 1\n");
      await put("tools/photos/vendor/downloaded.sh", "command -v vendor-tool || exit 1\n");
      const untracked = cli();
      assert.equal(untracked.status, 0, untracked.stderr);

      git("add", "--", file);
      const tracked = cli();
      assert.equal(tracked.status, 1, tracked.stderr);
      assert.ok(tracked.stderr.includes(`${file}: probes \`undeclared-tool\``), tracked.stderr);
      assert.doesNotMatch(tracked.stderr, /vendor-tool/);

      // Node and Wrangler belong to the repository's existing runtime/package
      // pins, even when an owned shell entrypoint checks that they are present.
      await put(file, "command -v node || exit 1\ncommand -v wrangler || exit 1\n");
      const corrected = cli();
      assert.equal(corrected.status, 0, corrected.stderr);
      assert.match(corrected.stdout, /across 6 shell scripts/);
    });
  });
}

test("prerequisite census fails when Git cannot establish ownership", async () => {
  await fixture(async ({ root, cli }) => {
    await rm(path.join(root, ".git"), { recursive: true });
    const result = cli();
    assert.notEqual(result.status, 0, result.stdout);
    assert.match(result.stderr, /not a git repository/);
    assert.doesNotMatch(result.stdout, /declaration: every guarded binary/);
  });
});

test("prerequisite census fails on a missing tracked script", async () => {
  await fixture(async ({ root, put, git, cli }) => {
    const file = "tools/photos/nested/missing.sh";
    await put(file, "command -v fixture || exit 1\n");
    git("add", "--", file);
    await rm(path.join(root, file));
    const result = cli();
    assert.notEqual(result.status, 0, result.stdout);
    assert.match(result.stderr, /ENOENT/);
    assert.ok(result.stderr.includes(file), result.stderr);
  });
});
