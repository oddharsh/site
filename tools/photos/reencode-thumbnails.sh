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
# After running, re-run hash-thumbnails.sh: it re-hashes each tier into public/i/
# and rewrites images/hashes.json. A re-encode mints a NEW content-addressed URL,
# so there is nothing to bust (THUMB_VERSION is gone; it only ever survived in the
# legacy-fallback URL shape).
#   SQ=600 ./tools/photos/reencode-thumbnails.sh
#   SQ=600 SQ_SM=400 ./tools/photos/reencode-thumbnails.sh "/path/to/source/folder"
#
set -euo pipefail

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
PROJECT_DIR="$( cd "$SCRIPT_DIR/../.." && pwd )"
DEST="$PROJECT_DIR/public/images"
SRC="${1:-/Users/aadharsh/Downloads/to post (from ssd)}"
SQ="${SQ:-600}"        # desktop square edge
SQ_SM="${SQ_SM:-400}"  # mobile square edge (filename suffix; must match THUMB_SMALL_PX)
SQ_XS="${SQ_XS:-200}"  # 1x square edge (the 184px tile at DPR-1)

# WHICH tiers to write. Default is everything, which is what a real re-encode
# wants. The reason this knob exists is that adding a tier must be ADDITIVE: an
# /i/ URL names its bytes, so re-encoding a tier that did not need to change
# mints a new hash, rewrites every page that references it, and orphans the
# a-dict and p-dict snapshots built against the old ones. `TIERS=xs` writes the
# 200px tier and leaves the other three byte-identical, which is how the 158
# committed photos were backfilled without touching a single existing hash.
TIERS="${TIERS:-sq,sm,xs}"
want() { case ",$TIERS," in *",$1,"*) return 0;; *) return 1;; esac; }
TMP="/tmp/aadhar-reencode-$$"
mkdir -p "$TMP"
trap 'rm -rf "$TMP"' EXIT

ZENC_DIR="$(cd "$(dirname "$0")/zenc" && pwd)"
ZENC="$ZENC_DIR/target/release/zenc"
ZENC_Q=84   # The linear-light geometry preserves high-frequency energy that sips'
            # gamma-incorrect average destroyed, so correct pixels compress worse
            # and the quality knob had to be chosen rather than inherited.
            #
            # Measured over 181 photos and all four tiers, q80/avif-58 against
            # q84/avif-63: jpg 600 +14.3%, avif 600 +21.8%, avif 400 +20.2%,
            # avif 200 +19.4%, tier total +17.6% or +2.39 MiB. So q84 is not free.
            #
            # It is kept anyway, because the alternative traded encoder quality
            # DOWN while trading geometry UP: the old corpus was sips geometry at
            # q84/63, and q80/58 would have been better pixels with more
            # quantization. q84/63 changes one variable instead of two, so the
            # corpus is strictly better than what it replaced rather than better
            # on one axis and worse on another.
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

# Enumerate published stems from the content-hashed JPG tiles in public/i/. The
# old images/*.jpg location emptied out in the /i/ cutover, so globbing $DEST would
# match nothing (and, with no nullglob, silently loop once on the literal glob).
STEMS=$(for j in "$PROJECT_DIR/public/i/"*.jpg; do b=$(basename "$j" .jpg); echo "${b%.*}"; done | sort -u)
TOTAL=$(echo "$STEMS" | grep -c . || true)
[ "$TOTAL" -gt 0 ] || { echo "error: no published thumbnails found in public/i/ (expected the content-hashed JPG tiles)" >&2; exit 1; }
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
  xstmp="$INTER/${stem}.xs.png"; xsavif="$DEST/${stem}-${SQ_XS}.avif"

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
  # ONE sips spawn for both dimensions. `sips -g` takes repeated keys, which
  # export-for-instagram.sh's dims() already relied on and these three sites did
  # not: two spawns measured 43ms against 23ms for one, on a 2000px intermediate.
  # Pure spawn overhead, no pixels touched.
  # 3. centre square, in ONE process, resampled in LINEAR LIGHT.
  #
  # This replaced six sips spawns on 2026-08-25: two to read the dimensions, one
  # to reach TIFF, one to resize, one to crop, one to reach PNG. `zenc square`
  # needs none of them. It computes the short-edge target itself, so W/H and `tl`
  # are gone with it, and it reads the JPEG and writes the PNG directly, so the
  # TIFF round trip that existed only because sips is slow at PNG is gone too.
  #
  # THE REASON IS QUALITY, and the speed is the bonus. sips resamples by
  # averaging ENCODED sRGB values as though they were light, which darkens every
  # texture it touches. Measured by tools/photos/resample-probe.ts against
  # patterns with analytically known answers, no reference implementation
  # involved:
  #
  #   candidate   gamma   identity   ring   gray->ch   ms/photo
  #   ideal       187.5       0.00      0          1
  #   sips        127.6       0.00      2          1      222.4
  #   zenc box    188.0       0.00      0          1       66.7
  #
  # A 1px black/white checkerboard must reduce to sRGB 187.5, half the LIGHT.
  # sips gives 127.6, and so does ffmpeg, so this is the industry norm rather
  # than a defect unique to sips. `--filter box` rather than lanczos3 because at
  # this reduction the sharpness Lanczos buys costs 26 levels of ringing that an
  # alias-free area average does not need; the probe measures that column too.
  #
  # THE COST, measured on 8 real sources before any of this was adopted. Correct
  # pixels compress WORSE, because sips' gamma-incorrect average was quietly
  # destroying high-frequency energy that a correct one keeps:
  #
  #   jpg  q84    288,987 -> 359,797 bytes   +24.5%
  #   avif q63    185,696 -> 239,092 bytes   +28.8%
  #
  # Every one of the 8 got bigger, from +1% to +43%. Projected over the shipped
  # tier that is 11.35 -> 14.38 MiB, +3.03 MiB, +26.7% on 660 files. The probe
  # measures correctness and cannot see this, which is why it is measured here.
  #
  # THE CORPUS IS DELIBERATELY NOT REGENERATED in the commit that wired this. The
  # scripts produce better pixels for the next photo added; the 158 already
  # committed still carry sips geometry. That inconsistency is on purpose and is
  # the open question: paying 3 MiB to fix a defect nobody has complained about
  # is a decision about this site rather than about resampling.
  if ! "$ZENC" square "$work" --size "$SQ" --out "$sqjpg" --filter box >/dev/null 2>&1; then FAIL=$((FAIL+1)); printf "✗"; continue; fi
  # 4. desktop square: zenc (zenjpeg hybrid+scan+sharp_yuv, q84) + AVIF (yuv400 for grayscale, else yuv420).
  #    metadata is stripped: the grid reads EXIF/histogram from metadata.json, so
  #    embedded EXIF/XMP/ICC in the thumbnail files is dead weight (~1.5KB/AVIF
  #    avg, up to ~5KB). avifenc gets --ignore-exif/--ignore-xmp (below); zenc
  #    already emits clean JPGs, but sips can leave a grayscale ICC on B&W frames,
  #    so strip the JPG too. assumes sRGB display (the AVIF primary has no profile
  #    either, so this keeps the two formats consistent).
  space=$(sips -g space "$sqjpg" 2>/dev/null | awk '/space:/{print $2}'); [ "$space" = "Gray" ] && yuv=400 || yuv=420
  if want sq; then
  if ! "$ZENC" "$sqjpg" "$jpg" -q "$ZENC_Q" >/dev/null 2>&1; then FAIL=$((FAIL+1)); printf "✗"; continue; fi
  exif-sooc -all= -overwrite_original "$jpg" >/dev/null 2>&1 || true
  if [ "$AVIF_ENCODER" = "avifenc" ]; then
    avifenc -q 63 -d 10 --ignore-icc --ignore-exif --ignore-xmp --speed 4 --jobs 4 --yuv "$yuv" "$sqjpg" "$avif" >/dev/null 2>&1 || { FAIL=$((FAIL+1)); printf "✗"; continue; }
  else
    sips -s format avif --setProperty formatOptions 60 "$sqjpg" --out "$avif" >/dev/null 2>&1 || { FAIL=$((FAIL+1)); printf "✗"; continue; }
  fi
  fi
  # 5. mobile square: downscale the SQ square to SQ_SM (square→square, no distortion)
  if want sm && "$ZENC" square "$sqjpg" --size "$SQ_SM" --out "$smtmp" --filter box >/dev/null 2>&1; then
    if [ "$AVIF_ENCODER" = "avifenc" ]; then
      avifenc -q 63 -d 10 --ignore-icc --ignore-exif --ignore-xmp --speed 4 --jobs 4 --yuv "$yuv" "$smtmp" "$smavif" >/dev/null 2>&1 || printf "~"
    else
      sips -s format avif --setProperty formatOptions 60 "$smtmp" --out "$smavif" >/dev/null 2>&1 || printf "~"
    fi
  fi
  # 6. 1x square: the same lossless SQ square down to SQ_XS, so this tier is ONE
  #    encode from the source like the other two rather than a resize of a resize.
  # zenc square here too. This tier was MISSED when the geometry moved on
  # 2026-08-25: the 600 and 400 tiers went to the linear-light kernel and the 200
  # stayed on sips, so a quarter of the shipped corpus was still gamma-incorrect
  # while the commit said otherwise. Found by grepping for the resize rather than
  # by any check, which is the gap worth noting.
  if want xs && "$ZENC" square "$sqjpg" --size "$SQ_XS" --out "$xstmp" --filter box >/dev/null 2>&1; then
    if [ "$AVIF_ENCODER" = "avifenc" ]; then
      avifenc -q 63 -d 10 --ignore-icc --ignore-exif --ignore-xmp --speed 4 --jobs 4 --yuv "$yuv" "$xstmp" "$xsavif" >/dev/null 2>&1 || printf "~"
    else
      sips -s format avif --setProperty formatOptions 60 "$xstmp" --out "$xsavif" >/dev/null 2>&1 || printf "~"
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
