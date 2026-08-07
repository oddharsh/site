#!/usr/bin/env node

// Validate the committed public photo artifact graph. Full-resolution source
// files stay outside git; this checks everything the site actually serves:
// the photo index, canonical metadata, alt text, the hash map, fingerprints,
// and all three pixel tiers. add-photos.sh runs this as its last
// phase, and CI runs it on every PR so an incremental add cannot silently
// truncate the library.

import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const IMAGES = path.join(ROOT, "assets/photos/data");
const HASHED = path.join(ROOT, "assets/photos/thumbs");

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
const photoIndex = await json(path.join(ROOT, "content/data/photo-index.json"));
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
  if (typeof entry?.full !== "string" || !entry.full.startsWith(`${stem}.`)) {
    fail(`${stem}: index full must be the R2 key for this stem (got ${JSON.stringify(entry?.full)})`);
  }
  if (!Number.isInteger(entry.size) || entry.size <= 0) {
    fail(`${stem}: index size must be a positive integer byte count (got ${JSON.stringify(entry?.size)})`);
  }
  if (entry.uploaded !== null && Number.isNaN(Date.parse(entry.uploaded))) {
    fail(`${stem}: index uploaded must be an ISO date or null (got ${JSON.stringify(entry?.uploaded)})`);
  }
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
  const fp = fingerprints[stem];
  if (!fp || !fp.a || !fp.j || !fp.s) fail(`${stem}: fingerprint entry must contain a, j, and s tiers`);
  for (const [tier, file] of [["a", files[0]], ["j", files[1]], ["s", files[2]]]) {
    expectedFiles.add(file);
    try { await stat(path.join(HASHED, file)); }
    catch { fail(`${stem}: missing hashed pixel tier ${file}`); }
    const actual = createHash("sha256").update(await readFile(path.join(HASHED, file))).digest("hex");
    if (actual !== fp[tier]) fail(`${stem}: fingerprint drift for ${file}`);
  }
}
const fingerprintStrays = Object.keys(fingerprints).filter((stem) => !hashes[stem]);
if (fingerprintStrays.length) fail(`images/fingerprints.json carries unpublished stems: ${fingerprintStrays.join(", ")}`);

const actualFiles = (await readdir(HASHED)).filter((file) => /\.(avif|jpg)$/.test(file));
const orphans = actualFiles.filter((file) => !expectedFiles.has(file));
if (orphans.length) fail(`unreferenced hashed pixel files: ${orphans.join(", ")}`);

// Alt text is a served artifact like the pixels and metadata, so a gap fails here
// rather than shipping an unlabelled image. add-photos.sh generates captions just
// above this check, so reaching it means the captioner was rate-limited or skipped.
const uncaptioned = stems.filter((stem) => !(alt[stem] || "").trim());
if (uncaptioned.length) {
  fail(`${uncaptioned.length} photo(s) without alt text: ${uncaptioned.slice(0, 8).join(", ")}` +
       `${uncaptioned.length > 8 ? " …" : ""}\n  fix with: npm run captions`);
}

console.log(`photo-pipeline: ${stems.length} photos, ${expectedFiles.size} hashed tiers, index in bijection, complete metadata + alt text`);
