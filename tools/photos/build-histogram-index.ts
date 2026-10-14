#!/usr/bin/env node

// Build public/images/histograms.json: every photo's four histogram channels,
// packed, keyed by stem. This file is a SERVER-SIDE input and is never fetched
// by a browser, which is what makes its size unremarkable.

import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const IMAGES = path.join(ROOT, "public/images");
const META = path.join(IMAGES, "meta");

export const CHANNELS = ["l", "r", "g", "b"];
export const BINS = 64;
export const HIST_BASE = 63;
export const HIST_LEVELS = 64;

export function packHistogram(hi) {
  if (!hi) return null;
  let out = "";
  for (const channel of CHANNELS) {
    const bins = hi[channel];
    if (!Array.isArray(bins) || bins.length !== BINS) return null;
    let previous = 0;
    for (let i = 0; i < BINS; i++) {
      const v = Number(bins[i]);
      const level = Math.max(0, Math.min(HIST_LEVELS - 1,
        Math.round((Number.isFinite(v) ? v : 0) * (HIST_LEVELS - 1) / 100)));
      const wire = (level - previous + HIST_LEVELS) % HIST_LEVELS;
      out += String.fromCharCode(HIST_BASE + wire);
      previous = level;
    }
  }
  return out;
}

export function unpackHistogram(packed) {
  if (!packed || packed.length !== CHANNELS.length * BINS) return null;
  const hi: Record<string, number[]> = {};
  for (const [ci, channel] of CHANNELS.entries()) {
    let previous = 0;
    const bins: number[] = [];
    for (let i = 0; i < BINS; i++) {
      const wire = packed.charCodeAt(ci * BINS + i) - HIST_BASE;
      if (wire < 0 || wire >= HIST_LEVELS) return null;
      const level = (previous + wire) % HIST_LEVELS;
      bins.push(Math.round(level * 100 / (HIST_LEVELS - 1)));
      previous = level;
    }
    hi[channel] = bins;
  }
  return hi;
}

export async function buildHistogramIndex(metaDir = META) {
  const files = (await readdir(metaDir)).filter((f) => f.endsWith(".json")).sort();
  const index = {};
  let skipped = 0;
  for (const file of files) {
    const stem = file.slice(0, -5);
    const record = JSON.parse(await readFile(path.join(metaDir, file), "utf8"));
    const packed = packHistogram(record.hi);
    if (packed) index[stem] = packed;
    else skipped++;
  }
  return { index, skipped, total: files.length };
}

if (import.meta.main) {
  const { index, skipped, total } = await buildHistogramIndex();
  await writeFile(path.join(IMAGES, "histograms.json"), `${JSON.stringify(index)}\n`);
  console.log(`histogram-index: ${Object.keys(index).length} of ${total} photos packed${skipped ? `, ${skipped} without a histogram` : ""}`);
}
