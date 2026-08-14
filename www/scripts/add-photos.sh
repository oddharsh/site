#!/usr/bin/env bash
# add-photos.sh — process one or more SOOC photos into the site.
#
# per source file, this script:
#   1. generates the grid thumbnails at www/images/<stem>.{jpg,avif} +
#      <stem>-<SQ_SM>.avif — PRE-CROPPED CENTER SQUARES (what the grid shows:
#      aspect-ratio:1 + object-fit:cover), metadata-stripped. mirrors
#      reencode-thumbnails.sh exactly (keep the two encode paths in sync).
#   2. uploads a BROWSER-RENDERABLE full-resolution JPG to R2 as
#      aadhar-photos/<stem>.jpg — this is what /images/full/<stem>.jpg returns
#      on click, and the shareable R2 copy. for a JPG-source photo that's the
#      original, rearranged to progressive by jpegtran on the way up (lossless
#      coefficient reorder, not a re-encode; the local source folder is never
#      modified); for a HEIF source it's the maximum-quality q100 export from
#      step 3, which zenc already writes progressive.
#   3. if the original is HEIF (.hif/.heic/.heif), generates a full-res archive
#      JPG (sips decodes to lossless PNG, zenc re-encodes at q100 4:2:2 with the
#      full trellis + scan-search, exiftool re-attaches source EXIF incl
#      Orientation) and uploads THAT. 4:2:2 matches the Fuji HIF's native chroma
#      (the sensor records 10-bit 4:2:2): unlike 4:4:4 it doesn't spend bytes on
#      interpolated horizontal chroma the sensor never sampled, and unlike 4:2:0
#      it keeps the vertical chroma the sensor did record. Still a clear win over
#      the old sips q100. The .HIF
#      original is NOT uploaded — it stays local-only (your drive + SSD are the
#      archive). Chrome/Firefox can't render HEIF anyway, and R2 is for
#      serving/sharing, not cold storage of originals.
#
# post-processing:
#   4. regenerates www/images/metadata.json + per-stem images/meta/<stem>.json
#      (EXIF for the tooltip) and bakes the 64-bin RGB+luma histograms into
#      meta.hist via `zenc histogram` — the tooltip renders the bars from
#      that field, and the metadata regen drops it, so the bake runs right after
#   5. writes the stem's entry into www/_worker.js/photo-index.json — the
#      committed photo index the worker BUNDLES (which photos exist: R2 key,
#      size, upload date). This is what makes a photo appear in the grid, and
#      it ships at deploy like every other committed artifact. (It replaced the
#      manifest:images KV cache over a runtime R2 list(); there is no cache to
#      bust anymore.)
#   6. captions anything still missing alt text (gen-alt-text.py), then validates
#      the whole artifact graph — pixels, EXIF, histograms, captions, the index —
#      via check-photo-pipeline.mjs, which fails the run rather than let an
#      unlabelled image reach a deploy
#
# REMOTE_RENDER_ONLY=1 skips R2 uploads. The GitHub Actions pipeline uses it
# because the source object is already in R2 and every generated artifact —
# tiers, metadata, the index entry — comes back as a normal PR.
#
# safe to re-run. skips thumbnail generation when all three thumb files are
# already newer than the source. always uploads to R2 (wrangler r2 put is
# idempotent). to add only new shots, pass just their paths (not the whole
# folder) so the 100+ existing originals aren't re-uploaded.
#
# NB: this only ADDS at the current SQ/SQ_SM. to change the square size for the
# whole library, that's reencode-thumbnails.sh's job (then hash-thumbnails.sh
# mints the new content-addressed /i/ URLs).
#
# usage:
#   ./www/scripts/add-photos.sh /path/to/photo.HIF
#   ./www/scripts/add-photos.sh /path/to/folder/
#   ./www/scripts/add-photos.sh /path/a.jpg /path/b.HIF /path/folder/

set -e

# resolve from anywhere — assumes script lives at www/scripts/
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
PROJECT_DIR="$( cd "$SCRIPT_DIR/../.." && pwd )"
DEST="$PROJECT_DIR/www/images"
TMP="/tmp/aadhar-add-photos-$$"

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
# zenc (www/scripts/zenc) is the JPEG encoder: a zenjpeg wrapper running
# hybrid trellis + progressive scan search, ~4% smaller than the retired cjpegli
# at equal quality (see /garage/encoding). It builds from source with cargo, so
# any machine with rust runs this pipeline; dependabot tracks the zenjpeg pin.
# q84 is calibrated to match the old cjpegli q82 quality at fewer bytes. mozjpeg's
# jpegtran still does the lossless EXIF-orientation step (structural, not an encode).
ZENC_DIR="$(cd "$(dirname "$0")/zenc" && pwd)"
ZENC="$ZENC_DIR/target/release/zenc"
ZENC_Q=84
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
if [ ! -x "$ZENC" ]; then
  command -v cargo >/dev/null 2>&1 || { echo "error: cargo (rust) not found; install from https://rustup.rs" >&2; exit 1; }
  echo "building zenc (zenjpeg encoder) — first run only…" >&2
  cargo build --release --manifest-path "$ZENC_DIR/Cargo.toml" >&2 || { echo "error: zenc build failed" >&2; exit 1; }
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
    avifenc -q 63 -d 10 --ignore-icc --ignore-exif --ignore-xmp --speed 4 --jobs 4 --yuv "$yuv" "$1" "$2" >/dev/null 2>&1
  else
    sips -s format avif --setProperty formatOptions 60 "$1" --out "$2" >/dev/null 2>&1
  fi
}

# ── phase 1: square thumbnails (zenc q84 JPG + 10-bit AVIF, + mobile AVIF) ──
echo "phase 1 — square thumbnails (${SQ}×${SQ} / ${SQ_SM}×${SQ_SM}, zenc q84 + AVIF via $AVIF_ENCODER, metadata-stripped)"
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
  # 4. desktop square JPG (zenc: zenjpeg hybrid+scan, q84 ≈ old jpegli q82) + strip
  #    any residual metadata (sips can leave a grayscale ICC on B&W frames; keep
  #    formats consistent / sRGB).
  if ! "$ZENC" "$sq" "$jpg" -q "$ZENC_Q" >/dev/null 2>&1; then T_FAIL=$((T_FAIL+1)); printf "✗"; continue; fi
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
  # This export IS the R2 share/click copy; the .HIF original stays local-only.
  # sips decodes the 10-bit HIF to a lossless PNG (sensor-native pixels, no
  # orientation applied), zenc re-encodes it at q100 4:2:2 (the HIF's native
  # chroma; hybrid trellis + scan search + sharp_yuv), and exiftool copies the
  # source EXIF back, including Orientation, so browsers rotate it exactly as the
  # old sips export did. Net: better than sips q100 and source-faithful on chroma
  # (4:4:4 fabricates horizontal chroma the sensor never sampled; 4:2:0 drops the
  # vertical chroma it did record). By Butteraugli 4:2:2 ties/beats both; by
  # SSIMULACRA2 it gives up ~0.1-0.5 pt vs 4:4:4 for ~14% fewer bytes. /garage/encoding.
  tmppng="$EXPORTS/${stem}.decode.png"
  if sips -s format png "$f" --out "$tmppng" >/dev/null 2>&1 \
     && "$ZENC" "$tmppng" "$out" -q 100 --yuv 422 >/dev/null 2>&1 \
     && exiftool -TagsFromFile "$f" -all:all -overwrite_original "$out" >/dev/null 2>&1; then
    rm -f "$tmppng"; H_OK=$((H_OK+1)); printf "."
  else
    rm -f "$tmppng"; H_FAIL=$((H_FAIL+1)); printf "✗"
  fi
done < "$SOURCES"
echo ""
echo "  exported: $H_OK  skipped (JPG sibling exists): $H_SKIP  failed: $H_FAIL"
echo ""

# ── phase 3: upload originals + HIF JPG exports to R2 ─────────────────
if [ "${REMOTE_RENDER_ONLY:-0}" = "1" ]; then
  echo "phase 3 — R2 uploads skipped (source is already remote)"
else
  echo "phase 3 — R2 uploads (parallel 4)"
  upload() {
    local key="$1" file="$2" ct="$3"
    if wrangler r2 object put "aadhar-photos/$key" --file="$file" --content-type="$ct" --remote >/dev/null 2>&1; then
      printf "."
    else
      printf "✗"
    fi
  }

# originals → R2. NB: HIF/HEIF originals are NOT uploaded — they stay local-only
# (your drive + SSD are the archive); R2 gets their q100 JPG export instead
# (phase 2 / below), which is browser-renderable + shareable. only JPG-source
# originals (already max-quality SOOC) go up. extension lowercased so keys
# are stable; stem case preserved.
#
# The R2 copy is rearranged to PROGRESSIVE on the way up (see prep_original).
# Camera JPGs are written baseline, and /images/full/<stem>.jpg is served as bare
# image/jpeg with no AVIF tier and no <picture> — it is the one surface here where
# a multi-MB file is the whole payload, so scan order is the entire loading
# experience. jpegtran reorders the existing DCT coefficients; it never decodes to
# pixels, so this is not a re-encode and there is no generational loss.
PROGDIR="$TMP/progressive"
mkdir -p "$PROGDIR"

# jpegtran -progressive on a COPY. The file in the source folder is never touched:
# that folder is the SOOC archive and stays byte-for-byte what the camera wrote.
# -copy all keeps EXIF (incl. Orientation) — gotcha 3/4 in CLAUDE.md, and the
# metadata pipeline reads these tags later. Falls back to the untouched original
# if jpegtran fails, so a bad file costs the optimisation and not the upload.
prep_original() {
  local src="$1" out="$2"
  if "$MOZ_JTRAN" -progressive -copy all -outfile "$out" "$src" 2>/dev/null && [ -s "$out" ]; then
    printf "%s" "$out"
  else
    printf "%s" "$src"
  fi
}

PENDING=0
while IFS= read -r f; do
  base=$(basename "$f")
  stem="${base%.*}"
  ext_lc=$(echo "${base##*.}" | tr '[:upper:]' '[:lower:]')
  case "$ext_lc" in
    heic|heif|hif) continue ;;   # local-only; the q100 JPG export is the R2 copy
  esac
  ( send=$(prep_original "$f" "$PROGDIR/$stem.$ext_lc")
    upload "${stem}.${ext_lc}" "$send" "image/jpeg" ) &
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
fi
echo ""

# ── phase 4: content-hash the new tiers + photo index + metadata ─────
echo "phase 4 — hash tiers + photo index + metadata regen"
# content-address every tier into www/i/ + refresh hashes.json (the
# worker bakes /i/ URLs from that map; idempotent, only new bytes copy)
"$SCRIPT_DIR/hash-thumbnails.sh" 2>&1 | tail -1

# ── the committed photo index (www/_worker.js/photo-index.json) ──
# One entry per published stem: the R2 key, its byte size, and when it was
# uploaded. The worker BUNDLES this file (photos.js imports it), so the pool
# read costs module memory instead of a KV round trip — and this write step is
# what replaced the retired manifest:images KV bust: a photo goes live at
# deploy, which was already the real gate because its /i/ tiles, hashes.json
# entry, and caption are committed files too.
#
# size = the staged bytes that went (or will go) to R2: the progressive
# rearrangement for a JPG source (falling back to the source file where
# jpegtran fell back, and in REMOTE_RENDER_ONLY mode, where the local file IS
# the R2 object), the q100 export for a HIF source. `uploaded` is preserved
# for a stem that already has an entry, so re-renders don't masquerade as new
# photos in the footer's "Last modified".
INDEX_FILE="$PROJECT_DIR/www/_worker.js/photo-index.json"
NOW_ISO="$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"
NEW_ENTRIES="$TMP/index-entries.json"
echo '{}' > "$NEW_ENTRIES"
[ -f "$INDEX_FILE" ] || echo '{}' > "$INDEX_FILE"
while IFS= read -r f; do
  base=$(basename "$f"); stem="${base%.*}"
  ext_lc=$(echo "${base##*.}" | tr '[:upper:]' '[:lower:]')
  case "$ext_lc" in
    heic|heif|hif) key="${stem}.jpg"; obj="$EXPORTS/$stem.jpg" ;;
    *)             key="${stem}.${ext_lc}"; obj="${PROGDIR:-/nonexistent}/$stem.$ext_lc"; [ -f "$obj" ] || obj="$f" ;;
  esac
  if [ ! -f "$obj" ]; then
    echo "  index: no staged bytes for $stem — entry skipped (photos:check will flag it)" >&2
    continue
  fi
  size=$(wc -c < "$obj" | tr -d '[:space:]')
  jq --arg s "$stem" --arg k "$key" --argjson z "$size" \
     '. + {($s): {full: $k, size: $z}}' "$NEW_ENTRIES" > "$NEW_ENTRIES.tmp" && mv "$NEW_ENTRIES.tmp" "$NEW_ENTRIES"
done < "$SOURCES"
jq -S --arg now "$NOW_ISO" --slurpfile new "$NEW_ENTRIES" '
  . as $idx
  | ($new[0] | with_entries(.value += {uploaded: ($idx[.key].uploaded // $now)}))
  | $idx + .
' "$INDEX_FILE" > "$INDEX_FILE.tmp" && mv "$INDEX_FILE.tmp" "$INDEX_FILE"
echo "  photo index: $(jq 'length' "$INDEX_FILE") entries"
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
  META_MODE=()
  if [ "${REMOTE_RENDER_ONLY:-0}" = "1" ]; then META_MODE=(--merge); fi
  "$SCRIPT_DIR/extract-photo-metadata.sh" "${META_MODE[@]}" "$META_SRC" 2>&1 | tail -1
else
  echo "  exiftool or jq missing — skipping metadata regen"
fi

# bake 64-bin RGB+luma histograms into per-stem meta. the photo tooltip renders
# the histogram from meta.hist (index.html renderHistogramSvg), and
# extract-photo-metadata.sh above does NOT emit hist — so this MUST run after it,
# or every incremental add strips the bars off all existing photos. computed from
# the shipped /i/ thumbnails via hashes.json; idempotent (unchanged thumbs re-bake
# byte-identically), so running over the whole library each add is a no-op diff.
# zenc does this now (2026-08-14, was photo-histograms.py + Pillow), which is why
# there is no longer a conditional here: $ZENC is built above and is not optional,
# so the bake either runs or the whole script has already failed.
"$ZENC" histogram --root "$PROJECT_DIR/www" 2>&1 | tail -1

# caption anything still missing alt text. runs AFTER hash-thumbnails.sh because
# it reads the committed www/i/ square via hashes.json and posts those exact
# bytes to Workers AI — no round trip to production, so a photo added seconds ago
# gets captioned here rather than waiting for a deploy. resumable and idempotent:
# already-captioned stems cost nothing. a 429 (the free 10k neurons/day) stops it
# early, which is why the failure is tolerated here and the real gate is
# check-photo-pipeline.mjs below.
if command -v python3 >/dev/null 2>&1; then
  python3 "$SCRIPT_DIR/gen-alt-text.py" || \
    echo "  captions incomplete — re-run 'pnpm run captions' before deploying"
else
  echo "  python3 missing — skipping alt-text generation"
fi

node "$PROJECT_DIR/www/scripts/check-photo-pipeline.mjs"
echo ""

echo "✓ done. deploy with:"
echo "    pnpm run deploy:direct"
