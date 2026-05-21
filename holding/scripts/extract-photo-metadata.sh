#!/usr/bin/env bash
# extract-photo-metadata.sh — read EXIF from a folder of SOOC photos and
# emit /images/metadata.json keyed by R2 filename. the worker doesn't read
# EXIF itself (would require bundling a JS library); this script runs
# locally once per upload batch.
#
# usage:
#   ./extract-photo-metadata.sh /path/to/sooc-originals/
#
# requires: exiftool (brew install exiftool), jq (brew install jq)
#
# what's extracted:
#   camera   - "<Make> <Model>"  e.g. "Apple iPhone 14 Pro" / "FUJIFILM X-T5"
#   lens     - LensModel         e.g. "XF35mmF1.4 R"
#   aperture - FNumber           e.g. "1.8"
#   shutter  - ExposureTime      e.g. "1/120"
#   iso      - ISO               e.g. 100
#   focal    - FocalLengthIn35mmFormat (35mm equivalent)
#   date     - DateTimeOriginal in ISO-8601
#   width    - ImageWidth  (full-res pixel dimensions, not thumbnail)
#   height   - ImageHeight
#
# GPS data is intentionally NOT included (privacy).
#
# output: holding/images/metadata.json, schema:
#   { "01.jpg": { "camera": "...", ... }, "IMG_1234.heic": { ... } }

set -euo pipefail

if [ $# -ne 1 ]; then
  echo "usage: $0 /path/to/sooc-originals/" >&2
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
  -DateTimeOriginal \
  -ImageWidth -ImageHeight \
  -ColorSpace \
  -WhiteBalance \
  -FlashMode -Flash \
  -FilmMode \
  -ColorChromeEffect -ColorChromeFXBlue \
  -GrainEffectRoughness -GrainEffectSize \
  -HighlightTone -ShadowTone -Saturation \
  '-Orientation#' \
  "$SRC_DIR" > "$TMP"

# transform into {stem: {camera, lens, aperture, shutter, iso, focal, date,
# width, height}} keyed by stem (filename without extension). orientation-
# aware width/height: for portrait shots, the camera writes landscape-
# physical sensor dims (e.g. 7728×5152) + an EXIF Orientation tag (6 or 8)
# telling viewers to rotate. our tooltip displays the orientation-corrected
# dims (5152×7728 here) so they match what the user actually sees.
#   Orientation 5/6/7/8 → 90° transforms → swap w/h
#   Orientation 1/2/3/4 → identity/180/flip → keep w/h as-is
jq 'reduce .[] as $e ({}; . + {
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
      flash:          ($e.Flash // null),
      # Fuji-only film-recipe fields. silently null on Leica/iPhone shots.
      film:           ($e.FilmMode // null),
      chrome:         ($e.ColorChromeEffect // null),
      chrome_blue:    ($e.ColorChromeFXBlue // null),
      grain:          ($e.GrainEffectRoughness // null),
      grain_size:     ($e.GrainEffectSize // null),
      highlight_tone: ($e.HighlightTone // null),
      shadow_tone:    ($e.ShadowTone // null),
      saturation:     ($e.Saturation // null),
    })
})' "$TMP" > "$OUT"

rm -f "$TMP"

COUNT=$(jq 'keys | length' "$OUT")
echo "✓ extracted metadata for $COUNT photos → $OUT"
echo "  next: commit + deploy. the hover tooltip on aadhar.sh will pick it up."
