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

for cmd in sips exif-sooc; do
  command -v "$cmd" >/dev/null 2>&1 || { echo "error: $cmd not in PATH" >&2; exit 1; }
done

source "$SCRIPT_DIR/require-exif-sooc.sh"
source "$SCRIPT_DIR/require-zenc.sh"
require_zenc_avif "$ZENC_DIR"
[ -d "$SRC" ]      || { echo "error: source folder not found: $SRC" >&2; exit 1; }
# Use the same source selection as ingest, restricted to published stems.
# Missing sources remain a supported partial rerender; ambiguous ones fail
# before any existing tier is replaced.
INPUTS="$TMP/inputs"
bun "$SCRIPT_DIR/photo-inputs.ts" rerender "$SRC" "$PROJECT_DIR/public/i" > "$INPUTS"
TOTAL=$(( $(tr -cd '\000' < "$INPUTS" | wc -c) / 4 ))
echo "re-encoding $TOTAL thumbnails as ${SQ}×${SQ} / ${SQ_SM}×${SQ_SM} center squares  (zenc q${ZENC_Q} + AVIF via libavif)"
echo "  source: $SRC"
echo ""

OK=0; MISS=0; FAIL=0
INTER="$TMP/inter"; mkdir -p "$INTER"
while IFS= read -r -d '' src && IFS= read -r -d '' original &&
      IFS= read -r -d '' full && IFS= read -r -d '' stem; do
  if [ -z "$src" ]; then MISS=$((MISS+1)); printf "?"; continue; fi

  tif="$INTER/${stem}.tif"

  # 1-3. decode → orient → all three tiers, ONE zenc invocation, in linear light.
  #
  # This consolidated four seams on 2026-08-26, each one measured before it moved:
  #
  #   - the `sips -Z 2000` first reduction was a GAMMA-INCORRECT resample feeding
  #     the correct one. An earlier note here declined removing it, measured with
  #     a home-grown mean-luminance metric; re-measured with ssimulacra2 against
  #     a linear-light ground truth, one-step wins +27.5 mean over 10 frames
  #     (57.23 -> 84.77), better on 10 of 10. The instrument was the error.
  #   - jpegtran's DCT rotation is silently non-lossless when the constraint
  #     edge is not iMCU-aligned, and this script never passed -perfect. On the
  #     2000x1333 intermediates, -rotate 270 (133 of 181 photos) was perfect BY
  #     LUCK and -rotate 90/-rotate 180 were not: XT507876 shipped with its
  #     frame displaced 5px and a garbled edge strip. zenc's --orient re-indexes
  #     samples in f32: exact at any dimensions, no MCU grid, no lottery.
  #   - the 400 and 200 tiers were resamples OF THE 600 TIER; all three now come
  #     from the same full-resolution linear-light frame.
  #   - a 10-bit HIF was quantised to 8 bits at this first step. The TIFF door
  #     decodes at 16 bits straight into f32 (sips -s format tiff is also 10.6x
  #     faster than PNG at this size: 509ms vs 6222ms on a 7728x5152 frame).
  #     JPEG sources skip the TIFF entirely: zenc decodes them itself.
  #
  # --transfer g22 for the Monochrom files, whose profile is Gray Gamma 2.2 and
  # not sRGB: linearising them with the sRGB curve was wrong by up to 4 codes,
  # in the shadows a monochrome body exists for. The curve is decode AND encode,
  # so unaveraged values pass through exactly and the shipped tone is unchanged.
  #
  # The probe (tools/photos/resample-probe.ts) and its history stay the record
  # for the kernel itself: gamma 188.0 where sips read 127.6, flat 0.00 where
  # sips read 0.49, ring 0. See also ZENC_Q above for what correct pixels cost.
  input="$src"
  case "${src##*.}" in
    [Hh][Ii][Ff]|[Hh][Ee][Ii][Cc]|[Hh][Ee][Ii][Ff])
      if ! sips -s format tiff "$src" --out "$tif" >/dev/null 2>&1; then FAIL=$((FAIL+1)); printf "✗"; continue; fi
      input="$tif" ;;
  esac
  o=$(exif-sooc -s -s -s -n -Orientation "$src" 2>/dev/null) || o=""
  case "$o" in [1-8]) ;; *) o=1 ;; esac
  # The transfer curve is zenc's to decide, from the file's own ICC, since
  # 2026-08-26. This used to be `sips -g profile` plus a literal match on
  # "Gray Gamma 2.2": a 123ms process per photo whose failure direction was
  # silent, because any other spelling falls back to sRGB and sRGB on Monochrom
  # data is wrong by up to 4 codes in the shadows. Classification is unchanged
  # on this corpus (2 g22, 179 srgb) and the outputs are byte-identical.
  # Only requested tiers are written, all from one decoded linear-light frame.
  stage="$INTER/$stem"; mkdir -p "$stage"
  args=(square "$input" --orient "$o" --filter box --jpeg-quality "$ZENC_Q")
  outputs=()
  if want sq; then
    args+=(--size "$SQ" --avif-out "$stage/${stem}.avif" --jpeg-out "$stage/${stem}.jpg")
    outputs+=("$stage/${stem}.avif" "$stage/${stem}.jpg")
  fi
  if want sm; then
    args+=(--size "$SQ_SM" --avif-out "$stage/${stem}-${SQ_SM}.avif")
    outputs+=("$stage/${stem}-${SQ_SM}.avif")
  fi
  if want xs; then
    args+=(--size "$SQ_XS" --avif-out "$stage/${stem}-${SQ_XS}.avif")
    outputs+=("$stage/${stem}-${SQ_XS}.avif")
  fi
  if [ "${#outputs[@]}" -eq 0 ]; then
    echo "error: TIERS must select sq, sm, or xs" >&2; exit 1
  fi
  if ! "$ZENC" "${args[@]}"; then
    rm -f "$tif"; FAIL=$((FAIL+1)); printf "✗"; continue
  fi
  rm -f "$tif"
  if want sq && ! exif-sooc -all= -overwrite_original "$stage/${stem}.jpg" >/dev/null; then
    FAIL=$((FAIL+1)); printf "✗"; continue
  fi
  complete=1
  for file in "${outputs[@]}"; do [ -s "$file" ] || complete=0; done
  if [ "$complete" -ne 1 ] || ! mv "${outputs[@]}" "$DEST/"; then
    FAIL=$((FAIL+1)); printf "✗"; continue
  fi
  OK=$((OK+1)); printf "."
done < "$INPUTS"
echo ""
echo ""
echo "  re-encoded: $OK   source-missing: $MISS   failed: $FAIL"
if [ "$FAIL" -gt 0 ] || [ "$OK" -eq 0 ]; then
  echo "error: thumbnail re-encode incomplete; do not hash or publish these outputs" >&2
  exit 1
fi
echo "  next: re-run hash-thumbnails.sh (new bytes mint new /i/ URLs), then"
echo "  re-bake the histograms, then \`bun run derive:check\`, commit, and deploy."
echo "  the worker bundles photo-index.json + hashes.json, so the deploy IS the"
echo "  cache bust."
echo ""
echo "  the re-bake is not optional and is why gotcha 46 exists: this script is"
echo "  the standalone path, #394 took it, re-encoded 316 tiles, re-baked nothing,"
echo "  and images/histograms.json described pixels nobody was served for nine"
echo "  days. derive:check is what says so now, by name and per file."
