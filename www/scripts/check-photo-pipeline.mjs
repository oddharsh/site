#!/usr/bin/env node

// Validate the committed public photo artifact graph. Full-resolution source
// files stay outside git; this checks everything the site actually serves:
// the photo index the worker bundles, metadata, per-photo EXIF/histogram JSON,
// the hash map, and all three pixel tiers. add-photos.sh runs this as its last
// phase, and CI runs it on every PR so an incremental add cannot silently
// truncate the library.

import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildExifIndex } from "./build-exif-index.mjs";
import { buildHistogramIndex } from "./build-histogram-index.mjs";
import { asRecord, asText } from "../_worker.js/lib/parse.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const IMAGES = path.join(ROOT, "www/images");
const HASHED = path.join(ROOT, "www/i");
const META = path.join(IMAGES, "meta");

const json = async (file) => JSON.parse(await readFile(file, "utf8"));
const fail = (message) => {
  console.error(`photo-pipeline: ${message}`);
  process.exit(1);
};

const metadata = await json(path.join(IMAGES, "metadata.json"));
const hashes = await json(path.join(IMAGES, "hashes.json"));
const fingerprints = await json(path.join(IMAGES, "fingerprints.json"));
const alt = await json(path.join(IMAGES, "alt.json"));
const stems = Object.keys(hashes).sort();
const metadataStems = Object.keys(metadata).sort();

if (JSON.stringify(stems) !== JSON.stringify(metadataStems)) {
  fail(`metadata/hash stem sets differ (${metadataStems.length} metadata, ${stems.length} hashes)`);
}

// The photo index is the pool the worker BUNDLES (photos.js imports it): the
// grid renders exactly these stems. It must be in perfect bijection with
// hashes.json — an index entry without hashes would SSR a broken tile, and a
// hashed stem without an index entry is a published photo that silently never
// appears. Field shape is load-bearing too: home.js reads full/size/uploaded
// verbatim into href/data-* attributes.
const photoIndex = await json(path.join(ROOT, "www/_worker.js/photo-index.json"));
const indexStems = Object.keys(photoIndex).sort();
if (JSON.stringify(stems) !== JSON.stringify(indexStems)) {
  const missing = stems.filter((s) => !photoIndex[s]);
  const extra = indexStems.filter((s) => !hashes[s]);
  fail(`photo-index/hash stem sets differ (${indexStems.length} index, ${stems.length} hashes)` +
       `${missing.length ? `\n  hashed but not indexed: ${missing.slice(0, 8).join(", ")}` : ""}` +
       `${extra.length ? `\n  indexed but not hashed: ${extra.slice(0, 8).join(", ")}` : ""}` +
       `\n  add-photos.sh phase 4 writes the index; a removed photo must lose its entry here too`);
}
for (const [stem, entry] of Object.entries(photoIndex)) {
  if (asText(entry?.full) === null || !entry.full.startsWith(`${stem}.`)) {
    fail(`${stem}: index full must be the R2 key for this stem (got ${JSON.stringify(entry?.full)})`);
  }
  if (!Number.isInteger(entry.size) || entry.size <= 0) {
    fail(`${stem}: index size must be a positive integer byte count (got ${JSON.stringify(entry?.size)})`);
  }
  if (entry.uploaded !== null && Number.isNaN(Date.parse(entry.uploaded))) {
    fail(`${stem}: index uploaded must be an ISO date or null (got ${JSON.stringify(entry?.uploaded)})`);
  }
}

// The published pixel tiers, in one place: a (600 AVIF), j (600 JPG),
// s (400 AVIF, DPR-2), x (200 AVIF, DPR-1).
const TIER_KEYS = ["a", "j", "s", "x"];

const expectedFiles = new Set();
for (const stem of stems) {
  const entry = hashes[stem];
  // x (the 200px DPR-1 tier) is required alongside the other three. It could
  // have been optional, since photo-grid.js degrades to two srcset candidates
  // without it and photos.js keeps serving the stem — but "the pipeline half ran"
  // is exactly the state this file exists to refuse, and an optional tier is one
  // nothing would ever notice missing.
  if (!asRecord(entry) || !entry.a || !entry.j || !entry.s || !entry.x) {
    fail(`${stem}: hash entry must contain a, j, s, and x tiers`);
  }

  const files = [
    `${stem}.${entry.a}.avif`,
    `${stem}.${entry.j}.jpg`,
    `${stem}-400.${entry.s}.avif`,
    `${stem}-200.${entry.x}.avif`,
  ];
  for (const [tier, file] of [["a", files[0]], ["j", files[1]], ["s", files[2]], ["x", files[3]]]) {
    expectedFiles.add(file);
    try { await stat(path.join(HASHED, file)); }
    catch { fail(`${stem}: missing hashed pixel tier ${file}`); }
    const actual = createHash("sha256").update(await readFile(path.join(HASHED, file))).digest("hex");
    // Asserted in the direction photo_recipe reads it: hash the published bytes,
    // and the index must name this exact stem and tier. A missing entry and a
    // drifted one are the same failure here, which is why the old separate
    // "must contain a, j and s tiers" guard is gone rather than rewritten.
    if (fingerprints[actual] !== `${stem}:${tier}`) fail(`${stem}: fingerprint drift for ${file}`);
  }

  let perPhoto;
  try { perPhoto = await json(path.join(META, `${stem}.json`)); }
  catch { fail(`${stem}: missing per-photo metadata`); }
  const hist = perPhoto.hi;
  if (!hist || !["l", "r", "g", "b"].every((channel) => Array.isArray(hist[channel]) && hist[channel].length === 64)) {
    fail(`${stem}: histogram must contain four 64-bin channels`);
  }
}
const fingerprintStems = [...new Set(Object.values(fingerprints).map((entry) => String(entry).slice(0, String(entry).lastIndexOf(":"))))];
const fingerprintStrays = fingerprintStems.filter((stem) => !hashes[stem]);
if (fingerprintStrays.length) fail(`images/fingerprints.json carries unpublished stems: ${fingerprintStrays.join(", ")}`);
// What this catches that nothing above does: a STALE digest naming a photo that
// is still published, left over from a previous encode. The per-stem loop passes
// because the CURRENT bytes still resolve, and the stray check passes because the
// stem is still in hashes.json, so the count is the only witness. Measured with
// both controls rather than reasoned about: an earlier version of this comment
// claimed it was the backstop for a digest COLLISION, and a collision in fact
// trips the per-stem loop first, since the surviving entry names the other stem
// and that reads as drift.
// TIER_KEYS rather than a literal 3: this assertion hardcoded the tier count and
// went red the moment the 200px tier landed, naming a number nobody had thought
// to update. It was the check doing its job, and it should not need a second
// edit next time.
if (Object.keys(fingerprints).length !== stems.length * TIER_KEYS.length) {
  fail(`images/fingerprints.json holds ${Object.keys(fingerprints).length} digests, expected ${stems.length * TIER_KEYS.length} (${stems.length} photos x ${TIER_KEYS.length} tiers)`);
}

const actualFiles = (await readdir(HASHED)).filter((file) => /\.(avif|jpg)$/.test(file));
const orphans = actualFiles.filter((file) => !expectedFiles.has(file));
if (orphans.length) fail(`unreferenced hashed pixel files: ${orphans.join(", ")}`);

// Hand-written pages may hardcode an /i/ URL (the /garage/tooltips demo slots do).
// A /i/ URL names exact bytes, so a re-encode mints a new hash and hash-thumbnails.sh
// prunes the old file — which would leave those pages 404ing on images with nothing
// to catch it. Walk the authored HTML/JS and hold every hardcoded reference to the
// same standard as the manifest's own tiers.
const HARDCODED_ROOTS = ["www/garage", "www/lwe", "www/index.html"];
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
       `${missing.length > 8 ? " …" : ""}\n  fix with: node www/scripts/build-exif-index.mjs`);
}
const stale = stems.filter((stem) => JSON.stringify(exifIndex[stem]) !== JSON.stringify(rebuilt[stem]));
if (stale.length) {
  fail(`images/exif.json disagrees with images/meta/ for ${stale.length} photo(s): ${stale.slice(0, 8).join(", ")}` +
       `${stale.length > 8 ? " …" : ""}\n  fix with: node www/scripts/build-exif-index.mjs`);
}
// The packed histogram index (/images/histograms.json) is what the worker inlines
// into each tile as data-hist, so a stale or partial one is a tooltip whose bars
// quietly go back to costing a request per hover. Derived from the same per-photo
// files, and rebuilt through the generator's OWN packing function rather than a
// second copy of the rule, so this cannot pass by agreeing with itself.
const histIndex = await json(path.join(IMAGES, "histograms.json"));
const rebuiltHist = (await buildHistogramIndex()).index;
const histMissing = stems.filter((stem) => !histIndex[stem]);
if (histMissing.length) {
  fail(`${histMissing.length} photo(s) absent from images/histograms.json: ${histMissing.slice(0, 8).join(", ")}` +
       `${histMissing.length > 8 ? " …" : ""}\n  fix with: node www/scripts/build-histogram-index.mjs`);
}
const histStale = stems.filter((stem) => histIndex[stem] !== rebuiltHist[stem]);
if (histStale.length) {
  fail(`images/histograms.json disagrees with images/meta/ for ${histStale.length} photo(s): ${histStale.slice(0, 8).join(", ")}` +
       `${histStale.length > 8 ? " …" : ""}\n  fix with: node www/scripts/build-histogram-index.mjs`);
}
const histStrays = Object.keys(histIndex).filter((stem) => !hashes[stem]);
if (histStrays.length) fail(`images/histograms.json carries unpublished stems: ${histStrays.join(", ")}`);

const strays = Object.keys(exifIndex).filter((stem) => !hashes[stem]);
if (strays.length) fail(`images/exif.json carries unpublished stems: ${strays.join(", ")}`);

// alt text is a served artifact like the pixels and the EXIF, so a gap fails here
// rather than shipping an unlabelled image. add-photos.sh generates captions just
// above this check, so reaching it means the captioner was rate-limited or skipped.
const uncaptioned = stems.filter((stem) => !(alt[stem] || "").trim());
if (uncaptioned.length) {
  fail(`${uncaptioned.length} photo(s) without alt text: ${uncaptioned.slice(0, 8).join(", ")}` +
       `${uncaptioned.length > 8 ? " …" : ""}\n  fix with: pnpm run captions`);
}

console.log(`photo-pipeline: ${stems.length} photos, ${expectedFiles.size} hashed tiers, index in bijection, complete EXIF + histogram + alt-text metadata`);
