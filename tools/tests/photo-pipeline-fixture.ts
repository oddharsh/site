import { mkdtemp, mkdir, readFile, realpath, writeFile, chmod, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { repoFiles } from "../lib/repo-files.ts";

export const REPO = fileURLToPath(new URL("../../", import.meta.url));

// Real shell entrypoints, deterministic encoder stubs, no network or private
// originals. Copy the shell corpus so sourced helpers run unchanged too.
export async function fixture(run) {
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
  const shell = (file, args: any[] = [], env: Record<string, any> = {}) =>
    spawnSync("/bin/bash", [path.join(root, "tools/photos", file), ...args], {
      cwd: root,
      encoding: "utf8",
      timeout: 10_000,
      env: {
        ...process.env,
        PATH: `${root}/bin:/usr/bin:/bin`,
        FIXTURE_ROOT: root,
        PHOTO_METRICS_BIN: `${root}/bin/photo-metrics`,
        JIXEL_ENC_BIN: `${root}/bin/jixel-enc`,
        TRACE: `${root}/trace`,
        JOBS: "1",
        REMOTE_RENDER_ONLY: "1",
        ...env,
      },
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
    const declared = JSON.parse(await readFile(new URL("../../config/tools.json", import.meta.url), "utf8")).tools.flatMap((t) => t.required_by ?? []);
    // pipeline-json.ts is the shells' JSON since 2026-09-15 and runs for real
    // under the fixture's node, with the one module it imports.
    const corpus = [
      "tools/photos/*.sh",
      "tools/photos/photo-inputs.ts",
      "tools/photos/pipeline-json.ts",
      "tools/lib/photo-indexes.ts",
      ...new Set<string>(declared),
    ];
    for (const rel of repoFiles(corpus, REPO)) {
      await put(rel, await readFile(path.join(REPO, rel), "utf8"));
    }
    await put("trace", "");
    await put("source/frame.jpg", "source fixture");
    await utimes(path.join(root, "source/frame.jpg"), 100, 100);
    await put("public/i/frame.12345678.jpg", "published tile");
    await put("public/images/.keep", "");
    await put("public/garage/enc/c-png.png", "published color fixture");
    await put("exports/frame.jpg", "previous export");
    await command(
      "bin/exif-sooc",
      `
case "$1" in
  --version) echo version >> "$TRACE"; printf '%s\\n' "\${SOOC_VERSION:-exif-sooc 0.4.0}"; exit "\${SOOC_STATUS:-0}" ;;
  -s) echo "orientation $*" >> "$TRACE"; echo 1 ;;
  *) echo "metadata $*" >> "$TRACE"
     [ "\${FAIL_METADATA:-0}" != 1 ] || { echo "metadata write failed" >&2; exit 7; }
     case "$*" in *r800.jpg*) [ "\${FAIL_METADATA:-0}" != resolution ] || exit 7 ;; esac ;;
esac`,
    );
    await command(
      "bin/sips",
      `
if [ "$1" = -g ]; then
  printf 'space: RGB\\npixelWidth: 400\\npixelHeight: 266\\n'
else
  echo sips >> "$TRACE"
  for last in "$@"; do :; done
  printf encoded > "$last"
fi`,
    );
    await command(
      "tools/photos/zenc/target/release/zenc",
      `
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
esac`,
    );
    for (const bin of ["avifenc", "cwebp"])
      await command(
        `bin/${bin}`,
        `
echo ${bin} >> "$TRACE"
for last in "$@"; do :; done
case "$last" in
  *-400.avif) tier=sm ;; *-200.avif) tier=xs ;; *.avif) tier=sq ;; *) tier=other ;;
esac
[ "\${FAIL_TIER:-}" != "$tier" ] || exit 8
[ "\${OMIT_TIER:-}" != "$tier" ] || exit 0
[ "\${EMPTY_TIER:-}" != "$tier" ] || { : > "$last"; exit 0; }
printf encoded > "$last"`,
      );
    await command("bin/brew", 'printf "%s/mozjpeg\\n" "$FIXTURE_ROOT"');
    await command("mozjpeg/bin/cjpeg", 'echo cjpeg >> "$TRACE"; printf encoded');
    // A tripwire for the rotation jpegtran used to do (gotcha 3): any call fails,
    // except the -revert coefficient reorders gen-encoding-samples.sh writes its
    // scan-order twins with, which have no geometry in them.
    await command("mozjpeg/bin/jpegtran", 'echo "jpegtran $*" >> "$TRACE"; case "$*" in *-revert*) printf encoded; exit 0 ;; esac; exit 1');
    // The metrics answer per file so a test can make a HIF's direct encode
    // beat its JPEG bar (CAND_S2 above 95, CAND_BA below 0.5) or not. hif-archive.ts
    // scores its candidates as cand.png; the bar is base.png. It reaches this
    // stub through PHOTO_METRICS_BIN rather than building tools/photos/photo-metrics.
    await command(
      "bin/photo-metrics",
      'case "$2" in *cand*) s2="${CAND_S2:-95}" ba="${CAND_BA:-0.5}" ;; *) s2=95 ba=0.5 ;; esac; echo "{\\"s2\\":$s2,\\"ba\\":$ba,\\"ba3\\":$ba}"',
    );
    // hif-archive.ts encodes its candidates and the final file through
    // JIXEL_ENC_BIN (in.png out.jxl distance), wrapping its input in "jxl:" the
    // way the cjxl stub below does, so an upload body names its source.
    await command("bin/jixel-enc", 'echo "jixel-enc $*" >> "$TRACE"; { printf "jxl:"; cat "$1"; } > "$2"');
    // export-for-instagram.sh runs the crate's own binary, the way it runs zenc,
    // on djpeg's decode of each candidate.
    await command("tools/photos/photo-metrics/target/release/photo-metrics", 'echo "{\\"s2\\":95,\\"ba\\":0.5,\\"ba3\\":0.5}"');
    await command("bin/djpeg", 'printf decoded > "$2"');
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
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

export async function uploadFixture(run) {
  await fixture(async (f) => {
    await f.put("uploads", "");
    await f.put("progressive-paths", "");
    await f.command(
      "mozjpeg/bin/jpegtran",
      `
while [ "$1" != -outfile ]; do shift; done
shift; out="$1"; src="$2"
printf '%s\\t%s\\n' "$src" "$out" >> "$FIXTURE_ROOT/progressive-paths"
printf progressive > "$out"
[ "\${COPY_FAIL:-0}" != 1 ] || exit 7`,
    );
    await f.put(
      "upload.mjs",
      `
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
`,
    );
    await f.command("node_modules/.bin/wrangler", `exec "${process.execPath}" "$FIXTURE_ROOT/upload.mjs" "$@"`);
    // The JPEG XL original, stubbed so the body says what it was made from:
    // cjxl wraps its input in "jxl:", and djxl unwraps it, so the rebuild
    // matches unless BAD_REBUILD makes it differ by one byte. cjxl also notes
    // whether jpegtran's rejected copy of its input still exists, the check the
    // uploader made when the JPEG itself went up.
    await f.command(
      "bin/cjxl",
      `
for last in "$@"; do :; done
for a in "$@"; do case "$a" in -*|9) ;; *) [ "$a" = "$last" ] || src="$a" ;; esac; done
echo "cjxl $*" >> "$TRACE"
copy=$(awk -F'\\t' -v s="$src" '$1 == s { print $2 }' "$FIXTURE_ROOT/progressive-paths" 2>/dev/null) || copy=""
[ -z "$copy" ] || [ ! -e "$copy" ] || echo "discarded-copy-exists" >> "$TRACE"
{ printf 'jxl:'; cat "$src"; } > "$last"`,
    );
    // A decode to PNG for hif-archive.ts's scores gets a header of the HIF's
    // size, which is all it reads of one.
    await f.command(
      "bin/djxl",
      `
case "$2" in *.png) printf '\\211PNG\\015\\012\\032\\012\\000\\000\\000\\015IHDR\\000\\000\\001\\220\\000\\000\\001\\012' > "$2"; exit 0 ;; esac
tail -c +5 "$1" > "$2"
[ "\${BAD_REBUILD:-0}" != 1 ] || printf x >> "$2"`,
    );
    const uploads = async () =>
      (await f.read("uploads"))
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    const ingest = (args = ["source"], env: Record<string, any> = {}) => f.shell("add-photos.sh", args, { REMOTE_RENDER_ONLY: "0", ...env });
    await run({ ...f, ingest, uploads });
  });
}
