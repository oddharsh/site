#!/usr/bin/env bash
#
# gen-encoding-grids.sh — generate the ZOOMED comparison crops for the
# /lwe/encoding study's three grids, all from ONE centered detail crop of the
# same lossless base the color study uses (garage/enc/c-png.png):
#
#   1. format x quality   — zenjpeg / WebP / AVIF, each at high/mid/low
#   2. chroma             — JPEG (mozjpeg) at 4:4:4 / 4:2:2 / 4:2:0, one quality
#   3. jpeg encoders      — baseline (sips) vs mozjpeg vs jpegli vs zenjpeg
#
# Outputs garage/enc/z-*.{jpg,webp,avif,png}. The demos fetch these live and
# measure real byte sizes, displayed pixel-zoomed so the artifacts are visible.
#
# ONE fixture this script CANNOT regenerate: z-enc-jpegli.jpg, the third cell of
# the encoder grid. cjpegli left the toolchain when the pipeline moved to zenc in
# 2026-07, so that file is frozen at the bytes jpegli produced then. It stays in
# the grid deliberately, because jpegli is the encoder that proved a standard
# JPEG could be halved and the grid reads as the sequence the site actually
# walked. Do not delete it expecting a rerun to bring it back.
set -euo pipefail
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
DEST="$( cd "$SCRIPT_DIR/.." && pwd )/garage/enc"
# zenc (zenjpeg hybrid trellis + progressive scan search) is the site's shipped
# JPEG encoder; the grids show it as the JPEG point. Auto-built via cargo.
ZENC_DIR="$(cd "$SCRIPT_DIR/zenc" && pwd)"
ZENC="$ZENC_DIR/target/release/zenc"
if [ ! -x "$ZENC" ]; then
  command -v cargo >/dev/null 2>&1 || { echo "error: cargo (rust) not found; install from https://rustup.rs" >&2; exit 1; }
  cargo build --release --manifest-path "$ZENC_DIR/Cargo.toml" >&2 || { echo "error: zenc build failed" >&2; exit 1; }
fi
# mozjpeg is KEG-ONLY, so `brew install mozjpeg` leaves its cjpeg off PATH and a
# bare `cjpeg` resolves libjpeg-turbo's instead. These grids publish a cell
# labelled "mozjpeg" on /lwe/encoding, so that silently compared the wrong
# encoder against itself: measured 2026-08-14 on one 64x64 edge, libjpeg-turbo
# 3.2.0 wrote 753 bytes where mozjpeg 4.1.5 wrote 513, a 32% gap on the exact
# axis this page teaches. add-photos.sh already resolves jpegtran this way.
#
# READ THIS BEFORE REGENERATING. The committed grids were produced by the bare
# (libjpeg-turbo) cjpeg, so the first run after this fix SHRINKS the mozjpeg
# cell from 1371 to 940 bytes, and that breaks the page's narrative rather than
# just its label: /lwe/encoding walks four encoders "in the order the site
# adopted them" and says each "squeezes a little harder than the last", which
# stops being true when mozjpeg (940 B) lands under zenjpeg (980 B) on this
# crop. Sizes on that page are measured live from these files, so the images
# and the copy disagree the moment you regenerate. Update the copy in the same
# commit, or do not regenerate.
MOZ_CJPEG="/opt/homebrew/opt/mozjpeg/bin/cjpeg"
if [ ! -x "$MOZ_CJPEG" ]; then
  echo "error: mozjpeg's cjpeg not found at $MOZ_CJPEG (brew install mozjpeg)" >&2
  echo "       a bare cjpeg is libjpeg-turbo's and would mislabel the grid" >&2
  exit 1
fi

TMP="/tmp/encgrid-$$"; mkdir -p "$TMP"; trap 'rm -rf "$TMP"' EXIT

# one centered 96x96 detail crop, shared by all three grids
sips -c 96 96 "$DEST/c-png.png" --out "$TMP/crop.png" >/dev/null 2>&1
ffmpeg -loglevel error -y -i "$TMP/crop.png" "$TMP/crop.ppm" 2>/dev/null   # cjpeg reads PPM, not PNG (sips BMP confuses it)
cp "$TMP/crop.png" "$DEST/z-crop.png"
sz(){ stat -f%z "$1"; }

# 1. format x quality
for q in 90 50 22; do "$ZENC" "$TMP/crop.png" "$DEST/z-zc$q.jpg" -q $q >/dev/null 2>&1; done
for q in 90 50 22; do cwebp -q $q "$TMP/crop.png" -o "$DEST/z-wp$q.webp" >/dev/null 2>&1; done
AV="--speed 6 --jobs 4 --ignore-icc --ignore-exif --ignore-xmp --yuv 420"
for q in 78 42 18; do avifenc -q $q $AV "$TMP/crop.png" "$DEST/z-av$q.avif" >/dev/null 2>&1; done

# 2. chroma subsampling (mozjpeg, one quality so only the chroma sampling varies)
"$MOZ_CJPEG" -quality 40 -sample 1x1 "$TMP/crop.ppm" > "$DEST/z-ch444.jpg" 2>/dev/null
"$MOZ_CJPEG" -quality 40 -sample 2x1 "$TMP/crop.ppm" > "$DEST/z-ch422.jpg" 2>/dev/null
"$MOZ_CJPEG" -quality 40 -sample 2x2 "$TMP/crop.ppm" > "$DEST/z-ch420.jpg" 2>/dev/null

# 3. jpeg encoders at the SAME quality setting (q72): baseline vs mozjpeg vs zenc
sips -s format jpeg --setProperty formatOptions 72 "$TMP/crop.png" --out "$DEST/z-enc-baseline.jpg" >/dev/null 2>&1
"$MOZ_CJPEG" -quality 72 "$TMP/crop.ppm" > "$DEST/z-enc-mozjpeg.jpg" 2>/dev/null
"$ZENC" "$TMP/crop.png" "$DEST/z-enc-zenc.jpg" -q 72 >/dev/null 2>&1

exiftool -all= -overwrite_original "$DEST"/z-*.jpg >/dev/null 2>&1 || true

echo "=== generated (96x96 crop) ==="
for f in "$DEST"/z-*; do printf "  %-22s %6s B\n" "$(basename "$f")" "$(sz "$f")"; done
