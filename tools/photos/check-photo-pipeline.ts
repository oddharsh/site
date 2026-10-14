#!/usr/bin/env node

// Validate the public photo artifact graph. Full-resolution source files stay
// outside git; this checks everything the site actually serves: the photo index
// the worker bundles, metadata, the histogram index, alt text, the hash map, and
// all four pixel tiers. add-photos.sh runs this as its last phase, and CI runs it
// on every PR so an incremental add cannot silently truncate the library.

import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildHistogramIndex } from "./build-histogram-index.ts";
import { buildExifIndex, buildImageFingerprints, HISTOGRAM_KEY, tierFiles, TIER_KEYS } from "../lib/photo-indexes.ts";
import { ALBUMS } from "../../src/worker/albums.ts";
import { asRecord, asText } from "../../src/worker/lib/parse.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const IMAGES = path.join(ROOT, "public/images");
const HASHED = path.join(ROOT, "public/i");
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
  const unhashed = metadataStems.filter((s) => !hashes[s]);
  const undescribed = stems.filter((s) => !metadata[s]);
  fail(`metadata/hash stem sets differ (${metadataStems.length} metadata, ${stems.length} hashes)` +
       `${unhashed.length ? `\n  described but not published: ${unhashed.slice(0, 8).join(", ")}${unhashed.length > 8 ? ` (+${unhashed.length - 8})` : ""}` : ""}` +
       `${undescribed.length ? `\n  published but not described: ${undescribed.slice(0, 8).join(", ")}${undescribed.length > 8 ? ` (+${undescribed.length - 8})` : ""}` : ""}` +
       `\n  metadata.json describes PUBLISHED photos; re-run extract-photo-metadata.sh, which scopes to hashes.json`);
}

const photoIndex: Record<string, { full?: string; size?: number; uploaded?: string; album?: string; heif?: string }> =
  await json(path.join(ROOT, "src/worker/photo-index.json"));
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
  if (entry.album !== undefined && !Object.hasOwn(ALBUMS, String(entry.album))) {
    fail(`${stem}: index album ${JSON.stringify(entry.album)} is not declared in src/worker/albums.ts`);
  }
  if (entry.heif !== undefined && !/^[A-Za-z0-9_.-]+\.(?:heic|heif|hif)$/i.test(String(entry.heif)) ) {
    fail(`${stem}: index heif must be a HEIF R2 key (got ${JSON.stringify(entry.heif)})`);
  }
  if (entry.heif !== undefined && !String(entry.heif).startsWith(`${stem}.`)) {
    fail(`${stem}: index heif must be this stem's own key (got ${JSON.stringify(entry.heif)})`);
  }
}

const histIndex = await json(path.join(IMAGES, "histograms.json"));

const expectedFiles = new Set();
for (const stem of stems) {
  const entry = hashes[stem];
  if (!asRecord(entry) || !entry.a || !entry.j || !entry.s || !entry.x) {
    fail(`${stem}: hash entry must contain a, j, s, and x tiers`);
  }

  const files = tierFiles(stem, entry);
  for (const tier of TIER_KEYS) {
    expectedFiles.add(files[tier]);
    try { await stat(path.join(HASHED, files[tier])); }
    catch { fail(`${stem}: missing hashed pixel tier ${files[tier]}`); }
  }

  const packedHist = histIndex[stem];
  if (!packedHist || packedHist.length !== 4 * 64) {
    fail(`${stem}: histograms.json must carry four 64-bin channels (got ${packedHist ? `${packedHist.length} chars` : "nothing"})`);
  }
}
try {
  const { tiers } = await buildImageFingerprints(ROOT);
  if (tiers !== stems.length * TIER_KEYS.length) {
    fail(`fingerprint derivation covered ${tiers} tiers, expected ${stems.length * TIER_KEYS.length} (${stems.length} photos x ${TIER_KEYS.length} tiers)`);
  }
} catch (error) {
  fail(String(error?.message || error));
}

const actualFiles = (await readdir(HASHED)).filter((file) => /\.(avif|jpg)$/.test(file));
const orphans = actualFiles.filter((file) => !expectedFiles.has(file));
if (orphans.length) fail(`unreferenced hashed pixel files: ${orphans.join(", ")}`);

// Hand-written pages may hardcode an /i/ URL (the /garage/tooltips demo slots do).
// A /i/ URL names exact bytes, so a re-encode mints a new hash and hash-thumbnails.sh
// prunes the old file — which would leave those pages 404ing on images with nothing
// to catch it. Walk the authored HTML/JS and hold every hardcoded reference to the
// same standard as the manifest's own tiers.
//
// THE ROOTS WERE public/garage AND public/lwe UNTIL 2026-08-28, and neither has held
// an HTML file since the src/pages split on 2026-08-18. So this walked two asset
// directories plus one page, read 0 references, and reported a pass, while the 12
// real ones sat in src/pages/garage/tooltips.html. Gotcha 40 from the scanner's
// side: the rewrite moved the documents and left the walk pointing where they used
// to be, and a grep for the old path finds nothing because the roots are a list of
// directories rather than a spelling of any file.
//
// It stayed invisible because the check only bites during a re-encode, and there
// had not been one since the split. The first full re-encode is what found it,
// which is the event it exists for.
const HARDCODED_ROOTS = ["src/pages", "src/content", "src/client"];
const HARDCODED_FLOOR = 12;
const walk = async (target) => {
  const entry = await stat(target);
  if (!entry.isDirectory()) return [target];
  const kids = await readdir(target, { withFileTypes: true });
  const nested = await Promise.all(kids.map((k) => walk(path.join(target, k.name))));
  return nested.flat();
};
const authored = (await Promise.all(HARDCODED_ROOTS.map((r) => walk(path.join(ROOT, r)))))
  .flat().filter((file) => /\.(html|js)$/.test(file));
let hardcoded = 0;
for (const file of authored) {
  const body = await readFile(file, "utf8");
  for (const [, name] of body.matchAll(/\/i\/([A-Za-z0-9_-]+\.[a-f0-9]{8}\.(?:avif|jpg))/g)) {
    hardcoded++;
    if (!expectedFiles.has(name)) {
      fail(`${path.relative(ROOT, file)} references /i/${name}, which no longer exists\n` +
           `  the tier was re-encoded; re-point it at the current hash in images/hashes.json`);
    }
  }
}
if (hardcoded < HARDCODED_FLOOR) {
  fail(`the hardcoded /i/ scan read ${hardcoded} references across ${authored.length} file(s), ` +
       `under the floor of ${HARDCODED_FLOOR}\n` +
       `  it has stopped matching. roots: ${HARDCODED_ROOTS.join(", ")}`);
}

const exifIndex = await buildExifIndex(ROOT);

const metaPresent = await stat(META).then((s) => s.isDirectory(), () => false);

const histMissing = stems.filter((stem) => !histIndex[stem]);
if (histMissing.length) {
  fail(`${histMissing.length} photo(s) absent from images/histograms.json: ${histMissing.slice(0, 8).join(", ")}` +
       `${histMissing.length > 8 ? " …" : ""}\n  fix with: bun tools/photos/build-histogram-index.ts`);
}

if (metaPresent) {
  const rolled = {};
  for (const file of (await readdir(META)).filter((f) => f.endsWith(".json"))) {
    const { [HISTOGRAM_KEY]: _hist, ...exif } = JSON.parse(await readFile(path.join(META, file), "utf8"));
    rolled[file.replace(/\.json$/, "")] = exif;
  }
  const stale = stems.filter((stem) => JSON.stringify(exifIndex[stem]) !== JSON.stringify(rolled[stem]));
  if (stale.length) {
    fail(`the two EXIF projections disagree for ${stale.length} photo(s): ${stale.slice(0, 8).join(", ")}` +
         `${stale.length > 8 ? " …" : ""}\n` +
         `  both come from projectExifRecord in tools/lib/photo-indexes.ts, so images/meta/ was\n` +
         `  written from an older metadata.json than the one on disk. Re-run extract-photo-metadata.sh.`);
  }
  const rebuiltHist = (await buildHistogramIndex()).index;
  const histStale = stems.filter((stem) => histIndex[stem] !== rebuiltHist[stem]);
  if (histStale.length) {
    fail(`images/histograms.json disagrees with images/meta/ for ${histStale.length} photo(s): ${histStale.slice(0, 8).join(", ")}` +
         `${histStale.length > 8 ? " …" : ""}\n  fix with: bun tools/photos/build-histogram-index.ts`);
  }
} else {
  console.log("photo-pipeline: images/meta/ absent (build output), so the projection-agreement checks are skipped here");
}

const histStrays = Object.keys(histIndex).filter((stem) => !hashes[stem]);
if (histStrays.length) fail(`images/histograms.json carries unpublished stems: ${histStrays.join(", ")}`);

const uncaptioned = stems.filter((stem) => !(alt[stem] || "").trim());
if (uncaptioned.length) {
  fail(`${uncaptioned.length} photo(s) without alt text: ${uncaptioned.slice(0, 8).join(", ")}` +
       `${uncaptioned.length > 8 ? " …" : ""}\n  fix with: bun run captions`);
}

console.log(`photo-pipeline: ${stems.length} photos, ${expectedFiles.size} hashed tiers, index in bijection, complete EXIF + histogram + alt-text metadata`);
