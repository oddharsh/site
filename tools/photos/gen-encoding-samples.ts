#!/usr/bin/env bun
//
// gen-encoding-samples.ts — regenerate the COLOR sample set for the
// /garage/encoding study from a single SOOC original, through every encoder the
// page compares. Prints real byte counts + bytes-per-pixel so the figcaptions and
// prose can be updated to match. The grayscale (g-*) set is generated separately
// from a Leica B&W frame and is NOT touched here.
//
// Subject must be a genuinely COLORFUL, detailed frame (the study is about color
// formats + chroma subsampling): XT509338 (Porsche: red calipers, yellow car,
// blue accent, silver wheel, cobblestone).
//
//   bun tools/photos/gen-encoding-samples.ts [STEM] [SRC_DIR_OR_FILE] [--dest <dir>]
//
// With no source argument the committed 400x266 PNG fixture is used, so the
// study can be regenerated remotely without the private SOOC archive.
//
// ── a bug the conversion fixes ────────────────────────────────────────────
// The shell version ran its exif-sooc VERSION GATE at the very end, after every
// write that depends on it. A too-old exif-sooc would therefore strip nothing
// (or, at 0.1.0, truncate every progressive JPEG at its first scan), the script
// would publish those files, and only then would it announce that the binary was
// unusable. Its sibling gen-encoding-grids runs the same gate FIRST, which is
// where it belongs and where this one now runs it.
import { $ } from "bun";
import { mkdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureZenc, requireBins } from "./lib/prereqs.ts";
import { EXIF_SOOC_MIN, versionAtLeast } from "./gen-encoding-grids.ts";

export const REQUIRES = ["sips", "cwebp", "avifenc", "exif-sooc"] as const;

const AV = ["--speed", "4", "--jobs", "4", "--ignore-icc", "--ignore-exif", "--ignore-xmp"];

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const destFlag = argv.indexOf("--dest");
  const positional = destFlag === -1 ? argv : argv.slice(0, destFlag);
  const bin = requireBins(REQUIRES);

  // FIRST, not last. See the note above.
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

  const stem = positional[0] || "XT509338";
  const sourceArg = positional[1] || join(dest, "c-png.png");

  let src = "";
  if (await Bun.file(sourceArg).exists()) {
    src = sourceArg;
  } else {
    for (const e of ["HIF", "hif", "HEIC", "heic", "jpg", "JPG"]) {
      const candidate = join(sourceArg, `${stem}.${e}`);
      if (await Bun.file(candidate).exists()) { src = candidate; break; }
    }
  }
  if (!src) {
    console.error(`no source for ${stem} in ${sourceArg}`);
    process.exit(1);
  }
  const zenc = await ensureZenc();
  console.log(`source: ${src}`);

  const tmp = join(tmpdir(), `enc-gen-${process.pid}`);
  await mkdir(tmp, { recursive: true });

  try {
    // lossless PNG intermediate at exact 400x266 (3:2). every encoder reads this
    // same base, so the comparison is apples-to-apples.
    const base = join(tmp, "base400.png");
    await $`${bin.sips} -s format png -Z 400 ${src} --out ${join(tmp, "b.png")}`.quiet();
    await $`${bin.sips} -c 266 400 ${join(tmp, "b.png")} --out ${base}`.quiet();

    const W = 400, H = 266, PX = W * H;
    const size = async (f: string) => (await stat(f)).size;
    const kb = (b: number) => (b / 1024).toFixed(1);
    const bpp = (b: number) => (b / PX).toFixed(2);
    const report = async (f: string) => {
      const b = await size(join(dest, f));
      console.log(`  ${f.padEnd(18)} ${String(b).padStart(8)} B   ${kb(b).padStart(6)} KB   ${bpp(b)} b/px`);
    };

    // ── color set ────────────────────────────────────────────────────────────
    await Bun.write(join(dest, "c-png.png"), Bun.file(base));    // lossless baseline
    await $`${bin.sips} -s format jpeg --setProperty formatOptions 82 ${base} --out ${join(dest, "c-sips82.jpg")}`.quiet();
    // zenc quality ladder; q84 is the shipped thumbnail setting (the old jpegli q82).
    for (const q of [62, 84, 95]) await $`${zenc} ${base} ${join(dest, `c-zc${q}.jpg`)} -q ${q}`.quiet();
    await $`exif-sooc -all= -overwrite_original ${join(dest, "c-sips82.jpg")} ${[62, 84, 95].map((q) => join(dest, `c-zc${q}.jpg`))}`.quiet().nothrow();

    for (const q of [60, 80]) await $`${bin.cwebp} -q ${q} ${base} -o ${join(dest, `c-wp${q}.webp`)}`.quiet();

    for (const [q, yuv, name] of [[40, "420", "c-av40"], [63, "420", "c-av63"], [85, "420", "c-av85"], [63, "444", "c-av63-444"]] as const) {
      await $`${bin.avifenc} -q ${q} --yuv ${yuv} ${AV} ${base} ${join(dest, `${name}.avif`)}`.quiet();
    }

    console.log(`\nCOLOR set (${W}x${H}, ${PX}px):`);
    for (const f of ["c-png.png", "c-sips82.jpg", "c-zc62.jpg", "c-zc84.jpg", "c-zc95.jpg",
      "c-wp60.webp", "c-wp80.webp", "c-av40.avif", "c-av63.avif", "c-av85.avif", "c-av63-444.avif"]) {
      await report(f);
    }

    // ── resolution table: avif q63 4:2:0 vs zenc q84 at 400 / 800 / 1200 ─────
    console.log("\nRESOLUTION table (avif q63 4:2:0  ·  zenc q84):");
    for (const [long, w, h] of [[400, 400, 266], [800, 800, 533], [1200, 1200, 800]] as const) {
      const b = join(tmp, `r${long}.png`);
      await $`${bin.sips} -s format png -Z ${long} ${src} --out ${join(tmp, "rb.png")}`.quiet();
      await $`${bin.sips} -c ${h} ${w} ${join(tmp, "rb.png")} --out ${b}`.quiet();
      await $`${bin.avifenc} -q 63 --yuv 420 ${AV} ${b} ${join(tmp, `r${long}.avif`)}`.quiet();
      const av = await size(join(tmp, `r${long}.avif`));
      await $`${zenc} ${b} ${join(tmp, `r${long}.jpg`)} -q 84`.quiet();
      await $`exif-sooc -all= -overwrite_original ${join(tmp, `r${long}.jpg`)}`.quiet().nothrow();
      const jl = await size(join(tmp, `r${long}.jpg`));
      const save = ((1 - av / jl) * 100).toFixed(0);
      console.log(`  ${w}x${h}   AVIF ${kb(av).padStart(6)} KB   zenc ${kb(jl).padStart(6)} KB   AVIF saves ${save}%`);
    }

    console.log("\ndone — update figcaptions/prose/table in src/pages/garage/encoding.html to match.");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}
