#!/usr/bin/env bun
// reencode-thumbnails.ts — re-encode ALL published grid thumbnails from the
// canonical source folder, in place, as PRE-CROPPED CENTER SQUARES: exactly what
// the homepage grid shows (aspect-ratio:1 + object-fit:cover). The file IS the
// displayed pixels, so no off-square bytes are shipped.
//
//   bun tools/photos/reencode-thumbnails.ts [SRC_DIR] [--dest <dir>]
//   SQ=600 SQ_SM=400 SQ_XS=200 TIERS=sq,sm,xs bun tools/photos/reencode-thumbnails.ts
//
// Three square tiers, all AVIF, plus one SQ JPG as the no-AVIF fallback:
//   SQ    desktop square (600 — the ~197px tile at DPR-3)
//   SQ_SM mobile square  (400 — the ~100px tile, served via <source media>)
//   SQ_XS 1x square      (200 — the 184px tile at DPR-1)
// SQ_SM and SQ_XS must match THUMB_SMALL_PX / the -<N>.avif suffixes the Worker
// expects.
//
// Deliberately does NOT touch R2 (it holds q100 JPG share copies, not
// originals), metadata.json (its width/height are the ORIGINAL dims), or the
// full-res click export. The source folder may be a disposable directory
// downloaded from R2 by the remote workflow.
import { $ } from "bun";
import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { ensureZenc, requireBins } from "./lib/prereqs.ts";
import { EXIF_SOOC_MIN, versionAtLeast } from "./gen-encoding-grids.ts";

export const REQUIRES = ["sips", "exif-sooc", "avifenc"] as const;

/** calibrated to match the retired cjpegli q82 quality at fewer bytes */
export const ZENC_Q = 84;
/** mozjpeg is keg-only, so a bare jpegtran is libjpeg-turbo's */
export const MOZ_JTRAN = "/opt/homebrew/opt/mozjpeg/bin/jpegtran";

/** EXIF orientation to the LOSSLESS jpegtran transform that bakes it in.
 *  avifenc and zenc both strip EXIF, so the rotation has to become pixels. */
export function orientationFlags(orientation: string): string[] {
  switch (orientation.trim()) {
    case "2": return ["-flip", "horizontal"];
    case "3": return ["-rotate", "180"];
    case "4": return ["-flip", "vertical"];
    case "5": return ["-transpose"];
    case "6": return ["-rotate", "90"];
    case "7": return ["-transverse"];
    case "8": return ["-rotate", "270"];
    default: return [];
  }
}

/** Resize the SHORT edge up to `sq` keeping aspect, so the centered crop has
 *  pixels to take. Integer ceiling, matching the shell's (SQ*H + W-1)/W. */
export const longEdgeFor = (w: number, h: number, sq: number) =>
  w <= h ? Math.ceil((sq * h) / w) : Math.ceil((sq * w) / h);

/** Published stems come from the content-hashed JPG tiles: <stem>.<hash8>.jpg */
export const stemOfHashed = (file: string) => basename(file, ".jpg").replace(/\.[^.]*$/, "");

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const destFlag = argv.indexOf("--dest");
  const positional = destFlag === -1 ? argv : argv.slice(0, destFlag);
  const bin = requireBins(REQUIRES);

  const root = new URL("../../", import.meta.url).pathname;
  const dest = destFlag === -1 ? join(root, "public/images") : argv[destFlag + 1];
  const src = positional[0] || "/Users/aadharsh/Downloads/to post (from ssd)";

  const SQ = Number(process.env.SQ || 600);
  const SQ_SM = Number(process.env.SQ_SM || 400);
  const SQ_XS = Number(process.env.SQ_XS || 200);
  const tiers = new Set((process.env.TIERS || "sq,sm,xs").split(","));

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
  if (!(await stat(src).catch(() => null))?.isDirectory()) {
    console.error(`error: source folder not found: ${src}`);
    process.exit(1);
  }
  await mkdir(dest, { recursive: true });

  const SOURCE_EXT = /\.(jpg|jpeg|png|hif|heic|heif)$/i;
  const sourceFiles = await readdir(src);
  const findSource = (stem: string) =>
    sourceFiles.find((f) => f.startsWith(stem + ".") && SOURCE_EXT.test(f));

  const stems = [...new Set(
    (await readdir(join(root, "public/i"))).filter((f) => f.endsWith(".jpg")).map(stemOfHashed),
  )].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  if (!stems.length) {
    console.error("error: no published thumbnails found in public/i/ (expected the content-hashed JPG tiles)");
    process.exit(1);
  }

  console.log(`re-encoding ${stems.length} thumbnails as ${SQ}x${SQ} / ${SQ_SM}x${SQ_SM} center squares  (zenc q${ZENC_Q} + AVIF via avifenc)`);
  console.log(`  source: ${src}\n`);

  const tmp = join(tmpdir(), `aadhar-reencode-${process.pid}`);
  const inter = join(tmp, "inter");
  await mkdir(inter, { recursive: true });

  let ok = 0, miss = 0, fail = 0;
  const avif = async (input: string, out: string, yuv: string) =>
    $`${bin.avifenc} -q 63 -d 10 --ignore-icc --ignore-exif --ignore-xmp --speed 4 --jobs 4 --yuv ${yuv} ${input} ${out}`.quiet();

  try {
    for (const stem of stems) {
      const found = findSource(stem);
      if (!found) { miss++; process.stdout.write("?"); continue; }
      const source = join(src, found);

      try {
        let work = join(inter, stem + ".jpg");
        // 1. decode source -> working JPG (long edge 2000, ample to crop a sharp square)
        await $`${bin.sips} -Z 2000 -s format jpeg --setProperty formatOptions 100 ${source} --out ${work}`.quiet();

        // 2. lossless EXIF-orientation rotation, baked in as pixels
        const o = (await $`exif-sooc -s -s -s -n -Orientation ${source}`.quiet().nothrow()).stdout.toString();
        const flags = orientationFlags(o);
        if (flags.length) {
          const rot = join(inter, stem + ".rot.jpg");
          const r = await $`${MOZ_JTRAN} -copy none ${flags} ${work}`.quiet().nothrow();
          if (r.exitCode === 0) { await Bun.write(rot, r.stdout); work = rot; }
        }

        // 3. center-crop to a square, on LOSSLESS intermediates. These used to run
        //    on the JPEG, and `sips -Z` / `sips -c` each decode and re-encode, so
        //    what reached zenc had been through three JPEG encodes rather than
        //    one. Measured over the corpus: median ssimulacra2 68.97 -> 80.20,
        //    better on 159 of 159 photos, for 1.1% more bytes.
        const dims = (await $`${bin.sips} -g pixelWidth -g pixelHeight ${work}`.quiet()).stdout.toString();
        const w = Number(dims.match(/pixelWidth:\s*(\d+)/)?.[1]);
        const h = Number(dims.match(/pixelHeight:\s*(\d+)/)?.[1]);
        if (!w || !h) { fail++; process.stdout.write("x"); continue; }

        const tif = join(inter, stem + ".tif");
        const sqt = join(inter, stem + ".sq.tif");
        const sqPng = join(inter, stem + ".sq.png");
        await $`${bin.sips} -s format tiff ${work} --out ${tif}`.quiet();
        await $`${bin.sips} -Z ${longEdgeFor(w, h, SQ)} ${tif}`.quiet();
        await $`${bin.sips} -c ${SQ} ${SQ} ${tif} --out ${sqt}`.quiet();
        await $`${bin.sips} -s format png ${sqt} --out ${sqPng}`.quiet();

        // 4. metadata is stripped: the grid reads EXIF from metadata.json, so
        //    embedded EXIF/XMP/ICC here is dead weight (~1.5KB/AVIF, up to ~5KB).
        const space = (await $`${bin.sips} -g space ${sqPng}`.quiet().nothrow()).stdout.toString();
        const yuv = /space:\s*Gray/.test(space) ? "400" : "420";

        if (tiers.has("sq")) {
          await $`${zenc} ${sqPng} ${join(dest, stem + ".jpg")} -q ${ZENC_Q}`.quiet();
          await $`exif-sooc -all= -overwrite_original ${join(dest, stem + ".jpg")}`.quiet().nothrow();
          await avif(sqPng, join(dest, stem + ".avif"), yuv);
        }
        // 5/6. the smaller tiers come from the same lossless square, so each is ONE
        //      encode from the source rather than a resize of a resize.
        for (const tierSpec of [{ name: "sm", edge: SQ_SM }, { name: "xs", edge: SQ_XS }]) {
          const tier: string = tierSpec.name;
          const edge: number = tierSpec.edge;
          if (!tiers.has(tier)) continue;
          const scaled = join(inter, stem + "." + tier + ".png");
          const r = await $`${bin.sips} -Z ${edge} ${sqPng} --out ${scaled}`.quiet().nothrow();
          if (r.exitCode !== 0) { process.stdout.write("~"); continue; }
          await avif(scaled, join(dest, stem + "-" + String(edge) + ".avif"), yuv).catch(() => process.stdout.write("~"));
        }
        ok++;
        process.stdout.write(".");
      } catch {
        fail++;
        process.stdout.write("x");
      }
    }
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }

  console.log(`\n\n  re-encoded: ${ok}   source-missing: ${miss}   failed: ${fail}`);
  console.log("  next: re-run hash-thumbnails.ts (new bytes mint new /i/ URLs), commit,");
  console.log("  then deploy — the worker bundles photo-index.json + hashes.json, so");
  console.log("  the deploy IS the cache bust.");
}
