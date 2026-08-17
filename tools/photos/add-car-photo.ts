#!/usr/bin/env bun
// add-car-photo.ts — process one resto-mod reference photo into the dual-encoded
// AVIF + JPG pair the homepage car-link tooltips expect.
//
//   bun tools/photos/add-car-photo.ts <stem> <input-image>
//
// stem is one of: singer | tuthill | hwa-evo | f355  (matches data-car-* in
// src/pages/index.html). input can be any format sips reads.
//
// Output: public/cars/<stem>.{avif,jpg}, long edge capped at 480px (2x the
// 240x160 tooltip box, so it stays crisp on retina while staying tiny). The
// tooltip CSS does object-fit:cover, so the source aspect ratio is preserved
// here and cropped at render, no distortion.
//
// No EXIF, no R2: these are small static reference images, not gallery photos.
import { $ } from "bun";
import { mkdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureZenc, requireBins } from "./lib/prereqs.ts";

// Declared as a VALUE so `tools:check` can read it instead of scraping shell.
// This is the whole point of the conversion; see lib/prereqs.ts.
export const REQUIRES = ["sips", "avifenc"] as const;

// Guarded so the file can be IMPORTED for its REQUIRES declaration without
// running. tools:check reads that export; without this it ran the script.
if (import.meta.main) {
  const [stem, src] = process.argv.slice(2);
  if (!stem || !src) {
    console.error("usage: bun tools/photos/add-car-photo.ts <stem> <input-image>");
    process.exit(1);
  }
  if (!(await Bun.file(src).exists())) {
    console.error(`no such file: ${src}`);
    process.exit(1);
  }

  const bin = requireBins(REQUIRES);
  const zenc = await ensureZenc();

  const dest = new URL("../../public/cars/", import.meta.url).pathname;
  await mkdir(dest, { recursive: true });

  // mktemp -d plus `trap rm -rf EXIT`, which is the one piece of the shell version
  // that has no direct equivalent: a finally block only runs if the process is not
  // killed, so the directory goes under the OS temp root where it is collectable.
  const tmp = join(tmpdir(), `car-${Bun.hash(stem + Date.now())}`);
  await mkdir(tmp, { recursive: true });

  try {
    const flat = join(tmp, "x.jpg");

    // 1. downscale (preserve aspect), strip to a clean sRGB JPG
    await $`${bin.sips} -Z 480 ${src} --out ${flat}`.quiet();

    // 2. JPG fallback via zenc (zenjpeg hybrid+scan, q84 is the old jpegli q82)
    await $`${zenc} ${flat} ${dest}${stem}.jpg -q 84`.quiet();

    // 3. AVIF primary. grayscale shots get yuv400; everything else yuv420.
    const space = (await $`${bin.sips} -g space ${flat}`.quiet().nothrow()).stdout.toString();
    const yuv = /space:\s*Gray/.test(space) ? "400" : "420";
    await $`${bin.avifenc} -q 63 --speed 4 --jobs 4 --ignore-icc --yuv ${yuv} ${dest}${stem}.jpg ${dest}${stem}.avif`.quiet();

    const dim = async (key: string) => {
      const out = (await $`${bin.sips} -g ${key} ${dest}${stem}.jpg`.quiet()).stdout.toString();
      return out.match(new RegExp(`${key}:\\s*(\\d+)`))?.[1] ?? "?";
    };
    const kb = async (p: string) => `${Math.round((await stat(p)).size / 1024)}K`;

    console.log(
      `${stem}: ${await dim("pixelWidth")}x${await dim("pixelHeight")}` +
      `  jpg ${await kb(`${dest}${stem}.jpg`)}  avif ${await kb(`${dest}${stem}.avif`)}`,
    );
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}
