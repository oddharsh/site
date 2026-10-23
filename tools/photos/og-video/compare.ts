// compare.ts: smallest file per codec that reaches one SSIMULACRA2 target, per
// clip, so the codec choice is read at equal quality rather than equal knobs.
//
//   bun tools/photos/og-video/compare.ts <out-dir> [target=80] [ids]
//
// <out-dir> holds what record.ts wrote (<id>/frames) and the compiled helpers
// (encode, y4m, decode). The CONTROL row is the frames through 4:2:0 and back
// with no codec at all: the ceiling every codec is scored under (about 90).
// Scores are the mean over 6 frames spread across the clip.
import { $ } from "bun";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { av1Flags } from "./encoders.ts";

const out = process.argv[2];
const target = Number(process.argv[3] ?? 80);
const only = process.argv[4] ? new Set(process.argv[4].split(",")) : null;
const bin = (n) => path.join(out, n);
// CODECS=h264,hevc reruns a subset and keeps the other codecs' rows from the
// last run's JSON, so fixing one encoder doesn't re-spend the AV1 encodes.
const codecs = (process.env.CODECS ?? "h264,hevc,av1").split(",");
const jsonPath = path.join(out, `compare-${target}.json`);
const prev = existsSync(jsonPath) ? Object.fromEntries(JSON.parse(readFileSync(jsonPath, "utf8")).map((r) => [r.id, r])) : {};

async function score(dir, decoded, picks) {
  let s = 0;
  for (const i of picks) {
    const f = `f${String(i).padStart(4, "0")}.png`;
    s += Number((await $`ssimulacra2 ${path.join(dir, "frames", f)} ${path.join(decoded, f)}`.text()).trim());
  }
  return s / picks.length;
}

// One trial: encode at knob k, decode the picks, score. Returns bytes + score.
async function trial(dir, codec, k, picks) {
  const tag = `${codec}-${k}`;
  const dec = path.join(dir, "d", tag);
  let file;
  if (codec === "av1") {
    file = path.join(dir, `av1-q${k}.webm`);
    await $`aomenc ${av1Flags(k)} -o ${file} ${path.join(dir, "clip.y4m")}`.quiet();
    await $`aomdec -o ${path.join(dir, "d.y4m")} ${file}`.quiet();
    await $`${bin("decode")} y4m ${path.join(dir, "d.y4m")} ${dec} ${picks.join(",")}`.quiet();
  } else {
    file = path.join(dir, `${codec}-q${k}.mp4`);
    await $`${bin("encode")} ${path.join(dir, "frames")} ${file} ${codec} 30 ${k}`.quiet();
    await $`${bin("decode")} mp4 ${file} ${dec} ${picks.join(",")}`.quiet();
  }
  return { k, file, bytes: statSync(file).size, score: await score(dir, dec, picks) };
}

// Bisect the knob for the cheapest setting that still clears the target.
// `cheap` and `good` are the two ends of the knob: VideoToolbox quality rises
// with k (0..1), aomenc cq-level falls with it. A pass moves `good` in (look
// cheaper), a miss moves `cheap` in. The first cut had these swapped, so every
// pass searched toward bigger files and H.264/HEVC never climbed to the target.
async function cheapest(dir, codec, picks) {
  let cheap = codec === "av1" ? 63 : 0.2,
    good = codec === "av1" ? 8 : 1.0;
  type Trial = Awaited<ReturnType<typeof trial>>;
  let best: Trial | null = null;
  for (let it = 0; it < 7; it++) {
    const mid = codec === "av1" ? Math.round((cheap + good) / 2) : Math.round(((cheap + good) / 2) * 100) / 100;
    const r = await trial(dir, codec, mid, picks);
    if (r.score >= target) {
      if (!best || r.bytes < best.bytes) best = r;
      good = mid;
    } else cheap = mid;
    if (codec === "av1" ? Math.abs(cheap - good) <= 1 : Math.abs(cheap - good) <= 0.02) break;
  }
  // The top of the knob never got tried if every trial missed; try it once so
  // "missed" means the codec can't reach the target, not that we never asked.
  if (!best) {
    const top = await trial(dir, codec, codec === "av1" ? 8 : 1.0, picks);
    if (top.score >= target) best = top;
  }
  return best ?? { k: "-", bytes: NaN, score: NaN, file: null };
}

const rows: object[] = [];
for (const id of readdirSync(out).filter((d) => existsSync(path.join(out, d, "frames")) && (!only || only.has(d)))) {
  const dir = path.join(out, id);
  const n = readdirSync(path.join(dir, "frames")).length;
  const picks = Array.from({ length: 6 }, (_, i) => Math.min(n - 1, Math.round(((i + 0.5) * n) / 6)));
  await $`${bin("y4m")} ${path.join(dir, "frames")} 30 > ${path.join(dir, "clip.y4m")}`.quiet();
  await $`${bin("decode")} y4m ${path.join(dir, "clip.y4m")} ${path.join(dir, "d", "ctl")} ${picks.join(",")}`.quiet();
  const ctl = await score(dir, path.join(dir, "d", "ctl"), picks);
  const r = { ...prev[id], id, frames: n, ctl: ctl.toFixed(1) };
  for (const codec of codecs) {
    const b = await cheapest(dir, codec, picks);
    r[codec] = b;
  }
  rows.push(r);
  const fmt = (b) => (b.file ? `${(b.bytes / 1024).toFixed(0)} KB @${b.score.toFixed(1)} (k=${b.k})` : "never reached");
  console.log(`${id.padEnd(16)} ctl ${r.ctl}  h264 ${fmt(r.h264)}  hevc ${fmt(r.hevc)}  av1 ${fmt(r.av1)}`);
}
await Bun.write(jsonPath, JSON.stringify(rows, null, 2));
