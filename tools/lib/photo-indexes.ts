// The two photo data indexes the site SERVES and no longer commits:
// images/exif.json (the tooltip's text tier) and images/fingerprints.json (the
// digest map photo_recipe recognises an uploaded thumbnail with).

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

export const EXIF_KEY_MAP: readonly (readonly [string, string])[] = [
  ["cm", "camera"], ["ln", "lens"], ["ap", "aperture"], ["sp", "shutter"],
  ["is", "iso"], ["fl", "focal"], ["ev", "ev"], ["dt", "date"],
  ["w", "width"], ["h", "height"], ["wb", "white_balance"], ["ct", "color_temp"],
  ["fs", "flash"], ["fm", "film"], ["dr", "dr"], ["cc", "chrome"],
  ["cb", "chrome_blue"], ["gr", "grain"], ["gs", "grain_size"],
  ["ht", "highlight_tone"], ["st", "shadow_tone"], ["sa", "saturation"],
];

export const HISTOGRAM_KEY = "hi";

export function projectExifRecord(record: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [short, long] of EXIF_KEY_MAP) {
    const value = record?.[long];
    if (value !== null && value !== undefined) out[short] = value;
  }
  return out;
}

export async function buildExifIndex(root: string): Promise<Record<string, Record<string, unknown>>> {
  const metadata = JSON.parse(await readFile(path.join(root, "public/images/metadata.json"), "utf8"));
  const index: Record<string, Record<string, unknown>> = {};
  for (const stem of Object.keys(metadata).sort()) index[stem] = projectExifRecord(metadata[stem]);
  return index;
}

export function serializeExifIndex(index: Record<string, unknown>): string {
  const rows = Object.keys(index).sort().map((stem) => `${JSON.stringify(stem)}:${JSON.stringify(index[stem])}`);
  return `{\n${rows.join(",\n")}\n}\n`;
}

export const TIER_KEYS = ["a", "j", "s", "x"] as const;

const FINGERPRINT_READ_CONCURRENCY = 8;

export function tierFiles(stem: string, entry: Record<string, string>): Record<string, string> {
  return {
    a: `${stem}.${entry.a}.avif`,
    j: `${stem}.${entry.j}.jpg`,
    s: `${stem}-400.${entry.s}.avif`,
    x: `${stem}-200.${entry.x}.avif`,
  };
}

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
