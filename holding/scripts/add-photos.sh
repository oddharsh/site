#!/usr/bin/env bash
# add-photos.sh — process one or more SOOC photos into the site.
#
# per source file, this script:
#   1. generates the grid thumbnails at holding/images/<stem>.{jpg,avif} +
#      <stem>-<SQ_SM>.avif — PRE-CROPPED CENTER SQUARES (what the grid shows:
#      aspect-ratio:1 + object-fit:cover), metadata-stripped. mirrors
#      reencode-thumbnails.sh exactly (keep the two encode paths in sync).
#   2. uploads the original to R2 as aadhar-photos/<filename>
#      (preserves SOOC bytes; this is what /images/full/<filename> returns)
#   3. if the original is HEIF (.hif/.heic/.heif), also generates a full-
#      resolution JPG export (q92) and uploads as aadhar-photos/<stem>.jpg
#      — Chrome/Firefox can't natively render HEIF and would trigger a
#      download dialog otherwise. the worker's manifest dedup prefers the
#      .jpg over the .HIF, so click-through opens in the browser.
#
# post-processing:
#   4. regenerates holding/images/metadata.json + per-stem images/meta/<stem>.json
#      (EXIF for the tooltip; histograms are computed client-side, not stored)
#   5. busts the manifest:images KV key so the worker re-derives from R2
#
# safe to re-run. skips thumbnail generation when all three thumb files are
# already newer than the source. always uploads to R2 (wrangler r2 put is
# idempotent). to add only new shots, pass just their paths (not the whole
# folder) so the 100+ existing originals aren't re-uploaded.
#
# NB: this only ADDS at the current SQ/SQ_SM. to change the square size for the
# whole library, that's reencode-thumbnails.sh's job (+ a THUMB_VERSION bump).
#
# usage:
#   ./holding/scripts/add-photos.sh /path/to/photo.HIF
#   ./holding/scripts/add-photos.sh /path/to/folder/
#   ./holding/scripts/add-photos.sh /path/a.jpg /path/b.HIF /path/folder/

set -e

# resolve from anywhere — assumes script lives at holding/scripts/
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
PROJECT_DIR="$( cd "$SCRIPT_DIR/../.." && pwd )"
DEST="$PROJECT_DIR/holding/images"
TMP="/tmp/aadhar-add-photos-$$"
NS="3cb8a107c58e47dc9244e75b33401f36"  # RN_KV namespace

# square thumbnail edges (px). the file IS the displayed pixels (center square),
# so no off-square bytes ship. MUST match reencode-thumbnails.sh + THUMB_SMALL_PX
# in _worker.js (the -<N>.avif suffix). override per run with SQ=/SQ_SM=.
SQ="${SQ:-600}"        # desktop square edge (~197px tile at DPR-3)
SQ_SM="${SQ_SM:-400}"  # mobile square edge (served via <source media> ≤560px)

# preconditions
if [ $# -eq 0 ]; then
  echo "usage: $0 <file-or-dir>..." >&2
  exit 1
fi
# jpegli is the primary JPEG encoder (github.com/google/jpegli → ~/.local/bin/);
# ~25% smaller than mozjpeg at indistinguishable quality. mozjpeg's jpegtran does
# the lossless EXIF-orientation step (structural, not an encode).
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
if command -v avifenc >/dev/null 2>&1; then AVIF_ENCODER="avifenc"; else AVIF_ENCODER="sips"; fi

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

# read EXIF Orientation → the jpegtran flag that brings the pixels upright.
# empty = no rotation. 1=normal, 3=180°, 6=90°CW, 8=270°CW, etc.
exif_to_jpegtran() {
  local o; o=$(exiftool -s -s -s -n -Orientation "$1" 2>/dev/null || echo "")
  case "$o" in
    ""|"1") echo "" ;;  "2") echo "-flip horizontal" ;;  "3") echo "-rotate 180" ;;
    "4") echo "-flip vertical" ;;  "5") echo "-transpose" ;;  "6") echo "-rotate 90" ;;
    "7") echo "-transverse" ;;  "8") echo "-rotate 270" ;;  *) echo "" ;;
  esac
}

avif_encode() {  # avif_encode <src.jpg> <out.avif>
  if [ "$AVIF_ENCODER" = "avifenc" ]; then
    # 4:0:0 for grayscale (Leica Monochrom — no chroma planes), else 4:2:0.
    # strip ICC/EXIF/XMP: the grid reads EXIF from metadata.json, so embedded
    # metadata is dead weight (and avifenc copies source EXIF by default).
    local space; space=$(sips -g space "$1" 2>/dev/null | awk '/space:/{print $2}')
    local yuv; [ "$space" = "Gray" ] && yuv=400 || yuv=420
    avifenc -q 63 --ignore-icc --ignore-exif --ignore-xmp --speed 4 --jobs 4 --yuv "$yuv" "$1" "$2" >/dev/null 2>&1
  else
    sips -s format avif --setProperty formatOptions 60 "$1" --out "$2" >/dev/null 2>&1
  fi
}

# ── phase 1: square thumbnails (jpegli q82 JPG + AVIF, + mobile AVIF) ──
echo "phase 1 — square thumbnails (${SQ}×${SQ} / ${SQ_SM}×${SQ_SM}, jpegli q82 + AVIF via $AVIF_ENCODER, metadata-stripped)"
T_OK=0; T_SKIP=0; T_FAIL=0
INTER="$TMP/inter"; mkdir -p "$INTER"
while IFS= read -r f; do
  base=$(basename "$f"); stem="${base%.*}"
  jpg="$DEST/${stem}.jpg"; avif="$DEST/${stem}.avif"; smavif="$DEST/${stem}-${SQ_SM}.avif"
  if [ -f "$jpg" ] && [ -f "$avif" ] && [ -f "$smavif" ] && [ "$jpg" -nt "$f" ]; then
    T_SKIP=$((T_SKIP+1)); printf "·"; continue
  fi
  work="$INTER/${stem}.jpg"; rot="$INTER/${stem}.rot.jpg"
  sq="$INTER/${stem}.sq.jpg"; sm="$INTER/${stem}.sm.jpg"

  # 1. decode source → working JPG (long edge 2000; ample to crop a sharp square).
  #    sips handles HEIF/HIF/HEIC decode natively.
  if ! sips -Z 2000 -s format jpeg --setProperty formatOptions 100 "$f" --out "$work" >/dev/null 2>&1; then
    T_FAIL=$((T_FAIL+1)); printf "✗"; continue
  fi
  # 2. lossless EXIF-orientation rotation (cjpegli/avifenc strip EXIF, bake it in)
  rot_flag=$(exif_to_jpegtran "$f")
  if [ -n "$rot_flag" ]; then
    if "$MOZ_JTRAN" -copy none $rot_flag "$work" > "$rot" 2>/dev/null; then work="$rot"; fi
  fi
  # 3. center-crop to a square: resize the SHORT edge to SQ, then crop SQ×SQ
  #    centered (sips object-position is center, matching object-fit:cover).
  W=$(sips -g pixelWidth "$work" 2>/dev/null | awk '/pixelWidth/{print $2}')
  H=$(sips -g pixelHeight "$work" 2>/dev/null | awk '/pixelHeight/{print $2}')
  if [ -z "$W" ] || [ -z "$H" ] || [ "$W" -lt 1 ] || [ "$H" -lt 1 ]; then T_FAIL=$((T_FAIL+1)); printf "✗"; continue; fi
  if [ "$W" -le "$H" ]; then tl=$(( (SQ*H + W-1)/W )); else tl=$(( (SQ*W + H-1)/H )); fi
  sips -Z "$tl" "$work" >/dev/null 2>&1
  if ! sips -c "$SQ" "$SQ" "$work" --out "$sq" >/dev/null 2>&1; then T_FAIL=$((T_FAIL+1)); printf "✗"; continue; fi
  # 4. desktop square JPG (jpegli q82) + strip any residual metadata (sips can
  #    leave a grayscale ICC on B&W frames; keep formats consistent / sRGB).
  if ! "$CJPEGLI" "$sq" "$jpg" -q 82 -p 2 >/dev/null 2>&1; then T_FAIL=$((T_FAIL+1)); printf "✗"; continue; fi
  exiftool -all= -overwrite_original "$jpg" >/dev/null 2>&1 || true
  # 5. desktop square AVIF
  if ! avif_encode "$sq" "$avif"; then T_FAIL=$((T_FAIL+1)); printf "✗"; continue; fi
  # 6. mobile square AVIF (downscale the SQ square → SQ_SM, square→square)
  if sips -Z "$SQ_SM" "$sq" --out "$sm" >/dev/null 2>&1; then
    avif_encode "$sm" "$smavif" || printf "~"
  fi
  T_OK=$((T_OK+1)); printf "."
done < "$SOURCES"
echo ""
echo "  generated: $T_OK  skipped (current): $T_SKIP  failed: $T_FAIL"
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

# originals — normalize extension to lowercase so R2 keys are stable. stem
# case is preserved.
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

# ── phase 4: metadata.json + per-stem files + cache bust ─────────────
echo "phase 4 — metadata regen + cache bust"
# regenerate from the FIRST input dir if it was a directory; else from the
# parent dir of the first file (metadata script walks one canonical dir).
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
  echo "  exiftool or jq missing — skipping metadata regen"
fi

wrangler kv key delete --namespace-id="$NS" "manifest:images"  --remote >/dev/null 2>&1 || true
wrangler kv key delete --namespace-id="$NS" "idx:images"       --remote >/dev/null 2>&1 || true
wrangler kv key delete --namespace-id="$NS" "idx:imagesfull"   --remote >/dev/null 2>&1 || true
echo "  manifest + index caches busted"
echo ""

echo "✓ done. deploy with:"
echo "    wrangler pages deploy holding --project-name aadhar-sh --branch holding --commit-dirty=true"
