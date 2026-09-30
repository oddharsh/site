// photo-tiles.ts — the 600px tile add-photos.sh cuts, for tools that measure it.
//
// Every encoder question about the served tier should be asked of the pixels
// the tier is encoded FROM, and those come out of one path: a HIF goes through
// a full-resolution sips TIFF, then `zenc square --orient N --filter box --size
// 600`, with the orientation read by exif-sooc. The AVIF and JPEG knob climbs
// both cut tiles here, so they measure the same pixels, and both check that
// encoding a tile at the shipped settings reproduces the shipped /i/ file byte
// for byte (162 of 162 for AVIF and 4 of 4 for JPEG on 2026-09-29), which is
// the proof that this IS the path. Writes only under the directory it is given.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ZENC = path.join(HERE, "../photos/zenc/target/release/zenc");
export const REPO = path.join(HERE, "../..");
export const SOOC = "/Users/aadharsh/Downloads/to post (from ssd)";

export async function sh(cmd: string[]): Promise<string> {
  const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const [out, err] = [await new Response(p.stdout).text(), await new Response(p.stderr).text()];
  if ((await p.exited) !== 0) throw new Error(`${path.basename(cmd[0])} failed: ${err.trim().slice(-300)}`);
  return out;
}

// A concurrency limit for tools that spawn encoders per tile.
export function limiter(n: number) {
  let running = 0;
  const waiting: Array<() => void> = [];
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    if (running >= n) await new Promise<void>((r) => waiting.push(r));
    running++;
    try { return await fn(); } finally { running--; waiting.shift()?.(); }
  };
}
export const defaultParallel = () => Math.max(2, os.availableParallelism() - 4);

export type TileSource = { stem: string; file: string };

// Every colour Fuji original in `src`, one per stem; a HIF outranks a JPG of
// the same frame, as add-photos.sh reads it. The Leica frames are left out:
// the Monochrom tiers are 1-channel, so chroma knobs mean nothing there.
export function fujiSources(src = SOOC): TileSource[] {
  const byStem = new Map<string, TileSource>();
  for (const f of fs.readdirSync(src).filter((n) => /^XT\d+\.(HIF|JPG)$/i.test(n)).sort()) {
    const stem = f.replace(/\.[^.]+$/, "");
    if (!byStem.has(stem) || /\.hif$/i.test(f)) byStem.set(stem, { stem, file: path.join(src, f) });
  }
  return [...byStem.values()];
}

export async function cutTile(it: TileSource, dir: string): Promise<string> {
  const png = path.join(dir, `${it.stem}.png`);
  if (fs.existsSync(png)) return png;
  fs.mkdirSync(dir, { recursive: true });
  let input = it.file, tif: string | null = null;
  if (/\.hif$/i.test(it.file)) {
    tif = path.join(dir, `${it.stem}.tif`);
    await sh(["sips", "-s", "format", "tiff", it.file, "--out", tif]);
    input = tif;
  }
  const o = Number(/"Orientation":\s*(\d)/.exec(await sh(["exif-sooc", "-n", "-Orientation", it.file]))?.[1] ?? 1);
  try {
    await sh([ZENC, "square", input, "--orient", String(o >= 1 && o <= 8 ? o : 1), "--filter", "box", "--size", "600", "--out", png]);
  } finally { if (tif) fs.rmSync(tif, { force: true }); }
  return png;
}

// The shipped /i/ file for a stem and tier key (a = 600px AVIF, j = 600px JPEG).
export function shippedTier(stem: string, key: "a" | "j"): string | null {
  const hashes = JSON.parse(fs.readFileSync(path.join(REPO, "public/images/hashes.json"), "utf8"));
  const h = hashes[stem]?.[key];
  const f = path.join(REPO, "public/i", `${stem}.${h}.${key === "a" ? "avif" : "jpg"}`);
  return h && fs.existsSync(f) ? f : null;
}
