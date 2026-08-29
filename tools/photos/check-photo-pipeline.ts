#!/usr/bin/env node

// Validate the public photo artifact graph. Full-resolution source files stay
// outside git; this checks everything the site actually serves: the photo index
// the worker bundles, metadata, the histogram index, alt text, the hash map, and
// all four pixel tiers. add-photos.sh runs this as its last phase, and CI runs it
// on every PR so an incremental add cannot silently truncate the library.
//
// Two of the artifacts it once READ are BUILD OUTPUT now (exif.json and
// fingerprints.json, since 2026-08-29), so it DERIVES those through
// tools/lib/photo-indexes.ts rather than opening a committed file. Both blocks
// below say which of their old assertions that retired and why; the short version
// is that a claim about a committed copy disagreeing with its inputs has nothing
// left to be true of once the build computes it from those same inputs.

import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildHistogramIndex } from "./build-histogram-index.ts";
import { buildExifIndex, buildImageFingerprints, HISTOGRAM_KEY, tierFiles, TIER_KEYS } from "../lib/photo-indexes.ts";
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
  // Name the stems and the likely cause. This used to report the two COUNTS and
  // nothing else, which says a set differs without saying how, and the usual
  // cause is not a missing photo at all: the source folder is an input superset,
  // so a full metadata regen used to write a record for every frame sitting in
  // it, published or not. extract-photo-metadata.sh scopes to hashes.json now,
  // and the message says so, because "165 metadata, 158 hashes" sent the last
  // reader looking for 7 broken photos rather than 7 unpublished ones.
  const unhashed = metadataStems.filter((s) => !hashes[s]);
  const undescribed = stems.filter((s) => !metadata[s]);
  fail(`metadata/hash stem sets differ (${metadataStems.length} metadata, ${stems.length} hashes)` +
       `${unhashed.length ? `\n  described but not published: ${unhashed.slice(0, 8).join(", ")}${unhashed.length > 8 ? ` (+${unhashed.length - 8})` : ""}` : ""}` +
       `${undescribed.length ? `\n  published but not described: ${undescribed.slice(0, 8).join(", ")}${undescribed.length > 8 ? ` (+${undescribed.length - 8})` : ""}` : ""}` +
       `\n  metadata.json describes PUBLISHED photos; re-run extract-photo-metadata.sh, which scopes to hashes.json`);
}

// The photo index is the pool the worker BUNDLES (photos.js imports it): the
// grid renders exactly these stems. It must be in perfect bijection with
// hashes.json — an index entry without hashes would SSR a broken tile, and a
// hashed stem without an index entry is a published photo that silently never
// appears. Field shape is load-bearing too: home.js reads full/size/uploaded
// verbatim into href/data-* attributes.
// One entry per photo stem: the R2 key, its byte size, and the upload stamp.
// Named here because `json()` answers unknown and this file's whole job is
// asserting the shape of that record.
const photoIndex: Record<string, { full?: string; size?: number; uploaded?: string }> =
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
}

// The published pixel tiers are a (600 AVIF), j (600 JPG), s (400 AVIF, DPR-2),
// x (200 AVIF, DPR-1). TIER_KEYS and the filename shape come from
// tools/lib/photo-indexes.ts, which is what the build derives fingerprints.json
// from, so this file and that derivation cannot disagree about which four files
// a stem publishes.

const histIndex = await json(path.join(IMAGES, "histograms.json"));

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

  const files = tierFiles(stem, entry);
  for (const tier of TIER_KEYS) {
    expectedFiles.add(files[tier]);
    try { await stat(path.join(HASHED, files[tier])); }
    catch { fail(`${stem}: missing hashed pixel tier ${files[tier]}`); }
  }

  // The four histogram channels are asserted against the INDEX now, because
  // images/meta/ is build output and is not in a fresh checkout. Same coverage,
  // one representation fewer.
  // Length is the domain check: a packed entry is 4 channels x 64 bins, one
  // character each. A missing or wrong-typed entry has no .length and fails here
  // the same way, so nothing needs to ask what type it is.
  const packedHist = histIndex[stem];
  if (!packedHist || packedHist.length !== 4 * 64) {
    fail(`${stem}: histograms.json must carry four 64-bin channels (got ${packedHist ? `${packedHist.length} chars` : "nothing"})`);
  }
}
// THREE FINGERPRINT ASSERTIONS LIVED HERE AND ARE GONE, because images/
// fingerprints.json is BUILD OUTPUT as of 2026-08-29 and each of the three was a
// statement about a committed file that could disagree with these bytes: a
// digest that had drifted, a digest naming an unpublished stem, and a count that
// no longer matched stems x tiers. A map derived from hashes.json and public/i
// on the way into .build/ cannot hold any of those three states, so re-asserting
// them here would be a check that can only agree with itself, which this
// repository has shipped before and does not want again.
//
// One fact about that map is NOT a restatement of its own inputs: two published
// tiers can hold identical bytes, and an inverted index cannot represent both.
// buildImageFingerprints refuses rather than picking a winner, and running it
// here is what puts that refusal in front of add-photos.sh instead of leaving it
// to the next build. It re-reads the same 660 files the loop above stats, which
// is the hashing this file used to do inline and no longer does.
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
// A scanner whose roots stop matching reports a pass over an empty set, which is
// what every floor in this repo refuses. 12 today, all in tooltips.html. Deleting
// that demo is a deliberate act and lowering this number with it is one line.
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

// exif.json is BUILD OUTPUT as of 2026-08-29, so this DERIVES it rather than
// reading it. Its coverage of the published set is asserted by the
// metadata/hash stem-set equality at the top of this file, which is exact in
// both directions, so the old "absent from images/exif.json" and "carries
// unpublished stems" checks would now be re-deriving that same equality from
// the same two files. They are gone rather than restated.
const exifIndex = await buildExifIndex(ROOT);

// TIERED, because images/meta/ is BUILD OUTPUT too and is absent from a fresh
// checkout. Where it exists, which is a workstation that just ran the pipeline,
// roll it up and compare.
//
// WHAT THAT COMPARISON MEANS CHANGED with the move, and it is worth more now
// than it was. It used to hold two committed copies of one projection together.
// The projection has TWO IMPLEMENTATIONS: the jq object literal in
// extract-photo-metadata.sh, which writes these per-photo files, and
// EXIF_KEY_MAP in tools/lib/photo-indexes.ts, which is what ships. Nothing else
// holds those two to each other, and a field added to one and forgotten in the
// other is silent on both sides: the tooltip renders one line fewer and the
// per-photo fallback renders one line more.
const metaPresent = await stat(META).then((s) => s.isDirectory(), () => false);

const histMissing = stems.filter((stem) => !histIndex[stem]);
if (histMissing.length) {
  fail(`${histMissing.length} photo(s) absent from images/histograms.json: ${histMissing.slice(0, 8).join(", ")}` +
       `${histMissing.length > 8 ? " …" : ""}\n  fix with: node tools/photos/build-histogram-index.ts`);
}

if (metaPresent) {
  // The per-photo files minus their histogram channel: what the jq literal in
  // extract-photo-metadata.sh produced for each stem.
  const rolled = {};
  for (const file of (await readdir(META)).filter((f) => f.endsWith(".json"))) {
    const { [HISTOGRAM_KEY]: _hist, ...exif } = JSON.parse(await readFile(path.join(META, file), "utf8"));
    rolled[file.replace(/\.json$/, "")] = exif;
  }
  const stale = stems.filter((stem) => JSON.stringify(exifIndex[stem]) !== JSON.stringify(rolled[stem]));
  if (stale.length) {
    fail(`the two EXIF projections disagree for ${stale.length} photo(s): ${stale.slice(0, 8).join(", ")}` +
         `${stale.length > 8 ? " …" : ""}\n` +
         `  images/meta/ came from the jq map in tools/photos/extract-photo-metadata.sh;\n` +
         `  what ships comes from EXIF_KEY_MAP in tools/lib/photo-indexes.ts. Make the two agree,\n` +
         `  or re-run extract-photo-metadata.sh if images/meta/ is simply older than metadata.json.`);
  }
  const rebuiltHist = (await buildHistogramIndex()).index;
  const histStale = stems.filter((stem) => histIndex[stem] !== rebuiltHist[stem]);
  if (histStale.length) {
    fail(`images/histograms.json disagrees with images/meta/ for ${histStale.length} photo(s): ${histStale.slice(0, 8).join(", ")}` +
         `${histStale.length > 8 ? " …" : ""}\n  fix with: node tools/photos/build-histogram-index.ts`);
  }
} else {
  console.log("photo-pipeline: images/meta/ absent (build output), so the projection-agreement checks are skipped here");
}

const histStrays = Object.keys(histIndex).filter((stem) => !hashes[stem]);
if (histStrays.length) fail(`images/histograms.json carries unpublished stems: ${histStrays.join(", ")}`);

// alt text is a served artifact like the pixels and the EXIF, so a gap fails here
// rather than shipping an unlabelled image. add-photos.sh generates captions just
// above this check, so reaching it means the captioner was rate-limited or skipped.
const uncaptioned = stems.filter((stem) => !(alt[stem] || "").trim());
if (uncaptioned.length) {
  fail(`${uncaptioned.length} photo(s) without alt text: ${uncaptioned.slice(0, 8).join(", ")}` +
       `${uncaptioned.length > 8 ? " …" : ""}\n  fix with: bun run captions`);
}

console.log(`photo-pipeline: ${stems.length} photos, ${expectedFiles.size} hashed tiers, index in bijection, complete EXIF + histogram + alt-text metadata`);
