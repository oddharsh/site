#!/usr/bin/env bash
#
# gen-encoding-grids.sh — generate the ZOOMED comparison crops for the
# /lwe/encoding study's three grids. Each grid gets the 96x96 slice that shows
# its axis, since one slice cannot: artifacts need edges, subsampling needs color.
set -euo pipefail

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
source "$SCRIPT_DIR/require-exif-sooc.sh"
DEST="$( cd "$SCRIPT_DIR/../.." && pwd )/public/garage/enc"
ZENC_DIR="$(cd "$SCRIPT_DIR/zenc" && pwd)"
ZENC="$ZENC_DIR/target/release/zenc"
if [ ! -x "$ZENC" ]; then
  command -v cargo >/dev/null 2>&1 || { echo "error: cargo (rust) not found; install from https://rustup.rs" >&2; exit 1; }
  cargo build --release --locked --manifest-path "$ZENC_DIR/Cargo.toml" >&2 || { echo "error: zenc build failed" >&2; exit 1; }
fi
# mozjpeg is KEG-ONLY, so `brew install mozjpeg` leaves its cjpeg off PATH and a
# bare `cjpeg` resolves libjpeg-turbo's instead. These grids publish a cell
# labelled "mozjpeg" on /lwe/encoding, so that silently compared the wrong
# encoder against itself: measured 2026-08-14 on one 64x64 edge, libjpeg-turbo
# 3.2.0 wrote 753 bytes where mozjpeg 4.1.5 wrote 513, a 32% gap on the exact
# axis this page teaches. add-photos.sh already resolves jpegtran this way.
MOZ_CJPEG="$(brew --prefix mozjpeg)/bin/cjpeg"
if [ ! -x "$MOZ_CJPEG" ]; then
  echo "error: mozjpeg's cjpeg not found at $MOZ_CJPEG (brew install mozjpeg)" >&2
  echo "       a bare cjpeg is libjpeg-turbo's and would mislabel the grid" >&2
  exit 1
fi

TMP="/tmp/encgrid-$$"; mkdir -p "$TMP"; trap 'rm -rf "$TMP"' EXIT

sips -c 96 96 "$DEST/c-png.png" --out "$TMP/crop.png" >/dev/null 2>&1
ffmpeg -loglevel error -y -i "$TMP/crop.png" "$TMP/crop.ppm" 2>/dev/null
cp "$TMP/crop.png" "$DEST/z-crop.png"
sz(){ stat -f%z "$1"; }

sips -c 96 96 --cropOffset 125 45 "$DEST/c-png.png" --out "$TMP/fmt.png" >/dev/null 2>&1
for q in 90 50 22; do "$ZENC" "$TMP/fmt.png" "$DEST/z-zc$q.jpg" -q $q >/dev/null 2>&1; done
for q in 90 50 22; do cwebp -q $q "$TMP/fmt.png" -o "$DEST/z-wp$q.webp" >/dev/null 2>&1; done
AV="--speed 6 --jobs 4 --ignore-icc --ignore-exif --ignore-xmp --yuv 420"
for q in 78 42 18; do avifenc -q $q $AV "$TMP/fmt.png" "$DEST/z-av$q.avif" >/dev/null 2>&1; done

"$ZENC" frame "$DEST/ch-branches.png" --out "$TMP/ch.ppm" >/dev/null
"$MOZ_CJPEG" -quality 75 -sample 1x1 "$TMP/ch.ppm" > "$DEST/z-ch444.jpg" 2>/dev/null
"$MOZ_CJPEG" -quality 75 -sample 2x1 "$TMP/ch.ppm" > "$DEST/z-ch422.jpg" 2>/dev/null
"$MOZ_CJPEG" -quality 75 -sample 2x2 "$TMP/ch.ppm" > "$DEST/z-ch420.jpg" 2>/dev/null

sips -s format jpeg --setProperty formatOptions 72 "$TMP/crop.png" --out "$DEST/z-enc-baseline.jpg" >/dev/null 2>&1
"$MOZ_CJPEG" -quality 72 "$TMP/crop.ppm" > "$DEST/z-enc-mozjpeg.jpg" 2>/dev/null
"$ZENC" "$TMP/crop.png" "$DEST/z-enc-zenc.jpg" -q 72 >/dev/null 2>&1

exif-sooc -all= -overwrite_original "$DEST"/z-*.jpg >/dev/null

echo "=== generated (96x96 crop) ==="
for f in "$DEST"/z-*; do printf "  %-22s %6s B\n" "$(basename "$f")" "$(sz "$f")"; done
