// The two photo data indexes the site SERVES and no longer commits:
// images/exif.json (the tooltip's text tier) and images/fingerprints.json (the
// digest map photo_recipe recognises an uploaded thumbnail with).
//
// Both were checked-in derivatives with nothing diffing them against the bytes
// they derive from, which is the shape that froze the search index twice: once
// because a path rename made the generator exit ENOENT, once because nobody ran
// it. Both freezes were silent, and could only be silent, because each consumer
// falls back to an empty result. A stale exif.json is a tooltip that renders
// with fewer lines; a stale fingerprints.json is photo_recipe reporting a real
// published photo as one this site never served. Neither raises anything.
//
// build.ts step 1a generates them into .build/public now, so the file that
// ships is a function of the commit that shipped it and there is no step anyone
// can forget. Nothing writes either one into the source tree any more.
//
// Both derivations take a root rather than resolving one from import.meta.url,
// because check-photo-pipeline.ts and the contract suite call them against the
// checkout while the build calls them on its way into .build/.

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

// ── exif.json ────────────────────────────────────────────────────────────────
//
// One file for every photo, rather than one file per photo, because the
// homepage draws a fresh RANDOM 12 of 165 on every request: three curls a
// second apart return three different sets, so a per-photo warm-up was cold on
// essentially every visit. A given slot repeats about 7.6% of the time.
//
//   12 per-photo files, per visit   ~8.9KB transferred, 12 requests, cold ~every visit
//   all 165 EXIF, one file          2.6KB brotli, 1 request, immutable, warm forever
//
// Histograms stay OUT of it. They are 623 of the ~977 bytes in a per-photo meta
// file, so folding them in would take this index from 2.6KB to 24KB brotli: a
// large idle download for bars most visitors never open. The tooltip renders its
// text from this index immediately and fetches the one histogram it needs when a
// hover actually happens.

/**
 * The 22 pairs, SHORT key to metadata.json's long one, in emission order.
 *
 * extract-photo-metadata.sh carries the same map as a jq object literal, because
 * it still writes the local images/meta/ files that `zenc histogram` bakes into.
 * That is a second implementation of one rule, so check-photo-pipeline.ts holds
 * the two together wherever images/meta/ exists: it rolls that directory up and
 * fails on any stem where the two projections disagree.
 */
export const EXIF_KEY_MAP: readonly (readonly [string, string])[] = [
  ["cm", "camera"], ["ln", "lens"], ["ap", "aperture"], ["sp", "shutter"],
  ["is", "iso"], ["fl", "focal"], ["ev", "ev"], ["dt", "date"],
  ["w", "width"], ["h", "height"], ["wb", "white_balance"], ["ct", "color_temp"],
  ["fs", "flash"], ["fm", "film"], ["dr", "dr"], ["cc", "chrome"],
  ["cb", "chrome_blue"], ["gr", "grain"], ["gs", "grain_size"],
  ["ht", "highlight_tone"], ["st", "shadow_tone"], ["sa", "saturation"],
];

/** `hi` is the four 64-bin histogram channels. Everything else in a meta file is EXIF text. */
export const HISTOGRAM_KEY = "hi";

/**
 * Project one metadata.json record through the key map, dropping nulls.
 *
 * A null field is DROPPED rather than emitted, because the tooltip skips a line
 * it has no value for and never fabricates one. jq's `select(.value != null)`
 * drops undefined the same way, since a key absent from the record reads as
 * null there, which is why this tests both.
 */
export function projectExifRecord(record: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [short, long] of EXIF_KEY_MAP) {
    const value = record?.[long];
    if (value !== null && value !== undefined) out[short] = value;
  }
  return out;
}

/** Every published photo's EXIF text, keyed by stem, projected from metadata.json. */
export async function buildExifIndex(root: string): Promise<Record<string, Record<string, unknown>>> {
  const metadata = JSON.parse(await readFile(path.join(root, "public/images/metadata.json"), "utf8"));
  const index: Record<string, Record<string, unknown>> = {};
  for (const stem of Object.keys(metadata).sort()) index[stem] = projectExifRecord(metadata[stem]);
  return index;
}

/**
 * ONE LINE PER STEM, which is a wire decision rather than a formatting one: the
 * whole point of this file is a small compressed payload, and a line per record
 * keeps a stem's record on a single line for anyone reading it raw.
 */
export function serializeExifIndex(index: Record<string, unknown>): string {
  const rows = Object.keys(index).sort().map((stem) => `${JSON.stringify(stem)}:${JSON.stringify(index[stem])}`);
  return `{\n${rows.join(",\n")}\n}\n`;
}

// ── fingerprints.json ────────────────────────────────────────────────────────
//
// The short hash in hashes.json names a URL; this longer digest lets the MCP
// photo_recipe tool prove that an uploaded thumbnail is one of those exact
// published bytes before it returns the camera recipe.
//
// Written DIGEST-FIRST (`{sha256: "stem:tier"}`) because that is the only
// direction anything reads it: photo_recipe hashes an upload and asks which
// published photo those bytes are. Stored stem-first the lookup had to scan
// every entry through a nested loop; keyed by digest, JSON.parse hands back the
// index itself and the lookup is one property access.
//
// This buys nothing on the wire, which is worth knowing before anyone
// "optimises" the encoding. sha256 is incompressible, so 660 digests sit on a
// ~21.1 KB entropy floor and brotli already recovers the hex alphabet's waste.
// Only truncating the digest moves that number, and that is a separate decision
// about how strong a match claim the tool is making.

export const TIER_KEYS = ["a", "j", "s", "x"] as const;

// The index currently reads 660 independent immutable tier files. Serial reads
// turn filesystem latency into a 660-step waterfall, while an unbounded
// Promise.all would ask the host to open the entire library at once. Eight keeps
// the same bounded ceiling as the build's compression pool; 13 alternating
// trials on 2026-09-01 cut the derivation median from 54.05ms to 15.99ms without
// changing a digest or the emitted key order. Nine alternating clean builds
// moved from 1671.23ms to 1603.61ms (4.0%).
const FINGERPRINT_READ_CONCURRENCY = 8;

/** The four published pixel-tier filenames for one stem, from its hashes.json entry. */
export function tierFiles(stem: string, entry: Record<string, string>): Record<string, string> {
  return {
    a: `${stem}.${entry.a}.avif`,
    j: `${stem}.${entry.j}.jpg`,
    s: `${stem}-400.${entry.s}.avif`,
    x: `${stem}-200.${entry.x}.avif`,
  };
}

/**
 * sha256 every published pixel tier, inverted to `{digest: "stem:tier"}`.
 *
 * Stems sorted and tiers in a fixed order, so the emitted key order is stable
 * and a rebuild that changed no pixel changes no byte of this file.
 */
export async function buildImageFingerprints(root: string): Promise<{
  index: Record<string, string>; photos: number; tiers: number;
}> {
  const hashes = JSON.parse(await readFile(path.join(root, "public/images/hashes.json"), "utf8"));
  const hashed = path.join(root, "public/i");
  const jobs: { stem: string; tier: typeof TIER_KEYS[number]; file: string }[] = [];
  for (const stem of Object.keys(hashes).sort()) {
    const files = tierFiles(stem, hashes[stem]);
    for (const tier of TIER_KEYS) jobs.push({ stem, tier, file: files[tier] });
  }

  // Fill by job index, then construct the object in that original order. The
  // scheduling is allowed to vary; fingerprints.json and collision selection
  // are not.
  const digests = new Array<string>(jobs.length);
  let next = 0;
  const readAndHash = async () => {
    for (;;) {
      const index = next++;
      if (index >= jobs.length) return;
      const bytes = await readFile(path.join(hashed, jobs[index].file));
      digests[index] = createHash("sha256").update(bytes).digest("hex");
    }
  };
  await Promise.all(Array.from(
    { length: Math.min(FINGERPRINT_READ_CONCURRENCY, jobs.length) },
    readAndHash,
  ));

  const index: Record<string, string> = {};
  for (const [jobIndex, { stem, tier, file }] of jobs.entries()) {
    const sum = digests[jobIndex];
    // Two published tiers holding identical bytes cannot both be represented
    // by an inverted index. The old stem-first shape did not make this
    // impossible, it made it INVISIBLE: the scan returned whichever entry it
    // reached first and nothing said the other existed. Refuse rather than pick.
    if (index[sum]) {
      throw new Error(`image fingerprints: ${file} is byte-identical to ${index[sum]}; publish one of the two, not both`);
    }
    index[sum] = `${stem}:${tier}`;
  }
  return { index, photos: Object.keys(hashes).length, tiers: jobs.length };
}

export function serializeFingerprints(index: Record<string, string>): string {
  return `${JSON.stringify(index)}\n`;
}
