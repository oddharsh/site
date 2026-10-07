#!/usr/bin/env bun
// r2-budget.ts — keep the aadhar-photos bucket inside R2's 10 GB free tier.
//
//   bun tools/photos/r2-budget.ts                    # print where the bucket stands
//   bun tools/photos/r2-budget.ts check --adding N   # exit 1 if N more bytes would pass the cap
//
// Every upload path calls this before it writes: add-photos.sh before phase 3,
// and jxl-originals.ts before each twin. The owner's rule is that the bucket is
// never over the free tier, and CAP leaves 0.5 GB under it for what neither
// figure below can see.
//
// WHY TWO FIGURES. Cloudflare's own number (`wrangler r2 bucket info`) lags:
// measured 2026-10-07, it still read 516 objects and 10.2 GB more than 20
// minutes after 40 further twins (~0.8 GB) had gone up, and it is rounded to
// three digits. So the guard also computes a FLOOR from what the committed index
// knows, and trusts whichever is larger:
//   - every original's recorded byte size,
//   - each recorded JPEG XL twin at TWIN_RATIO of its original (the largest
//     twin/original ratio across the first 135 twins was 0.943),
//   - each recorded HEIF at HEIF_RATIO of its JPEG (cota-wec's 89 measured
//     1.57 GB against 2.02 GB of JPEG, 0.78),
//   - UNINDEXED, the objects R2 holds that the index names nowhere: 8.39 GB
//     before any twin, less 5.59 GB of indexed JPEG and 1.57 GB of HEIF.
// The floor is deliberately conservative; it may only overstate.
import fs from "node:fs";
import path from "node:path";
import type { IndexEntry } from "./pipeline-json.ts";

export const CAP = 9.5e9;
export const TWIN_RATIO = 0.95;
export const HEIF_RATIO = 0.85;
export const UNINDEXED = 1.25e9;

const ROOT = path.resolve(import.meta.dir, "../..");

/** What the committed index alone says the bucket holds, at least. */
export function indexFloor(index: Record<string, IndexEntry>): number {
  let bytes = UNINDEXED;
  for (const e of Object.values(index)) {
    bytes += e.size;
    if (e.jxl) bytes += e.size * TWIN_RATIO;
    if (e.heif) bytes += e.size * HEIF_RATIO;
  }
  return bytes;
}

/** wrangler's "10.2 GB" back to bytes, decimal units as R2 bills them. */
export function parseSize(text: string): number {
  const m = text.trim().match(/^([\d.]+)\s*(B|kB|KB|MB|GB|TB)$/);
  if (!m) throw new Error(`unreadable bucket size: ${JSON.stringify(text)}`);
  const scale = { B: 1, kB: 1e3, KB: 1e3, MB: 1e6, GB: 1e9, TB: 1e12 }[m[2] as "B"];
  return Number(m[1]) * scale;
}

export function reportedSize(): number {
  const wrangler = path.join(ROOT, "node_modules/.bin/wrangler");
  const r = Bun.spawnSync([wrangler, "r2", "bucket", "info", "aadhar-photos", "--json"], { stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`wrangler r2 bucket info failed: ${r.stderr.toString().trim().split("\n").at(-1)}`);
  const out = r.stdout.toString();
  return parseSize(JSON.parse(out.slice(out.indexOf("{"))).bucket_size);
}

export function standing(index = readIndex()) {
  const floor = indexFloor(index), reported = reportedSize();
  return { floor, reported, current: Math.max(floor, reported) };
}

/** A first ingest into an empty tree has no index yet; that is a floor of UNINDEXED. */
function readIndex(): Record<string, IndexEntry> {
  const file = path.join(ROOT, "src/worker/photo-index.json");
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
}

const gb = (n: number) => `${(n / 1e9).toFixed(2)} GB`;

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const s = standing();
  console.log(`r2 budget: Cloudflare reports ${gb(s.reported)}, the index floor is ${gb(s.floor)}; cap ${gb(CAP)}`);
  if (argv[0] === "check") {
    const i = argv.indexOf("--adding");
    const adding = i === -1 ? NaN : Number(argv[i + 1]);
    if (!Number.isFinite(adding) || adding < 0) throw new Error("check needs --adding <bytes>");
    const after = s.current + adding;
    if (after > CAP) {
      console.error(`refusing: ${gb(s.current)} + ${gb(adding)} = ${gb(after)} would pass the ${gb(CAP)} cap (R2's free tier is 10 GB)`);
      process.exit(1);
    }
    console.log(`ok: ${gb(s.current)} + ${gb(adding)} = ${gb(after)}, ${gb(CAP - after)} under the cap`);
  }
}
