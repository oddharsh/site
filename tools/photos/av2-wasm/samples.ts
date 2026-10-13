// samples.ts: write the AV2 files /garage/av2 decodes in the browser.
//
// For each stem: cut the 600px tile exactly as av2-tile-probe.ts does (zenc
// square, EXIF orientation, box filter), re-encode the shipped AVIF from it and
// REFUSE to continue unless the bytes match the /i/ file this site serves, then
// write the largest AV2 file at or under that size. The page puts the two side
// by side, so the AV1 half is the real shipped file and the AV2 half never gets
// extra bytes. Scores are ssimulacra2 against the tile, both decodes at full depth.
//
// usage: bun tools/photos/av2-wasm/samples.ts --src <originals> --stems a,b,c
//          [--build <libavif-avm build dir>] [--zenc <zenc binary>]
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HERE = import.meta.dir;
const REPO = path.resolve(HERE, "../../..");
const argv = process.argv.slice(2);
const arg = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const BUILD = path.resolve(arg("build") ?? path.join(HERE, "../libavif-avm/build"));
const ZENC = path.resolve(arg("zenc") ?? path.join(HERE, "../zenc/target/release/zenc"));
const OUT = path.join(REPO, "public/garage/av2");
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "av2-samples-"));
// av2-tile-probe.ts's base AV2 arm and its AVIF control, unchanged
const AVM = ["-c", "avm", "-d", "10", "--speed", "6", "--yuv", "444", "-a", "sb-size=128", "--jobs", "4"];
const AVIF = ["-q", "63", "-d", "10", "--speed", "2", "--yuv", "444", "--jobs", "4"];

async function sh(cmd: string[]): Promise<string> {
  const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const [out, err] = [await new Response(p.stdout).text(), await new Response(p.stderr).text()];
  if ((await p.exited) !== 0) throw new Error(`${path.basename(cmd[0])} failed:\n${err.slice(-600)}`);
  return out;
}
const s2 = async (ref: string, png: string) => Number.parseFloat(await sh(["ssimulacra2", ref, png]));

async function sample(src: string, stem: string) {
  const file = path.join(src, `${stem}.JPG`);
  const o = Number(/"Orientation":\s*(\d)/.exec(await sh(["exif-sooc", "-n", "-Orientation", file]))?.[1] ?? 1);
  const tile = path.join(WORK, `${stem}.png`);
  await sh([ZENC, "square", file, "--orient", String(o >= 1 && o <= 8 ? o : 1), "--filter", "box", "--size", "600", "--out", tile]);

  const shipped = fs.readdirSync(path.join(REPO, "public/i")).find((f) => new RegExp(`^${stem}\\.[0-9a-f]{8}\\.avif$`).test(f));
  if (!shipped) throw new Error(`${stem}: no shipped 600px AVIF in public/i`);
  const avif = path.join(WORK, `${stem}.av1.avif`);
  await sh(["avifenc", ...AVIF, tile, avif]);
  const want = fs.readFileSync(path.join(REPO, "public/i", shipped));
  if (!want.equals(fs.readFileSync(avif))) throw new Error(`${stem}: the re-encoded AVIF differs from /i/${shipped}, so the tile is not the shipped tile's source`);
  const budget = want.length;

  // a higher qp writes a smaller file: find the lowest qp that fits
  let lo = 0, hi = 255, best = -1;
  while (lo <= hi) {
    const qp = (lo + hi) >> 1, out = path.join(WORK, `${stem}.${qp}.avif`);
    await sh([path.join(BUILD, "avifenc"), ...AVM, "-a", `qp=${qp}`, tile, out]);
    if (fs.statSync(out).size <= budget) { best = qp; hi = qp - 1; } else lo = qp + 1;
  }
  if (best < 0) throw new Error(`${stem}: no AV2 qp fits ${budget} B`);
  const av2 = path.join(WORK, `${stem}.${best}.avif`);
  const av1png = path.join(WORK, `${stem}.av1.png`), av2png = path.join(WORK, `${stem}.av2.png`);
  await sh(["avifdec", avif, av1png]);
  await sh([path.join(BUILD, "avifdec"), av2, av2png]);
  fs.copyFileSync(av2, path.join(OUT, `${stem}-av2.avif`));
  return { stem, shipped: `/i/${shipped}`, av1Bytes: budget, av2Bytes: fs.statSync(av2).size, qp: best,
    bpp: +(budget * 8 / 360000).toFixed(2), av1S2: +(await s2(tile, av1png)).toFixed(2), av2S2: +(await s2(tile, av2png)).toFixed(2) };
}

const src = arg("src"), stems = arg("stems")?.split(",");
if (!src || !stems) { console.error("usage: bun tools/photos/av2-wasm/samples.ts --src <originals> --stems a,b,c"); process.exit(2); }
try {
  const rows = await Promise.all(stems.map((s) => sample(src, s)));
  for (const r of rows) console.log(JSON.stringify(r));
} finally {
  fs.rmSync(WORK, { recursive: true, force: true });
}
