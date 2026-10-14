// av2-tile-probe.ts — AV2 or JPEG XL against the shipped AVIF on WHOLE-FRAME
// 600px tiles. --codec picks which; AV2 (avm) is the default.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { HOLDOUT, TRAIN } from "./codec-knob-probe.ts";
import { AV2_BUILD, AV2_BUILD_COMMAND, AV2_TUNED_BUILD } from "./av2-tone.ts";
import { JXL_ARGS } from "./gen-pixel-peeper.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../..");
const argv = process.argv.slice(2);
const arg = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const BUILD = path.resolve(arg("build") ?? (fs.existsSync(path.join(AV2_TUNED_BUILD, "avifenc")) ? AV2_TUNED_BUILD : AV2_BUILD));
const ZENC = path.join(HERE, "zenc/target/release/zenc");
const WORK = path.join(os.tmpdir(), "av2-tile-probe");
const EXCLUDE = new Set([...TRAIN, ...HOLDOUT, "XT507495"]);
const HASHES = JSON.parse(fs.readFileSync(path.join(REPO, "public/images/hashes.json"), "utf8")) as Record<string, { a: string }>;

const AVM = ["-c", "avm", "-d", "10", "--speed", "6", "--yuv", "444", "-a", "sb-size=128", "--jobs", "4"];
const QM = ["-a", "enable-qm=1", "-a", "qm-curve=1"];
const AVM_CONFIGS: Record<string, string[]> = {
  base: [],
  curve: QM,
  qmseg12: [...QM, "-a", "qmseg=1", "-a", "qmseg-level=12"],
};
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
    const file = path.join(src, `${stem}.JPG`);
    await sh([ZENC, "square", file, "--orient", String(await orientation(file)), "--filter", "box", "--size", "600", "--out", png]);
  }
  return png;
}

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
  const shipped = path.join(REPO, "public/i", `${stem}.${HASHES[stem]?.a}.avif`);
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
  if (codec === "avm" && configs.some((c) => c !== "base") && BUILD !== AV2_TUNED_BUILD) console.error(`note: ${configs.join(",")} needs the tuned build (${AV2_BUILD_COMMAND}); using ${BUILD}`);
  const label = codec === "avm" ? `AV2 (${path.basename(BUILD)})` : `JPEG XL (${(await sh(["cjxl", "--version"])).split(" ")[1]})`;
  const stems = arg("stems")?.split(",") ?? fs.readdirSync(src)
    .filter((f) => /^XT\d+\.JPG$/.test(f)).map((f) => f.replace(/\.JPG$/, "")).filter((s) => !EXCLUDE.has(s)).sort();
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
  console.log(`  by bits per pixel at the AVIF budget (${first}):`);
  for (const [lo, hi] of [[0, 0.3], [0.3, 0.5], [0.5, 0.8], [0.8, 1.2], [1.2, 99]]) {
    const band = rows.filter((r) => { const bpp = r.budget * 8 / 360000; return bpp >= lo && bpp < hi; });
    if (!band.length) continue;
    const d = band.map((r) => r.res[first].s2 - r.avif.s2);
    console.log(`    ${lo}-${hi === 99 ? "" : hi} bpp: ${band.length} tiles, Δs2 ${signed(mean(d))}, ${codec === "avm" ? "AV2" : "JXL"} wins ${d.filter((x) => x > 0).length}`);
  }
  const out = arg("json");
  if (out) fs.writeFileSync(out, `${JSON.stringify(rows, null, 1)}\n`);
  return 0;
}

if (import.meta.main) process.exit(await main());
