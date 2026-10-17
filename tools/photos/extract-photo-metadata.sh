#!/usr/bin/env bash
# extract-photo-metadata.sh — read EXIF from SOOC photo files or folders and
# emit /images/metadata.json keyed by R2 filename. the worker doesn't read
# EXIF itself (would require bundling a JS library); this script runs in the
# remote photo workflow once per upload batch.
#
# usage:
#   ./extract-photo-metadata.sh /path/to/sooc-originals/
#   ./extract-photo-metadata.sh --merge /path/to/selected-sources/
#   ./extract-photo-metadata.sh --merge /first/frame.HIF /second/other.jpg
#
# requires: exif-sooc (cargo install --git https://github.com/oddharsh/exif-sooc exif-sooc),
#           and the bun the rest of the pipeline already runs (pipeline-json.ts)
#
# exif-sooc emits this record shape and the recipe card directly, and owns the
# merge. It replaced exiftool + jaq + build-recipes.py on 2026-08-14, measured on
# the 158 committed photos: byte-identical output, and 9.9ms against exiftool's
# 995ms, which is within 0.3ms of the I/O floor for opening those files at all.
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
# output: public/images/metadata.json, schema:
#   { "01.jpg": { "camera": "...", ... }, "IMG_1234.heic": { ... } }

set -euo pipefail

MERGE=0
if [ "${1:-}" = "--merge" ]; then
  MERGE=1
  shift
fi

if [ $# -eq 0 ]; then
  echo "usage: $0 [--merge] <source-file-or-dir>..." >&2
  exit 1
fi

SRC_DIR="$*"  # label only; preserve each original argument when reading
for source in "$@"; do
  if [ ! -d "$source" ] && [ ! -f "$source" ]; then
    echo "error: source not found: $source" >&2
    exit 1
  fi
done

if ! command -v exif-sooc >/dev/null 2>&1; then
  echo "error: exif-sooc not found. install with:" >&2
  echo "  cargo install --git https://github.com/oddharsh/exif-sooc exif-sooc" >&2
  exit 1
fi
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
# The served asset tree. NOT "$SCRIPT_DIR/..": that resolved to www/ back when
# this script lived in www/scripts/, and it resolves to tools/ now.
PUBLIC_DIR="$( cd "$SCRIPT_DIR/../.." && pwd )/public"
OUT="$PUBLIC_DIR/images/metadata.json"

# zenc bakes the histogram channels at the end of this script, sharing the JPEG
# decoder the encoder already links. Same auto-build-on-first-run convention as
# the other pipeline scripts, so a fresh checkout needs cargo and nothing else.
ZENC_DIR="$(cd "$SCRIPT_DIR/zenc" && pwd)"
ZENC="$ZENC_DIR/target/release/zenc"
if [ ! -x "$ZENC" ]; then
  echo "building zenc (histogram bake) — first run only…" >&2
  cargo build --release --locked --manifest-path "$ZENC_DIR/Cargo.toml" >&2 || { echo "error: zenc build failed" >&2; exit 1; }
fi

# `--merge-into` states the merge rule instead of relying on an operator. A
# shallow merge would silently drop `recipe` from every re-merged photo, since a
# --merge read carries none, and the failure reads as a tooltip that has
# quietly stopped showing lines. The rule:
#
#   * a stem the read did not see passes through untouched
#   * a stem it did see keeps every key it already had, freshly read fields on top
#
# It prints to stdout and never writes the file it read, so a crash cannot leave
# a truncated metadata.json where a complete one was.
if [ "$MERGE" -eq 1 ]; then
  exif-sooc --keyed --merge-into "$OUT" -q -r "$@" > "$OUT.tmp"
else
  exif-sooc --keyed -q -r "$@" > "$OUT.tmp"
fi
# NOTE: "$OUT" is not replaced yet. The prune below runs on the temp file and
# the single `mv` happens after it, so a refusal there leaves the metadata.json
# on disk exactly as it was.

# ── scope the record to PUBLISHED photos ──────────────────────────────────────
# SRC_DIR is an INPUT SUPERSET, not the archive. The curated source folder holds
# every frame worth keeping; the site holds the ones somebody actually ran
# through add-photos.sh, and the two drift apart the moment a shot is added to
# the folder and not published. Measured 2026-08-24: 165 eligible files in the
# folder against 158 published, so a full regen wrote 165 records and
# check-photo-pipeline.ts failed the run on the bijection it exists to hold.
#
# Left unscoped this is a live defect rather than dead weight, because nothing
# downstream re-joins against the pool. `photoFacets` in src/worker/photos.ts
# folds over EVERY entry here, so /photos would tally cameras, lenses, films and
# years for 7 photos that do not exist on the site, and /images/metadata.json is
# a public URL, so it would publish their EXIF too. hashes.json is the right
# authority: hash-thumbnails.sh writes it from the /i/ tiers that actually
# exist, which is the same set check-photo-pipeline.ts calls published, and
# add-photos.sh phase 4 refreshes it BEFORE calling this script.
#
# The prune runs in both modes. --merge reads SRC_DIR too, so it picks up the
# same unpublished frames; it differs in preserving stems it did not read, and
# those are already published by definition.
HASHES_JSON="$PUBLIC_DIR/images/hashes.json"
# pipeline-json.ts since 2026-09-15, where this was four jaq calls; it names
# the filters it stands in for, and its prune reproduces the committed
# metadata.json byte for byte, which is the bar because that file is jaq's
# pretty-printer output and `mv` below is what commits it.
PJ="$SCRIPT_DIR/pipeline-json.ts"
read_count=$(bun "$PJ" length "$OUT.tmp")
if [ -s "$HASHES_JSON" ] && [ "$(bun "$PJ" length "$HASHES_JSON")" -gt 0 ]; then
  dropped=$(bun "$PJ" prune "$OUT.tmp" --published "$HASHES_JSON" --out "$OUT.pruned")
  kept_count=$(bun "$PJ" length "$OUT.pruned")

  # FLOOR. An empty intersection means SRC_DIR is not the folder this archive was
  # built from, and writing that result would replace every record with nothing.
  # Refuse instead, leaving the file that is on disk untouched.
  if [ "$kept_count" -eq 0 ]; then
    rm -f "$OUT.tmp" "$OUT.pruned"
    echo "error: none of the $read_count photos read from $SRC_DIR are published." >&2
    echo "  metadata.json left untouched. is that the right source folder?" >&2
    exit 1
  fi
  mv "$OUT.pruned" "$OUT.tmp"

  # Say what was dropped. Silence would be the same failure this pipeline keeps
  # shipping: an operator who added a frame to the folder and never published it
  # should read that as a fact about the folder rather than never learn it.
  # STDERR, deliberately. add-photos.sh tails this script's stdout to keep its
  # own output short, so a notice printed on stdout is a notice the one caller
  # that matters never shows. Routine progress stays on stdout; anything the
  # operator has to know goes here.
  if [ -n "$dropped" ]; then
    echo "  $((read_count - kept_count)) photo(s) here are not published; metadata scoped to the $kept_count that are:" >&2
    printf '%s\n' "$dropped" | sed 's/^/    /' >&2
  fi

  # The other direction is DATA LOSS in full mode, so it refuses rather than
  # warns. A full run REPLACES the record, so a published photo whose source file
  # this run could not see does not merely go undescribed: its EXIF is deleted,
  # and the tooltip renders blank lines for a photo that still ships. Pointed at
  # a folder of one, a full regen would cut metadata.json to 1 record and report
  # success.
  #
  # --merge is the mode for a partial source, which is why add-photos.sh and the
  # remote pipeline use it, and merge preserves stems it did not read, so this
  # list is empty there by construction.
  unread=$(bun "$PJ" unread "$HASHES_JSON" --against "$OUT.tmp")
  if [ -n "$unread" ]; then
    unread_count=$(printf '%s\n' "$unread" | wc -l | tr -d ' ')
    {
      echo "error: $unread_count published photo(s) have no source file in $SRC_DIR."
      printf '%s\n' "$unread" | sed -n '1,8s/^/    /p'
      [ "$unread_count" -gt 8 ] && echo "    (+$((unread_count - 8)) more)"
      echo "  a full regen REPLACES metadata.json, so writing this would delete their EXIF."
      echo "  point at the folder holding every published photo, or pass --merge to update just this batch."
    } >&2
    rm -f "$OUT.tmp"
    exit 1
  fi
else
  echo "  no hashes.json yet, so every photo read is kept; the prune needs a published set."
fi
mv "$OUT.tmp" "$OUT"

# One file per photo, images/meta/<stem>.json, in the compact schema: SHORT
# keys, only the fields the tooltip renders, null-valued fields dropped. The
# split calls projectExifRecord (tools/lib/photo-indexes.ts), the same function
# build.ts projects exif.json through, so the key map has one copy.
# metadata.json keeps the full, long-key schema: it is the public /photos index
# (PHOTO_PUBLIC_FIELDS in src/worker/photos.ts reads it) and the archive.
#
# These files are a local pipeline artifact. The histogram bake and the index
# build below read them; build.ts derives the served /images/meta/ files from
# the committed indexes. Bump META_V in tooltip.js when the fields change.
META_DIR="$PUBLIC_DIR/images/meta"
mkdir -p "$META_DIR"
if [ "$MERGE" -eq 0 ]; then
  rm -f "$META_DIR"/*.json   # drop stale per-stem files (e.g. removed photos)
fi
bun "$PJ" meta-split "$OUT" --out-dir "$META_DIR"

# the recipe card is derived during extraction (exif-sooc --keyed), so a --merge
# run refreshes cards for the BATCH only. A full run regenerates all of them,
# which is what to do after an exif-sooc upgrade that changes the card.

# bake the 64-bin histograms back into the meta files (the full run may have
# wiped them; the tooltip reads meta.hi instead of computing client-side).
# THE ONLY BAKE IN THE PIPELINE, and it is pinned here: the index build below
# reads meta/, so a bake anywhere else is one the index cannot see.
#
# NOT piped into `tail -1`, matching the sibling call #566 unpiped. The status
# half of gotcha 40 was never open here, because this script has carried
# `set -euo pipefail` since before that PR and pipefail already hands the
# pipeline zenc's status over tail's. What the pipe cost was narrower and had
# no other cover: the per-stem warnings. Measured 2026-08-29 against a root
# whose hashes.json names a tile that is not on disk, both shapes exit 1 and
# stop the run, and only the unpiped one prints `warn: L1009919_2:
# L1009919_2.6e03d6df.jpg missing, skipped`. Piped, the run died on a summary
# reading "1 skipped" and named no stem.
"$ZENC" histogram --root "$PUBLIC_DIR"

# The packed bars the grid inlines into each tile as data-hist. These read the
# per-photo files, so they still run here.
bun "$SCRIPT_DIR/build-histogram-index.ts"

COUNT=$(bun "$PJ" length "$OUT")
if [ "$MERGE" -eq 1 ]; then
  echo "✓ merged metadata for $COUNT photos → $OUT (+ per-stem files in images/meta/, histograms baked)"
else
  echo "✓ extracted metadata for $COUNT photos → $OUT (+ $COUNT per-stem files in images/meta/, histograms baked)"
fi
echo "  next: bump META_V in tooltip.js if fields changed, commit + deploy."
