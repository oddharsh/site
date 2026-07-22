#!/usr/bin/env node

// Validate the committed public photo artifact graph. Full-resolution source
// files stay outside git; this checks everything the site actually serves:
// metadata, per-photo EXIF/histogram JSON, the hash map, and all three pixel
// tiers. add-photos.sh runs this before it busts the manifest cache, and CI runs
// it on every PR so an incremental add cannot silently truncate the library.

import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const IMAGES = path.join(ROOT, "holding/images");
const HASHED = path.join(ROOT, "holding/i");
const META = path.join(IMAGES, "meta");

const json = async (file) => JSON.parse(await readFile(file, "utf8"));
const fail = (message) => {
  console.error(`photo-pipeline: ${message}`);
  process.exit(1);
};

const metadata = await json(path.join(IMAGES, "metadata.json"));
const hashes = await json(path.join(IMAGES, "hashes.json"));
const alt = await json(path.join(IMAGES, "alt.json"));
const stems = Object.keys(hashes).sort();
const metadataStems = Object.keys(metadata).sort();

if (JSON.stringify(stems) !== JSON.stringify(metadataStems)) {
  fail(`metadata/hash stem sets differ (${metadataStems.length} metadata, ${stems.length} hashes)`);
}

const expectedFiles = new Set();
for (const stem of stems) {
  const entry = hashes[stem];
  if (!entry || typeof entry !== "object" || !entry.a || !entry.j || !entry.s) {
    fail(`${stem}: hash entry must contain a, j, and s tiers`);
  }

  const files = [
    `${stem}.${entry.a}.avif`,
    `${stem}.${entry.j}.jpg`,
    `${stem}-400.${entry.s}.avif`,
  ];
  for (const file of files) {
    expectedFiles.add(file);
    try { await stat(path.join(HASHED, file)); }
    catch { fail(`${stem}: missing hashed pixel tier ${file}`); }
  }

  let perPhoto;
  try { perPhoto = await json(path.join(META, `${stem}.json`)); }
  catch { fail(`${stem}: missing per-photo metadata`); }
  const hist = perPhoto.hist;
  if (!hist || !["l", "r", "g", "b"].every((channel) => Array.isArray(hist[channel]) && hist[channel].length === 64)) {
    fail(`${stem}: histogram must contain four 64-bin channels`);
  }
}

const actualFiles = (await readdir(HASHED)).filter((file) => /\.(avif|jpg)$/.test(file));
const orphans = actualFiles.filter((file) => !expectedFiles.has(file));
if (orphans.length) fail(`unreferenced hashed pixel files: ${orphans.join(", ")}`);

// alt text is a served artifact like the pixels and the EXIF, so a gap fails here
// rather than shipping an unlabelled image. add-photos.sh generates captions just
// above this check, so reaching it means the captioner was rate-limited or skipped.
const uncaptioned = stems.filter((stem) => !(alt[stem] || "").trim());
if (uncaptioned.length) {
  fail(`${uncaptioned.length} photo(s) without alt text: ${uncaptioned.slice(0, 8).join(", ")}` +
       `${uncaptioned.length > 8 ? " …" : ""}\n  fix with: npm run captions`);
}

console.log(`photo-pipeline: ${stems.length} photos, ${expectedFiles.size} hashed tiers, complete EXIF + histogram + alt-text metadata`);
