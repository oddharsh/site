#!/usr/bin/env node

// Validate the committed public photo artifact graph. Full-resolution source
// files stay outside git; this checks everything the site actually serves:
// metadata, per-photo EXIF/histogram JSON, the hash map, and all three pixel
// tiers. add-photos.sh runs this before it busts the manifest cache, and CI runs
// it on every PR so an incremental add cannot silently truncate the library.

import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildExifIndex } from "./build-exif-index.mjs";

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
  const hist = perPhoto.hi;
  if (!hist || !["l", "r", "g", "b"].every((channel) => Array.isArray(hist[channel]) && hist[channel].length === 64)) {
    fail(`${stem}: histogram must contain four 64-bin channels`);
  }
}

const actualFiles = (await readdir(HASHED)).filter((file) => /\.(avif|jpg)$/.test(file));
const orphans = actualFiles.filter((file) => !expectedFiles.has(file));
if (orphans.length) fail(`unreferenced hashed pixel files: ${orphans.join(", ")}`);

// Hand-written pages may hardcode an /i/ URL (the /garage/tooltips demo slots do).
// A /i/ URL names exact bytes, so a re-encode mints a new hash and hash-thumbnails.sh
// prunes the old file — which would leave those pages 404ing on images with nothing
// to catch it. Walk the authored HTML/JS and hold every hardcoded reference to the
// same standard as the manifest's own tiers.
const HARDCODED_ROOTS = ["holding/garage", "holding/lwe", "holding/index.html"];
const walk = async (target) => {
  const entry = await stat(target);
  if (!entry.isDirectory()) return [target];
  const kids = await readdir(target, { withFileTypes: true });
  const nested = await Promise.all(kids.map((k) => walk(path.join(target, k.name))));
  return nested.flat();
};
const authored = (await Promise.all(HARDCODED_ROOTS.map((r) => walk(path.join(ROOT, r)))))
  .flat().filter((file) => /\.(html|js)$/.test(file));
for (const file of authored) {
  const body = await readFile(file, "utf8");
  for (const [, name] of body.matchAll(/\/i\/([A-Za-z0-9_-]+\.[a-f0-9]{8}\.(?:avif|jpg))/g)) {
    if (!expectedFiles.has(name)) {
      fail(`${path.relative(ROOT, file)} references /i/${name}, which no longer exists\n` +
           `  the tier was re-encoded; re-point it at the current hash in images/hashes.json`);
    }
  }
}

// The shared EXIF index (/images/exif.json) is what the tooltip reads for its
// text on every hover, so a stale or partial one is a silently blanker tooltip
// rather than an error anyone would notice. It is DERIVED from the per-photo
// files, so rebuild it here and compare: any drift means extract-photo-metadata.sh
// ran without regenerating it. The tooltip still self-heals per photo, but the
// point of the index is that it should not have to.
const exifIndex = await json(path.join(IMAGES, "exif.json"));
const rebuilt = await buildExifIndex();
const missing = stems.filter((stem) => !exifIndex[stem]);
if (missing.length) {
  fail(`${missing.length} photo(s) absent from images/exif.json: ${missing.slice(0, 8).join(", ")}` +
       `${missing.length > 8 ? " …" : ""}\n  fix with: node holding/scripts/build-exif-index.mjs`);
}
const stale = stems.filter((stem) => JSON.stringify(exifIndex[stem]) !== JSON.stringify(rebuilt[stem]));
if (stale.length) {
  fail(`images/exif.json disagrees with images/meta/ for ${stale.length} photo(s): ${stale.slice(0, 8).join(", ")}` +
       `${stale.length > 8 ? " …" : ""}\n  fix with: node holding/scripts/build-exif-index.mjs`);
}
const strays = Object.keys(exifIndex).filter((stem) => !hashes[stem]);
if (strays.length) fail(`images/exif.json carries unpublished stems: ${strays.join(", ")}`);

// alt text is a served artifact like the pixels and the EXIF, so a gap fails here
// rather than shipping an unlabelled image. add-photos.sh generates captions just
// above this check, so reaching it means the captioner was rate-limited or skipped.
const uncaptioned = stems.filter((stem) => !(alt[stem] || "").trim());
if (uncaptioned.length) {
  fail(`${uncaptioned.length} photo(s) without alt text: ${uncaptioned.slice(0, 8).join(", ")}` +
       `${uncaptioned.length > 8 ? " …" : ""}\n  fix with: npm run captions`);
}

console.log(`photo-pipeline: ${stems.length} photos, ${expectedFiles.size} hashed tiers, complete EXIF + histogram + alt-text metadata`);
