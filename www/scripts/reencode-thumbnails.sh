#!/usr/bin/env bash
#
# reencode-thumbnails.sh — re-encode ALL published grid thumbnails from the
# canonical source folder at a new resolution, in place.
#
# Re-encodes the grid thumbnails as PRE-CROPPED CENTER SQUARES — exactly what the
# homepage grid shows (aspect-ratio:1 + object-fit:cover). The file IS the
# displayed pixels, so no off-square bytes are shipped. Two square tiers:
#   SQ    desktop square (default 600 — the ~197px tile at DPR-3; 800 would be
#         MORE pixels than the old 800-long-edge and bigger for no visible gain)
#   SQ_SM mobile square  (default 400 — the ~100px tile, served via <source media>)
# AVIF for both; a single SQ JPG is the no-AVIF fallback. NB: SQ_SM must match
# THUMB_SMALL_PX in _worker.js (the -<N>.avif suffix).
#
# Deliberately does NOT touch R2 (it now holds only q100 JPG share copies, not
# originals), metadata.json (its width/height are the ORIGINAL dims), or the
# full-res click export. The source folder may be a disposable directory
# downloaded from R2 by the remote GitHub Actions workflow.
#
# FUTURE — native-aspect layout (when CSS masonry / grid-lanes ships in 2+
# engines; today it's Safari 26 only, Chrome behind a flag — see /garage/horizon).
# The square crop here is a CURRENT-ENGINES compromise; the long-term intent is to
# stop cropping and lay photos out at their native aspect, packed creatively
# (masonry) and scaled by SOOC pixel area. To get there: re-encode full-frame
# (NOT square) thumbnails from the local SOOC originals in $SRC (the .HIF files)
# — nothing is lost, the crop only ever lived in these files — and drive the
# layout from metadata.json's original
# width/height. Key gotcha (this bit us before): if a tile is shown LARGER than
# its thumbnail's resolution it pixelates, so the thumbnail's encoded size must
# scale with its DISPLAY area, not be a fixed long-edge. So that variant wants a
# per-photo target size (area-aware), not one global SQ.
#
# Relative TILE AREA = (pixel area) × (sensor area):
#   - pixel area  = metadata.json width × height (already stored).
#   - sensor area = camera model → mm² lookup. Today's bodies:
#       FUJIFILM X-T50            APS-C  ~367 mm²  (40 MP)
#       Leica M Monochrom Typ 246 full   ~864 mm²  (24 MP)
#     so Leica frames land ~1.4× the Fuji tiles — a gentle premium for the
#     bigger sensor, NOT "more megapixels wins" (pure-MP would invert this).
# Normalize the metric into a few DISCRETE area tiers (e.g. 1× / 1.4× / 2×),
# never literal-proportional (that's what caused the earlier imbalance). SHAPE
# comes from native aspect (don't crop); this metric only sets relative AREA.
# With just two bodies it's near-binary today — the visual variety will come
# from aspect ratios, not this — but it future-proofs the moment a 3rd body lands.
#
# After running, re-run hash-thumbnails.sh: it re-hashes each tier into www/i/
# and rewrites images/hashes.json. A re-encode mints a NEW content-addressed URL,
# so there is nothing to bust (THUMB_VERSION is gone; it only ever survived in the
# legacy-fallback URL shape).
#   SQ=600 ./www/scripts/reencode-thumbnails.sh
#   SQ=600 SQ_SM=400 ./www/scripts/reencode-thumbnails.sh "/path/to/source/folder"
#
set -euo pipefail

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
PROJECT_DIR="$( cd "$SCRIPT_DIR/../.." && pwd )"
DEST="$PROJECT_DIR/www/images"
SRC="${1:-/Users/aadharsh/Downloads/to post (from ssd)}"
SQ="${SQ:-600}"        # desktop square edge
SQ_SM="${SQ_SM:-400}"  # mobile square edge (filename suffix; must match THUMB_SMALL_PX)
TMP="/tmp/aadhar-reencode-$$"
mkdir -p "$TMP"
trap 'rm -rf "$TMP"' EXIT

ZENC_DIR="$(cd "$(dirname "$0")/zenc" && pwd)"
ZENC="$ZENC_DIR/target/release/zenc"
ZENC_Q=84   # calibrated to match the retired cjpegli q82 quality at fewer bytes
MOZ_JTRAN="/opt/homebrew/opt/mozjpeg/bin/jpegtran"

for cmd in sips exif-sooc; do
  command -v "$cmd" >/dev/null 2>&1 || { echo "error: $cmd not in PATH" >&2; exit 1; }
done

# exif-sooc must be new enough to WRITE, and the check is on the version rather
# than on a flag, because every failure mode here is quiet. An older build does
# not reject -all=: it reads it as a tag SELECTION and prints JSON, so the strip
# does nothing. 0.1.0 went further and truncated progressive JPEGs at their
# first scan, and every JPEG this pipeline produces is progressive. Each write
# below is wrapped in `|| true`, so a shipped file would keep the metadata this
# exists to remove, or lose most of its image, and nothing would say a word.
EXIF_SOOC_MIN=0.2.0
# `|| true` matters under `set -euo pipefail`: without it a missing or broken
# binary kills the script at this assignment, silently, before the message
# below can say what is wrong.
sooc_ver=$(exif-sooc --version 2>/dev/null | awk '{print $NF}' || true)
# Anything that is not a plain x.y.z is refused rather than compared. `sort -V`
# happily orders a word against a version and answers, so a garbled --version
# would otherwise read as new enough.
case "$sooc_ver" in
  *[!0-9.]*|'') sooc_ver='' ;;
esac
if [ -z "$sooc_ver" ] || [ "$(printf '%s\n%s\n' "$EXIF_SOOC_MIN" "$sooc_ver" | sort -V | head -1)" != "$EXIF_SOOC_MIN" ]; then
  echo "error: exif-sooc ${sooc_ver:-not found} is older than $EXIF_SOOC_MIN, which cannot write metadata safely." >&2
  echo "  update with: cargo install --git https://github.com/oddharsh/exif-sooc exif-sooc --force" >&2
  exit 1
fi
if [ ! -x "$ZENC" ]; then
  command -v cargo >/dev/null 2>&1 || { echo "error: cargo (rust) not found; install from https://rustup.rs" >&2; exit 1; }
  echo "building zenc (zenjpeg encoder) — first run only…" >&2
  cargo build --release --manifest-path "$ZENC_DIR/Cargo.toml" >&2 || { echo "error: zenc build failed" >&2; exit 1; }
fi
[ -x "$MOZ_JTRAN" ] || { echo "error: jpegtran not installed (brew install mozjpeg)" >&2; exit 1; }
[ -d "$SRC" ]      || { echo "error: source folder not found: $SRC" >&2; exit 1; }
if command -v avifenc >/dev/null 2>&1; then AVIF_ENCODER="avifenc"; else AVIF_ENCODER="sips"; fi

# EXIF Orientation → jpegtran transform flag (identical to add-photos.sh).
exif_to_jpegtran() {
  local o; o=$(exif-sooc -s -s -s -n -Orientation "$1" 2>/dev/null || echo "")
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

# Enumerate published stems from the content-hashed JPG tiles in www/i/. The
# old images/*.jpg location emptied out in the /i/ cutover, so globbing $DEST would
# match nothing (and, with no nullglob, silently loop once on the literal glob).
STEMS=$(for j in "$PROJECT_DIR/www/i/"*.jpg; do b=$(basename "$j" .jpg); echo "${b%.*}"; done | sort -u)
TOTAL=$(echo "$STEMS" | grep -c . || true)
[ "$TOTAL" -gt 0 ] || { echo "error: no published thumbnails found in www/i/ (expected the content-hashed JPG tiles)" >&2; exit 1; }
echo "re-encoding $TOTAL thumbnails as ${SQ}×${SQ} / ${SQ_SM}×${SQ_SM} center squares  (zenc q${ZENC_Q} + AVIF via $AVIF_ENCODER)"
echo "  source: $SRC"
echo ""

OK=0; MISS=0; FAIL=0
INTER="$TMP/inter"; mkdir -p "$INTER"
while IFS= read -r stem; do
  [ -n "$stem" ] || continue
  if ! src=$(find_source "$stem"); then MISS=$((MISS+1)); printf "?"; continue; fi

  work="$INTER/${stem}.jpg"; rot="$INTER/${stem}.rot.jpg"
  # Lossless intermediates, not JPEGs: see the note at the geometry below.
  tif="$INTER/${stem}.tif"; sqt="$INTER/${stem}.sq.tif"
  sqjpg="$INTER/${stem}.sq.png"; smtmp="$INTER/${stem}.sm.png"
  jpg="$DEST/${stem}.jpg"; avif="$DEST/${stem}.avif"; smavif="$DEST/${stem}-${SQ_SM}.avif"

  # 1. decode source → working JPG (long edge 2000 — ample to crop a sharp square)
  if ! sips -Z 2000 -s format jpeg --setProperty formatOptions 100 "$src" --out "$work" >/dev/null 2>&1; then
    FAIL=$((FAIL+1)); printf "✗"; continue
  fi
  # 2. lossless EXIF-orientation rotation (cjpegli/avifenc strip EXIF, bake it in)
  rot_flag=$(exif_to_jpegtran "$src")
  if [ -n "$rot_flag" ]; then
    if "$MOZ_JTRAN" -copy none $rot_flag "$work" > "$rot" 2>/dev/null; then work="$rot"; fi
  fi
  # 3. center-crop to a square — what the grid actually shows. resize the SHORT
  #    edge up to SQ (keeping aspect), then crop SQ×SQ centered (sips object-
  #    position is center, matching object-fit:cover's default).
  W=$(sips -g pixelWidth "$work" 2>/dev/null | awk '/pixelWidth/{print $2}')
  H=$(sips -g pixelHeight "$work" 2>/dev/null | awk '/pixelHeight/{print $2}')
  if [ -z "$W" ] || [ -z "$H" ] || [ "$W" -lt 1 ] || [ "$H" -lt 1 ]; then FAIL=$((FAIL+1)); printf "✗"; continue; fi
  if [ "$W" -le "$H" ]; then tl=$(( (SQ*H + W-1)/W )); else tl=$(( (SQ*W + H-1)/H )); fi
  # The resize and the crop run on a LOSSLESS intermediate. They used to run on
  # the JPEG, and `sips -Z` and `sips -c` each decode and re-encode, so what
  # reached zenc had been through three JPEG encodes rather than one. Measured
  # over the whole corpus: median ssimulacra2 68.97 -> 80.20, better on 159 of
  # 159 photos, for 1.1% more bytes. TIFF for the geometry because sips writes
  # it fastest, then one PNG because that is what zenc and avifenc read.
  if ! sips -s format tiff "$work" --out "$tif" >/dev/null 2>&1; then FAIL=$((FAIL+1)); printf "✗"; continue; fi
  sips -Z "$tl" "$tif" >/dev/null 2>&1
  if ! sips -c "$SQ" "$SQ" "$tif" --out "$sqt" >/dev/null 2>&1; then FAIL=$((FAIL+1)); printf "✗"; continue; fi
  if ! sips -s format png "$sqt" --out "$sqjpg" >/dev/null 2>&1; then FAIL=$((FAIL+1)); printf "✗"; continue; fi
  # 4. desktop square: zenc (zenjpeg hybrid+scan+sharp_yuv, q84) + AVIF (yuv400 for grayscale, else yuv420).
  #    metadata is stripped: the grid reads EXIF/histogram from metadata.json, so
  #    embedded EXIF/XMP/ICC in the thumbnail files is dead weight (~1.5KB/AVIF
  #    avg, up to ~5KB). avifenc gets --ignore-exif/--ignore-xmp (below); zenc
  #    already emits clean JPGs, but sips can leave a grayscale ICC on B&W frames,
  #    so strip the JPG too. assumes sRGB display (the AVIF primary has no profile
  #    either, so this keeps the two formats consistent).
  if ! "$ZENC" "$sqjpg" "$jpg" -q "$ZENC_Q" >/dev/null 2>&1; then FAIL=$((FAIL+1)); printf "✗"; continue; fi
  exif-sooc -all= -overwrite_original "$jpg" >/dev/null 2>&1 || true
  space=$(sips -g space "$sqjpg" 2>/dev/null | awk '/space:/{print $2}'); [ "$space" = "Gray" ] && yuv=400 || yuv=420
  if [ "$AVIF_ENCODER" = "avifenc" ]; then
    avifenc -q 63 -d 10 --ignore-icc --ignore-exif --ignore-xmp --speed 4 --jobs 4 --yuv "$yuv" "$sqjpg" "$avif" >/dev/null 2>&1 || { FAIL=$((FAIL+1)); printf "✗"; continue; }
  else
    sips -s format avif --setProperty formatOptions 60 "$sqjpg" --out "$avif" >/dev/null 2>&1 || { FAIL=$((FAIL+1)); printf "✗"; continue; }
  fi
  # 5. mobile square: downscale the SQ square to SQ_SM (square→square, no distortion)
  if sips -Z "$SQ_SM" "$sqjpg" --out "$smtmp" >/dev/null 2>&1; then
    if [ "$AVIF_ENCODER" = "avifenc" ]; then
      avifenc -q 63 -d 10 --ignore-icc --ignore-exif --ignore-xmp --speed 4 --jobs 4 --yuv "$yuv" "$smtmp" "$smavif" >/dev/null 2>&1 || printf "~"
    else
      sips -s format avif --setProperty formatOptions 60 "$smtmp" --out "$smavif" >/dev/null 2>&1 || printf "~"
    fi
  fi
  OK=$((OK+1)); printf "."
done <<< "$STEMS"
echo ""
echo ""
echo "  re-encoded: $OK   source-missing: $MISS   failed: $FAIL"
echo "  next: re-run hash-thumbnails.sh (new bytes mint new /i/ URLs), commit,"
echo "  then deploy — the worker bundles photo-index.json + hashes.json, so"
echo "  the deploy IS the cache bust."
