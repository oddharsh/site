#!/usr/bin/env bun
// photo-metrics-parity.ts: does photo-metrics still make hif-archive.ts's
// decision the way libjxl's CLIs did? Run it before merging any move of the
// fast-ssim2 or butteraugli pins in tools/photos/photo-metrics/Cargo.toml.
//
//   bun tools/photos/photo-metrics-parity.ts [--limit N] [--work DIR]
//
// For every 7th HIF in the photo inbox (20 frames), it runs hif-archive.ts's
// own bisection twice, once scored by photo-metrics and once by libjxl's
// `ssimulacra2` and `butteraugli_main --pnorm 3`, against the same sips 16-bit
// reference and zenc q100 4:2:2 baseline. Encodes are shared, so the two
// searches see identical candidates and differ only in their scorer. It prints
// each frame's two picks and, over every candidate both scored, the largest
// ssimulacra2 and 3-norm gaps.
//
// PASS means the same distance on every frame. A pin move that fails it moves
// archive decisions, and the honest response is to say so in the PR rather
// than to merge it as a refresh.
//
// MEASURED 2026-10-14, at the pins in Cargo.toml, against libjxl 0.12.0:
//   same distance on 20 of 20 HIFs; same verdict on 161 of 161 candidates
//   worst gap over those candidates: ssimulacra2 0.19, 3-norm 0.00001
// The ssimulacra2 gap is the one to watch: its half of the verdict flipped on
// 2 of 161 candidates, and butteraugli decided both the same way. Cargo.toml
// records what that gap is not. An 8-bit spot check over 868 pairs (31 photos
// x 28 encodes at 1080px) gave worst gaps of 0.0019 and 0.0002.
//
// Needs libjxl's tools on PATH, which nothing else in the photo pipeline
// does now. Each libjxl score of a 40 MP pair costs ~36 s and ~9 GB, so it
// runs one frame at a time.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ARGS, beats, searchDistance, stripPng, type Score } from "./hif-archive.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ZENC = path.join(HERE, "zenc/target/release/zenc");
const METRICS = path.join(HERE, "photo-metrics");
const SRC = "/Users/aadharsh/Downloads/to post (from ssd)";
const argv = process.argv.slice(2);
const arg = (name: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const WORK = path.resolve(arg("work") ?? path.join(os.tmpdir(), "photo-metrics-parity"));

function sh(cmd: string[], tolerate = false): string {
  const r = spawnSync(cmd[0], cmd.slice(1), { encoding: "utf8", maxBuffer: 1 << 26 });
  if (r.error) throw r.error;
  // butteraugli_main exits non-zero on a large distance and still prints both scores
  if (r.status !== 0 && !tolerate) throw new Error(`${path.basename(cmd[0])} exited ${r.status}: ${r.stderr.trim().split("\n").at(-1)}`);
  return r.stdout.trim();
}

function libjxl(ref: string, img: string): Score {
  const s2 = Number.parseFloat(sh(["ssimulacra2", ref, img]));
  const lines = sh(["butteraugli_main", ref, img, "--pnorm", "3"], true).split("\n");
  const ba3 = Number.parseFloat(/3-norm:\s*([\d.]+)/.exec(lines.join("\n"))?.[1] ?? "");
  if (!Number.isFinite(s2) || !Number.isFinite(ba3)) throw new Error(`libjxl printed no score for ${img}`);
  return { s2, ba3 };
}

if (!fs.existsSync(ZENC)) throw new Error(`zenc is not built: cargo build --release --locked --manifest-path ${path.join(HERE, "zenc/Cargo.toml")}`);
sh(["cargo", "build", "--release", "--locked", "--quiet", "--manifest-path", path.join(METRICS, "Cargo.toml")]);
const BIN = path.join(METRICS, "target/release/photo-metrics");
const ours = (ref: string, img: string): Score => JSON.parse(sh([BIN, ref, img])) as Score;

const hifs = fs.readdirSync(SRC).sort().filter((f) => /^XT.*\.HIF$/.test(f)).filter((_, i) => i % 7 === 0)
  .slice(0, Number(arg("limit") ?? Infinity));
fs.mkdirSync(WORK, { recursive: true });
let same = 0, worstS2 = 0, worstBa3 = 0;
for (const f of hifs) {
  const stem = f.replace(/\.[^.]+$/, "");
  const dir = fs.mkdtempSync(path.join(WORK, `${stem}-`));
  try {
    const raw = path.join(dir, "raw.png"), ref = path.join(dir, "ref.png");
    const baseJpg = path.join(dir, "base.jpg"), base = path.join(dir, "base.ppm");
    sh(["sips", "-s", "format", "png", path.join(SRC, f), "--out", raw]);
    stripPng(raw, ref);
    sh([ZENC, raw, baseJpg, "-q", "100", "--yuv", "422"]);
    sh(["djpeg", "-outfile", base, baseJpg]);
    const decoded = new Map<number, string>();
    const dec = (d: number) => {
      let p = decoded.get(d);
      if (!p) {
        const jxl = path.join(dir, `d${d}.jxl`);
        p = path.join(dir, `d${d}.png`);
        sh(["cjxl", "--quiet", "-d", String(d), ...ARGS, ref, jxl]);
        sh(["djxl", jxl, p]);
        decoded.set(d, p);
      }
      return p;
    };
    const scored = { ours: new Map<number, Score>(), libjxl: new Map<number, Score>() };
    const pick = async (who: "ours" | "libjxl") => {
      const scorer = who === "ours" ? ours : libjxl;
      const bar = scorer(ref, base);
      return searchDistance(async (d) => {
        const s = scorer(ref, dec(d));
        scored[who].set(d, s);
        return beats(s, bar);
      });
    };
    const a = await pick("ours"), b = await pick("libjxl");
    for (const [d, s] of scored.ours) {
      const l = scored.libjxl.get(d);
      if (!l) continue;
      worstS2 = Math.max(worstS2, Math.abs(s.s2 - l.s2));
      worstBa3 = Math.max(worstBa3, Math.abs(s.ba3 - l.ba3));
    }
    if (a === b) same++;
    console.log(`${stem}  photo-metrics d${a}  libjxl d${b}  ${a === b ? "same" : "DIFFERENT"}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
console.log(`\n${same === hifs.length ? "PASS" : "FAIL"}: same distance on ${same}/${hifs.length}; worst gap over shared candidates: ssimulacra2 ${worstS2.toFixed(4)}, 3-norm ${worstBa3.toFixed(4)}`);
process.exitCode = same === hifs.length ? 0 : 1;
