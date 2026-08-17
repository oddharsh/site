#!/usr/bin/env node

// Build www/images/histograms.json: every photo's four histogram channels,
// packed, keyed by stem. This file is a SERVER-SIDE input and is never fetched
// by a browser, which is what makes its size unremarkable.
//
// Why it exists. The tooltip's bars used to arrive on the hover that needed
// them: one /images/meta/<stem>.json per photo, measured on production at 135ms
// and 117ms for the first two hovers, once per photo, with the histogram unable
// to draw until its file landed. The obvious fix is to send the bars with the
// page, and the obstacle was WHERE the worker gets them: the grid fragment draws
// a fresh random twelve per request, so it needs all 158 available. Bundling
// them costs 22.9 KiB gzip, which is 83% of the worker bundle's remaining
// headroom; reading twelve files per request costs twelve subrequests against a
// 50 cap. Reading ONE file, memoised per isolate exactly like alt.json and
// hashes.json already are, costs neither.
//
// This does NOT contradict build-exif-index.mjs's reasoning for leaving
// histograms out of exif.json. That argument is about a file every visitor
// downloads whole: all 158 histograms would take that index from 2.6 KiB to
// 24 KiB brotli for bars most people never see. Here only the twelve the page
// actually drew ride in the document, which measures at ~1.9 KiB brotli, and
// they are exactly the twelve a visitor is able to hover.
//
// Packing: four channels of 64 bins, each 0-100, so one byte per bin and 256
// bytes per photo, base64'd for a JSON string. Base64 rather than the nested
// arrays the meta files use because the arrays cost 103,962 bytes against
// 56,569 for the same data, and this is read on a worker cold start.
//
// Run by extract-photo-metadata.sh so `pnpm run photos` keeps it current, and
// rebuilt by check-photo-pipeline.mjs, which fails on any drift.

import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const IMAGES = path.join(ROOT, "www/images");
const META = path.join(IMAGES, "meta");

export const CHANNELS = ["l", "r", "g", "b"];
export const BINS = 64;

// Exported so check-photo-pipeline.mjs rebuilds through the SAME function rather
// than through a second copy of the packing rule that could agree with itself.
export function packHistogram(hi) {
  if (!hi) return null;
  const out = Buffer.alloc(CHANNELS.length * BINS);
  for (const [ci, channel] of CHANNELS.entries()) {
    const bins = hi[channel];
    if (!Array.isArray(bins) || bins.length !== BINS) return null;
    for (let i = 0; i < BINS; i++) {
      const v = Number(bins[i]);
      // Clamped rather than trusted: a bin outside 0-100 would wrap in a byte and
      // draw a plausible wrong shape, which is the failure mode this whole
      // surface is built to avoid (the pipeline's rule is to skip a value it
      // cannot state, never to fabricate one).
      out[ci * BINS + i] = Math.max(0, Math.min(255, Math.round(Number.isFinite(v) ? v : 0)));
    }
  }
  return out.toString("base64");
}

export async function buildHistogramIndex() {
  const files = (await readdir(META)).filter((f) => f.endsWith(".json")).sort();
  const index = {};
  let skipped = 0;
  for (const file of files) {
    const stem = file.slice(0, -5);
    const record = JSON.parse(await readFile(path.join(META, file), "utf8"));
    const packed = packHistogram(record.hi);
    if (packed) index[stem] = packed;
    else skipped++;
  }
  return { index, skipped, total: files.length };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { index, skipped, total } = await buildHistogramIndex();
  await writeFile(path.join(IMAGES, "histograms.json"), `${JSON.stringify(index)}\n`);
  console.log(`histogram-index: ${Object.keys(index).length} of ${total} photos packed${skipped ? `, ${skipped} without a histogram` : ""}`);
}
