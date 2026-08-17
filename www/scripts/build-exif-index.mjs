#!/usr/bin/env node

// Build www/images/exif.json: every photo's EXIF in ONE file, with the
// histograms left behind.
//
// Why one file, when per-photo files were the deliberate choice: the homepage
// draws a fresh RANDOM 12 of 158 on every single request (three curls a second
// apart return three different sets), so the per-photo warm-up was cold on
// essentially every visit. A given slot repeats about 7.6% of the time, which
// makes "repeat visits are served from the browser's HTTP cache" true in theory
// and false in practice. Measured on the committed metadata:
//
//   12 per-photo files, per visit   ~8.9KB transferred, 12 requests, cold ~every visit
//   all 158 EXIF, one file          2.6KB brotli, 1 request, immutable, warm forever
//
// The index wins on the FIRST visit (11 fewer sets of response headers, and 158
// records compress against each other) and costs nothing on every visit after.
//
// Histograms stay per-photo on purpose. They are 623 of the ~977 bytes in a meta
// file, so folding them in would take the index from 2.6KB to 24KB brotli: a big
// idle download for bars most visitors never see. The tooltip now renders its
// text from the index immediately and fetches the one histogram it needs when a
// hover actually happens.
//
// Run by extract-photo-metadata.sh (so `pnpm run photos` keeps it current) and
// verified by check-photo-pipeline.mjs, which fails on a stale or partial index.
//
// images/meta/ IS A LOCAL PIPELINE ARTIFACT as of 2026-08-17, not a committed
// tree. This script and build-histogram-index.mjs read it right after
// extract-photo-metadata.sh writes it, and the two indexes they emit are what
// gets committed; build.mjs then derives the served /images/meta/<stem>.json
// files back out of those indexes. So the causality runs one way now, and a
// stale per-photo file is no longer a state the repository can hold.

import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const META = path.join(ROOT, "www/images/meta");
const OUT = path.join(ROOT, "www/images/exif.json");

// `hi` is the four 64-bin histogram channels. Everything else is EXIF text.
export const HISTOGRAM_KEY = "hi";

export async function buildExifIndex() {
  const files = (await readdir(META)).filter((f) => f.endsWith(".json")).sort();
  const index = {};
  for (const file of files) {
    const { [HISTOGRAM_KEY]: _hist, ...exif } = JSON.parse(await readFile(path.join(META, file), "utf8"));
    index[file.replace(/\.json$/, "")] = exif;
  }
  return index;
}

// Written as one line per stem: the whole point is a small compressed payload,
// and a line per record keeps the git diff of an incremental add readable.
export function serialize(index) {
  const rows = Object.keys(index).sort().map((stem) => `${JSON.stringify(stem)}:${JSON.stringify(index[stem])}`);
  return `{\n${rows.join(",\n")}\n}\n`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const index = await buildExifIndex();
  const body = serialize(index);
  await writeFile(OUT, body);
  console.log(`exif index: ${Object.keys(index).length} photos → ${path.relative(ROOT, OUT)} (${(body.length / 1024).toFixed(1)}KB raw)`);
}
