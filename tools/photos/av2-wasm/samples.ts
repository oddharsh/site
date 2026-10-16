// samples.ts: write the AV2 files /garage/av2 decodes in the browser.
//
// For each stem: cut the 600px tile exactly as add-photos.sh does (a HIF goes
// through sips to a lossless TIFF first, then zenc square with the photo's EXIF
// orientation and the box filter), let zenc write its AVIF tier beside the PNG,
// and REFUSE to continue unless that AVIF matches the /i/ file this site serves
// byte for byte. zenc's AVIF tier is avifenc run on that same 8-bit PNG (its
// avif_tiers_match_the_installed_cli test), so the PNG is the pixels the shipped
// AV1 file started from. Then write the largest AV2 file at or under the shipped
// size, from the same PNG, plus a lossless WebP of the PNG for the page's
// "source" view. The AV1 half is the real shipped file and the AV2 half never
// gets extra bytes. Scores are ssimulacra2 against the tile, both decodes at full
// depth.
//
// The originals are Fuji JPGs and HIFs (XT5*) and Leica JPGs (L1*); a Leica
// Monochrom tile is 8-bit gray, so both codecs code it as 4:0:0, the way zenc
// codes the shipped one.
//
// usage: bun tools/photos/av2-wasm/samples.ts --src <originals> --stems a,b,c
//          [--build <av2-tone encoder build dir>] [--zenc <zenc binary>]
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AV2_BUILD } from "../av2-tone.ts";

const HERE = import.meta.dir;
const REPO = path.resolve(HERE, "../../..");
const argv = process.argv.slice(2);
const arg = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const BUILD = path.resolve(arg("build") ?? AV2_BUILD);
const ZENC = path.resolve(arg("zenc") ?? path.join(HERE, "../zenc/target/release/zenc"));
const OUT = path.join(REPO, "public/garage/av2");
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "av2-samples-"));
// av2-tile-probe.ts's base AV2 arm, with zenc's ignore flags so neither codec
// reads metadata the other doesn't
const AVM = ["-c", "avm", "-d", "10", "--speed", "6", "-a", "sb-size=128", "--jobs", "4", "--ignore-icc", "--ignore-exif", "--ignore-xmp"];
const SOURCES = [".HIF", ".JPG", ".jpg"];

async function sh(cmd: string[]): Promise<string> {
  const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const [out, err] = [await new Response(p.stdout).text(), await new Response(p.stderr).text()];
  if ((await p.exited) !== 0) throw new Error(`${path.basename(cmd[0])} failed:\n${err.slice(-600)}`);
  return out;
}
const STEM = /^[A-Za-z0-9_-]+$/;
const HASH8 = /^[0-9a-f]{8}$/;
const s2 = async (ref: string, png: string) => Number.parseFloat(await sh(["ssimulacra2", ref, png]));

async function sample(src: string, stem: string) {
  if (!STEM.test(stem)) throw new Error(`${JSON.stringify(stem)} is not a photo stem like XT507488`);
  const ext = SOURCES.find((e) => fs.existsSync(path.join(src, stem + e)));
  if (!ext) throw new Error(`${stem}: no ${SOURCES.join(", ")} original in ${src}`);
  const file = path.join(src, stem + ext);
  const kind = stem.startsWith("L1") ? "Leica JPG" : ext === ".HIF" ? "Fuji HIF" : "Fuji JPG";
  const o = Number((await sh(["exif-sooc", "-s", "-s", "-s", "-n", "-Orientation", file])).trim() || 1);
  let input = file;
  if (ext === ".HIF") {
    input = path.join(WORK, `${stem}.tif`);
    await sh(["sips", "-s", "format", "tiff", file, "--out", input]);
  }
  const tile = path.join(WORK, `${stem}.png`),
    avif = path.join(WORK, `${stem}.av1.avif`);
  await sh([ZENC, "square", input, "--orient", String(o >= 1 && o <= 8 ? o : 1), "--filter", "box", "--size", "600", "--out", tile, "--avif-out", avif]);
  if (input !== file) fs.rmSync(input);

  // <stem>.<hash8>.avif, matched as strings: the stem is a CLI argument, so it
  // never becomes part of a pattern
  const shipped = fs
    .readdirSync(path.join(REPO, "public/i"))
    .find((f) => f.startsWith(`${stem}.`) && f.endsWith(".avif") && HASH8.test(f.slice(stem.length + 1, -".avif".length)));
  if (!shipped) throw new Error(`${stem}: no shipped 600px AVIF in public/i`);
  const want = fs.readFileSync(path.join(REPO, "public/i", shipped));
  if (!want.equals(fs.readFileSync(avif))) throw new Error(`${stem}: zenc's AVIF differs from /i/${shipped}, so the tile is not the shipped tile's source`);
  const budget = want.length;
  // PNG colour type, IHDR byte 25: 0 is gray
  const gray = fs.readFileSync(tile)[25] === 0;

  // a higher qp writes a smaller file: find the lowest qp that fits
  let lo = 0,
    hi = 255,
    best = -1;
  while (lo <= hi) {
    const qp = (lo + hi) >> 1,
      out = path.join(WORK, `${stem}.${qp}.avif`);
    await sh([path.join(BUILD, "avifenc"), ...AVM, "--yuv", gray ? "400" : "444", "-a", `qp=${qp}`, tile, out]);
    if (fs.statSync(out).size <= budget) {
      best = qp;
      hi = qp - 1;
    } else lo = qp + 1;
  }
  if (best < 0) throw new Error(`${stem}: no AV2 qp fits ${budget} B`);
  const av2 = path.join(WORK, `${stem}.${best}.avif`);
  const av1png = path.join(WORK, `${stem}.av1.png`),
    av2png = path.join(WORK, `${stem}.av2.png`);
  await sh(["avifdec", avif, av1png]);
  await sh([path.join(BUILD, "avifdec"), av2, av2png]);
  fs.copyFileSync(av2, path.join(OUT, `${stem}-av2.avif`));
  const ref = path.join(OUT, `${stem}-src.webp`);
  await sh(["cwebp", "-quiet", "-lossless", "-exact", "-z", "9", "-metadata", "none", tile, "-o", ref]);
  return {
    stem,
    kind,
    gray,
    shipped: `/i/${shipped}`,
    av1Bytes: budget,
    av2Bytes: fs.statSync(av2).size,
    srcBytes: fs.statSync(ref).size,
    qp: best,
    bpp: +((budget * 8) / 360000).toFixed(2),
    av1S2: +(await s2(tile, av1png)).toFixed(2),
    av2S2: +(await s2(tile, av2png)).toFixed(2),
  };
}

const src = arg("src"),
  stems = arg("stems")?.split(",");
if (!src || !stems) {
  console.error("usage: bun tools/photos/av2-wasm/samples.ts --src <originals> --stems a,b,c");
  process.exit(2);
}
try {
  const rows = await Promise.all(stems.map((s) => sample(src, s)));
  for (const r of rows) console.log(JSON.stringify(r));
} finally {
  fs.rmSync(WORK, { recursive: true, force: true });
}
