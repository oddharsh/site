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
    // dependency of the corpus rather than a member of it. Every file a
    // `required_by` in config/tools.json names joins for the same reason, read
    // from the declaration rather than listed here: check-tools.ts fails on a
    // required_by it cannot open, so the fixture has to hold whatever the real
    // declaration points at, and that set changed the day python3's only
    // consumer became a .py outside the shell glob (2026-09-15).
    const declared = JSON.parse(await readFile(new URL("../config/tools.json", import.meta.url), "utf8"))
      .tools.flatMap((t) => t.required_by ?? []);
    // pipeline-json.ts is the shells' JSON since 2026-09-15 and runs for real
    // under the fixture's node, with the one module it imports.
    const corpus = ["tools/photos/*.sh", "tools/photos/photo-inputs.ts", "tools/photos/pipeline-json.ts", "tools/lib/photo-indexes.ts", ...new Set(declared)];
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
  --version) echo version >> "$TRACE"; printf '%s\\n' "\${SOOC_VERSION:-exif-sooc 0.4.0}"; exit "\${SOOC_STATUS:-0}" ;;
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
[ "$1" != --avif-version ] || { echo "libavif 1.4.2"; exit 0; }
echo zenc >> "$TRACE"
case "$1" in
  square|resize)
    while [ "$#" -gt 0 ]; do
      case "$1" in
        --out|--jpeg-out|--avif-out)
          shift
          case "$1" in *-400.avif) tier=sm ;; *-200.avif) tier=xs ;; *.avif) tier=sq ;; *) tier=other ;; esac
          [ "\${FAIL_TIER:-}" != "$tier" ] || exit 8
          if [ "\${OMIT_TIER:-}" = "$tier" ]; then :
          elif [ "\${EMPTY_TIER:-}" = "$tier" ]; then : > "$1"
          else printf encoded > "$1"; fi ;;
      esac
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
    // A tripwire for the rotation jpegtran used to do (gotcha 3): any call fails,
    // except the -revert coefficient reorders gen-encoding-samples.sh writes its
    // scan-order twins with, which have no geometry in them.
    await command("mozjpeg/bin/jpegtran", 'echo "jpegtran $*" >> "$TRACE"; case "$*" in *-revert*) printf encoded; exit 0 ;; esac; exit 1');
    await command("bin/ffmpeg", 'for last in "$@"; do :; done; printf encoded > "$last"');
    // The metrics answer per file so a test can make a HIF's direct encode
    // beat its JPEG bar (CAND_S2 above 95, CAND_BA below 0.5) or not. hif-archive.ts
    // scores its candidates as cand.png; the bar is base.ppm.
    await command("bin/ssimulacra2", 'case "$2" in *cand*) echo "${CAND_S2:-95}" ;; *) echo 95 ;; esac');
    await command("bin/butteraugli_main", 'case "$2" in *cand*) echo "${CAND_BA:-0.5}" ;; *) echo 0.5 ;; esac');
    // djpeg decodes the bar for hif-archive.ts; a PPM header is all it reads.
    await command("bin/djpeg", 'while [ "$1" != -outfile ]; do shift; done; printf "P6\n400 266\n255\n" > "$2"');
    // BSD stat is used by these macOS scripts; keep the control portable in CI.
    await command("bin/stat", 'test "$1" = -f%z; test -f "$2"; echo 7');
    await command("bin/cargo", 'echo cargo >> "$TRACE"');
    await command("bin/pkg-config", "exit 0");
    // The shells spawn `bun` for their TS since 2026-09-16; under `bun test` that
    // is this very runtime, and under test:node it is node running the same TS.
    await command("bin/bun", `exec "${process.execPath}" "$@"`);
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
      assert.match(refused.stderr, /older than 0\.4\.0/);
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
      if (file === "gen-encoding-samples.sh") assert.match(await read("trace"), /jpegtran -revert .*-optimize[\s\S]*jpegtran -revert .*-progressive/);
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
    for (const version of ["exif-sooc 0.4.0", "exif-sooc 0.10.0", "exif-sooc 1.0.0"]) {
      const result = shell("require-exif-sooc.sh", [], { SOOC_VERSION: version });
      assert.equal(result.status, 0, result.stderr);
    }
    for (const [version, status] of [
      ["exif-sooc 0.1.9", "0"], ["exif-sooc 0.2.0", "0"], ["exif-sooc 0.2.9", "0"],
      ["exif-sooc 0.3.0", "0"], ["exif-sooc 0.3.9", "0"],
      ["exif-sooc 0.4.0", "9"],
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
    await put(file, guard.replace("EXIF_SOOC_MIN=0.4.0", "EXIF_SOOC_MIN=0.1.0"));
    const mismatch = cli();
    assert.equal(mismatch.status, 1, mismatch.stderr);
    assert.match(mismatch.stderr, /floors exif-sooc at 0\.1\.0 while config\/tools.json declares 0\.4\.0/);
    await put(file, guard.replace("EXIF_SOOC_MIN=0.4.0", ""));
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
const type = key.endsWith('.jxl') ? 'image/jxl' : 'image/jpeg';
if (args.slice(0,3).join(' ') !== 'r2 object put' || !args.includes('--content-type=' + type) || !args.includes('--remote')) process.exit(98);
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
    // The JPEG XL original, stubbed so the body says what it was made from:
    // cjxl wraps its input in "jxl:", and djxl unwraps it, so the rebuild
    // matches unless BAD_REBUILD makes it differ by one byte. cjxl also notes
    // whether jpegtran's rejected copy of its input still exists, the check the
    // uploader made when the JPEG itself went up.
    await f.command("bin/cjxl", `
for last in "$@"; do :; done
for a in "$@"; do case "$a" in -*|9) ;; *) [ "$a" = "$last" ] || src="$a" ;; esac; done
echo "cjxl $*" >> "$TRACE"
copy=$(awk -F'\\t' -v s="$src" '$1 == s { print $2 }' "$FIXTURE_ROOT/progressive-paths" 2>/dev/null) || copy=""
[ -z "$copy" ] || [ ! -e "$copy" ] || echo "discarded-copy-exists" >> "$TRACE"
{ printf 'jxl:'; cat "$src"; } > "$last"`);
    await f.command("bin/djxl", `
tail -c +5 "$1" > "$2"
[ "\${BAD_REBUILD:-0}" != 1 ] || printf x >> "$2"`);
    const uploads = async () => (await f.read("uploads")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
    const ingest = (args = ["source"], env = {}) => f.shell("add-photos.sh", args, { REMOTE_RENDER_ONLY: "0", ...env });
    await run({ ...f, ingest, uploads });
  });
}

test("failed source or HEIF-companion uploads stop before hashing and index writes", async () => {
  await uploadFixture(async ({ put, read, ingest, uploads }) => {
    await put("source/companion.HIF", "HEIF original");
    await put("src/worker/photo-index.json", '{"existing":{"full":"existing.jpg"}}');
    for (const key of ["aadhar-photos/frame.jxl", "aadhar-photos/companion.jxl"]) {
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
      // Only the JPEG XL goes up, wrapping the prepared JPEG: for a HIF that is
      // zenc's re-encode AFTER jpegtran's DC-first reorder, never the source.
      { key: "aadhar-photos/companion.jxl", body: "jxl:progressive" },
      { key: "aadhar-photos/frame.jxl", body: "jxl:progressive" },
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
    assert.equal(sent.body, "jxl:source fixture");
    assert.match(await read("trace"), /cjxl /, "the probe below only means something if cjxl ran");
    assert.doesNotMatch(await read("trace"), /discarded-copy-exists/);
    assert.equal(await read("source/frame.jpg"), "source fixture");
  });
});

// The HIF branch has no untouched original to fall back to: zenc's own file is
// the one whose luma-first scan order kept 53 archives blank until 66-99% of the
// download, so a failed reorder must fail the photo rather than upload that.
test("a HIF archive whose DC-first reorder fails is never uploaded", async () => {
  await uploadFixture(async ({ put, read, ingest, uploads }) => {
    await put("source/companion.HIF", "HEIF original");
    const result = ingest(["source/companion.HIF"], { COPY_FAIL: "1" });
    assert.equal(result.status, 1, result.stderr + result.stdout);
    assert.match(result.stderr, /phase 2 incomplete/);
    assert.deepEqual(await uploads(), []);
    assert.doesNotMatch(await read("trace"), /downstream-hash/);
    // control: the same source with a working reorder uploads the reordered bytes
    const good = ingest(["source/companion.HIF"]);
    assert.equal(good.status, 23, good.stderr + good.stdout);
    const sent = (await uploads()).filter(row => row.event === "start");
    assert.deepEqual(sent.map(({ key, body }) => ({ key, body })), [
      { key: "aadhar-photos/companion.jxl", body: "jxl:progressive" },
    ]);
  });
});

// The .jxl is the only copy R2 will hold, so one whose rebuild differs from the
// prepared JPEG by a byte must never reach R2, and the photo fails the way a
// failed HEIF upload does: before hashing, with the index untouched.
test("a JPEG XL original that does not rebuild the prepared JPEG is never uploaded", async () => {
  await uploadFixture(async ({ put, read, ingest, uploads }) => {
    await put("src/worker/photo-index.json", '{"existing":{"full":"existing.jpg"}}');
    const bad = ingest(["source/frame.jpg"], { BAD_REBUILD: "1" });
    assert.equal(bad.status, 1, bad.stderr + bad.stdout);
    assert.match(bad.stderr, /phase 3 incomplete/);
    assert.match(bad.stderr, /JPEG XL original failed .*aadhar-photos\/frame\.jxl/);
    assert.deepEqual(await uploads(), [], "nothing went up, the JPEG included");
    assert.doesNotMatch(await read("trace"), /downstream-hash/);
    assert.equal(await read("src/worker/photo-index.json"), '{"existing":{"full":"existing.jpg"}}');
    // Control: an exact rebuild uploads it, with its own content type.
    await put("uploads", "");
    const good = ingest(["source/frame.jpg"]);
    assert.equal(good.status, 23, good.stderr + good.stdout);
    assert.deepEqual((await uploads()).filter(row => row.event === "start").map(row => row.key),
      ["aadhar-photos/frame.jxl"]);
  });
});

// A HIF photo's archive is encoded from the HIF's own pixels when that beats
// the JPEG ingest prepared on both metrics, with the HIF's EXIF copied on
// (sips drops every Fujifilm maker note), and is that JPEG repacked when it
// does not. A JPEG photo is always the repack: it has no better source.
test("a HIF photo's archive is its own pixels when they beat the JPEG bar, and the repacked JPEG when not", async () => {
  await uploadFixture(async ({ root, put, read, ingest, uploads }) => {
    await put("source/companion.HIF", "HEIF original");
    const win = { CAND_S2: "96", CAND_BA: "0.4" };
    const direct = ingest(["source"], win);
    assert.equal(direct.status, 23, direct.stderr + direct.stdout);
    const sent = Object.fromEntries((await uploads()).filter((r) => r.event === "start").map((r) => [r.key, r.body]));
    // sips's PNG of the HIF ("encoded") went through cjxl, not the JPEG bar
    assert.equal(sent["aadhar-photos/companion.jxl"], "jxl:encoded");
    assert.equal(sent["aadhar-photos/frame.jxl"], "jxl:progressive", "a JPEG source is repacked whatever the metrics say");
    // the HIF's EXIF goes onto the .jxl (phase 2 also copies it onto the JPEG bar)
    assert.match(await read("trace"), new RegExp(`metadata -TagsFromFile ${root}/source/companion\\.HIF -all:all -overwrite_original \\S+\\.jxl`));
    // Control: a candidate that wins only one metric is no win, so the HIF
    // photo falls back to the repack.
    for (const half of [{ CAND_S2: "96" }, { CAND_BA: "0.4" }]) {
      await put("uploads", ""); await put("trace", "");
      const lost = ingest(["source/companion.HIF"], half);
      assert.equal(lost.status, 23, lost.stderr + lost.stdout);
      assert.deepEqual((await uploads()).filter((r) => r.event === "start").map((r) => [r.key, r.body]),
        [["aadhar-photos/companion.jxl", "jxl:progressive"]], JSON.stringify(half));
      assert.doesNotMatch(await read("trace"), /-overwrite_original \S+\.jxl/);
    }
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
    // nine photos, one JPEG XL original each
    assert.equal(keys.length, 9);
    assert.equal(new Set(keys).size, 9);
    assert.ok(keys.includes("aadhar-photos/extra 0.jxl"));
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
      assert.deepEqual(sent.map(({ key, body }) => [key, body]), [["aadhar-photos/frame.jxl", "jxl:progressive"]]);
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

// The remote pipeline gets a migrated original as its .jxl plus the JPEG djxl
// rebuilt beside it. The JPEG feeds the encoders; the index has to keep naming
// the .jxl and its size, or a rerender would point every link at a key R2 no
// longer holds.
test("remote ingest of a JPEG XL original records the .jxl key and size, not the rebuilt JPEG", async () => {
  await uploadFixture(async ({ root, put, command, ingest, read, uploads }) => {
    await put("moved/Moved.jpg", "rebuilt JPEG bytes");
    await put("moved/Moved.jxl", "jxl:x");
    const jpg = path.join(root, "moved/Moved.jpg");
    const jxl = path.join(root, "moved/Moved.jxl");
    assert.deepEqual(await photoInputs([path.join(root, "moved")], { remote: true }), [
      { stem: "Moved", source: jpg, original: jxl, full: "Moved.jxl" },
    ]);
    // Control: a local ingest of the same folder ignores the .jxl entirely.
    assert.deepEqual(await photoInputs([path.join(root, "moved")]), [
      { stem: "Moved", source: jpg, original: jpg, full: "Moved.jpg" },
    ]);
    await put("src/worker/photo-index.json", '{"Moved":{"full":"Moved.jxl","jpeg":"Moved.JPG","size":5,"uploaded":"2026-07-27T00:00:00.000Z"}}');
    await command("tools/photos/hash-thumbnails.sh", "exit 0");
    await command("tools/photos/extract-photo-metadata.sh", "exit 31");
    const result = ingest(["moved"], { REMOTE_RENDER_ONLY: "1" });
    assert.equal(result.status, 31, result.stderr + result.stdout);
    assert.deepEqual(await uploads(), []);
    assert.deepEqual(JSON.parse(await read("src/worker/photo-index.json")).Moved,
      { full: "Moved.jxl", jpeg: "Moved.JPG", size: 5, uploaded: "2026-07-27T00:00:00.000Z" });
  });
});

// The remote downloader meets two kinds of JPEG XL original. A transcode
// rebuilds its JPEG, and the .jxl must leave the scanned folder: its metadata
// is Brotli-compressed, and exif-sooc 0.4.0 reads .jxl, so beside the JPEG it
// would be a second, failing read of the same photo. A HIF photo's direct
// encode has no JPEG inside: it decodes to a 16-bit PNG and the .jxl stays,
// as the only copy of the HIF's EXIF.
test("the remote downloader rebuilds a transcode's JPEG and decodes a direct archive, keeping only the latter's .jxl in the folder", async () => {
  await fixture(async ({ root, put, command, shell, read }) => {
    const box = (kind, body) => { const b = Buffer.alloc(8); b.writeUInt32BE(body.length + 8); b.write(kind, 4, "latin1"); return Buffer.concat([b, Buffer.from(body)]); };
    const jxl = (...boxes) => Buffer.concat([Buffer.from([0, 0, 0, 12, 0x4a, 0x58, 0x4c, 0x20, 0x0d, 0x0a, 0x87, 0x0a]), box("ftyp", "jxl \0\0\0\0jxl "), ...boxes]);
    await mkdir(path.join(root, "r2"), { recursive: true });
    await writeFile(path.join(root, "r2/Old.jxl"), jxl(box("jbrd", "x"), box("jxlc", "jpeg inside")));
    await writeFile(path.join(root, "r2/New.jxl"), jxl(box("Exif", "\0\0\0\0MM"), box("jxlc", "hif pixels")));
    await command("bin/curl", 'for a in "$@"; do case "$a" in */images/full/*) key="${a##*/}" ;; esac; prev="$a"; done\nwhile [ "$1" != --output ]; do shift; done\ncp "$FIXTURE_ROOT/r2/$key" "$2"');
    await command("bin/djxl", 'printf "decoded %s" "$*" > "$2"');
    await command("bin/exif-sooc", 'echo 400');
    await put("keys", "Old.jxl\nNew.jxl\n");
    const r = shell("download-remote-photos.sh", ["keys", "dest"]);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    const exists = (p) => readFile(path.join(root, p)).then(() => true, () => false);
    assert.equal(await exists("dest/Old.jpg"), true, "the transcode's JPEG");
    assert.equal(await exists("dest/Old.jxl"), false, "a transcode's .jxl must not stay where exif-sooc scans");
    assert.equal(await exists("dest.r2/Old.jxl"), true);
    assert.match(await read("dest/New.png"), /--bits_per_sample=16/, "a direct archive decodes to 16-bit PNG");
    assert.equal(await exists("dest/New.jxl"), true, "a direct archive's .jxl stays, as its metadata source");
    assert.equal(await exists("dest/New.jpg"), false, "djxl must not be asked for a JPEG it would invent");
    // Remote ingest finds the transcode's key in its new home and refuses the
    // direct archive by name rather than dropping it from the plan.
    await assert.rejects(photoInputs([path.join(root, "dest")], { remote: true }), /cannot re-ingest New/);
    await rm(path.join(root, "dest/New.jxl")); await rm(path.join(root, "dest/New.png"));
    assert.deepEqual(await photoInputs([path.join(root, "dest")], { remote: true }), [
      { stem: "Old", source: path.join(root, "dest/Old.jpg"), original: path.join(root, "dest.r2/Old.jxl"), full: "Old.jxl" },
    ]);
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
    // the key is the companion JPEG's, tab and newline intact, with .jxl
    assert.deepEqual(sent.map(({ key, body }) => [key, body]), [[`aadhar-photos/${stem}.jxl`, "jxl:progressive"]]);
  });
});

test("ingest forwards exactly the selected metadata sources across folders as a merge", async () => {
  await uploadFixture(async ({ root, put, command, ingest, read }) => {
    await put("source/frame.HIF", "HEIF original");
    await put("other/second photo.jpeg", "second original");
    await put("src/worker/photo-index.json", "{}");
    await command("tools/photos/hash-thumbnails.sh", "exit 0");
    // The index writer is pipeline-json.ts under the fixture's real node, so
    // it runs here rather than being stubbed: this fixture used to stand in a
    // constant `bin/jaq` because installing a JSON CLI in contract CI was the
    // alternative, and that alternative is gone.
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
    // A REAL write failure rather than a stub exiting 17: the writer lands its
    // output at <index>.tmp and renames, so a directory squatting on that path
    // fails the write with EISDIR after the merge has been computed, which is
    // the latest point a failure can land and the one that must leave the
    // committed bytes alone.
    await put("src/worker/photo-index.json.tmp/squatter", "");
    await command("tools/photos/extract-photo-metadata.sh", 'echo unexpected-metadata >> "$TRACE"; exit 31');
    const result = ingest(["source/frame.jpg"]);
    assert.equal(result.status, 1, result.stderr + result.stdout);
    assert.match(result.stderr, /pipeline-json: /, "the writer names itself in the failure");
    assert.equal(await read("src/worker/photo-index.json"), previous);
    assert.doesNotMatch(await read("trace"), /unexpected-metadata/);
  });
});
