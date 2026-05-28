#!/usr/bin/env bash
# add-photos.sh — process one or more SOOC photos into the site.
#
# per source file, this script:
#   1. generates a 500px JPG thumbnail at holding/images/<stem>.jpg
#      (this is what the photo grid displays)
#   2. uploads the original to R2 as aadhar-photos/<filename>
#      (preserves SOOC bytes; this is what /images/full/<filename> returns)
#   3. if the original is HEIF (.hif/.heic/.heif), also generates a full-
#      resolution JPG export (q92) and uploads as aadhar-photos/<stem>.jpg
#      — Chrome/Firefox can't natively render HEIF and would trigger a
#      download dialog otherwise. the worker's manifest dedup prefers the
#      .jpg over the .HIF, so click-through opens in the browser.
#
# post-processing:
#   4. regenerates holding/images/metadata.json (EXIF for the tooltip)
#   5. busts the manifest:images KV key so the worker re-derives from R2
#
# safe to re-run. skips local thumbnail generation if the thumbnail is
# already newer than the source. always uploads to R2 (wrangler r2 put
# is idempotent — overwrites with same content).
#
# usage:
#   ./holding/scripts/add-photos.sh /path/to/photo.JPG
#   ./holding/scripts/add-photos.sh /path/to/folder/
#   ./holding/scripts/add-photos.sh /path/a.jpg /path/b.HIF /path/folder/

set -e

# resolve from anywhere — assumes script lives at holding/scripts/
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
PROJECT_DIR="$( cd "$SCRIPT_DIR/../.." && pwd )"
DEST="$PROJECT_DIR/holding/images"
TMP="/tmp/aadhar-add-photos-$$"
NS="3cb8a107c58e47dc9244e75b33401f36"  # RN_KV namespace

# grid thumbnail long-edge in px. the homepage renders each tile at
# ~204 CSS px (660px window / 3 cols), so 500px covers 2x retina with
# headroom. was 1200 historically, which oversampled ~9x by area and
# bloated cold-load bandwidth (the full-res original is what /images/full
# serves on click, so the thumbnail is never shown larger than the grid).
# override with THUMB_PX=N if a future layout needs bigger tiles.
THUMB_PX="${THUMB_PX:-500}"

# preconditions
if [ $# -eq 0 ]; then
  echo "usage: $0 <file-or-dir>..." >&2
  exit 1
fi
# jpegli is the primary JPEG encoder — built locally from
# github.com/google/jpegli and copied to ~/.local/bin/. it produces ~25%
# smaller JPEGs than mozjpeg at indistinguishable visual quality and is
# Google's active heir to mozjpeg. install steps in
# holding/scripts/build-jpegli.sh.
#
# mozjpeg's jpegtran is still used for the EXIF-orientation step (lossless
# rotation of the intermediate). that's structural, not an encode, so the
# jpegli/mozjpeg choice doesn't affect output quality here.
CJPEGLI="$HOME/.local/bin/cjpegli"
MOZJPEG_DIR="/opt/homebrew/opt/mozjpeg/bin"
MOZ_JTRAN="$MOZJPEG_DIR/jpegtran"

for cmd in sips wrangler exiftool; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "error: $cmd not found in PATH" >&2
    case "$cmd" in
      exiftool) echo "  install with: brew install exiftool" >&2 ;;
    esac
    exit 1
  fi
done
if [ ! -x "$CJPEGLI" ]; then
  echo "error: cjpegli not found at $CJPEGLI" >&2
  echo "  build with: $(dirname "$0")/build-jpegli.sh" >&2
  exit 1
fi
if [ ! -x "$MOZ_JTRAN" ]; then
  echo "error: jpegtran not installed at $MOZJPEG_DIR" >&2
  echo "  install with: brew install mozjpeg" >&2
  exit 1
fi

mkdir -p "$DEST" "$TMP"
trap 'rm -rf "$TMP"' EXIT

# ── enumerate inputs ──────────────────────────────────────────────────
SOURCES="$TMP/sources.txt"
> "$SOURCES"
for arg in "$@"; do
  if [ -d "$arg" ]; then
    find "$arg" -maxdepth 1 -type f \( \
      -iname "*.jpg" -o -iname "*.jpeg" \
      -o -iname "*.heic" -o -iname "*.heif" -o -iname "*.hif" \
      \) >> "$SOURCES"
  elif [ -f "$arg" ]; then
    echo "$arg" >> "$SOURCES"
  else
    echo "warning: skipping $arg (not a file or directory)" >&2
  fi
done

sort -u "$SOURCES" -o "$SOURCES"
TOTAL=$(wc -l < "$SOURCES" | tr -d ' ')
if [ "$TOTAL" -eq 0 ]; then
  echo "no eligible photos found in input(s)" >&2
  exit 1
fi
echo "found $TOTAL source file(s) to process"
echo ""

# ── phase 1a: 1200px progressive JPG thumbnails (fallback) ───────────
# two-stage encode:
#   1. sips resizes the source down to THUMB_PX (500px default) on the long edge and writes
#      a near-lossless intermediate JPEG (formatOptions 100). this is
#      where HEIF/HIF/HEIC decoding happens — sips handles the formats
#      Apple makes the camera shoot in.
#   2. mozjpeg's djpeg → cjpeg recompresses with progressive scanning,
#      trellis optimization, and tuned Q tables. ≈18–22% smaller than
#      the sips default JPEG output at indistinguishable visual quality,
#      AND progressive means slow networks paint a low-res pass first
#      instead of revealing top-down.
# tuning notes:
#   -quality 82           sweet spot for photo content with mozjpeg
#   -progressive          (default in mozjpeg) multi-pass decode
#   -optimize             (default) custom Huffman tables
#   -tune-ssim            optimize trellis search for structural similarity
# helper: read EXIF Orientation off a file and return the jpegtran flag
# that brings the pixels upright. empty string means no rotation needed.
# common camera values: 1=normal, 3=180°, 6=90° CW, 8=270° CW (= 90° CCW).
exif_to_jpegtran() {
  local f="$1"
  local o
  o=$(exiftool -s -s -s -n -Orientation "$f" 2>/dev/null || echo "")
  case "$o" in
    "" | "1") echo "" ;;
    "2")      echo "-flip horizontal" ;;
    "3")      echo "-rotate 180" ;;
    "4")      echo "-flip vertical" ;;
    "5")      echo "-transpose" ;;
    "6")      echo "-rotate 90" ;;
    "7")      echo "-transverse" ;;
    "8")      echo "-rotate 270" ;;
    *)        echo "" ;;
  esac
}

echo "phase 1a — progressive JPG thumbnails (${THUMB_PX}px, jpegli q82, EXIF-rotated)"
T_OK=0; T_SKIP=0; T_FAIL=0
INTER="$TMP/jpg_intermediate"
mkdir -p "$INTER"
while IFS= read -r f; do
  base=$(basename "$f")
  stem="${base%.*}"
  thumb="$DEST/${stem}.jpg"
  if [ -f "$thumb" ] && [ "$thumb" -nt "$f" ]; then
    T_SKIP=$((T_SKIP+1)); printf "·"
    continue
  fi
  mid="$INTER/${stem}.jpg"
  rot_mid="$INTER/${stem}.rot.jpg"

  # 1. resize + decode with sips (handles HEIF/HIF natively). near-lossless
  #    JPEG intermediate keeps the bridge between formats clean.
  if ! sips -Z "$THUMB_PX" -s format jpeg --setProperty formatOptions 100 "$f" --out "$mid" >/dev/null 2>&1; then
    T_FAIL=$((T_FAIL+1)); printf "✗"; continue
  fi

  # 2. apply EXIF orientation losslessly with jpegtran. portrait shots
  #    from the camera have landscape pixels + an "Orientation: Rotate
  #    90 CW" tag — viewers that read EXIF render them right. but our
  #    next stage (cjpegli) strips EXIF, so we must physically rotate
  #    the pixels here. jpegtran's transform is lossless when dims are
  #    MCU-aligned (always true for our 1200px-long-edge thumbs).
  rot_flag=$(exif_to_jpegtran "$f")
  if [ -n "$rot_flag" ]; then
    if "$MOZ_JTRAN" -copy none $rot_flag "$mid" > "$rot_mid" 2>/dev/null; then
      mid="$rot_mid"
    fi
  fi

  # 3. jpegli recompression: psychovisually-tuned Q tables, adaptive per-
  #    block quantization, max-progressive scan (-p 2). ~25% smaller than
  #    mozjpeg at the same nominal quality, indistinguishable visually.
  if "$CJPEGLI" "$mid" "$thumb" -q 82 -p 2 >/dev/null 2>&1; then
    T_OK=$((T_OK+1)); printf "."
  else
    T_FAIL=$((T_FAIL+1)); printf "✗"
  fi
done < "$SOURCES"
echo ""
echo "  generated: $T_OK  skipped (current): $T_SKIP  failed: $T_FAIL"
echo ""

# (WebP middle tier was removed in 2026-05 — every modern browser
# advertises image/avif natively, so the WebP middle never served
# anyone. revert this commit to bring it back if needed.)

# ── phase 1b: 1200px AVIF thumbnails (<picture> primary) ─────────────
# AVIF is the primary source — typically 20–40% smaller than WebP at
# equivalent visual quality. encoded from the JPG thumb so dims + crop
# match the other tiers exactly. encoder preference:
#   1. avifenc (libavif, `brew install libavif`) — best quality/size,
#      tuned via CQ 30 (≈ JPEG q82 quality, far smaller). preferred.
#   2. sips    — macOS-native AVIF encoder, no extra dep. formatOptions
#      60 ≈ visually-lossless for photo content. fallback.
# NB: <picture>'s type-fallback only catches "format not supported";
# decode failures will NOT cascade to phase 1a. if browsers start
# reporting broken images, demote AVIF rather than layering on fallbacks.
echo "phase 1b — AVIF thumbnails (${THUMB_PX}px, picture primary)"
A_OK=0; A_SKIP=0; A_FAIL=0
if command -v avifenc >/dev/null 2>&1; then
  AVIF_ENCODER="avifenc"
else
  AVIF_ENCODER="sips"
fi
while IFS= read -r f; do
  base=$(basename "$f")
  stem="${base%.*}"
  jpg="$DEST/${stem}.jpg"
  avif="$DEST/${stem}.avif"
  if [ ! -f "$jpg" ]; then
    A_FAIL=$((A_FAIL+1)); printf "✗"
    continue
  fi
  if [ -f "$avif" ] && [ "$avif" -nt "$jpg" ]; then
    A_SKIP=$((A_SKIP+1)); printf "·"
    continue
  fi
  if [ "$AVIF_ENCODER" = "avifenc" ]; then
    # subsampling by source color space: grayscale sources (e.g. Leica
    # Monochrom) → 4:0:0 (yuv400, no chroma planes — correct, smaller, and
    # no risk of a faint chroma cast); color sources → 4:2:0 (yuv420,
    # standard for photographic thumbnails, visually identical to 4:4:4 at
    # this size). detected via `sips -g space` (Gray vs RGB).
    space=$(sips -g space "$jpg" 2>/dev/null | awk '/space:/{print $2}')
    if [ "$space" = "Gray" ]; then yuv=400; else yuv=420; fi
    if avifenc -q 63 --ignore-icc --speed 4 --jobs 4 --yuv "$yuv" "$jpg" "$avif" >/dev/null 2>&1; then
      A_OK=$((A_OK+1)); printf "."
    else
      A_FAIL=$((A_FAIL+1)); printf "✗"
    fi
  else
    # sips writes via the Apple AVIF encoder (macOS 13+). slower + slightly
    # larger output than avifenc but no extra brew install.
    if sips -s format avif --setProperty formatOptions 60 "$jpg" --out "$avif" >/dev/null 2>&1; then
      A_OK=$((A_OK+1)); printf "."
    else
      A_FAIL=$((A_FAIL+1)); printf "✗"
    fi
  fi
done < "$SOURCES"
echo ""
echo "  generated: $A_OK  skipped (current): $A_SKIP  failed: $A_FAIL  (encoder: $AVIF_ENCODER)"
echo ""

# ── phase 2: HIF → full-res JPG export (for click-through) ────────────
echo "phase 2 — HIF → full-res JPG exports"
H_OK=0; H_SKIP=0; H_FAIL=0
EXPORTS="$TMP/jpgexports"
mkdir -p "$EXPORTS"
while IFS= read -r f; do
  base=$(basename "$f")
  ext_lc=$(echo "${base##*.}" | tr '[:upper:]' '[:lower:]')
  case "$ext_lc" in
    hif|heic|heif) ;;
    *) continue ;;
  esac
  stem="${base%.*}"
  src_dir=$(dirname "$f")
  # skip if the same folder already has a JPG/JPEG sibling — that's the
  # authoritative click target; no need to make a derived export.
  if ls "$src_dir"/"$stem".[Jj][Pp][Gg] 2>/dev/null  | grep -q . || \
     ls "$src_dir"/"$stem".[Jj][Pp][Ee][Gg] 2>/dev/null | grep -q .; then
    H_SKIP=$((H_SKIP+1)); printf "→"
    continue
  fi
  out="$EXPORTS/${stem}.jpg"
  if sips -s format jpeg --setProperty formatOptions 92 "$f" --out "$out" >/dev/null 2>&1; then
    H_OK=$((H_OK+1)); printf "."
  else
    H_FAIL=$((H_FAIL+1)); printf "✗"
  fi
done < "$SOURCES"
echo ""
echo "  exported: $H_OK  skipped (JPG sibling exists): $H_SKIP  failed: $H_FAIL"
echo ""

# ── phase 3: upload originals + HIF JPG exports to R2 ─────────────────
echo "phase 3 — R2 uploads (parallel 4)"
upload() {
  local key="$1" file="$2" ct="$3"
  if wrangler r2 object put "aadhar-photos/$key" --file="$file" --content-type="$ct" --remote >/dev/null 2>&1; then
    printf "."
  else
    printf "✗"
  fi
}

# originals — normalize extension to lowercase so R2 keys are stable
# (camera SOOC files come in as .JPG; we don't want to mix with .jpg
# exports of HIFs and end up with a case-split bucket). stem case is
# preserved.
PENDING=0
while IFS= read -r f; do
  base=$(basename "$f")
  stem="${base%.*}"
  ext_lc=$(echo "${base##*.}" | tr '[:upper:]' '[:lower:]')
  key="${stem}.${ext_lc}"
  ct="image/jpeg"
  case "$ext_lc" in
    heic|heif|hif) ct="image/heic" ;;
  esac
  upload "$key" "$f" "$ct" &
  PENDING=$((PENDING+1))
  if [ $PENDING -ge 4 ]; then wait; PENDING=0; fi
done < "$SOURCES"
wait
echo ""

# HIF JPG exports (the click-through-friendly companion)
if [ "$(ls -A "$EXPORTS" 2>/dev/null)" ]; then
  echo "  HIF JPG exports:"
  PENDING=0
  for jpg in "$EXPORTS"/*.jpg; do
    [ -f "$jpg" ] || continue
    stem=$(basename "$jpg" .jpg)
    upload "${stem}.jpg" "$jpg" "image/jpeg" &
    PENDING=$((PENDING+1))
    if [ $PENDING -ge 4 ]; then wait; PENDING=0; fi
  done
  wait
  echo ""
fi
echo ""

# ── phase 4: metadata.json + cache bust ──────────────────────────────
echo "phase 4 — metadata regen + cache bust"
# regenerate from the FIRST input dir if it was a directory; else from
# the default source folder. (metadata script needs one canonical dir
# to walk; per-file regen would be awkward.)
META_SRC=""
for arg in "$@"; do
  if [ -d "$arg" ]; then META_SRC="$arg"; break; fi
done
if [ -z "$META_SRC" ]; then
  META_SRC="$(dirname "$(head -1 "$SOURCES")")"
fi
if command -v exiftool >/dev/null 2>&1 && command -v jq >/dev/null 2>&1; then
  "$SCRIPT_DIR/extract-photo-metadata.sh" "$META_SRC" 2>&1 | tail -1
else
  echo "  exiftool or jq missing — skipping metadata.json regen"
fi

wrangler kv key delete --namespace-id="$NS" "manifest:images"  --remote >/dev/null 2>&1 || true
wrangler kv key delete --namespace-id="$NS" "idx:images"       --remote >/dev/null 2>&1 || true
wrangler kv key delete --namespace-id="$NS" "idx:imagesfull"   --remote >/dev/null 2>&1 || true
echo "  manifest + index caches busted"
echo ""

echo "✓ done. deploy with:"
echo "    wrangler pages deploy holding --project-name aadhar-sh --branch holding"
