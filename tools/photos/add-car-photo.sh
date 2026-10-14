#!/usr/bin/env bash
# add-car-photo.sh — process one resto-mod reference photo into the dual-encoded
# AVIF + JPG pair the homepage car-link tooltips expect.
set -euo pipefail

STEM="${1:?usage: add-car-photo.sh <stem> <input-image>}"
SRC="${2:?usage: add-car-photo.sh <stem> <input-image>}"
[ -f "$SRC" ] || { echo "no such file: $SRC" >&2; exit 1; }

DEST="$(cd "$(dirname "$0")/../../public/cars" && pwd)"
SIPS=/usr/bin/sips
ZENC_DIR="$(cd "$(dirname "$0")/zenc" && pwd)"
ZENC="$ZENC_DIR/target/release/zenc"
AVIFENC="$(command -v avifenc)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

if [ ! -x "$ZENC" ]; then
  command -v cargo >/dev/null 2>&1 || { echo "error: cargo (rust) not found; install from https://rustup.rs" >&2; exit 1; }
  cargo build --release --locked --manifest-path "$ZENC_DIR/Cargo.toml" >&2 || { echo "error: zenc build failed" >&2; exit 1; }
fi

input="$SRC"
case "$(printf '%s' "${SRC##*.}" | /usr/bin/tr '[:upper:]' '[:lower:]')" in
  jpg|jpeg|png|tif|tiff) ;;
  *)
    "$SIPS" -s format tiff "$SRC" --out "$TMP/decoded.tif" >/dev/null 2>&1 ||
      { echo "error: sips cannot decode $SRC" >&2; exit 1; }
    input="$TMP/decoded.tif" ;;
esac

srcw=$("$SIPS" -g pixelWidth "$input" | /usr/bin/awk '/pixelWidth/{print $2}')
srch=$("$SIPS" -g pixelHeight "$input" | /usr/bin/awk '/pixelHeight/{print $2}')
if [ "$srcw" -ge "$srch" ]; then axis=--width; else axis=--height; fi
"$ZENC" resize "$input" "$axis" 480 --filter box --out "$TMP/x.png" >/dev/null 2>&1

"$ZENC" "$TMP/x.png" "$DEST/$STEM.jpg" -q 84 >/dev/null 2>&1

space=$("$SIPS" -g space "$input" 2>/dev/null | /usr/bin/awk '/space:/{print $2}') || space=""
if [ "$space" = "Gray" ]; then yuv=400; else yuv=420; fi
"$AVIFENC" -q 63 -d 10 --speed 2 --jobs 4 --ignore-icc --ignore-exif --ignore-xmp \
  --yuv "$yuv" "$TMP/x.png" "$DEST/$STEM.avif" >/dev/null 2>&1

aw=$("$SIPS" -g pixelWidth "$DEST/$STEM.jpg" | /usr/bin/awk '/pixelWidth/{print $2}')
ah=$("$SIPS" -g pixelHeight "$DEST/$STEM.jpg" | /usr/bin/awk '/pixelHeight/{print $2}')
echo "$STEM: ${aw}x${ah}  jpg $(du -h "$DEST/$STEM.jpg" | cut -f1)  avif $(du -h "$DEST/$STEM.avif" | cut -f1)"
