#!/usr/bin/env bash
# extract-photo-metadata.sh — read EXIF from a folder of SOOC photos and
# emit /images/metadata.json keyed by R2 filename. the worker doesn't read
# EXIF itself (would require bundling a JS library); this script runs in the
# remote photo workflow once per upload batch.
#
# usage:
#   ./extract-photo-metadata.sh /path/to/sooc-originals/
#   ./extract-photo-metadata.sh --merge /path/to/selected-sources/
#
# requires: exif-sooc (cargo install --git https://github.com/oddharsh/exif-sooc),
#           jq (brew install jq)
#
# This read exiftool + jq + build-recipes.py until 2026-08-14. exif-sooc emits
# this record shape and the recipe card directly, and owns the merge, so the
# reshape filter and the Python step are both gone. Measured on the 158
# committed photos: byte-identical output, and 9.9ms against exiftool's 995ms,
# which is within 0.3ms of the I/O floor for opening those files at all.
#
# --merge updates only the supplied source batch and preserves metadata for
# other photos. This is the mode used by the remote GitHub Actions pipeline,
# where downloading the entire private archive for one new photo would be
# wasteful.
#
# what's extracted (all values are nullable; tooltip skips lines that
# are null rather than fabricate). discipline: read what the EXIF says,
# leave blank when it doesn't say. never guess.
#
# core EXIF (works on every body):
#   camera          - "<Make> <Model>"  e.g. "FUJIFILM X-T50"
#   lens            - LensModel         e.g. "XF35mmF1.4 R"
#   aperture        - FNumber           e.g. "f/2.8"
#   shutter         - ExposureTime      e.g. "1/120"
#   iso             - ISO               e.g. 800
#   focal           - 35mm-equivalent focal length
#   ev              - ExposureCompensation
#   exposure_mode   - "Manual" / "Aperture-priority AE" / etc
#   meter           - "Multi-segment" / "Spot" / "Center-weighted average"
#   focus_mode      - "AF-S" / "AF-C" / "Manual"
#   drive           - "Single" / "Continuous Low" / etc
#   date            - DateTimeOriginal (Fuji format: "YYYY:MM:DD HH:MM:SS")
#   width, height   - orientation-corrected pixel dimensions
#   color_space     - "sRGB" / "Adobe RGB"
#   white_balance   - "Auto" / "Daylight" / "Kelvin" / etc
#   color_temp      - when WB is Kelvin, the actual K value
#   wb_shift        - WhiteBalanceFineTune, when set
#   flash           - "No Flash" / "Fired, ..." etc
#   sharpness       - standard EXIF sharpness setting
#   noise_reduction - Fuji NR setting
#
# Fuji-specific film recipe (silently null on Leica/iPhone shots):
#   film         - FilmMode               e.g. "Classic Negative"
#   dr           - DynamicRange           e.g. "100%" / "200%" / "Auto"
#   chrome       - ColorChromeEffect      "Off" / "Weak" / "Strong"
#   chrome_blue  - ColorChromeFXBlue      same scale
#   grain        - GrainEffectRoughness   "Off" / "Weak" / "Strong"
#   grain_size   - GrainEffectSize        "Small" / "Large"
#   highlight_tone, shadow_tone, saturation
#
# GPS data is intentionally NOT included (privacy).
#
# output: www/images/metadata.json, schema:
#   { "01.jpg": { "camera": "...", ... }, "IMG_1234.heic": { ... } }

set -euo pipefail

MERGE=0
if [ "${1:-}" = "--merge" ]; then
  MERGE=1
  shift
fi

if [ $# -ne 1 ]; then
  echo "usage: $0 [--merge] /path/to/sooc-originals/" >&2
  exit 1
fi

SRC_DIR="$1"
if [ ! -d "$SRC_DIR" ]; then
  echo "error: $SRC_DIR is not a directory" >&2
  exit 1
fi

if ! command -v exif-sooc >/dev/null 2>&1; then
  echo "error: exif-sooc not found. install with:" >&2
  echo "  cargo install --git https://github.com/oddharsh/exif-sooc" >&2
  exit 1
fi
if ! command -v jq >/dev/null 2>&1; then
  echo "error: jq not found. install with: brew install jq" >&2
  exit 1
fi

# resolve the output path relative to this script
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
OUT="$SCRIPT_DIR/../images/metadata.json"

# zenc bakes the histogram channels at the end of this script (it replaced
# photo-histograms.py + Pillow on 2026-08-14, sharing the JPEG decoder the
# encoder already links). Same auto-build-on-first-run convention the other six
# pipeline scripts use, so a fresh checkout needs cargo and nothing else.
ZENC_DIR="$(cd "$SCRIPT_DIR/zenc" && pwd)"
ZENC="$ZENC_DIR/target/release/zenc"
if [ ! -x "$ZENC" ]; then
  echo "building zenc (histogram bake) — first run only…" >&2
  cargo build --release --manifest-path "$ZENC_DIR/Cargo.toml" >&2 || { echo "error: zenc build failed" >&2; exit 1; }
fi

# exif-sooc reads the containers directly and emits this script's exact record
# shape, so the 50-line jq `reduce` that used to reshape `exiftool -json` is
# gone, and so is the `jq -s '.[0] * .[1]'` merge that followed it.
#
# THE MERGE IS THE REASON THIS SWAP MATTERS, more than the speed. jq's object
# `*` is a RECURSIVE merge, and the reflexive substitute `+` is shallow: on a
# --merge run the fresh read carries no `recipe`, so `+` would drop the card
# from every re-merged photo, silently, and the failure reads as a tooltip that
# has quietly stopped showing lines. That operator pinned this pipeline to jq
# specifically. `--merge-into` states the rule instead of relying on one:
#
#   * a stem the read did not see passes through untouched
#   * a stem it did see keeps every key it already had, freshly read fields on top
#
# It prints to stdout and never writes the file it read, so a crash cannot leave
# a truncated metadata.json where a complete one was.
#
# The recipe card comes out of the same pass (exif-sooc derives it from the Fuji
# tags), which is what retired build-recipes.py and the last Python in this
# script's path.
#
# Verified before the swap: regenerating all 158 committed photos through
# exif-sooc produced records byte-identical to what exiftool + jq + Python
# produced, recipe cards included, 158/158.
if [ "$MERGE" -eq 1 ]; then
  exif-sooc --keyed --merge-into "$OUT" -q -r "$SRC_DIR" > "$OUT.tmp"
else
  exif-sooc --keyed -q -r "$SRC_DIR" > "$OUT.tmp"
fi
mv "$OUT.tmp" "$OUT"

# also emit one file per photo for the tooltip's per-photo lazy fetch:
# /images/meta/<stem>.json. these are immutable + content-addressed, so a visitor
# only pulls EXIF for the photos they actually hover (not the whole index), and
# repeat visits are served from the browser cache. metadata.json stays as the full
# index (the /images/metadata.json endpoint + a fallback). bump the ?mv version
# (META_V in tooltip.js) whenever this regenerates so caches refresh.
META_DIR="$SCRIPT_DIR/../images/meta"
mkdir -p "$META_DIR"
if [ "$MERGE" -eq 0 ]; then
  rm -f "$META_DIR"/*.json   # drop stale per-stem files (e.g. removed photos)
fi
# per-photo files carry a COMPACT schema, not a verbatim copy of the metadata.json
# entry: SHORT keys, only the fields the tooltip actually renders, and null-valued
# fields dropped. these are fetched once per hover (the hot path), so every byte is
# on someone's cursor. metadata.json keeps the full, readable, long-key schema — it
# is the public /photos index (photos.js PHOTO_PUBLIC_FIELDS reads it) and the
# archive. KEEP THIS MAP IN SYNC with tooltip.js (reader) and zenc's histogram.rs
# (which merges the "hi" histogram into these same files):
#   cm camera · ln lens · ap aperture · sp shutter · is iso · fl focal · ev ·
#   dt date · w width · h height · wb white_balance · ct color_temp · fs flash ·
#   fm film · dr · cc chrome · cb chrome_blue · gr grain · gs grain_size ·
#   ht highlight_tone · st shadow_tone · sa saturation  (hi added later by histograms)
jq -c 'to_entries[]' "$OUT" | while IFS= read -r entry; do
  stem=$(printf '%s' "$entry" | jq -r '.key')
  printf '%s' "$entry" | jq -c '.value | {
    cm: .camera, ln: .lens, ap: .aperture, sp: .shutter, is: .iso, fl: .focal,
    ev: .ev, dt: .date, w: .width, h: .height, wb: .white_balance, ct: .color_temp,
    fs: .flash, fm: .film, dr: .dr, cc: .chrome, cb: .chrome_blue, gr: .grain,
    gs: .grain_size, ht: .highlight_tone, st: .shadow_tone, sa: .saturation
  } | with_entries(select(.value != null))' > "$META_DIR/$stem.json"
done

# the recipe card is derived during extraction now (exif-sooc --keyed), so
# build-recipes.py is gone. One consequence worth knowing: a --merge run
# refreshes cards for the BATCH only, where the old script rewrote every card on
# every run. A full run still regenerates all of them, which is what to do after
# an exif-sooc upgrade that changes the card.

# bake the 64-bin histograms back into the meta files (the full run may have
# wiped them; the tooltip reads meta.hi instead of computing client-side)
"$ZENC" histogram --root "$SCRIPT_DIR/.." 2>&1 | tail -1

# roll the per-photo EXIF (minus histograms) into the one shared index the
# tooltip warms on idle. derived data, so it MUST be rebuilt whenever the
# per-photo files change; check-photo-pipeline.mjs fails on any drift.
node "$SCRIPT_DIR/build-exif-index.mjs"

COUNT=$(jq 'keys | length' "$OUT")
if [ "$MERGE" -eq 1 ]; then
  echo "✓ merged metadata for $COUNT photos → $OUT (+ per-stem files in images/meta/, histograms baked)"
else
  echo "✓ extracted metadata for $COUNT photos → $OUT (+ $COUNT per-stem files in images/meta/, histograms baked)"
fi
echo "  next: bump META_V in tooltip.js if fields changed, commit + deploy."
