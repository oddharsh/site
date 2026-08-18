#!/usr/bin/env bun
//
// gen-encoding-grids.ts — generate the ZOOMED comparison crops for the
// /lwe/encoding study's three grids, all from ONE centered detail crop of the
// same lossless base the color study uses (garage/enc/c-png.png):
//
//   1. format x quality   — zenjpeg / WebP / AVIF, each at high/mid/low
//   2. chroma             — JPEG (mozjpeg) at 4:4:4 / 4:2:2 / 4:2:0, one quality
//   3. jpeg encoders      — baseline (sips) vs mozjpeg vs jpegli vs zenjpeg
//
// Outputs garage/enc/z-*.{jpg,webp,avif,png}. The demos fetch these live and
// measure real byte sizes, displayed pixel-zoomed so the artifacts are visible.
//
// ONE fixture this script CANNOT regenerate: z-enc-jpegli.jpg, the third cell of
// the encoder grid. cjpegli left the toolchain when the pipeline moved to zenc in
// 2026-07, so that file is frozen at the bytes jpegli produced then. It stays in
// the grid deliberately, because jpegli is the encoder that proved a standard
// JPEG could be halved and the grid reads as the sequence the site actually
// walked. Do not delete it expecting a rerun to bring it back.
//
// READ THIS BEFORE REGENERATING. The committed grids were produced by the bare
// (libjpeg-turbo) cjpeg, so the first run after the mozjpeg fix SHRINKS the
// mozjpeg cell from 1371 to 940 bytes, and that breaks the page's narrative
// rather than just its label: /lwe/encoding walks four encoders "in the order
// the site adopted them" and says each "squeezes a little harder than the last",
// which stops being true when mozjpeg (940 B) lands under zenjpeg (980 B) on
// this crop. Sizes on that page are measured live from these files, so the
// images and the copy disagree the moment you regenerate. Update the copy in the
// same commit, or do not regenerate.
//
//   bun tools/photos/gen-encoding-grids.ts [--dest <dir>]
//
// --dest exists so the conversion could be verified against a scratch directory
// without touching the committed grids.
import { $ } from "bun";
import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureZenc, requireBins } from "./lib/prereqs.ts";

export const REQUIRES = ["sips", "ffmpeg", "cwebp", "avifenc", "exif-sooc"] as const;

/**
 * exif-sooc must be new enough to WRITE, and the gate is on the version rather
 * than on a flag because every failure mode here is quiet. An older build does
 * not reject -all=: it reads it as a tag SELECTION and prints JSON, so the strip
 * does nothing. 0.1.0 went further and truncated progressive JPEGs at their
 * first scan, and every JPEG this pipeline produces is progressive.
 */
export const EXIF_SOOC_MIN = "0.2.0";

/** Anything that is not a plain x.y.z is REFUSED rather than compared. The shell
 *  used `sort -V`, which happily orders a word against a version and answers, so
 *  a garbled --version would otherwise read as new enough. */
export function versionAtLeast(found: string, min: string): boolean {
  if (!/^\d+(\.\d+)*$/.test(found)) return false;
  const a = found.split(".").map(Number);
  const b = min.split(".").map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return true;
}

// mozjpeg is KEG-ONLY, so `brew install mozjpeg` leaves its cjpeg off PATH and a
// bare `cjpeg` resolves libjpeg-turbo's instead. These grids publish a cell
// labelled "mozjpeg" on /lwe/encoding, so that silently compared the wrong
// encoder against itself: measured 2026-08-14 on one 64x64 edge, libjpeg-turbo
// 3.2.0 wrote 753 bytes where mozjpeg 4.1.5 wrote 513, a 32% gap on the exact
// axis this page teaches.
export const MOZ_CJPEG = "/opt/homebrew/opt/mozjpeg/bin/cjpeg";

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const destFlag = argv.indexOf("--dest");
  const bin = requireBins(REQUIRES);

  const version = (await $`exif-sooc --version`.quiet().nothrow()).stdout.toString().trim().split(/\s+/).at(-1) ?? "";
  if (!versionAtLeast(version, EXIF_SOOC_MIN)) {
    console.error(`error: exif-sooc ${version || "not found"} is older than ${EXIF_SOOC_MIN}, which cannot write metadata safely.`);
    console.error("  update with: cargo install --git https://github.com/oddharsh/exif-sooc exif-sooc --force");
    process.exit(1);
  }

  const dest = destFlag === -1
    ? join(new URL("../../", import.meta.url).pathname, "public/garage/enc")
    : argv[destFlag + 1];
  await mkdir(dest, { recursive: true });

  if (!(await Bun.file(MOZ_CJPEG).exists())) {
    console.error(`error: mozjpeg's cjpeg not found at ${MOZ_CJPEG} (brew install mozjpeg)`);
    console.error("       a bare cjpeg is libjpeg-turbo's and would mislabel the grid");
    process.exit(1);
  }
  const zenc = await ensureZenc();

  const tmp = join(tmpdir(), `encgrid-${process.pid}`);
  await mkdir(tmp, { recursive: true });

  try {
    // one centered 96x96 detail crop, shared by all three grids
    await $`${bin.sips} -c 96 96 ${join(dest, "c-png.png")} --out ${join(tmp, "crop.png")}`.quiet();
    // cjpeg reads PPM, not PNG (sips BMP output confuses it)
    await $`${bin.ffmpeg} -loglevel error -y -i ${join(tmp, "crop.png")} ${join(tmp, "crop.ppm")}`.quiet();
    await Bun.write(join(dest, "z-crop.png"), Bun.file(join(tmp, "crop.png")));

    const png = join(tmp, "crop.png");
    const ppm = join(tmp, "crop.ppm");

    // 1. format x quality
    for (const q of [90, 50, 22]) await $`${zenc} ${png} ${join(dest, `z-zc${q}.jpg`)} -q ${q}`.quiet();
    for (const q of [90, 50, 22]) await $`${bin.cwebp} -q ${q} ${png} -o ${join(dest, `z-wp${q}.webp`)}`.quiet();
    const av = ["--speed", "6", "--jobs", "4", "--ignore-icc", "--ignore-exif", "--ignore-xmp", "--yuv", "420"];
    for (const q of [78, 42, 18]) await $`${bin.avifenc} -q ${q} ${av} ${png} ${join(dest, `z-av${q}.avif`)}`.quiet();

    // 2. chroma subsampling (mozjpeg, one quality so only the sampling varies)
    for (const [sample, name] of [["1x1", "444"], ["2x1", "422"], ["2x2", "420"]] as const) {
      const out = await $`${MOZ_CJPEG} -quality 40 -sample ${sample} ${ppm}`.quiet();
      await Bun.write(join(dest, `z-ch${name}.jpg`), out.stdout);
    }

    // 3. jpeg encoders at the SAME quality setting (q72)
    await $`${bin.sips} -s format jpeg --setProperty formatOptions 72 ${png} --out ${join(dest, "z-enc-baseline.jpg")}`.quiet();
    const moz = await $`${MOZ_CJPEG} -quality 72 ${ppm}`.quiet();
    await Bun.write(join(dest, "z-enc-mozjpeg.jpg"), moz.stdout);
    await $`${zenc} ${png} ${join(dest, "z-enc-zenc.jpg")} -q 72`.quiet();

    const jpgs = (await readdir(dest)).filter((f) => f.startsWith("z-") && f.endsWith(".jpg")).map((f) => join(dest, f));
    await $`exif-sooc -all= -overwrite_original ${jpgs}`.quiet().nothrow();

    console.log("=== generated (96x96 crop) ===");
    for (const f of (await readdir(dest)).filter((f) => f.startsWith("z-")).sort()) {
      console.log(`  ${f.padEnd(22)} ${String((await stat(join(dest, f))).size).padStart(6)} B`);
    }
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}
