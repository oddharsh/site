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
# requires: exiftool (brew install exiftool), jq (brew install jq)
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
#   camera          - "<Make> <Model>"  e.g. "FUJIFILM X-T5"
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
# output: holding/images/metadata.json, schema:
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

if ! command -v exiftool >/dev/null 2>&1; then
  echo "error: exiftool not found. install with: brew install exiftool" >&2
  exit 1
fi
if ! command -v jq >/dev/null 2>&1; then
  echo "error: jq not found. install with: brew install jq" >&2
  exit 1
fi

# resolve the output path relative to this script
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
OUT="$SCRIPT_DIR/../images/metadata.json"

# exiftool can output JSON natively, but we want a custom shape keyed by
# filename. dump per-file JSON and reduce with jq.
TMP=$(mktemp)
EXTRACTED=$(mktemp)
# `-Orientation#` forces numeric output (1..8) for the rotation tag so
# the jq below can compare integers. without the trailing #, exiftool
# prints "Rotate 270 CW" which is human-readable but awkward to parse.
# the other tags stay in their friendly form: "1/250" for shutter,
# "f/2.8" for aperture, "ISO 100" etc. — that's what the tooltip wants.
#
# the second block pulls Fuji X-series MakerNotes (Film Mode / Color
# Chrome / Grain Effect / tone curves / saturation / WB fine-tune) so
# the tooltip can show what "recipe" was set in-camera. these tags are
# silently empty on non-Fuji bodies (Leica, iPhone), so they cost
# nothing to extract universally.
exiftool -json -q \
  -FileName \
  -Make -Model -LensModel \
  -FNumber -ExposureTime -ISO \
  -FocalLengthIn35mmFormat \
  -ExposureCompensation \
  -ExposureMode -ExposureProgram -MeteringMode \
  -DateTimeOriginal \
  -ImageWidth -ImageHeight \
  -ColorSpace \
  -WhiteBalance -ColorTemperature -WhiteBalanceFineTune \
  -FlashMode -Flash \
  -FilmMode \
  -DynamicRange \
  -FocusMode -DriveMode \
  -FujiFilm:Sharpness -NoiseReduction -Clarity \
  -DevelopmentDynamicRange \
  -ColorChromeEffect -ColorChromeFXBlue \
  -GrainEffectRoughness -GrainEffectSize \
  -HighlightTone -ShadowTone -Saturation \
  '-Orientation#' \
  "$SRC_DIR" > "$TMP"

# NB: metadata extraction intentionally emits only EXIF/Fuji fields. The
# follow-up bake below adds the {l,r,g,b} histogram channels to each per-photo
# meta file from the shipped hashed JPG tier. Keeping that as a separate step
# makes incremental adds safe: extraction can rebuild metadata without
# silently dropping histogram data.

# transform into {stem: {camera, lens, aperture, shutter, iso, focal, date,
# width, height}} keyed by stem (filename without extension). orientation-
# aware width/height: for portrait shots, the camera writes landscape-
# physical sensor dims (e.g. 7728×5152) + an EXIF Orientation tag (6 or 8)
# telling viewers to rotate. our tooltip displays the orientation-corrected
# dims (5152×7728 here) so they match what the user actually sees.
#   Orientation 5/6/7/8 → 90° transforms → swap w/h
#   Orientation 1/2/3/4 → identity/180/flip → keep w/h as-is
jq '
  reduce .[] as $e ({}; . + {
  ($e.FileName | tostring | sub("\\.[^.]+$"; "")):
    (($e.Orientation // 1) as $o |
     (if ($o == 5 or $o == 6 or $o == 7 or $o == 8)
       then { w: ($e.ImageHeight // null), h: ($e.ImageWidth // null) }
       else { w: ($e.ImageWidth // null),  h: ($e.ImageHeight // null) }
      end) as $dim |
    {
      camera:   (if $e.Make and $e.Model then ($e.Make + " " + $e.Model) else ($e.Make // $e.Model // null) end),
      lens:     ($e.LensModel // null),
      aperture: (if $e.FNumber then ("f/" + ($e.FNumber | tostring)) else null end),
      shutter:  ($e.ExposureTime // null),
      iso:      ($e.ISO // null),
      focal:    (if $e.FocalLengthIn35mmFormat then ($e.FocalLengthIn35mmFormat | tostring) else null end),
      ev:       ($e.ExposureCompensation // null),
      date:     ($e.DateTimeOriginal // null),
      width:    $dim.w,
      height:   $dim.h,
      color_space:    ($e.ColorSpace // null),
      white_balance:  ($e.WhiteBalance // null),
      color_temp:     ($e.ColorTemperature // null),
      wb_shift:       ($e.WhiteBalanceFineTune // null),
      flash:          ($e.Flash // null),
      # standard exposure / focus / metering fields. populated on most bodies.
      exposure_mode:  ($e.ExposureMode // $e.ExposureProgram // null),
      meter:          ($e.MeteringMode // null),
      focus_mode:     ($e.FocusMode // null),
      drive:          ($e.DriveMode // null),
      # Fuji writes TWO Sharpness tags: the standard ExifIFD one is a coarse
      # Soft/Normal/Hard, while FujiFilm:Sharpness carries the real -4..+4 the
      # recipe card needs. we ask for the FujiFilm one explicitly above.
      sharpness:      ($e.Sharpness // null),
      noise_reduction:($e.NoiseReduction // null),
      clarity:        ($e.Clarity // null),
      # DynamicRange reads "Standard"; DevelopmentDynamicRange is the real
      # 100/200/400 that prints as DR100/DR200/DR400.
      dr_value:       ($e.DevelopmentDynamicRange // null),
      # Fuji-only film-recipe fields. silently null on Leica/iPhone shots.
      film:           ($e.FilmMode // null),
      dr:             ($e.DynamicRange // null),
      chrome:         ($e.ColorChromeEffect // null),
      chrome_blue:    ($e.ColorChromeFXBlue // null),
      grain:          ($e.GrainEffectRoughness // null),
      grain_size:     ($e.GrainEffectSize // null),
      highlight_tone: ($e.HighlightTone // null),
      shadow_tone:    ($e.ShadowTone // null),
      saturation:     ($e.Saturation // null),
    })
})' "$TMP" > "$EXTRACTED"

if [ "$MERGE" -eq 1 ] && [ -s "$OUT" ]; then
  MERGED=$(mktemp)
  jq -s '.[0] * .[1]' "$OUT" "$EXTRACTED" > "$MERGED"
  mv "$MERGED" "$OUT"
else
  mv "$EXTRACTED" "$OUT"
fi

rm -f "$TMP" "$EXTRACTED"

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
# archive. KEEP THIS MAP IN SYNC with tooltip.js (reader) and photo-histograms.py
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

# derive the self-documenting Fuji recipe card for each photo (fujixweekly
# idiom) into metadata.json. runs on the full index, so it also refreshes
# photos outside a --merge batch whose recipe format may have changed.
"$SCRIPT_DIR/build-recipes.py" 2>&1 | tail -1

# bake the 64-bin histograms back into the meta files (the full run may have
# wiped them; the tooltip reads meta.hi instead of computing client-side)
"$SCRIPT_DIR/photo-histograms.py" 2>&1 | tail -1

COUNT=$(jq 'keys | length' "$OUT")
if [ "$MERGE" -eq 1 ]; then
  echo "✓ merged metadata for $COUNT photos → $OUT (+ per-stem files in images/meta/, histograms baked)"
else
  echo "✓ extracted metadata for $COUNT photos → $OUT (+ $COUNT per-stem files in images/meta/, histograms baked)"
fi
echo "  next: bump META_V in tooltip.js if fields changed, commit + deploy."
