// av2-tile-probe.ts — AV2 or JPEG XL against the shipped AVIF on WHOLE-FRAME
// 600px tiles. --codec picks which; AV2 (avm) is the default.
//
// WHY THIS EXISTS BESIDE codec-knob-probe.ts. That probe scores /pixel-peeper's
// detail crops: the single most detailed 320px window of each photo, at native
// resolution, chosen to be the hardest thing an encoder sees. The 600px tier this
// site ships is something else, a whole frame reduced about 8x, and the two sit
// at different densities: the crops average 1.08 bits per pixel at the AVIF
// tier's budget, this probe's 38 tiles 0.46. AV2's standing against AV1 turns
// on exactly that. Measured 2026-09-28 on 38 tiles, pooling both: under 0.3 bpp
// AV2 won 12 of 12, and over 1.2 bpp it won 0 of 5. A verdict read off the crops
// alone described the dense end and was reported as the whole answer on
// /garage/av2 for a day.
//
// THE 38 ARE NOT THE TIER. The shipped 600px tier itself (255 XT*.avif in
// public/i, 2026-10-07) has a median of 0.67 and a mean of 0.70, and buckets
// 30 / 52 / 71 / 86 / 16 across the five bands main() prints. 82 of 255 sit
// under 0.5, where AV2 won 23 of 24 pooled calls; 173 sit above it, where it
// won 6 of 30. The budgets are right (the control below matched 38 of 38); the
// SAMPLE is thin. See WHICH PHOTOS. /garage/av2 then said the tier was a win
// for nine days, until the 2026-10-07 correction.
//
// THE TIER, MEASURED 2026-10-07: `--hif --stratify 8`, 40 tiles cut from HIF
// originals, 8 per band, control 40 of 40, same tuned build:
//   band      tiles  base Δs2  s2 wins  bu3 wins   qmseg12 Δs2  tier
//   <0.3        8     +1.11      8        8          +1.28       30
//   0.3-0.5     8     +0.54      7        6          +0.67       52
//   0.5-0.8     8     +0.32      7        5          +0.56       71
//   0.8-1.2     8     -0.82      1        0          -0.60       86
//   >1.2        8     -1.47      0        0          -1.49       16
// Bits per pixel and the base margin correlate at -0.84 (the JPG tiles: -0.33)
// and a straight fit crosses zero at 0.69, on the tier's 0.67 median. Weighted
// by the tier: base -0.04 s2, qmseg12 +0.15; AV2 wins about 148 of 255 by s2.
// The 2026-09-28 JPG set, re-run the same day as a control, reproduced its
// published numbers exactly (+0.77, 28 of 38; qmseg12 +0.89, 30 of 38).
// Pooled, the 78 tiles by band (base): <0.3 20 of 20 at +1.41, 0.3-0.5 18 of
// 20 at +0.63, 0.5-0.8 11 of 19 at +0.03, 0.8-1.2 2 of 10 at -0.21, >1.2 0 of 9
// at -1.40. Weighted by the tier: base +0.14 s2, about 135 of 255 s2 wins and
// 111 butteraugli (max-norm) wins; qmseg12 +0.30, 143 and 128. The two samples
// disagree at 0.5-0.8 (JPG 4 of 11, HIF 7 of 8), the least settled band.
// The crops lose where these tiles win (4 crops at 0.5-0.8, 0 wins), so at
// equal bits per pixel a native-resolution detail window is harder than a
// reduced whole frame, and bpp alone does not decide it.
//
// WHAT IT DOES. Each tile is cut the way add-photos.sh cuts the 600px tier, by
// `zenc square` (EXIF orientation applied, box filter, linear light). Its budget
// is the shipped AVIF encode of that tile (-q 63 -d 10 --speed 2 --yuv 444).
// Every config is searched on its own codec's knob until two encodes straddle
// the budget, both are scored against the tile, and the score is interpolated to
// the exact byte count, so every comparison is file against file at matched bytes.
//
// CONTROL. The re-encoded AVIF is compared with the shipped /i/ file byte for
// byte. A budget taken from some other encode compares against a file this site
// does not serve, so a mismatch is reported and the tile still scored, marked.
// 38 of 38 matched on 2026-10-01.
//
// JPEG XL, `--codec jxl`, asks the same question of the codec Chrome is bringing
// back (Canary 155 decodes it by default). cjxl's distance is continuous, so it
// is bisected in log space; the repack arm bisects zenc's integer JPEG quality.
// The configs are codec-knob-probe.ts's own: `base` is JXL_ARGS, what the format
// axis ships; `e7` is cjxl's default effort; `zencjxlnr` is a zenc JPEG repacked
// losslessly (cjxl -j 1, no reconstruction box), JXL's best arm on the crops.
//
// WHAT IT FOUND FOR JXL, 2026-10-01, cjxl 0.12.0 on the same 38 tiles, Δ s2
// against the shipped AVIF at matched bytes:
//   base        -7.56 mean, -7.51 median   wins 0/38   butteraugli wins 1/38
//   e7          -8.37 mean, -8.01 median   wins 0/38   butteraugli wins 1/38
//   zencjxlnr   -9.12 mean, -9.10 median   wins 1/38   butteraugli wins 0/38
// By bits per pixel (base): under 0.3 -8.77 (12 tiles), 0.3-0.5 -7.11 (12),
// 0.5-0.8 -6.94 (11), over 0.8 -6.78 (3), and no band wins a tile. That is about
// three times the 2.09 / 2.50 deficit codec-knob-probe.ts measured on the
// crops, so density cuts the opposite way for JXL than for AV2: it falls further
// behind where the budget is thin, which is where a thumbnail lives. The gap is
// the encoder rather than colour handling: at -d 0.3 one tile scores 93.1
// against AVIF -q 95's 93.9 through the same tile, decoder and metric. A Chrome
// Canary 157 load test the same day put byte-matched JXL level with AVIF on
// time-to-visible, so quality is what decides it.
//
// WHICH PHOTOS. Fuji JPEGs in --src, minus the 16 crop stems the knob probe uses
// (so nothing here was tuned on, JXL_ARGS included) and XT507495, a burst
// neighbour of the train crop XT507494. --stems overrides that with an explicit list.
// By default only .JPG originals qualify. In the photo inbox those are 43
// frames shot August to December 2025, before the camera moved to HEIF, and
// they ship sparse: mean 0.48 bpp, against 0.67 for the 119 HIF frames beside
// them and 0.74 for the tier minus all 43. The 2026-09-28 run drew from them.
//
// --hif draws from the .HIF originals instead, cut the way add-photos.sh cuts
// them: `sips -s format tiff` (lossless, 16-bit), then `zenc square` on the
// TIFF. The control below holds for that path too. --stratify n takes n stems
// per bits-per-pixel band, read off the SHIPPED /i/ AVIF, spaced evenly through
// each band, and the summary adds a tier-weighted line: each band's result
// weighted by how many of the shipped 600px tiles sit in it. That line is the
// probe's answer for the tier; the plain means describe whatever was sampled.
//
// usage: bun tools/photos/av2-tile-probe.ts --src <originals> [--codec avm|jxl]
//          [--hif] [--stratify n] [--list] [--stems a,b] [--configs base,qmseg12]
//          [--parallel n] [--build <dir>] [--json out]
// ZENC=<path> overrides the zenc binary (a worktree has no target/ of its own).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { HOLDOUT, TRAIN } from "./codec-knob-probe.ts";
import { JXL_ARGS } from "./gen-pixel-peeper.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../..");
const argv = process.argv.slice(2);
const arg = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const TUNED = path.join(HERE, "libavif-avm/build/tuned");
const BUILD = path.resolve(arg("build") ?? (fs.existsSync(path.join(TUNED, "avifenc")) ? TUNED : path.join(HERE, "libavif-avm/build")));
const ZENC = process.env.ZENC ?? path.join(HERE, "zenc/target/release/zenc");
const WORK = path.join(os.tmpdir(), "av2-tile-probe");
const EXCLUDE = new Set([...TRAIN, ...HOLDOUT, "XT507495"]);
const HASHES = JSON.parse(fs.readFileSync(path.join(REPO, "public/images/hashes.json"), "utf8")) as Record<string, { a: string }>;
const shippedAvif = (stem: string) => path.join(REPO, "public/i", `${stem}.${HASHES[stem]?.a}.avif`);
// a 600px tile is 360,000 pixels, so bits per pixel is bytes * 8 / 360000
const TILE_PX = 600 * 600;
const BANDS: [number, number][] = [[0, 0.3], [0.3, 0.5], [0.5, 0.8], [0.8, 1.2], [1.2, 99]];
const bandOf = (bpp: number) => BANDS.findIndex(([lo, hi]) => bpp >= lo && bpp < hi);
const bandName = ([lo, hi]: [number, number]) => `${lo}-${hi === 99 ? "" : hi}`;
/** Shipped 600px bits per pixel for every Fuji stem with an AVIF in public/i. */
function shippedBpp(): Map<string, number> {
  const out = new Map<string, number>();
  for (const stem of Object.keys(HASHES)) {
    if (!/^XT\d+$/.test(stem) || !HASHES[stem]?.a) continue;
    const f = shippedAvif(stem);
    if (fs.existsSync(f)) out.set(stem, (fs.statSync(f).size * 8) / TILE_PX);
  }
  return out;
}

// the AV2 arm: speed 6 with the 128px superblock a real 600px tile gets
const AVM = ["-c", "avm", "-d", "10", "--speed", "6", "--yuv", "444", "-a", "sb-size=128", "--jobs", "4"];
const QM = ["-a", "enable-qm=1", "-a", "qm-curve=1"];
const AVM_CONFIGS: Record<string, string[]> = {
  base: [],
  curve: QM,
  qmseg12: [...QM, "-a", "qmseg=1", "-a", "qmseg-level=12"],
};
// the JXL arms. zencjxlnr's flags go to the repack call, not to an encode.
const JXL_CONFIGS: Record<string, string[]> = {
  base: JXL_ARGS,
  e7: ["-e", "7"],
  zencjxlnr: ["--lossless_jpeg=1", "-e", "9", "--allow_jpeg_reconstruction=0"],
};
const REPACK = new Set(["zencjxlnr"]);
const CODECS = {
  avm: { configs: AVM_CONFIGS, defaults: "base,qmseg12" },
  jxl: { configs: JXL_CONFIGS, defaults: "base,e7,zencjxlnr" },
};
type Codec = keyof typeof CODECS;

type Score = { s2: number; bu: number; bu3: number };
// knob is AV2's qp, cjxl's distance, or zenc's JPEG quality, by config
type Point = Score & { knob: number; bytes: number };
type Result = Score & { knob: number };
type Row = { stem: string; budget: number; control: boolean; avif: Score; res: Record<string, Result> };

async function sh(cmd: string[]): Promise<string> {
  const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const [out, err] = [await new Response(p.stdout).text(), await new Response(p.stderr).text()];
  // butteraugli_main exits non-zero on a large distance and still prints both scores
  if ((await p.exited) !== 0 && !cmd[0].endsWith("butteraugli_main")) throw new Error(`${path.basename(cmd[0])} failed:\n${err.slice(-600)}`);
  return out;
}
async function score(src: string, png: string): Promise<Score> {
  const s2 = Number.parseFloat(await sh(["ssimulacra2", src, png]));
  const b = await sh(["butteraugli_main", src, png, "--pnorm", "3"]);
  const bu = Number.parseFloat(b.split("\n")[0] ?? "");
  const bu3 = Number.parseFloat(/3-norm:\s*([\d.]+)/.exec(b)?.[1] ?? "");
  if (![s2, bu, bu3].every(Number.isFinite)) throw new Error(`a metric printed no score for ${png}`);
  return { s2, bu, bu3 };
}

async function orientation(file: string): Promise<number> {
  const out = await sh(["exif-sooc", "-n", "-Orientation", file]);
  const o = Number(/"Orientation":\s*(\d)/.exec(out)?.[1] ?? 1);
  return o >= 1 && o <= 8 ? o : 1;
}
async function tile(src: string, stem: string): Promise<string> {
  const png = path.join(WORK, `${stem}.png`);
  if (!fs.existsSync(png)) {
    const jpg = path.join(src, `${stem}.JPG`);
    if (fs.existsSync(jpg)) {
      await sh([ZENC, "square", jpg, "--orient", String(await orientation(jpg)), "--filter", "box", "--size", "600", "--out", png]);
    } else {
      // add-photos.sh's HEIF door: a lossless 16-bit TIFF, then zenc. The TIFF
      // is about 311 MB, so it goes as soon as the tile is cut.
      const hif = path.join(src, `${stem}.HIF`), tif = path.join(WORK, `${stem}.tif`);
      await sh(["sips", "-s", "format", "tiff", hif, "--out", tif]);
      try {
        await sh([ZENC, "square", tif, "--orient", String(await orientation(hif)), "--filter", "box", "--size", "600", "--out", png]);
      } finally {
        fs.rmSync(tif, { force: true });
      }
    }
  }
  return png;
}

/** The score at exactly `budget` bytes, interpolated between an encode above it and one at or below. */
function straddle(a: Point, b: Point, budget: number): Result {
  const w = (a.bytes - budget) / (a.bytes - b.bytes);
  const lerp = (k: keyof Score) => a[k] + w * (b[k] - a[k]);
  return { knob: a.knob + w * (b.knob - a.knob), s2: lerp("s2"), bu: lerp("bu"), bu3: lerp("bu3") };
}

async function encodeAvm(ref: string, stem: string, cfg: string, qp: number): Promise<Point> {
  const out = path.join(WORK, "enc", `${stem}.${cfg}.${qp}.avif`), png = out.replace(/\.avif$/, ".png");
  await sh([path.join(BUILD, "avifenc"), ...AVM, ...AVM_CONFIGS[cfg], "-a", `qp=${qp}`, ref, out]);
  await sh([path.join(BUILD, "avifdec"), out, png]);
  return { knob: qp, bytes: fs.statSync(out).size, ...(await score(ref, png)) };
}
/** Bisect AV2's quantizer onto the budget (a higher qp writes a smaller file). */
async function matchedAvm(ref: string, stem: string, cfg: string, budget: number, hint: number): Promise<Result> {
  const seen = new Map<number, Point>();
  const at = async (q: number): Promise<Point> => {
    const hit = seen.get(q);
    if (hit) return hit;
    const p = await encodeAvm(ref, stem, cfg, q);
    seen.set(q, p);
    return p;
  };
  let lo = hint, hi = hint, step = 4;
  if ((await at(hint)).bytes > budget) {
    while ((await at(hi)).bytes > budget && hi < 255) { lo = hi; hi = Math.min(255, hi + step); step *= 2; }
  } else {
    while ((await at(lo)).bytes <= budget && lo > 0) { hi = lo; lo = Math.max(0, lo - step); step *= 2; }
  }
  const [minP, maxP] = [await at(lo), await at(hi)];
  if (minP.bytes <= budget || maxP.bytes > budget) throw new Error(`${stem} ${cfg}: ${budget} B is outside AV2's qp range`);
  while (hi - lo > 1) {
    const m = (lo + hi) >> 1;
    if ((await at(m)).bytes > budget) lo = m;
    else hi = m;
  }
  return straddle(await at(lo), await at(hi), budget);
}

async function encodeJxl(ref: string, stem: string, cfg: string, knob: number): Promise<Point> {
  const base = path.join(WORK, "enc", `${stem}.${cfg}.${knob.toFixed(4)}`), jxl = `${base}.jxl`, png = `${base}.png`;
  if (REPACK.has(cfg)) {
    await sh([ZENC, ref, `${base}.jpg`, "-q", String(knob), "--yuv", "420"]);
    await sh(["cjxl", `${base}.jpg`, jxl, ...JXL_CONFIGS[cfg], "--quiet"]);
  } else {
    await sh(["cjxl", ref, jxl, "-d", knob.toFixed(4), ...JXL_CONFIGS[cfg], "--quiet"]);
  }
  await sh(["djxl", jxl, png, "--quiet"]);
  return { knob, bytes: fs.statSync(jxl).size, ...(await score(ref, png)) };
}
/**
 * Bisect a JXL arm onto the budget, keeping the nearest encode on each side.
 * cjxl's distance is continuous (a higher distance writes a smaller file), so it
 * bisects in log space until the straddling pair is within 0.4% of the budget;
 * the repack's zenc quality is an integer (higher is bigger) and bisects to
 * adjacent steps.
 */
async function matchedJxl(ref: string, stem: string, cfg: string, budget: number): Promise<Result> {
  const near: { above?: Point; below?: Point } = {};
  const at = async (k: number): Promise<number> => {
    const p = await encodeJxl(ref, stem, cfg, k);
    if (p.bytes > budget) { if (!near.above || p.bytes < near.above.bytes) near.above = p; }
    else if (!near.below || p.bytes > near.below.bytes) near.below = p;
    return p.bytes;
  };
  if (REPACK.has(cfg)) {
    let lo = 5, hi = 100;
    while (lo <= hi) {
      const q = (lo + hi) >> 1;
      if ((await at(q)) > budget) hi = q - 1;
      else lo = q + 1;
    }
  } else {
    let lo = Math.log(0.05), hi = Math.log(25);
    for (let i = 0; i < 14; i++) {
      if (near.above && near.below && near.above.bytes - near.below.bytes < budget * 0.004) break;
      const mid = (lo + hi) / 2;
      if ((await at(Math.exp(mid))) > budget) lo = mid;
      else hi = mid;
    }
  }
  if (!near.above || !near.below) throw new Error(`${stem} ${cfg}: ${budget} B is outside JXL's range`);
  return straddle(near.above, near.below, budget);
}

async function probe(src: string, stem: string, codec: Codec, configs: string[]): Promise<Row> {
  const ref = await tile(src, stem);
  const avif = path.join(WORK, "enc", `${stem}.shipped.avif`);
  await sh(["avifenc", "-q", "63", "-d", "10", "--speed", "2", "--yuv", "444", "--jobs", "4", ref, avif]);
  await sh(["avifdec", avif, avif.replace(/\.avif$/, ".png")]);
  const budget = fs.statSync(avif).size;
  const shipped = shippedAvif(stem);
  const control = fs.existsSync(shipped) && Buffer.compare(fs.readFileSync(shipped), fs.readFileSync(avif)) === 0;
  const res: Record<string, Result> = {};
  let hint = 105;
  for (const c of configs) {
    if (codec === "avm") {
      res[c] = await matchedAvm(ref, stem, c, budget, hint);
      hint = Math.round(res[c].knob);
    } else {
      res[c] = await matchedJxl(ref, stem, c, budget);
    }
  }
  return { stem, budget, control, avif: await score(ref, avif.replace(/\.avif$/, ".png")), res };
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const signed = (x: number, d = 2) => `${x >= 0 ? "+" : ""}${x.toFixed(d)}`;

async function main(): Promise<number> {
  const src = arg("src");
  const codec = (arg("codec") ?? "avm") as Codec;
  if (!src || !CODECS[codec]) { console.error("usage: bun tools/photos/av2-tile-probe.ts --src <folder of originals> [--codec avm|jxl] [--stems a,b] [--configs base,qmseg12] [--json out]"); return 2; }
  const known = CODECS[codec].configs;
  const configs = (arg("configs") ?? CODECS[codec].defaults).split(",");
  for (const c of configs) if (!known[c]) { console.error(`unknown ${codec} config ${c}; have ${Object.keys(known).join(", ")}`); return 2; }
  if (codec === "avm" && configs.some((c) => c !== "base") && BUILD !== TUNED) console.error(`note: ${configs.join(",")} needs the tuned build (build.sh --tuned); using ${BUILD}`);
  const label = codec === "avm" ? `AV2 (${path.basename(BUILD)})` : `JPEG XL (${(await sh(["cjxl", "--version"])).split(" ")[1]})`;
  const ext = argv.includes("--hif") ? "HIF" : "JPG";
  const tier = shippedBpp();
  let stems = arg("stems")?.split(",") ?? fs.readdirSync(src)
    .filter((f) => f.startsWith("XT") && f.endsWith(`.${ext}`)).map((f) => f.slice(0, -4))
    .filter((s) => /^XT\d+$/.test(s) && !EXCLUDE.has(s)).sort();
  const per = Number(arg("stratify") ?? 0);
  if (per > 0) {
    // n per band, spaced evenly by shipped bpp through each band, so a band's
    // pick covers its range rather than bunching at one end
    const known = stems.filter((s) => tier.has(s));
    stems = BANDS.flatMap((_, b) => {
      const pool = known.filter((s) => bandOf(tier.get(s)!) === b).sort((x, y) => tier.get(x)! - tier.get(y)!);
      if (pool.length <= per) return pool;
      return Array.from({ length: per }, (_, i) => pool[Math.floor(((i + 0.5) * pool.length) / per)]);
    }).sort();
  }
  if (argv.includes("--list")) {
    for (const s of stems) console.log(`${s}  ${tier.get(s)?.toFixed(3) ?? "not shipped"} bpp`);
    return 0;
  }
  fs.mkdirSync(path.join(WORK, "enc"), { recursive: true });

  const rows: Row[] = [];
  const queue = [...stems];
  // tiles in flight: a 600px AV2 encode keeps about one core busy whatever
  // --jobs says (a tile has five 128px superblock rows to spread), so run several
  const parallel = Math.max(1, Number(arg("parallel") ?? Math.max(2, Math.floor(os.availableParallelism() / 3))));
  await Promise.all(Array.from({ length: parallel }, async () => {
    for (let s = queue.shift(); s; s = queue.shift()) {
      const r = await probe(src, s, codec, configs);
      rows.push(r);
      console.error(`${s}: ${r.budget} B, ${(r.budget * 8 / 360000).toFixed(2)} bpp${r.control ? "" : " [AVIF CONTROL MISMATCH]"} | vs AVIF: ${configs.map((c) => `${c} ${signed(r.res[c].s2 - r.avif.s2)}`).join("  ")}`);
    }
  }));
  rows.sort((a, b) => a.stem.localeCompare(b.stem));

  console.log(`\n${rows.length} tiles, ${label} against the shipped AVIF at matched bytes`);
  console.log(`  control: the re-encoded AVIF matches the shipped /i/ file on ${rows.filter((r) => r.control).length} of ${rows.length}`);
  for (const c of configs) {
    const s2 = rows.map((r) => r.res[c].s2 - r.avif.s2), bu3 = rows.map((r) => r.res[c].bu3 - r.avif.bu3);
    console.log(`  ${c.padEnd(9)} Δs2 ${signed(mean(s2))}  wins ${s2.filter((x) => x > 0).length}/${rows.length}  Δbu3 ${signed(mean(bu3), 3)}  wins ${bu3.filter((x) => x < 0).length}/${rows.length}`);
  }
  const first = configs[0];
  const who = codec === "avm" ? "AV2" : "JXL";
  const inBand = (b: number) => rows.filter((r) => bandOf((r.budget * 8) / TILE_PX) === b);
  const tierCount = BANDS.map((_, b) => [...tier.values()].filter((x) => bandOf(x) === b).length);
  console.log(`  by bits per pixel at the AVIF budget (${first}), beside the shipped tier's ${tier.size} tiles:`);
  BANDS.forEach((band, b) => {
    const d = inBand(b).map((r) => r.res[first].s2 - r.avif.s2);
    const got = d.length ? `${d.length} tiles, Δs2 ${signed(mean(d))}, ${who} wins ${d.filter((x) => x > 0).length}` : "no tiles";
    console.log(`    ${bandName(band).padEnd(8)} bpp: ${got}  (tier: ${tierCount[b]})`);
  });
  // Each band's result weighted by its share of the shipped tier: what the
  // sample says about the tier, rather than about the sample's own mix.
  const covered = BANDS.map((_, b) => b).filter((b) => inBand(b).length > 0);
  const weight = covered.reduce((a, b) => a + tierCount[b], 0);
  if (weight > 0) {
    console.log(`  tier-weighted (bands covering ${weight} of ${tier.size} shipped tiles):`);
    for (const c of configs) {
      let ds2 = 0, wins = 0;
      for (const b of covered) {
        const d = inBand(b).map((r) => r.res[c].s2 - r.avif.s2);
        ds2 += (tierCount[b] / weight) * mean(d);
        wins += tierCount[b] * (d.filter((x) => x > 0).length / d.length);
      }
      console.log(`    ${c.padEnd(9)} Δs2 ${signed(ds2)}  ${who} would win about ${Math.round(wins)} of ${weight}`);
    }
  }
  const out = arg("json");
  if (out) fs.writeFileSync(out, `${JSON.stringify(rows, null, 1)}\n`);
  return 0;
}

if (import.meta.main) process.exit(await main());
