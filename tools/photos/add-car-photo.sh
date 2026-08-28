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
  cargo build --release --locked --manifest-path "$ZENC_DIR/Cargo.toml" >&2 || { echo "error: zenc build failed" >&2; exit 1; }
fi

# 1. DECODE, and only for what zenc cannot open itself. zenc reads JPEG, PNG and
# TIFF, so sips is here for HEIC/HIF, WEBP, AVIF and whatever else it reads. The
# door is a TIFF because it is LOSSLESS and 16-bit, which is the same door
# add-photos.sh phase 1 uses; `sips -s format png` deflates the same pixels and
# takes about 10x longer at full resolution.
#
# This step used to be `sips -Z 480 -s format jpeg`, which did three jobs at
# once and got two of them wrong: it wrote a LOSSY intermediate that both
# encoders below then re-encoded, and it resampled in gamma space, which the
# 2026-08-26 ingest rewrite took out of every other path here (+27.5 mean
# ssimulacra2 over 10 frames, `bun run onestep:probe`).
input="$SRC"
case "$(printf '%s' "${SRC##*.}" | /usr/bin/tr '[:upper:]' '[:lower:]')" in
  jpg|jpeg|png|tif|tiff) ;;
  *)
    "$SIPS" -s format tiff "$SRC" --out "$TMP/decoded.tif" >/dev/null 2>&1 ||
      { echo "error: sips cannot decode $SRC" >&2; exit 1; }
    input="$TMP/decoded.tif" ;;
esac

# 2. cap the long edge at 480 into a LOSSLESS PNG, resampled in linear light.
# `zenc resize` caps ONE axis and keeps the whole frame, so which axis carries
# the cap has to be decided here; `sips -Z` took the long edge on its own.
#
# EXIF orientation is deliberately NOT applied, because the old path did not
# apply it either and this swap is not the place to change what ships. Measured
# 2026-08-27 on XT507876.JPG (orientation 6): `sips -Z 480` writes 480x320 and
# leaves the tag, zenc's encode ignores EXIF, so the old script shipped 480x320
# unrotated and so does this one. A portrait source is sideways either way.
srcw=$("$SIPS" -g pixelWidth "$input" | /usr/bin/awk '/pixelWidth/{print $2}')
srch=$("$SIPS" -g pixelHeight "$input" | /usr/bin/awk '/pixelHeight/{print $2}')
if [ "$srcw" -ge "$srch" ]; then axis=--width; else axis=--height; fi
"$ZENC" resize "$input" "$axis" 480 --filter box --out "$TMP/x.png" >/dev/null 2>&1

# 3. JPG fallback via zenc (zenjpeg hybrid+scan, q84 ≈ old jpegli q82)
"$ZENC" "$TMP/x.png" "$DEST/$STEM.jpg" -q 84 >/dev/null 2>&1

# 4. AVIF primary, from the SAME lossless PNG rather than from the JPG above.
# Encoding it from the JPG spent a whole generation for nothing: measured
# 2026-08-27 over 3 sources at this tier, from-the-PNG is +2.2 to +3.4
# ssimulacra2 at the same bytes. `-d 10` is the 10-bit encode every other
# avifenc call site here passes, worth another 0.5-1.4% off.
#
# `--speed 2` tracks the photo pipeline, which moved off 4 on 2026-08-28 for
# -1.65% bytes AND +0.162 mean ssimulacra2 (the measurement lives at
# avif_encode() in add-photos.sh). It was taken on the 600/400/200 photo tiers
# rather than on this 480px one, and this call site inherits it because it is
# the same encoder at the same -q 63 -d 10 on a tier of the same order. The
# cost here is invisible either way: one image per invocation, sub-second.
# public/cars is not content-addressed, so this re-mints no URL; the six
# committed reference pairs stay speed 4 until somebody re-adds one.
#
# grayscale shots get yuv400; everything else yuv420. The probe reads the
# SOURCE rather than the intermediate, because the source is where the colour
# space is a fact about the photograph. The two agree here (measured 2026-08-27:
# sips reports Gray for a Monochrom JPG and for the PNG zenc resizes it into),
# and reading the source means a future intermediate format cannot quietly
# decide this. Tolerant under pipefail: an unreadable colorspace falls through
# to 4:2:0.
space=$("$SIPS" -g space "$input" 2>/dev/null | /usr/bin/awk '/space:/{print $2}') || space=""
if [ "$space" = "Gray" ]; then yuv=400; else yuv=420; fi
"$AVIFENC" -q 63 -d 10 --speed 2 --jobs 4 --ignore-icc --ignore-exif --ignore-xmp \
  --yuv "$yuv" "$TMP/x.png" "$DEST/$STEM.avif" >/dev/null 2>&1

aw=$("$SIPS" -g pixelWidth "$DEST/$STEM.jpg" | /usr/bin/awk '/pixelWidth/{print $2}')
ah=$("$SIPS" -g pixelHeight "$DEST/$STEM.jpg" | /usr/bin/awk '/pixelHeight/{print $2}')
echo "$STEM: ${aw}x${ah}  jpg $(du -h "$DEST/$STEM.jpg" | cut -f1)  avif $(du -h "$DEST/$STEM.avif" | cut -f1)"
