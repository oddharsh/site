#!/usr/bin/env bash
#
# reencode-thumbnails.sh — re-encode ALL published grid thumbnails from the
# canonical source folder at a new resolution, in place.
#
# Use this after changing the thumbnail long-edge (THUMB_PX). It runs ONLY the
# two thumbnail encode passes from add-photos.sh (jpegli JPG + AVIF), reusing
# the identical commands so output matches the canonical pipeline exactly.
#
# Deliberately does NOT touch:
#   - R2 originals (thumbnail size is independent of the stored original)
#   - metadata.json (its width/height are the ORIGINAL orientation-corrected
#     dims, not the thumbnail's, so they don't change)
#   - the HIF → full-res click export (unchanged)
#
# After running, bump THUMB_VERSION in _worker.js so the new pixels bust the
# edge + browser + service-worker caches (the ?v=N on every thumbnail URL).
#
#   THUMB_PX=800 ./holding/scripts/reencode-thumbnails.sh
#   THUMB_PX=800 ./holding/scripts/reencode-thumbnails.sh "/path/to/source/folder"
#
set -euo pipefail

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
PROJECT_DIR="$( cd "$SCRIPT_DIR/../.." && pwd )"
DEST="$PROJECT_DIR/holding/images"
SRC="${1:-/Users/aadharsh/Downloads/to post (from ssd)}"
THUMB_PX="${THUMB_PX:-800}"
TMP="/tmp/aadhar-reencode-$$"
mkdir -p "$TMP"
trap 'rm -rf "$TMP"' EXIT

CJPEGLI="$HOME/.local/bin/cjpegli"
MOZ_JTRAN="/opt/homebrew/opt/mozjpeg/bin/jpegtran"

for cmd in sips exiftool; do
  command -v "$cmd" >/dev/null 2>&1 || { echo "error: $cmd not in PATH" >&2; exit 1; }
done
[ -x "$CJPEGLI" ]  || { echo "error: cjpegli not at $CJPEGLI (build-jpegli.sh)" >&2; exit 1; }
[ -x "$MOZ_JTRAN" ] || { echo "error: jpegtran not installed (brew install mozjpeg)" >&2; exit 1; }
[ -d "$SRC" ]      || { echo "error: source folder not found: $SRC" >&2; exit 1; }
if command -v avifenc >/dev/null 2>&1; then AVIF_ENCODER="avifenc"; else AVIF_ENCODER="sips"; fi

# EXIF Orientation → jpegtran transform flag (identical to add-photos.sh).
exif_to_jpegtran() {
  local o; o=$(exiftool -s -s -s -n -Orientation "$1" 2>/dev/null || echo "")
  case "$o" in
    ""|"1") echo "" ;;  "2") echo "-flip horizontal" ;;  "3") echo "-rotate 180" ;;
    "4") echo "-flip vertical" ;;  "5") echo "-transpose" ;;  "6") echo "-rotate 90" ;;
    "7") echo "-transverse" ;;  "8") echo "-rotate 270" ;;  *) echo "" ;;
  esac
}

# find the source file for a thumbnail stem (any extension/case)
find_source() {
  local stem="$1" hit
  for hit in "$SRC/$stem".*; do
    case "${hit##*.}" in
      [Jj][Pp][Gg]|[Jj][Pp][Ee][Gg]|[Pp][Nn][Gg]|[Hh][Ii][Ff]|[Hh][Ee][Ii][Cc]|[Hh][Ee][Ii][Ff]) echo "$hit"; return 0 ;;
    esac
  done
  return 1
}

STEMS=$(for j in "$DEST"/*.jpg; do basename "$j" .jpg; done)
TOTAL=$(echo "$STEMS" | grep -c . || true)
echo "re-encoding $TOTAL thumbnails at ${THUMB_PX}px  (jpegli q82 + AVIF via $AVIF_ENCODER)"
echo "  source: $SRC"
echo ""

OK=0; MISS=0; FAIL=0
INTER="$TMP/inter"; mkdir -p "$INTER"
while IFS= read -r stem; do
  [ -n "$stem" ] || continue
  if ! src=$(find_source "$stem"); then MISS=$((MISS+1)); printf "?"; continue; fi

  mid="$INTER/${stem}.jpg"; rot="$INTER/${stem}.rot.jpg"
  jpg="$DEST/${stem}.jpg"; avif="$DEST/${stem}.avif"

  # 1. sips resize/decode → near-lossless JPG intermediate
  if ! sips -Z "$THUMB_PX" -s format jpeg --setProperty formatOptions 100 "$src" --out "$mid" >/dev/null 2>&1; then
    FAIL=$((FAIL+1)); printf "✗"; continue
  fi
  # 2. lossless EXIF-orientation rotation (cjpegli strips EXIF, so bake it in)
  rot_flag=$(exif_to_jpegtran "$src")
  if [ -n "$rot_flag" ]; then
    if "$MOZ_JTRAN" -copy none $rot_flag "$mid" > "$rot" 2>/dev/null; then mid="$rot"; fi
  fi
  # 3. jpegli q82, max-progressive
  if ! "$CJPEGLI" "$mid" "$jpg" -q 82 -p 2 >/dev/null 2>&1; then
    FAIL=$((FAIL+1)); printf "✗"; continue
  fi
  # 4. AVIF primary (yuv400 for grayscale sources, else yuv420) — from the JPG
  #    so crop/dims match exactly.
  if [ "$AVIF_ENCODER" = "avifenc" ]; then
    space=$(sips -g space "$jpg" 2>/dev/null | awk '/space:/{print $2}')
    [ "$space" = "Gray" ] && yuv=400 || yuv=420
    avifenc -q 63 --ignore-icc --speed 4 --jobs 4 --yuv "$yuv" "$jpg" "$avif" >/dev/null 2>&1 || { FAIL=$((FAIL+1)); printf "✗"; continue; }
  else
    sips -s format avif --setProperty formatOptions 60 "$jpg" --out "$avif" >/dev/null 2>&1 || { FAIL=$((FAIL+1)); printf "✗"; continue; }
  fi
  OK=$((OK+1)); printf "."
done <<< "$STEMS"
echo ""
echo ""
echo "  re-encoded: $OK   source-missing: $MISS   failed: $FAIL"
echo "  next: bump THUMB_VERSION in holding/_worker.js, then deploy."
