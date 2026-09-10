import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, realpath, writeFile, chmod, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { photoInputs } from "./photos/photo-inputs.ts";

const REPO = fileURLToPath(new URL("../", import.meta.url));

// Real shell entrypoints, deterministic encoder stubs, no network or private
// originals. Copy the shell corpus so sourced helpers run unchanged too.
async function fixture(run) {
  // CANONICAL root. The selector resolves directory aliases on purpose, so a
  // fixture rooted at a symlink compares its resolved paths against unresolved
  // expectations and fails on macOS alone, where $TMPDIR reaches /private/var
  // through /var. Linux CI cannot see it.
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "photo-metadata-")));
  const put = async (file, text) => {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), text);
  };
  const command = async (file, body) => {
    await put(file, `#!/bin/bash\nset -eu\n${body}\n`);
    await chmod(path.join(root, file), 0o755);
  };
  const read = (file) => readFile(path.join(root, file), "utf8");
  const shell = (file, args = [], env = {}) => spawnSync("/bin/bash", [path.join(root, "tools/photos", file), ...args], {
    cwd: root, encoding: "utf8", timeout: 10_000,
    env: { ...process.env, PATH: `${root}/bin:/usr/bin:/bin`, FIXTURE_ROOT: root,
      TRACE: `${root}/trace`, JOBS: "1", REMOTE_RENDER_ONLY: "1", ...env },
  });
  try {
    // Take the corpus from git rather than from a directory listing, which is
    // the census check-tools.ts itself takes. A listing of tools/photos alone
    // misses the nested AVIF builder, so a declaration naming it reads as a
    // stale path, and it would copy an ignored download that no check sees.
    // photo-inputs.ts is named outright because the shells call it: it is a
    // dependency of the corpus rather than a member of it.
    const corpus = ["tools/photos/*.sh", "tools/photos/photo-inputs.ts"];
    for (const rel of execFileSync("git", ["ls-files", "-z", ...corpus], { cwd: REPO, encoding: "utf8" }).split("\0").filter(Boolean)) {
      await put(rel, await readFile(path.join(REPO, rel), "utf8"));
    }
    await put("trace", "");
    await put("source/frame.jpg", "source fixture");
    await utimes(path.join(root, "source/frame.jpg"), 100, 100);
    await put("public/i/frame.12345678.jpg", "published tile");
    await put("public/images/.keep", "");
    await put("public/garage/enc/c-png.png", "published color fixture");
    await put("exports/frame.jpg", "previous export");
    await command("bin/exif-sooc", `
case "$1" in
  --version) echo version >> "$TRACE"; printf '%s\\n' "\${SOOC_VERSION:-exif-sooc 0.2.0}"; exit "\${SOOC_STATUS:-0}" ;;
  -s) echo "orientation $*" >> "$TRACE"; echo 1 ;;
  *) echo "metadata $*" >> "$TRACE"
     [ "\${FAIL_METADATA:-0}" != 1 ] || { echo "metadata write failed" >&2; exit 7; }
     case "$*" in *r800.jpg*) [ "\${FAIL_METADATA:-0}" != resolution ] || exit 7 ;; esac ;;
esac`);
    await command("bin/sips", `
if [ "$1" = -g ]; then
  printf 'space: RGB\\npixelWidth: 400\\npixelHeight: 266\\n'
else
  echo sips >> "$TRACE"
  for last in "$@"; do :; done
  printf encoded > "$last"
fi`);
    await command("tools/photos/zenc/target/release/zenc", `
echo zenc >> "$TRACE"
case "$1" in
  square|resize)
    while [ "$#" -gt 0 ]; do
      case "$1" in --out|--jpeg-out) shift; printf encoded > "$1" ;; esac
      shift
    done ;;
  *) printf encoded > "$2" ;;
esac`);
    for (const bin of ["avifenc", "cwebp"]) await command(`bin/${bin}`, `
echo ${bin} >> "$TRACE"
for last in "$@"; do :; done
case "$last" in
  *-400.avif) tier=sm ;; *-200.avif) tier=xs ;; *.avif) tier=sq ;; *) tier=other ;;
esac
[ "\${FAIL_TIER:-}" != "$tier" ] || exit 8
[ "\${OMIT_TIER:-}" != "$tier" ] || exit 0
[ "\${EMPTY_TIER:-}" != "$tier" ] || { : > "$last"; exit 0; }
printf encoded > "$last"`);
    await command("bin/brew", 'printf "%s/mozjpeg\\n" "$FIXTURE_ROOT"');
    await command("mozjpeg/bin/cjpeg", 'echo cjpeg >> "$TRACE"; printf encoded');
    await command("mozjpeg/bin/jpegtran", 'echo jpegtran >> "$TRACE"; exit 1');
    await command("bin/ffmpeg", 'for last in "$@"; do :; done; printf encoded > "$last"');
    await command("bin/ssimulacra2", "echo 95");
    await command("bin/butteraugli_main", "echo 0.5");
    // BSD stat is used by these macOS scripts; keep the control portable in CI.
    await command("bin/stat", 'test "$1" = -f%z; test -f "$2"; echo 7');
    await command("bin/cargo", 'echo cargo >> "$TRACE"');
    await command("bin/node", `exec "${process.execPath}" "$@"`);
    await command("node_modules/.bin/wrangler", 'echo forbidden-upload >> "$TRACE"; exit 99');
    // Stop the successful ingest control at the next phase, before unrelated
    // index/caption work; failed phase 1 must never reach this sentinel.
    await command("tools/photos/hash-thumbnails.sh", 'echo downstream-hash >> "$TRACE"; exit 23');
    await run({ root, put, read, shell, command });
  } finally { await rm(root, { recursive: true, force: true }); }
}

const cases = [
  { file: "gen-encoding-samples.sh", args: [], status: 0 },
  { file: "gen-encoding-grids.sh", args: [], status: 0 },
  { file: "reencode-thumbnails.sh", args: ["source"], status: 0 },
  { file: "add-photos.sh", args: ["source/frame.jpg"], status: 23 },
  { file: "export-for-instagram.sh", args: ["--max", "--out", "exports", "source/frame.jpg"], status: 0 },
  { file: "export-for-instagram.sh", args: ["--max", "--keep-exif", "--out", "exports", "source/frame.jpg"], status: 0 },
];

for (const { file, args, status } of cases) {
  test(`${file} ${args.includes("--keep-exif") ? "copy" : "strip"} refuses unsafe metadata work`, async () => {
    await fixture(async ({ put, read, shell }) => {
      const refused = shell(file, args, { SOOC_VERSION: "exif-sooc 0.1.0" });
      assert.equal(refused.status, 1, refused.stderr);
      assert.match(refused.stderr, /older than 0\.2\.0/);
      assert.doesNotMatch(await read("trace"), /sips|zenc|metadata|downstream|upload/);
      assert.equal(await read("public/garage/enc/c-png.png"), "published color fixture");

      await put("trace", "");
      const broken = shell(file, args, { FAIL_METADATA: "1" });
      assert.equal(broken.status, file === "add-photos.sh" || file === "reencode-thumbnails.sh" ? 1 : 7, broken.stderr + broken.stdout);
      assert.match(await read("trace"), /metadata/);
      assert.doesNotMatch(await read("trace"), /downstream|upload/);
      assert.doesNotMatch(broken.stdout, /done —|next: re-run hash/);
      if (file === "export-for-instagram.sh") assert.equal(await read("exports/frame.jpg"), "previous export");

      await put("trace", "");
      const good = shell(file, args);
      assert.equal(good.status, status, good.stderr + good.stdout);
      assert.match(await read("trace"), /metadata/);
      if (file === "add-photos.sh") assert.match(await read("trace"), /downstream-hash/);
      if (file === "export-for-instagram.sh") assert.equal(await read("exports/frame.jpg"), "encoded");
    });
  });
}

test("encoding sample measurements stop when temporary JPEG metadata editing fails", async () => {
  await fixture(async ({ shell }) => {
    const result = shell("gen-encoding-samples.sh", [], { FAIL_METADATA: "resolution" });
    assert.equal(result.status, 7, result.stderr + result.stdout);
    assert.doesNotMatch(result.stdout, /800x533|1200x800|done —/);
  });
});

test("ingest stops before later phases when any thumbnail tier fails", async () => {
  for (const failure of [
    { FAIL_TIER: "sq" }, { FAIL_TIER: "sm" }, { FAIL_TIER: "xs" },
    { OMIT_TIER: "xs" }, { EMPTY_TIER: "sm" },
  ]) await fixture(async ({ read, shell }) => {
    const result = shell("add-photos.sh", ["source/frame.jpg"], failure);
    assert.equal(result.status, 1, result.stderr + result.stdout);
    assert.match(result.stderr, /phase 1 incomplete/);
    assert.doesNotMatch(result.stdout, /phase 2|phase 3|phase 4/);
    assert.doesNotMatch(await read("trace"), /downstream|upload/);
  });
});

test("ingest preserves previous tiers on failure and rebuilds an incomplete cached set", async () => {
  await fixture(async ({ root, put, read, shell }) => {
    const files = ["frame.jpg", "frame.avif", "frame-400.avif", "frame-200.avif"].map((f) => `public/images/${f}`);
    for (const file of files) {
      await put(file, "previous tier");
      await utimes(path.join(root, file), 1, 1);
    }
    for (const failure of [{ FAIL_METADATA: "1" }, { FAIL_TIER: "xs" }]) {
      const result = shell("add-photos.sh", ["source/frame.jpg"], failure);
      assert.equal(result.status, 1, result.stderr);
      for (const file of files) assert.equal(await read(file), "previous tier");
    }
    assert.equal(shell("add-photos.sh", ["source/frame.jpg"]).status, 23);
    for (const file of files) assert.equal(await read(file), "encoded");
    // A complete current set skips encoding; a missing or empty smallest tier
    // must invalidate it even though the JPEG remains newer than the source.
    await put("trace", "");
    assert.equal(shell("add-photos.sh", ["source/frame.jpg"]).status, 23);
    assert.doesNotMatch(await read("trace"), /zenc|metadata|avifenc/);
    for (const empty of [false, true]) {
      if (empty) await put(files[3], "");
      else await rm(path.join(root, files[3]));
      const result = shell("add-photos.sh", ["source/frame.jpg"]);
      assert.equal(result.status, 23, result.stderr);
      assert.equal(await read(files[3]), "encoded");
    }
  });
});

test("the shared EXIF guard requires a successful, exact version report", async () => {
  await fixture(async ({ shell }) => {
    for (const version of ["exif-sooc 0.2.0", "exif-sooc 0.10.0", "exif-sooc 1.0.0"]) {
      const result = shell("require-exif-sooc.sh", [], { SOOC_VERSION: version });
      assert.equal(result.status, 0, result.stderr);
    }
    for (const [version, status] of [
      ["exif-sooc 0.1.9", "0"], ["exif-sooc 0.2.0", "9"],
      ["exif-sooc 1..0", "0"], ["exif-sooc 2", "0"], ["exif-sooc 2.0.0.0", "0"],
      ["unknown 2.0.0", "0"], ["exif-sooc 2.0.0\nwarning", "0"], ["garbled", "0"],
    ]) {
      const result = shell("require-exif-sooc.sh", [], { SOOC_VERSION: version, SOOC_STATUS: status });
      assert.equal(result.status, 1, `${version} / ${status}: ${result.stderr}`);
      assert.match(result.stderr, /refusing metadata writes/);
    }
  });
});

test("tools:check still refuses missing or contradictory minimum-version guards", async () => {
  await fixture(async ({ root, put, read }) => {
    const declaration = JSON.parse(await readFile(new URL("../config/tools.json", import.meta.url), "utf8"));
    for (const tool of declaration.tools) tool.path = `absent/${tool.bin}`;
    await put("config/tools.json", JSON.stringify(declaration));
    await put("CLAUDE.md", declaration.tools.map((t) => t.bin).join("\n"));
    await put("docs/MAINTENANCE.md", "fixture");
    await put("tools/check-tools.ts", await readFile(new URL("./check-tools.ts", import.meta.url), "utf8"));
    execFileSync("git", ["init", "-q"], { cwd: root, stdio: "pipe" });
    execFileSync("git", ["add", "."], { cwd: root, stdio: "pipe" });
    const cli = () => spawnSync(process.execPath, [path.join(root, "tools/check-tools.ts")], {
      cwd: root, encoding: "utf8", env: { ...process.env, CI: "1" }, timeout: 10_000,
    });
    const good = cli();
    assert.equal(good.status, 0, good.stderr);
    const file = "tools/photos/require-exif-sooc.sh";
    const guard = await read(file);
    await put(file, guard.replace("EXIF_SOOC_MIN=0.2.0", "EXIF_SOOC_MIN=0.1.0"));
    const mismatch = cli();
    assert.equal(mismatch.status, 1, mismatch.stderr);
    assert.match(mismatch.stderr, /floors exif-sooc at 0\.1\.0 while config\/tools.json declares 0\.2\.0/);
    await put(file, guard.replace("EXIF_SOOC_MIN=0.2.0", ""));
    const missing = cli();
    assert.equal(missing.status, 1, missing.stderr);
    assert.match(missing.stderr, /minimum-version scanner matched 0 guards/);
    assert.match(missing.stderr, /no script enforces it/);
  });
});

async function uploadFixture(run) {
  await fixture(async (f) => {
    await f.put("uploads", "");
    await f.put("progressive-paths", "");
    await f.command("mozjpeg/bin/jpegtran", `
while [ "$1" != -outfile ]; do shift; done
shift; out="$1"; src="$2"
printf '%s\\t%s\\n' "$src" "$out" >> "$FIXTURE_ROOT/progressive-paths"
printf progressive > "$out"
[ "\${COPY_FAIL:-0}" != 1 ] || exit 7`);
    await f.put("upload.mjs", `
import { appendFileSync, existsSync, readFileSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
const key = args[3];
const file = args.find(a => a.startsWith('--file=')).slice(7);
if (args.slice(0,3).join(' ') !== 'r2 object put' || !args.includes('--content-type=image/jpeg') || !args.includes('--remote')) process.exit(98);
const root = process.env.FIXTURE_ROOT;
const log = value => appendFileSync(root + '/uploads', JSON.stringify(value) + '\\n');
const progressive = readFileSync(root + '/progressive-paths', 'utf8').split('\\n').map(line => line.split('\\t')).find(([src]) => src === file)?.[1];
log({ event: 'start', key, body: readFileSync(file,'utf8'), discardedCopyStillExists: !!progressive && existsSync(progressive) });
if (process.env.UPLOAD_BARRIER) {
  mkdirSync(root + '/started', { recursive: true });
  writeFileSync(root + '/started/' + process.pid, '');
  const until = Date.now() + 4000;
  while (readdirSync(root + '/started').length < 4 && Date.now() < until) await new Promise(r => setTimeout(r, 10));
  if (readdirSync(root + '/started').length < 4) process.exit(97);
  await new Promise(r => setTimeout(r, 40));
}
const failed = process.env.FAIL_UPLOAD === key || process.env.FAIL_UPLOAD === 'all';
log({ event: 'end', key, failed });
process.exit(failed ? 9 : 0);
`);
    await f.command("node_modules/.bin/wrangler", `exec "${process.execPath}" "$FIXTURE_ROOT/upload.mjs" "$@"`);
    const uploads = async () => (await f.read("uploads")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
    const ingest = (args = ["source"], env = {}) => f.shell("add-photos.sh", args, { REMOTE_RENDER_ONLY: "0", ...env });
    await run({ ...f, ingest, uploads });
  });
}

test("failed source or HEIF-companion uploads stop before hashing and index writes", async () => {
  await uploadFixture(async ({ put, read, ingest, uploads }) => {
    await put("source/companion.HIF", "HEIF original");
    await put("src/worker/photo-index.json", '{"existing":{"full":"existing.jpg"}}');
    for (const key of ["aadhar-photos/frame.jpg", "aadhar-photos/companion.jpg"]) {
      await put("trace", ""); await put("uploads", "");
      const failed = ingest(["source"], { FAIL_UPLOAD: key });
      assert.equal(failed.status, 1, failed.stderr + failed.stdout);
      assert.match(failed.stderr, /phase 3 incomplete/);
      assert.match(failed.stderr, new RegExp(key.replaceAll(".", "\\.")));
      assert.doesNotMatch(failed.stdout, /phase 4/);
      assert.doesNotMatch(await read("trace"), /downstream-hash/);
      assert.equal(await read("src/worker/photo-index.json"), '{"existing":{"full":"existing.jpg"}}');
      assert.ok((await uploads()).some(row => row.key === key && row.failed));
    }
    await put("uploads", "");
    const good = ingest();
    assert.equal(good.status, 23, good.stderr + good.stdout);
    assert.match(await read("trace"), /downstream-hash/);
    const sent = (await uploads()).filter(row => row.event === "start").map(({key,body}) => ({key,body}));
    assert.deepEqual(sent.sort((a,b) => a.key.localeCompare(b.key)), [
      { key: "aadhar-photos/companion.jpg", body: "encoded" },
      { key: "aadhar-photos/frame.jpg", body: "progressive" },
    ]);
    assert.equal(await read("source/frame.jpg"), "source fixture");
    assert.equal(await read("source/companion.HIF"), "HEIF original");
  });
});

test("progressive-copy failure uploads the untouched source and removes the rejected copy", async () => {
  await uploadFixture(async ({ ingest, uploads, read }) => {
    const result = ingest(["source/frame.jpg"], { COPY_FAIL: "1" });
    assert.equal(result.status, 23, result.stderr + result.stdout);
    const [sent] = (await uploads()).filter(row => row.event === "start");
    assert.equal(sent.body, "source fixture");
    assert.equal(sent.discardedCopyStillExists, false);
    assert.equal(await read("source/frame.jpg"), "source fixture");
  });
});

test("upload batching stays at four regardless of encoder concurrency", async () => {
  await uploadFixture(async ({ put, ingest, uploads }) => {
    for (let i = 0; i < 8; i++) await put(`source/extra ${i}.JPG`, `source ${i}`);
    const result = ingest(["source"], { JOBS: "8", UPLOAD_BARRIER: "1" });
    assert.equal(result.status, 23, result.stderr + result.stdout);
    let active = 0, maximum = 0;
    const keys = [];
    for (const event of await uploads()) {
      active += event.event === "start" ? 1 : -1;
      maximum = Math.max(maximum, active);
      if (event.event === "start") keys.push(event.key);
    }
    assert.equal(maximum, 4);
    assert.equal(active, 0);
    assert.equal(keys.length, 9);
    assert.equal(new Set(keys).size, 9);
    assert.ok(keys.includes("aadhar-photos/extra 0.jpg"));
  });
});

test("remote-render-only mode performs no uploads even if the upload CLI would fail", async () => {
  await uploadFixture(async ({ ingest, uploads }) => {
    const result = ingest(["source/frame.jpg"], { REMOTE_RENDER_ONLY: "1", FAIL_UPLOAD: "all" });
    assert.equal(result.status, 23, result.stderr + result.stdout);
    assert.deepEqual(await uploads(), []);
  });
});

test("photo selection pairs a requested HEIF with its camera JPEG without overriding an explicit JPEG", async () => {
  await fixture(async ({ root, put }) => {
    await put("source/frame.hIf", "HEIF original");
    const jpg = path.join(root, "source/frame.jpg");
    const hif = path.join(root, "source/frame.hIf");
    const pair = [{ stem: "frame", source: hif, original: jpg, full: "frame.jpg" }];
    assert.deepEqual(await photoInputs([hif]), pair);
    assert.deepEqual(await photoInputs([hif, jpg, path.join(root, "source/../source/frame.jpg")]), pair);
    assert.deepEqual(await photoInputs([path.join(root, "source")]), pair);
    assert.deepEqual(await photoInputs([jpg]), [{ stem: "frame", source: jpg, original: jpg, full: "frame.jpg" }]);
  });
});

test("ingest and rerender both use one HEIF pixel source and one JPEG click object", async () => {
  await uploadFixture(async ({ root, put, read, ingest, shell, uploads }) => {
    await put("source/frame.hIf", "HEIF original");
    for (const input of ["source/frame.hIf", "source"]) {
      await put("uploads", ""); await put("trace", "");
      const result = ingest([input]);
      assert.equal(result.status, 23, result.stderr + result.stdout);
      const sent = (await uploads()).filter(row => row.event === "start");
      assert.equal(sent.length, 1);
      assert.equal(sent[0].key, "aadhar-photos/frame.jpg");
      assert.equal(sent[0].body, "progressive");
      if (input.endsWith("hIf")) {
        assert.ok((await read("trace")).includes(`-Orientation ${root}/source/frame.hIf`));
        assert.doesNotMatch(await read("trace"), /-Orientation .*frame\.jpg/);
      }
    }
    await put("trace", "");
    const rerender = shell("reencode-thumbnails.sh", ["source"]);
    assert.equal(rerender.status, 0, rerender.stderr + rerender.stdout);
    assert.ok((await read("trace")).includes(`-Orientation ${root}/source/frame.hIf`));
    assert.doesNotMatch(await read("trace"), /-Orientation .*frame\.jpg/);
    assert.equal(await read("source/frame.hIf"), "HEIF original");
    assert.equal(await read("source/frame.jpg"), "source fixture");
  });
});

test("ambiguous stems fail before encoding, uploading, hashing, or replacing existing tiers", async () => {
  for (const duplicate of ["source/frame.JPEG", "other/frame.JPG"]) {
    await uploadFixture(async ({ put, read, ingest, shell }) => {
      await put(duplicate, "different original");
      await put("public/images/frame.jpg", "previous tier");
      const result = ingest(["source/frame.jpg", duplicate]);
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, /ambiguous photo stem frame/);
      assert.doesNotMatch(await read("trace"), /sips|zenc|metadata|upload|downstream/);
      assert.equal(await read("public/images/frame.jpg"), "previous tier");
      if (duplicate.startsWith("source/")) {
        const rerender = shell("reencode-thumbnails.sh", ["source"]);
        assert.equal(rerender.status, 1, rerender.stderr);
        assert.match(rerender.stderr, /ambiguous photo stem frame/);
        assert.equal(await read("public/images/frame.jpg"), "previous tier");
      }
    });
  }
});

test("remote ingest preserves the existing JPEG key and refuses a HEIF that would need an upload", async () => {
  await uploadFixture(async ({ root, put, read, ingest, uploads }) => {
    await put("source/Remote.JPEG", "remote bytes");
    const source = path.join(root, "source/Remote.JPEG");
    assert.deepEqual(await photoInputs([source], { remote: true }), [
      { stem: "Remote", source, original: source, full: "Remote.JPEG" },
    ]);
    assert.equal(ingest([source], { REMOTE_RENDER_ONLY: "1" }).status, 23);
    assert.equal(await read("progressive-paths"), "");
    assert.deepEqual(await uploads(), []);
    await put("source/frame.HIF", "HEIF original");
    await put("trace", "");
    const failed = ingest(["source/frame.HIF"], { REMOTE_RENDER_ONLY: "1" });
    assert.equal(failed.status, 1, failed.stderr);
    assert.match(failed.stderr, /remote ingest needs the existing JPEG object/);
    assert.doesNotMatch(await read("trace"), /sips|zenc|metadata|upload|downstream/);
  });
});

test("input selection keeps published-only rerenders and rejects unsupported or conflicting sources", async () => {
  await fixture(async ({ root, put }) => {
    await put("source/png.png", "PNG fixture");
    await put("source/private.hif", "private HEIF");
    await put("source/private.heic", "conflicting private HEIF");
    const dir = path.join(root, "source");
    const png = path.join(dir, "png.png");
    const plan = await photoInputs([dir], { published: new Set(["png", "missing"]) });
    assert.deepEqual(plan, [
      { stem: "missing", source: "", original: null, full: "" },
      { stem: "png", source: png, original: null, full: "png.jpg" },
    ]);
    await assert.rejects(photoInputs([png]), /unsupported photo input/);
    await assert.rejects(photoInputs([dir]), /ambiguous photo stem private/);
    await assert.rejects(photoInputs([path.join(root, "absent")]), /ENOENT/);
  });
});

test("the shell input plan preserves filename whitespace and JPEG companion extensions", async () => {
  await uploadFixture(async ({ put, ingest, uploads }) => {
    const stem = "name with\ttab\nand newline";
    await put(`source/${stem}.JpEg`, "camera JPEG");
    await put(`source/${stem}.hEiC`, "HEIF original");
    const result = ingest([`source/${stem}.hEiC`]);
    assert.equal(result.status, 23, result.stderr + result.stdout);
    const sent = (await uploads()).filter(row => row.event === "start");
    assert.equal(sent.length, 1);
    assert.equal(sent[0].key, `aadhar-photos/${stem}.jpeg`);
    assert.equal(sent[0].body, "progressive");
  });
});

test("ingest forwards exactly the selected metadata sources across folders as a merge", async () => {
  await uploadFixture(async ({ root, put, command, ingest, read }) => {
    await put("source/frame.HIF", "HEIF original");
    await put("other/second photo.jpeg", "second original");
    await put("src/worker/photo-index.json", "{}");
    await command("tools/photos/hash-thumbnails.sh", "exit 0");
    // The JSON writer is outside this argument-boundary control. Native jaq
    // parity is checked separately; a constant producer lets the real shell
    // reach the extractor without installing an external CLI in contract CI.
    await command("bin/jaq", "echo '{}'");
    await command("tools/photos/extract-photo-metadata.sh", `printf '%s\\0' "$@" > "$FIXTURE_ROOT/metadata-args"; exit 31`);
    const result = ingest(["source", "other/second photo.jpeg"]);
    assert.equal(result.status, 31, result.stderr + result.stdout);
    assert.deepEqual((await read("metadata-args")).split("\0"), [
      "--merge", `${root}/source/frame.HIF`, `${root}/other/second photo.jpeg`, "",
    ]);
  });
});

test("metadata extraction passes multiple file arguments intact and preserves the prior record on read failure", async () => {
  await fixture(async ({ root, put, command, shell, read }) => {
    await put("other/second photo.jpeg", "second original");
    await put("public/images/metadata.json", '{"previous":{"camera":"kept"}}');
    await command("bin/jaq", "exit 99");
    await command("bin/exif-sooc", `printf '%s\\0' "$@" > "$FIXTURE_ROOT/metadata-args"; exit 29`);
    const files = [`${root}/source/frame.jpg`, `${root}/other/second photo.jpeg`];
    const result = shell("extract-photo-metadata.sh", ["--merge", ...files]);
    assert.equal(result.status, 29, result.stderr);
    assert.deepEqual((await read("metadata-args")).split("\0"), [
      "--keyed", "--merge-into", `${root}/public/images/metadata.json`, "-q", "-r", ...files, "",
    ]);
    assert.equal(await read("public/images/metadata.json"), '{"previous":{"camera":"kept"}}');
  });
});

test("an index write failure stops ingest before metadata can advance", async () => {
  await uploadFixture(async ({ put, command, ingest, read }) => {
    const previous = '{"held":{"full":"held.jpg","size":9}}';
    await put("src/worker/photo-index.json", previous);
    await command("tools/photos/hash-thumbnails.sh", "exit 0");
    await command("bin/jaq", "exit 17");
    await command("tools/photos/extract-photo-metadata.sh", 'echo unexpected-metadata >> "$TRACE"; exit 31');
    const result = ingest(["source/frame.jpg"]);
    assert.equal(result.status, 17, result.stderr + result.stdout);
    assert.equal(await read("src/worker/photo-index.json"), previous);
    assert.doesNotMatch(await read("trace"), /unexpected-metadata/);
  });
});
