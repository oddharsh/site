#!/usr/bin/env bun
// add-photos.ts — the photo pipeline. Takes SOOC originals and produces every
// artifact the site needs, in four phases:
//
//   1. square thumbnails   600 / 400 / 200 AVIF + one 600 JPG fallback
//   2. HIF -> full-res JPG the q100 4:2:2 share copy (Fuji HIF is 4:2:2 native)
//   3. R2 uploads          the originals, progressive-ified, 4 at a time
//   4. index + metadata    hashes, photo-index, EXIF, histograms, alt text
//
//   bun tools/photos/add-photos.ts <file-or-dir>...
//   REMOTE_RENDER_ONLY=1 …   phase 3 is skipped (the source is already in R2)
//
// The source folder is CURATED: /Users/aadharsh/Downloads/to post (from ssd)/.
// Nothing else on disk belongs here.
import { $ } from "bun";
import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import { ensureZenc, requireBins } from "./lib/prereqs.ts";
import { EXIF_SOOC_MIN, versionAtLeast } from "./gen-encoding-grids.ts";
import { longEdgeFor, orientationFlags, MOZ_JTRAN, ZENC_Q } from "./reencode-thumbnails.ts";

export const REQUIRES = ["sips", "exif-sooc", "avifenc"] as const;

const SOURCE_EXT = /\.(jpg|jpeg|heic|heif|hif)$/i;
const IS_HEIF = /\.(hif|heic|heif)$/i;

if (import.meta.main) {
  const inputs = process.argv.slice(2);
  if (!inputs.length) {
    console.error("usage: bun tools/photos/add-photos.ts <file-or-dir>...");
    process.exit(1);
  }

  const root = new URL("../../", import.meta.url).pathname;
  const dest = join(root, "public/images");
  const wrangler = join(root, "node_modules/.bin/wrangler");
  const SQ = Number(process.env.SQ || 600);
  const SQ_SM = Number(process.env.SQ_SM || 400);
  const SQ_XS = Number(process.env.SQ_XS || 200);
  const remoteOnly = process.env.REMOTE_RENDER_ONLY === "1";

  if (!(await Bun.file(wrangler).exists())) {
    console.error(`error: pinned wrangler not found at ${wrangler}\n  run: bun install`);
    process.exit(1);
  }
  const bin = requireBins(REQUIRES);
  const version = (await $`exif-sooc --version`.quiet().nothrow()).stdout.toString().trim().split(/\s+/).at(-1) ?? "";
  if (!versionAtLeast(version, EXIF_SOOC_MIN)) {
    console.error(`error: exif-sooc ${version || "not found"} is older than ${EXIF_SOOC_MIN}, which cannot write metadata safely.`);
    console.error("  update with: cargo install --git https://github.com/oddharsh/exif-sooc exif-sooc --force");
    process.exit(1);
  }
  const zenc = await ensureZenc();
  if (!(await Bun.file(MOZ_JTRAN).exists())) {
    console.error("error: jpegtran not installed (brew install mozjpeg)");
    process.exit(1);
  }
  await mkdir(dest, { recursive: true });

  const tmp = join("/tmp", `aadhar-add-photos-${process.pid}`);
  const inter = join(tmp, "inter");
  const exports_ = join(tmp, "jpgexports");
  const progdir = join(tmp, "progressive");
  for (const d of [inter, exports_, progdir]) await mkdir(d, { recursive: true });

  // ── sources ───────────────────────────────────────────────────────────────
  const sources = new Set<string>();
  for (const arg of inputs) {
    const st = await stat(arg).catch(() => null);
    if (st?.isDirectory()) {
      for (const f of await readdir(arg)) if (SOURCE_EXT.test(f)) sources.add(join(arg, f));
    } else if (st?.isFile()) sources.add(arg);
    else console.error(`warning: skipping ${arg} (not a file or directory)`);
  }
  const list = [...sources].sort();
  if (!list.length) { console.error("no eligible photos found in input(s)"); process.exit(1); }
  console.log(`found ${list.length} source file(s) to process\n`);

  const avifEncode = async (src: string, out: string) => {
    const space = (await $`${bin.sips} -g space ${src}`.quiet().nothrow()).stdout.toString();
    const yuv = /space:\s*Gray/.test(space) ? "400" : "420";
    return $`${bin.avifenc} -q 63 -d 10 --ignore-icc --ignore-exif --ignore-xmp --speed 4 --jobs 4 --yuv ${yuv} ${src} ${out}`.quiet().nothrow();
  };

  // ── phase 1: square thumbnails ────────────────────────────────────────────
  console.log(`phase 1 — square thumbnails (${SQ}x${SQ} / ${SQ_SM}x${SQ_SM}, zenc q${ZENC_Q} + AVIF, metadata-stripped)`);
  let tOk = 0, tSkip = 0, tFail = 0;
  for (const f of list) {
    const stem = basename(f, extname(f));
    const jpg = join(dest, `${stem}.jpg`);
    const avif = join(dest, `${stem}.avif`);
    const smavif = join(dest, `${stem}-${SQ_SM}.avif`);

    // skip when every tier already exists AND is newer than the source
    const [js, ss] = await Promise.all([stat(jpg).catch(() => null), stat(f).catch(() => null)]);
    if (js && ss && await Bun.file(avif).exists() && await Bun.file(smavif).exists() && js.mtimeMs > ss.mtimeMs) {
      tSkip++; process.stdout.write("·"); continue;
    }

    try {
      let work = join(inter, `${stem}.jpg`);
      await $`${bin.sips} -Z 2000 -s format jpeg --setProperty formatOptions 100 ${f} --out ${work}`.quiet();

      const o = (await $`exif-sooc -s -s -s -n -Orientation ${f}`.quiet().nothrow()).stdout.toString();
      const flags = orientationFlags(o);
      if (flags.length) {
        const r = await $`${MOZ_JTRAN} -copy none ${flags} ${work}`.quiet().nothrow();
        if (r.exitCode === 0) {
          const rot = join(inter, `${stem}.rot.jpg`);
          await Bun.write(rot, r.stdout);
          work = rot;
        }
      }

      const dims = (await $`${bin.sips} -g pixelWidth -g pixelHeight ${work}`.quiet()).stdout.toString();
      const w = Number(dims.match(/pixelWidth:\s*(\d+)/)?.[1]);
      const h = Number(dims.match(/pixelHeight:\s*(\d+)/)?.[1]);
      if (!w || !h) { tFail++; process.stdout.write("x"); continue; }

      const tif = join(inter, `${stem}.tif`);
      const sqt = join(inter, `${stem}.sq.tif`);
      const sq = join(inter, `${stem}.sq.png`);
      await $`${bin.sips} -s format tiff ${work} --out ${tif}`.quiet();
      await $`${bin.sips} -Z ${longEdgeFor(w, h, SQ)} ${tif}`.quiet();
      await $`${bin.sips} -c ${SQ} ${SQ} ${tif} --out ${sqt}`.quiet();
      await $`${bin.sips} -s format png ${sqt} --out ${sq}`.quiet();

      await $`${zenc} ${sq} ${jpg} -q ${ZENC_Q}`.quiet();
      await $`exif-sooc -all= -overwrite_original ${jpg}`.quiet().nothrow();
      if ((await avifEncode(sq, avif)).exitCode !== 0) { tFail++; process.stdout.write("x"); continue; }

      for (const [edge, out] of [[SQ_SM, smavif], [SQ_XS, join(dest, `${stem}-${SQ_XS}.avif`)]] as const) {
        const scaled = join(inter, `${stem}.${edge}.png`);
        const r = await $`${bin.sips} -Z ${edge} ${sq} --out ${scaled}`.quiet().nothrow();
        if (r.exitCode === 0) { if ((await avifEncode(scaled, out)).exitCode !== 0) process.stdout.write("~"); }
      }
      tOk++; process.stdout.write(".");
    } catch {
      tFail++; process.stdout.write("x");
    }
  }
  console.log(`\n  generated: ${tOk}  skipped (current): ${tSkip}  failed: ${tFail}\n`);

  // ── phase 2: HIF -> full-res JPG ──────────────────────────────────────────
  console.log("phase 2 — HIF → full-res JPG exports");
  let hOk = 0, hSkip = 0, hFail = 0;
  for (const f of list) {
    if (!IS_HEIF.test(f)) continue;
    const stem = basename(f, extname(f));
    // a JPG sibling in the source folder IS the share copy; do not make a second
    const siblings = await readdir(dirname(f));
    if (siblings.some((s) => new RegExp(`^${stem}\\.jpe?g$`, "i").test(s))) { hSkip++; process.stdout.write("→"); continue; }

    const out = join(exports_, `${stem}.jpg`);
    const png = join(exports_, `${stem}.decode.png`);
    const okDecode = (await $`${bin.sips} -s format png ${f} --out ${png}`.quiet().nothrow()).exitCode === 0;
    // q100 4:2:2 because Fuji HIF is 4:2:2 native; 4:4:4 would be a byte tax
    const okEnc = okDecode && (await $`${zenc} ${png} ${out} -q 100 --yuv 422`.quiet().nothrow()).exitCode === 0;
    const okExif = okEnc && (await $`exif-sooc -TagsFromFile ${f} -all:all -overwrite_original ${out}`.quiet().nothrow()).exitCode === 0;
    await rm(png, { force: true });
    if (okExif) { hOk++; process.stdout.write("."); } else { hFail++; process.stdout.write("x"); }
  }
  console.log(`\n  exported: ${hOk}  skipped (JPG sibling exists): ${hSkip}  failed: ${hFail}\n`);

  // ── phase 3: R2 ───────────────────────────────────────────────────────────
  const staged = new Map<string, string>();       // stem -> the bytes that go to R2
  if (remoteOnly) {
    console.log("phase 3 — R2 uploads skipped (source is already remote)");
  } else {
    console.log("phase 3 — R2 uploads (parallel 4)");
  }
  const upload = async (key: string, file: string) => {
    const r = await $`${wrangler} r2 object put ${`aadhar-photos/${key}`} --file=${file} --content-type=image/jpeg --remote`.quiet().nothrow();
    process.stdout.write(r.exitCode === 0 ? "." : "x");
  };
  /** Progressive rewrite is lossless and shrinks the share copy; fall back to the
   *  original bytes if jpegtran refuses rather than uploading nothing. */
  const prepOriginal = async (src: string, out: string) => {
    const r = await $`${MOZ_JTRAN} -progressive -copy all -outfile ${out} ${src}`.quiet().nothrow();
    return r.exitCode === 0 && (await stat(out).catch(() => null))?.size ? out : src;
  };

  const pool = async <T>(items: T[], n: number, fn: (t: T) => Promise<void>) => {
    for (let i = 0; i < items.length; i += n) await Promise.all(items.slice(i, i + n).map(fn));
  };

  const originals = list.filter((f) => !IS_HEIF.test(f));
  await pool(originals, 4, async (f) => {
    const stem = basename(f, extname(f));
    const ext = extname(f).slice(1).toLowerCase();
    const send = await prepOriginal(f, join(progdir, `${stem}.${ext}`));
    staged.set(stem, send);
    if (!remoteOnly) await upload(`${stem}.${ext}`, send);
  });
  if (!remoteOnly) console.log("");

  const exported = (await readdir(exports_)).filter((f) => f.endsWith(".jpg"));
  for (const f of exported) staged.set(basename(f, ".jpg"), join(exports_, f));
  if (!remoteOnly && exported.length) {
    console.log("  HIF JPG exports:");
    await pool(exported, 4, (f) => upload(f, join(exports_, f)));
    console.log("");
  }

  // ── phase 4: index + metadata ─────────────────────────────────────────────
  console.log("\nphase 4 — hash tiers + photo index + metadata regen");
  await $`bun ${join(root, "tools/photos/hash-thumbnails.ts")}`.nothrow();

  const indexFile = join(root, "src/worker/photo-index.json");
  const now = new Date().toISOString().replace(/\.\d+Z$/, ".000Z");
  const index: Record<string, { full: string; size: number; uploaded: string }> =
    JSON.parse(await Bun.file(indexFile).text().catch(() => "{}"));

  for (const f of list) {
    const stem = basename(f, extname(f));
    const ext = extname(f).slice(1).toLowerCase();
    const key = IS_HEIF.test(f) ? `${stem}.jpg` : `${stem}.${ext}`;
    const obj = staged.get(stem);
    if (!obj || !(await Bun.file(obj).exists())) {
      console.error(`  index: no staged bytes for ${stem} — entry skipped (photos:check will flag it)`);
      continue;
    }
    // uploaded is PRESERVED for a photo already in the index: it records when the
    // photo first shipped, not when this run touched it.
    index[stem] = { full: key, size: (await stat(obj)).size, uploaded: index[stem]?.uploaded ?? now };
  }
  // jq -S: keys sorted, at every level
  const sortedIndex = Object.fromEntries(
    Object.keys(index).sort().map((k) => [k, Object.fromEntries(Object.keys(index[k]).sort().map((j) => [j, (index[k] as never)[j]]))]),
  );
  await Bun.write(indexFile, JSON.stringify(sortedIndex, null, 2) + "\n");
  console.log(`  photo index: ${Object.keys(sortedIndex).length} entries`);

  // NOT inputs.find(async …): an async predicate returns a promise, which is
  // always truthy, so find() would hand back the first argument whatever it is.
  let metaSrc = "";
  for (const a of inputs) {
    if ((await stat(a).catch(() => null))?.isDirectory()) { metaSrc = a; break; }
  }
  if (!metaSrc) metaSrc = dirname(list[0]);
  const metaArgs = remoteOnly ? ["--merge", metaSrc] : [metaSrc];
  await $`bun ${join(root, "tools/photos/extract-photo-metadata.ts")} ${metaArgs}`.nothrow();

  // was --root "$PROJECT_DIR/www", a directory that stopped existing at the split
  await $`${zenc} histogram --root ${join(root, "public")}`.nothrow();

  const captions = await $`python3 ${join(root, "tools/photos/gen-alt-text.py")}`.nothrow();
  if (captions.exitCode !== 0) console.log("  captions incomplete — re-run 'bun run captions' before deploying");

  await $`bun ${join(root, "tools/photos/check-photo-pipeline.mjs")}`.nothrow();

  await rm(tmp, { recursive: true, force: true });
  console.log("\n✓ done. deploy with:\n    bun run deploy:direct");
}
