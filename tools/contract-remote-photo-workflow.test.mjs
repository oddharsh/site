import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, writeFile, rm, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";

const workflow = await readFile(new URL("../.github/workflows/photo-pipeline.yml", import.meta.url), "utf8");

// Execute the actual workflow shell, with encoders/network commands replaced by
// deterministic producers. Every named block must exist; no missing-step pass.
function step(name) {
  const marker = `      - name: ${name}\n`;
  assert.equal(workflow.split(marker).length, 2, `one workflow step: ${name}`);
  const block = workflow.split(marker)[1].split("\n      - name:")[0];
  const run = block.match(/^        run: \|\n((?:          .*\n|\n)*)/m);
  assert.ok(run, `${name} has a literal shell block`);
  return run[1].replace(/^          /gm, "");
}

async function fixture(run) {
  const root = await mkdtemp(path.join(tmpdir(), "photo-workflow-"));
  const bin = path.join(root, "bin");
  const trace = path.join(root, "calls");
  await mkdir(bin);
  const put = async (file, body) => {
    const target = path.join(root, file);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, body);
  };
  const command = async (file, body) => {
    await put(file, `#!/bin/bash\nset -eu\n${body}\n`);
    await chmod(path.join(root, file), 0o755);
  };
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, RUNNER_TEMP: root,
    TRACE: trace, REMOTE_RENDER_ONLY: "1", GITHUB_RUN_ID: "fixture", GITHUB_REPOSITORY: "fixture/site" };
  const shell = (name, extra = {}) => spawnSync("bash", ["-e", "-o", "pipefail", "-c", step(name)],
    { cwd: root, env: { ...env, ...extra }, encoding: "utf8" });
  try { await run({ root, put, command, shell, trace }); }
  finally { await rm(root, { recursive: true, force: true }); }
}

for (const routine of ["reencode-thumbnails", "refresh-metadata"]) test(`remote ${routine} rebuilds metadata, packed histograms and search before verification`, async () => {
  await fixture(async ({ root, put, command, shell, trace }) => {
    await mkdir(path.join(root, "photo-source"));
    await command("tools/photos/reencode-thumbnails.sh", 'echo pixels >> "$TRACE"');
    await command("tools/photos/hash-thumbnails.sh", 'echo hashes >> "$TRACE"');
    await command("tools/photos/extract-photo-metadata.sh", 'test "$1" = --merge\ntest "$2" = "$RUNNER_TEMP/photo-source"\necho metadata-and-histograms >> "$TRACE"\ntouch rebuilt-metadata rebuilt-histograms');
    await command("bin/node", 'test "$1" = tools/photos/gen-photo-semantics.ts\ntest -e rebuilt-metadata\necho semantics >> "$TRACE"\ntouch rebuilt-semantics');
    await command("bin/bun", 'test "$*" = "run photos:check"\ntest -e rebuilt-histograms\ntest -e rebuilt-semantics\necho verified >> "$TRACE"');
    const result = shell("Run the selected photo routine", { ROUTINE: routine });
    assert.equal(result.status, 0, result.stderr);
    const expected = routine === "reencode-thumbnails" ? ["pixels", "hashes"] : [];
    assert.deepEqual((await readFile(trace, "utf8")).trim().split("\n"),
      [...expected, "metadata-and-histograms", "semantics", "verified"]);
    // A failed producer must prevent both verification and later publication.
    await put("calls", "");
    await command("tools/photos/extract-photo-metadata.sh", "exit 7");
    assert.equal(shell("Run the selected photo routine", { ROUTINE: routine }).status, 7);
    assert.doesNotMatch(await readFile(trace, "utf8"), /semantics|verified/);
  });
});

test("remote derivation recording vouches only for each routine's regenerated artifacts", async () => {
  await fixture(async ({ put, command, shell, trace }) => {
    await command("bin/bun", 'echo "$*" >> "$TRACE"');
    for (const [routine, ids] of /** @type {const} */ ([
      ["add-photo", ["hashes", "histograms", "alt", "semantics"]],
      ["reencode-thumbnails", ["hashes", "histograms", "semantics"]],
      ["refresh-metadata", ["histograms", "semantics"]],
      ["add-car-photo", []], ["regenerate-encoding-study", []],
    ])) {
      await put("calls", "");
      assert.equal(shell("Record regenerated photo derivations", { ROUTINE: routine }).status, 0);
      assert.equal(await readFile(trace, "utf8"), ids.map((id) => `run derive:check -- --lock --only images/${id}\n`).join(""));
    }
    await command("bin/bun", "exit 9");
    assert.equal(shell("Record regenerated photo derivations", { ROUTINE: "add-photo" }).status, 9);
  });
});

const artifacts = {
  "add-photo": ["public/i/tile.jpg", "public/images/histograms.json", "src/worker/photo-index.json", "config/derivations.json", "config/derivations.lock.json"],
  "reencode-thumbnails": ["public/i/tile.jpg", "public/images/histograms.json", "config/derivations.json", "config/derivations.lock.json"],
  "refresh-metadata": ["public/images/metadata.json", "config/derivations.json", "config/derivations.lock.json"],
  "add-car-photo": ["public/cars/singer.jpg"],
  "regenerate-encoding-study": ["public/garage/enc/c-png.png"],
};

for (const [routine, paths] of Object.entries(artifacts)) test(`remote ${routine} publishes all its artifacts and refuses unaccounted output`, async () => {
  // Local Git is real; push and PR creation are replaced at the executable boundary.
  const git = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  await fixture(async ({ root, put, command, shell, trace }) => {
    execFileSync(git, ["init", "-q"], { cwd: root });
    await put(".gitignore", "bin/\ncalls\n");
    await put("unrelated.txt", "baseline");
    execFileSync(git, ["add", "."], { cwd: root });
    execFileSync(git, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.com", "commit", "-qm", "base"], { cwd: root });
    await command("bin/git", `if [ "$1" = push ]; then echo push >> "$TRACE"; else exec "${git}" "$@"; fi`);
    await command("bin/gh", 'echo pr >> "$TRACE"');
    for (const file of paths) await put(file, "artifact");
    const result = shell("Open artifact pull request", { ROUTINE: routine });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(await readFile(trace, "utf8"), "push\npr\n");
    assert.deepEqual(execFileSync(git, ["diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD"], { cwd: root, encoding: "utf8" }).trim().split("\n").sort(), paths.toSorted());
    for (const stray of ["unrelated.txt", "new-unexpected.txt"]) {
      await put("calls", "");
      await put(stray, "unaccounted output");
      const rejected = shell("Open artifact pull request", { ROUTINE: routine, GITHUB_RUN_ID: stray });
      assert.equal(rejected.status, 1, rejected.stderr);
      assert.match(rejected.stderr, /outside this routine's artifact paths/);
      assert.equal(await readFile(trace, "utf8"), "");
      execFileSync(git, ["add", stray], { cwd: root });
      execFileSync(git, ["commit", "-qm", "fixture reset"], { cwd: root });
    }
  });
});

test("re-encoding refuses partial tiers and empty selections before downstream hashing", async () => {
  const source = await readFile(new URL("./photos/reencode-thumbnails.sh", import.meta.url), "utf8");
  await fixture(async ({ root, put, command }) => {
    await put("tools/photos/reencode-thumbnails.sh", source);
    await put("tools/photos/require-exif-sooc.sh", await readFile(new URL("./photos/require-exif-sooc.sh", import.meta.url), "utf8"));
    await put("public/i/frame.12345678.jpg", "published fixture");
    await put("source/frame.jpg", "source fixture");
    await mkdir(path.join(root, "public/images"), { recursive: true });
    await command("bin/exif-sooc", 'if [ "$1" = --version ]; then echo "exif-sooc 0.2.0"; else echo 1; fi');
    await command("bin/sips", 'echo "space: RGB"');
    await command("tools/photos/zenc/target/release/zenc", `
if [ "$1" = square ]; then
  [ "\${FAIL_AT:-}" != square ] || exit 6
  while [ "$#" -gt 0 ]; do
    if [ "$1" = --out ]; then shift; touch "$1"; fi
    shift
  done
else
  [ "\${FAIL_AT:-}" != jpeg ] || exit 6
  touch "$2"
fi`);
    // The selected binary is inside this fixture, so no host encoder can run.
    await command("tools/photos/libavif/build/avifenc", `
for out in "$@"; do :; done
case "$out" in
  *-400.avif) tier=sm;; *-200.avif) tier=xs;; *) tier=sq;;
esac
[ "\${FAIL_AT:-}" != "$tier" ] || exit 6
touch "$out"`);
    for (const failure of ["", "square", "jpeg", "sq", "sm", "xs"]) {
      const result = spawnSync("bash", ["tools/photos/reencode-thumbnails.sh", "source"], {
        cwd: root, encoding: "utf8", env: { ...process.env, PATH: `${root}/bin:${process.env.PATH}`, FAIL_AT: failure },
      });
      assert.equal(result.status, failure ? 1 : 0, `${failure || "complete"}: ${result.stderr}`);
      if (failure) assert.match(result.stderr, /do not hash or publish/);
    }
    await rm(path.join(root, "source/frame.jpg"));
    const empty = spawnSync("bash", ["tools/photos/reencode-thumbnails.sh", "source"], {
      cwd: root, encoding: "utf8", env: { ...process.env, PATH: `${root}/bin:${process.env.PATH}` },
    });
    assert.equal(empty.status, 1, empty.stderr);
    assert.match(empty.stderr, /do not hash or publish/);
  });
});

test("the cold runner installs the JSON CLI its downloader requires", async () => {
  await fixture(async ({ root, command, shell }) => {
    await command("bin/brew", 'test "$1" = install\nshift\nfor formula in "$@"; do touch "$RUNNER_TEMP/bin/$formula"; chmod +x "$RUNNER_TEMP/bin/$formula"; done');
    await command("bin/cargo", 'test "$1" = install');
    await command("bin/python", 'test "$1" = -m\ntest "$2" = venv\nmkdir -p "$3/bin"');
    const result = shell("Install image toolchain", { GITHUB_PATH: `${root}/runner-path` });
    assert.equal(result.status, 0, result.stderr);
    const installed = spawnSync("bash", ["-c", 'test -x "$RUNNER_TEMP/bin/jaq"'], { env: { ...process.env, RUNNER_TEMP: root } });
    assert.equal(installed.status, 0, "the downloader calls jaq on a fresh runner");
  });
});

test("photo scripts resolve encoder executables from the active installation", async () => {
  await fixture(async ({ root, command }) => {
    await command("bin/brew", 'test "$*" = "--prefix mozjpeg"\necho "$RUNNER_TEMP/alternate brew/mozjpeg"');
    await command("bin/avifenc", "exit 0");
    for (const [file, variable, expected] of [
      ["add-photos.sh", "MOZJPEG_DIR", `${root}/alternate brew/mozjpeg/bin`],
      ["gen-encoding-grids.sh", "MOZ_CJPEG", `${root}/alternate brew/mozjpeg/bin/cjpeg`],
      ["add-car-photo.sh", "AVIFENC", `${root}/bin/avifenc`],
    ]) {
      const source = await readFile(new URL(`./photos/${file}`, import.meta.url), "utf8");
      const assignment = source.split("\n").find((line) => line.startsWith(`${variable}=`));
      assert.ok(assignment);
      const result = spawnSync("bash", ["-eu", "-c", `${assignment}\nprintf '%s' "$${variable}"`], {
        env: { ...process.env, PATH: `${root}/bin:${process.env.PATH}`, RUNNER_TEMP: root }, encoding: "utf8",
      });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, expected);
    }
  });
});
