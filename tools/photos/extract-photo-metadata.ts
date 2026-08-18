#!/usr/bin/env bun
// extract-photo-metadata.ts — read EXIF from a folder of SOOC photos and emit
// images/metadata.json keyed by R2 filename. The worker does not read EXIF
// itself (that would mean bundling a JS library), so this runs once per upload
// batch.
//
//   bun tools/photos/extract-photo-metadata.ts /path/to/sooc-originals/
//   bun tools/photos/extract-photo-metadata.ts --merge /path/to/selected-sources/
//
// --merge updates only the supplied source batch and preserves metadata for
// other photos. That is the mode the remote GitHub Actions pipeline uses, where
// downloading the entire private archive for one new photo would be wasteful.
//
// This read exiftool + jq + build-recipes.py until 2026-08-14. exif-sooc emits
// the record shape and the recipe card directly and owns the merge, so the
// reshape filter and the Python step are both gone. Measured on the 158
// committed photos: byte-identical output, and 9.9ms against exiftool's 995ms.
//
// DISCIPLINE: every value is nullable and the tooltip skips lines that are null
// rather than fabricate one. Read what the EXIF says, leave blank when it does
// not say, never guess. The projection below drops nulls for that reason.
//
// ── paths this conversion fixes ───────────────────────────────────────────
// META_DIR was "$SCRIPT_DIR/../images/meta" and the histogram bake ran with
// --root "$SCRIPT_DIR/..", both of which resolved to tools/ after the tree
// split rather than to the served tree. Fifth and sixth instances of a computed
// path no search for `www/` could find.
import { $ } from "bun";
import { mkdir, readdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { ensureZenc, requireBins } from "./lib/prereqs.ts";

export const REQUIRES = ["exif-sooc"] as const;

/**
 * The per-stem projection the tooltip's BARS tier reads. Short keys because 158
 * of these ship; nulls dropped because a missing line is the honest rendering.
 * This was a jq filter, and jq leaves the declaration with it.
 */
export const SHORT_KEYS = {
  cm: "camera", ln: "lens", ap: "aperture", sp: "shutter", is: "iso", fl: "focal",
  ev: "ev", dt: "date", w: "width", h: "height", wb: "white_balance", ct: "color_temp",
  fs: "flash", fm: "film", dr: "dr", cc: "chrome", cb: "chrome_blue", gr: "grain",
  gs: "grain_size", ht: "highlight_tone", st: "shadow_tone", sa: "saturation",
} as const;

export function project(record: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [short, full] of Object.entries(SHORT_KEYS)) {
    const v = record[full];
    if (v !== null && v !== undefined) out[short] = v;
  }
  return out;
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const merge = argv.includes("--merge");
  const srcDir = argv.filter((a) => a !== "--merge")[0];
  if (!srcDir) {
    console.error("usage: bun tools/photos/extract-photo-metadata.ts [--merge] <source-dir>");
    process.exit(1);
  }
  requireBins(REQUIRES);
  const zenc = await ensureZenc();

  const root = new URL("../../", import.meta.url).pathname;
  const out = join(root, "public/images/metadata.json");
  const metaDir = join(root, "public/images/meta");

  // Write through a .tmp so a failed read cannot truncate the committed record.
  const tmp = `${out}.tmp`;
  const args = merge ? ["--keyed", "--merge-into", out, "-q", "-r", srcDir] : ["--keyed", "-q", "-r", srcDir];
  const read = await $`exif-sooc ${args}`.quiet();
  await Bun.write(tmp, read.stdout);
  await rename(tmp, out);

  await mkdir(metaDir, { recursive: true });
  if (!merge) {
    // drop stale per-stem files (a removed photo would otherwise linger)
    for (const f of await readdir(metaDir)) {
      if (f.endsWith(".json")) await rm(join(metaDir, f));
    }
  }

  const records: Record<string, Record<string, unknown>> = JSON.parse(await Bun.file(out).text());
  for (const [stem, record] of Object.entries(records)) {
    // jq -c emits a trailing newline and JSON.stringify does not. One byte per
    // file, 158 files, and the difference is invisible until something diffs them.
    await Bun.write(join(metaDir, `${stem}.json`), JSON.stringify(project(record)) + "\n");
  }

  const hist = await $`${zenc} histogram --root ${join(root, "public")}`.quiet().nothrow();
  console.log(hist.stdout.toString().trim().split("\n").at(-1) ?? "");

  await $`bun ${join(root, "tools/photos/build-exif-index.mjs")}`;
  await $`bun ${join(root, "tools/photos/build-histogram-index.mjs")}`;

  const count = Object.keys(records).length;
  console.log(
    merge
      ? `✓ merged metadata for ${count} photos → ${out} (+ per-stem files in images/meta/, histograms baked)`
      : `✓ extracted metadata for ${count} photos → ${out} (+ ${count} per-stem files in images/meta/, histograms baked)`,
  );
  console.log("  next: bump META_V in tooltip.js if fields changed, commit + deploy.");
}
