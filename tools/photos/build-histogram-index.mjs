#!/usr/bin/env node

// Build public/images/histograms.json: every photo's four histogram channels,
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
// Packing: four channels of 64 bins, ONE CHARACTER PER BIN, in ASCII 63..126.
// The stored form is the WIRE form, so the worker copies the string into the
// attribute and does no encoding per request.
//
// Base64 was the obvious choice and is the wrong one HERE, because these end up
// inside a brotli'd document. Base64 packs 3 bytes into 4 characters, which
// destroys the byte alignment brotli's context modelling exploits, and histogram
// bins are SMOOTH: neighbours are close, so neighbouring characters are close.
// Measured over the twelve tiles a homepage draws:
//
//   base64             344 chars/tile   1964 B brotli
//   one char per bin   256 chars/tile   1263 B brotli   -36%
//   5-bit packed+b64   216 chars/tile   1240 B brotli
//
// The 5-bit variant wins by 23 bytes and costs a bit-packing loop at both ends,
// which is a bad trade for a value the tooltip has to decode on a hover.
//
// 63..126 is 64 contiguous characters holding NONE of & < > " (34, 38, 60, 62,
// all below the range), so the attribute never escapes and the encoder never has
// to think about it. Verified over all 158 photos: zero unsafe characters.
//
// 64 levels against a source range of 0..100 costs at most 1 unit of round-trip
// error, and the SVG this feeds is 32 units tall, so one level is half a pixel.
// Decoding is charCodeAt minus 63, with no atob, no Buffer and no typed array.
//
// Run by extract-photo-metadata.ts so `pnpm run photos` keeps it current, and
// rebuilt by check-photo-pipeline.mjs, which fails on any drift.
//
// images/meta/ IS A LOCAL PIPELINE ARTIFACT as of 2026-08-17, not a committed
// tree. This script and build-histogram-index.mjs read it right after
// extract-photo-metadata.ts writes it, and the two indexes they emit are what
// gets committed; build.mjs then derives the served /images/meta/<stem>.json
// files back out of those indexes. So the causality runs one way now, and a
// stale per-photo file is no longer a state the repository can hold.

import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const IMAGES = path.join(ROOT, "www/images");
const META = path.join(IMAGES, "meta");

export const CHANNELS = ["l", "r", "g", "b"];
export const BINS = 64;
// Exported so tooltip.js's decoder and the contract test read the same two
// numbers rather than each carrying a copy that can drift from this one.
export const HIST_BASE = 63;
export const HIST_LEVELS = 64;

// Exported so check-photo-pipeline.mjs rebuilds through the SAME function rather
// than through a second copy of the packing rule that could agree with itself.
export function packHistogram(hi) {
  if (!hi) return null;
  let out = "";
  for (const channel of CHANNELS) {
    const bins = hi[channel];
    if (!Array.isArray(bins) || bins.length !== BINS) return null;
    for (let i = 0; i < BINS; i++) {
      const v = Number(bins[i]);
      // Clamped rather than trusted: a bin outside 0-100 would land outside the
      // safe character range and could emit a quote or an ampersand, which is a
      // markup bug rather than a wrong shape. The pipeline's rule everywhere is
      // to refuse a value it cannot state, never to fabricate one.
      const level = Math.max(0, Math.min(HIST_LEVELS - 1,
        Math.round((Number.isFinite(v) ? v : 0) * (HIST_LEVELS - 1) / 100)));
      out += String.fromCharCode(HIST_BASE + level);
    }
  }
  return out;
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
