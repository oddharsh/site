#!/usr/bin/env bash
# add-car-photo.sh — process one resto-mod reference photo into the dual-encoded
# AVIF + JPG pair the homepage car-link tooltips expect.
#
#   ./add-car-photo.sh <stem> <input-image>
#
# stem is one of: singer | tuthill | hwa-evo | f355  (matches data-car-* in index.html)
# input can be any format sips reads (JPG/PNG/HEIC/WEBP/AVIF...).
#
# Output: public/cars/<stem>.{avif,jpg}, long edge capped at 480px (2x the
# 240x160 tooltip box, so it stays crisp on retina while staying tiny). The
# tooltip CSS does object-fit:cover, so the source aspect ratio is preserved
# here and cropped at render — no distortion.
#
# No EXIF, no R2: these are small static reference images, not gallery photos.
#
# pipefail because every measurement below reads through a pipe into awk, and
# without it a failed sips reports awk's status instead of its own.
set -euo pipefail

STEM="${1:?usage: add-car-photo.sh <stem> <input-image>}"
SRC="${2:?usage: add-car-photo.sh <stem> <input-image>}"
[ -f "$SRC" ] || { echo "no such file: $SRC" >&2; exit 1; }

DEST="$(cd "$(dirname "$0")/../../public/cars" && pwd)"
SIPS=/usr/bin/sips
ZENC_DIR="$(cd "$(dirname "$0")/zenc" && pwd)"
ZENC="$ZENC_DIR/target/release/zenc"
AVIFENC=/opt/homebrew/bin/avifenc
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

if [ ! -x "$ZENC" ]; then
  command -v cargo >/dev/null 2>&1 || { echo "error: cargo (rust) not found; install from https://rustup.rs" >&2; exit 1; }
  cargo build --release --manifest-path "$ZENC_DIR/Cargo.toml" >&2 || { echo "error: zenc build failed" >&2; exit 1; }
fi

# 1. downscale (preserve aspect), strip to a clean sRGB JPG.
# `-s format jpeg` is load-bearing rather than belt-and-braces: `-Z` RESIZES and
# does not convert, so a HEIC/PNG/WEBP source came out still in its own format
# under a .jpg name, and zenc refused it ("Illegal start bytes"). That made the
# HEIC/WEBP/AVIF half of this script's own usage line above dead, silently, since
# every step here is >/dev/null. Measured 2026-08-24: byte-identical output for a
# JPEG source (so no committed car photo moves), and exit 0 instead of 1 for a
# .HIF. add-photos.sh has always passed the flag; this script never did.
"$SIPS" -Z 480 -s format jpeg "$SRC" --out "$TMP/x.jpg" >/dev/null 2>&1

# 2. JPG fallback via zenc (zenjpeg hybrid+scan, q84 ≈ old jpegli q82)
"$ZENC" "$TMP/x.jpg" "$DEST/$STEM.jpg" -q 84 >/dev/null 2>&1

# 3. AVIF primary. grayscale shots get yuv400; everything else yuv420.
space=$("$SIPS" -g space "$TMP/x.jpg" 2>/dev/null | /usr/bin/awk '/space:/{print $2}')
if [ "$space" = "Gray" ]; then yuv=400; else yuv=420; fi
"$AVIFENC" -q 63 --speed 4 --jobs 4 --ignore-icc --yuv "$yuv" \
  "$DEST/$STEM.jpg" "$DEST/$STEM.avif" >/dev/null 2>&1

aw=$("$SIPS" -g pixelWidth "$DEST/$STEM.jpg" | /usr/bin/awk '/pixelWidth/{print $2}')
ah=$("$SIPS" -g pixelHeight "$DEST/$STEM.jpg" | /usr/bin/awk '/pixelHeight/{print $2}')
echo "$STEM: ${aw}x${ah}  jpg $(du -h "$DEST/$STEM.jpg" | cut -f1)  avif $(du -h "$DEST/$STEM.avif" | cut -f1)"
