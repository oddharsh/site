// reencode-hif-archives.ts overwrites R2 objects in place, so what it refuses
// matters as much as what it does. These run the real script, and the real
// hif-archive.ts it calls, against a stub R2 holding real JPEG XL container
// bytes: no --backup means no run, a dry run writes nothing, a real run
// overwrites the same key and records its size, a rerun skips what is done,
// and a photo whose encode cannot beat its bar keeps its archive.
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { assert, test } from "./contract-shared.ts";

const REPO = fileURLToPath(new URL("../", import.meta.url));
const BUN = process.versions.bun ? process.execPath : "bun";

const box = (kind, body) => { const b = Buffer.alloc(8); b.writeUInt32BE(body.length + 8); b.write(kind, 4, "latin1"); return Buffer.concat([b, Buffer.from(body)]); };
const container = (...boxes) => Buffer.concat([Buffer.from([0, 0, 0, 12, 0x4a, 0x58, 0x4c, 0x20, 0x0d, 0x0a, 0x87, 0x0a]), box("ftyp", "jxl \0\0\0\0jxl "), ...boxes]);
const TRANSCODE = container(box("jbrd", "rebuild"), box("jxlc", "the old q100 archive"));

async function setup() {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "reencode-hif-")));
  const put = async (rel, bytes, mode) => {
    await mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await writeFile(path.join(root, rel), bytes);
    if (mode) await chmod(path.join(root, rel), mode);
  };
  for (const rel of ["tools/photos/reencode-hif-archives.ts", "tools/photos/hif-archive.ts", "tools/photos/pipeline-json.ts", "tools/lib/photo-indexes.ts"]) {
    await put(rel, await readFile(path.join(REPO, rel)));
  }
  await put("src/worker/photo-index.json", JSON.stringify({ X1: { full: "X1.jxl", size: TRANSCODE.length, uploaded: "2026-07-27T00:00:00.000Z" } }, null, 2) + "\n");
  await put("r2/X1.jxl", TRANSCODE);
  await put("hifs/X1.HIF", "HEIF original");
  // R2: get copies out of r2/, put copies in, and every call is logged.
  await put("node_modules/.bin/wrangler", `#!/bin/bash
echo "$*" >> "$FIXTURE_ROOT/calls"
key="\${4#aadhar-photos/}"; file=""; for a in "$@"; do case "$a" in --file=*) file="\${a#--file=}" ;; esac; done
case "$3" in
  get) [ -f "$FIXTURE_ROOT/r2/$key" ] || { echo "✘ [ERROR] The specified key does not exist." >&2; exit 1; }; cp "$FIXTURE_ROOT/r2/$key" "$file" ;;
  put) cp "$file" "$FIXTURE_ROOT/r2/$key" ;;
esac`, 0o755);
  // cjxl writes a real container without jbrd for a lossy encode (so a rerun
  // reads it as direct) and copies its input for a lossless repack.
  await put("bin/cjxl", `#!/bin/bash
for last in "$@"; do :; done
for a in "$@"; do case "$a" in -*|[0-9]*) ;; *) [ "$a" = "$last" ] || src="$a" ;; esac; done
case "$*" in *--lossless_jpeg=1*) cp "$src" "$last"; exit 0 ;; esac
printf '\\000\\000\\000\\014JXL \\015\\012\\207\\012\\000\\000\\000\\024ftypjxl \\000\\000\\000\\000jxl \\000\\000\\000\\014jxlcnew!' > "$last"`, 0o755);
  await put("bin/djxl", '#!/bin/bash\ncp "$1" "$2"', 0o755);
  await put("bin/sips", '#!/bin/bash\nif [ "$1" = -g ]; then printf "pixelWidth: 400\\npixelHeight: 266\\n"; else for last in "$@"; do :; done; printf png > "$last"; fi', 0o755);
  await put("bin/djpeg", '#!/bin/bash\nwhile [ "$1" != -outfile ]; do shift; done; printf "P6\\n400 266\\n255\\n" > "$2"', 0o755);
  await put("bin/ssimulacra2", '#!/bin/bash\ncase "$2" in *cand*) echo "${CAND_S2:-95}" ;; *) echo 95 ;; esac', 0o755);
  await put("bin/butteraugli_main", '#!/bin/bash\ncase "$2" in *cand*) echo "${CAND_BA:-0.5}" ;; *) echo 0.5 ;; esac', 0o755);
  await put("bin/exif-sooc", '#!/bin/bash\n[ "$1" = --version ] && { echo "exif-sooc 0.4.0"; exit 0; }\necho "exif-sooc $*" >> "$FIXTURE_ROOT/calls"', 0o755);
  const run = (args, env = {}) => spawnSync(BUN, ["tools/photos/reencode-hif-archives.ts", "--hif-dir", "hifs", ...args], {
    cwd: root, encoding: "utf8", timeout: 60_000,
    env: { ...process.env, PATH: `${root}/bin:${process.env.PATH}`, FIXTURE_ROOT: root, ...env },
  });
  const read = (rel) => readFile(path.join(root, rel)).catch(() => null);
  const calls = async () => ((await read("calls"))?.toString() ?? "").split("\n").filter(Boolean);
  return { root, run, read, calls };
}
const WIN = { CAND_S2: "96", CAND_BA: "0.4" };

test("no run overwrites an archive without a backup to keep the old bytes in", async () => {
  const { run, calls } = await setup();
  const r = run([], WIN);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /--backup <dir> is required/);
  assert.deepEqual(await calls(), [], "refused before reading anything");
});

test("a dry run reads and encodes but writes nothing anywhere", async () => {
  const { run, read, calls } = await setup();
  const before = await read("src/worker/photo-index.json");
  const r = run(["--dry-run"], WIN);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /✓ X1: d0\.6, .*\(dry run\)/, "a candidate that always wins takes the top of the range");
  assert.ok((await calls()).every((c) => !c.includes(" put ")), "no upload");
  assert.deepEqual(await read("r2/X1.jxl"), TRANSCODE);
  assert.deepEqual(await read("src/worker/photo-index.json"), before);
});

test("a real run overwrites the same key, backs up the old bytes, records the size, and a rerun skips it", async () => {
  const { root, run, read, calls } = await setup();
  const r = run(["--backup", "backup"], WIN);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const now = /** @type {Buffer} */ (await read("r2/X1.jxl"));
  assert.notDeepEqual(now, TRANSCODE);
  assert.equal(now.includes(Buffer.from("jbrd")), false, "the new archive is direct");
  assert.deepEqual(await read("backup/X1.jxl"), TRANSCODE, "the old archive survives locally");
  const index = JSON.parse(String(await read("src/worker/photo-index.json")));
  assert.deepEqual(index.X1, { full: "X1.jxl", size: now.length, uploaded: "2026-07-27T00:00:00.000Z" }, "same key, new size");
  const log = await calls();
  assert.ok(log.some((c) => c.startsWith("r2 object put aadhar-photos/X1.jxl")), "uploaded under the same key");
  assert.ok(log.some((c) => /^exif-sooc -TagsFromFile \S+X1\.HIF -all:all -overwrite_original \S+\.jxl$/.test(c)), "the HIF's EXIF went onto it");
  // a rerun finds it direct and leaves it alone
  const again = run(["--backup", "backup"], WIN);
  assert.equal(again.status, 0, again.stderr);
  assert.match(again.stdout, /X1: already encoded from its HIF/);
  assert.equal((await calls()).filter((c) => c.includes(" put ")).length, 1);
  assert.deepEqual(await readdir(path.join(root, "backup")), ["X1.jxl"]);
});

test("a photo whose encode cannot beat its bar on both metrics keeps its archive", async () => {
  const { run, read, calls } = await setup();
  const r = run(["--backup", "backup"], { CAND_S2: "96" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /= X1: kept as is/);
  assert.deepEqual(await read("r2/X1.jxl"), TRANSCODE);
  assert.ok((await calls()).every((c) => !c.includes(" put ")));
});
