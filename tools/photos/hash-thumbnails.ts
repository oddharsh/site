#!/usr/bin/env bun
//
// hash-thumbnails.ts — content-address the published thumbnails and keep them
// addressed on every photo add.
//
// For every tier file in public/images/ (<stem>.avif, <stem>.jpg,
// <stem>-400.avif, <stem>-200.avif) this computes sha256, copies the bytes to
// public/i/<name-with-.hash8-before-ext>, and writes public/images/hashes.json
// ({stem: {a,j,s,x}}), which buildImagesManifest reads to bake /i/ URLs into the
// photo manifest. A URL is born with its bytes, so the ?v=THUMB_VERSION
// global-bump class and the 4h edge-404 poison class both die structurally.
//
// Idempotent: re-running only adds/refreshes entries whose bytes changed (a
// changed file gets a NEW hashed name; the old one is pruned below).
//
//   bun tools/photos/hash-thumbnails.ts
//
// ── the path bug this conversion fixes ────────────────────────────────────
// The shell version computed HOLDING as "$(dirname $0)/..", which was www/ when
// this lived at www/scripts/. After the tree split it resolved to tools/, so
// SRC_DIR was tools/images and the fingerprint call was tools/scripts/... —
// both missing. It had been broken since the split, and no search for `www/`
// could find it because the path was COMPUTED rather than written. That is the
// third script in this directory with the same defect.
import { createHash } from "node:crypto";
import { copyFile, mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";

/** No external binaries: hashing and copying are language features. python3
 *  is dropped here exactly as it was in bump-version. */
export const REQUIRES = [] as const;

/** Codepoint order, matching python sorted(). NOT localeCompare: this map is
 *  compared byte-for-byte, and a locale-aware collation reorders keys. */
const byCodePoint = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** The four published tiers, and the map key each one occupies. */
export const TIERS = [
  { key: "a", suffix: ".avif", hashed: (stem: string, h: string) => `${stem}.${h}.avif` },
  { key: "j", suffix: ".jpg", hashed: (stem: string, h: string) => `${stem}.${h}.jpg` },
  { key: "s", suffix: "-400.avif", hashed: (stem: string, h: string) => `${stem}-400.${h}.avif` },
  { key: "x", suffix: "-200.avif", hashed: (stem: string, h: string) => `${stem}-200.${h}.avif` },
] as const;

/**
 * Stems come from ANY tier present, not just the JPG. A full re-encode writes
 * every tier so the JPG was a fine proxy; an ADDITIVE run (TIERS=xs in
 * reencode-thumbnails, which is how the 200px tier was backfilled without
 * reminting the other three hashes) writes one AVIF and no JPG at all, and a
 * JPG-only scan finds nothing and silently hashes zero photos.
 */
export function stemOf(file: string): string | null {
  for (const suffix of ["-400.avif", "-200.avif"]) {
    if (file.endsWith(suffix)) return file.slice(0, -suffix.length);
  }
  if (file.endsWith(".jpg")) return file.slice(0, -4);
  if (file.endsWith(".avif")) return file.slice(0, -5);
  return null;
}

/** python's json.dump(separators=(",", ":"), sort_keys=True): compact, keys
 *  sorted at every level, and NO trailing newline. */
export function serializeMap(map: Record<string, Record<string, string>>): string {
  const sorted: Record<string, Record<string, string>> = {};
  for (const stem of Object.keys(map).sort(byCodePoint)) {
    const entry = map[stem];
    sorted[stem] = Object.fromEntries(Object.keys(entry).sort(byCodePoint).map((k) => [k, entry[k]]));
  }
  return JSON.stringify(sorted);
}

const hash8 = async (path: string) =>
  createHash("sha256").update(Buffer.from(await Bun.file(path).arrayBuffer())).digest("hex").slice(0, 8);

export async function hashThumbnails(srcDir: string, outDir: string, mapPath: string) {
  await mkdir(outDir, { recursive: true });

  const files = await readdir(srcDir);
  const stems = [...new Set(files.map(stemOf).filter((s): s is string => !!s))].sort(byCodePoint);

  // MERGE into the existing map: an incremental add only stages the NEW stems in
  // public/images/ (earlier tiers were pruned once hashed into public/i/), so a
  // from-scratch rebuild would drop every prior stem and make buildImagesManifest
  // skip those photos.
  let map: Record<string, Record<string, string>> = {};
  try {
    map = JSON.parse(await Bun.file(mapPath).text());
  } catch {
    map = {};
  }

  let copied = 0;
  for (const stem of stems) {
    const entry: Record<string, string> = {};
    for (const tier of TIERS) {
      const src = join(srcDir, stem + tier.suffix);
      if (!(await Bun.file(src).exists())) continue;
      const h = await hash8(src);
      const out = join(outDir, tier.hashed(stem, h));
      if (!(await Bun.file(out).exists())) {
        await copyFile(src, out);
        copied++;
      }
      entry[tier.key] = h;
    }
    if (Object.keys(entry).length) {
      // MERGE rather than replace. An additive run carries only the tier it
      // generated, so assigning the entry outright would drop a, j and s for
      // every stem it touched — and those tiers would still be on disk in
      // public/i/, so the damage reads as a map that forgot them rather than as
      // missing files.
      map[stem] = { ...map[stem], ...entry };
    }
  }

  await Bun.write(mapPath, serializeMap(map));

  // Clean up so the tree matches the map:
  //   1. drop the un-hashed source tiers just addressed — they live in /i/ now.
  //      metadata.json / alt.json / hashes.json / meta/ stay put.
  //   2. drop /i/ files a re-encode superseded, so public/i/ is 1:1 with
  //      hashes.json and check-photo-pipeline passes.
  let prunedSrc = 0;
  for (const stem of stems) {
    for (const tier of TIERS) {
      const p = join(srcDir, stem + tier.suffix);
      if (await Bun.file(p).exists()) {
        await rm(p);
        prunedSrc++;
      }
    }
  }

  const expected = new Set<string>();
  for (const [stem, entry] of Object.entries(map)) {
    for (const tier of TIERS) {
      if (entry[tier.key]) expected.add(tier.hashed(stem, entry[tier.key]));
    }
  }
  let prunedI = 0;
  for (const f of await readdir(outDir)) {
    if (/\.(avif|jpg)$/.test(f) && !expected.has(f)) {
      await rm(join(outDir, f));
      prunedI++;
    }
  }

  return { stems: Object.keys(map).length, copied, prunedSrc, prunedI };
}

if (import.meta.main) {
  const root = new URL("../../", import.meta.url).pathname;
  const srcDir = join(root, "public/images");
  const outDir = join(root, "public/i");
  const mapPath = join(srcDir, "hashes.json");

  const r = await hashThumbnails(srcDir, outDir, mapPath);
  console.log(`hashed ${r.stems} stems, copied ${r.copied} new files -> ${outDir}`);
  console.log(`pruned ${r.prunedSrc} un-hashed source tiers, ${r.prunedI} superseded /i/ files`);
  console.log(`map: ${mapPath}`);

  // The short URL hash above is intentionally kept separate from the full-byte
  // fingerprint used by the exact photo_recipe matcher.
  const { $ } = await import("bun");
  await $`bun ${join(root, "tools/photos/build-image-fingerprints.mjs")}`;
}
