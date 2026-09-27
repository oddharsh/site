#!/usr/bin/env bash
#
# gen-encoding-grids.sh — generate the ZOOMED comparison crops for the
# /lwe/encoding study's three grids. Each grid gets the 96x96 slice that shows
# its axis, since one slice cannot: artifacts need edges, subsampling needs color.
#
#   1. format x quality   — zenjpeg / WebP / AVIF, each at high/mid/low, on the
#                           front wheel of the color study's lossless base
#                           (garage/enc/c-png.png)
#   2. chroma             — JPEG (mozjpeg) at 4:4:4 / 4:2:2 / 4:2:0, one quality,
#                           on branches against red glass (ch-branches.png)
#   3. jpeg encoders      — baseline (sips) vs mozjpeg vs jpegli vs zenjpeg, on
#                           the centred crop of c-png.png, which it keeps because
#                           its jpegli cell cannot be re-encoded (below)
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
source "$SCRIPT_DIR/require-exif-sooc.sh"
DEST="$( cd "$SCRIPT_DIR/../.." && pwd )/public/garage/enc"
# zenc (zenjpeg hybrid trellis + progressive scan search) is the site's shipped
# JPEG encoder; the grids show it as the JPEG point. Auto-built via cargo.
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
MOZ_CJPEG="$(brew --prefix mozjpeg)/bin/cjpeg"
if [ ! -x "$MOZ_CJPEG" ]; then
  echo "error: mozjpeg's cjpeg not found at $MOZ_CJPEG (brew install mozjpeg)" >&2
  echo "       a bare cjpeg is libjpeg-turbo's and would mislabel the grid" >&2
  exit 1
fi

TMP="/tmp/encgrid-$$"; mkdir -p "$TMP"; trap 'rm -rf "$TMP"' EXIT

# the centred 96x96 crop: the encoder grid's slice (and z-crop.png)
sips -c 96 96 "$DEST/c-png.png" --out "$TMP/crop.png" >/dev/null 2>&1
ffmpeg -loglevel error -y -i "$TMP/crop.png" "$TMP/crop.ppm" 2>/dev/null   # cjpeg reads PPM, not PNG (sips BMP confuses it)
cp "$TMP/crop.png" "$DEST/z-crop.png"
sz(){ stat -f%z "$1"; }

# 1. format x quality, on its OWN slice: the front wheel's face (spokes, bolts,
# the red caliper, the centre cap) rather than the centred crop, which is mostly
# flat black bodywork. A near-empty slice hid both halves of what this grid
# teaches: the artifacts had nothing to break, and its bytes were so small that
# container overhead ranked the formats (AVIF heaviest) the opposite way to the
# full-photo table on the same page. On the wheel AVIF comes out smallest at all
# three tiers, which is the ordering that table measures.
sips -c 96 96 --cropOffset 125 45 "$DEST/c-png.png" --out "$TMP/fmt.png" >/dev/null 2>&1
for q in 90 50 22; do "$ZENC" "$TMP/fmt.png" "$DEST/z-zc$q.jpg" -q $q >/dev/null 2>&1; done
for q in 90 50 22; do cwebp -q $q "$TMP/fmt.png" -o "$DEST/z-wp$q.webp" >/dev/null 2>&1; done
# --speed 6 here, --speed 4 in gen-encoding-samples.sh, --speed 2 in the photo
# pipeline since 2026-08-28. Three values on purpose for now, and the divergence
# is recorded rather than swept: this grid varies FORMAT and QUALITY at a fixed
# effort, and moving the effort moves every AVIF byte count the page prints, so
# aligning it means regenerating the committed samples under public/garage/enc.
# That is a separate change with a real diff, and picking one effort for a page
# whose job is teaching these axes is an editorial decision rather than a flag
# sweep. Do not "fix" this to match the pipeline without regenerating.
AV="--speed 6 --jobs 4 --ignore-icc --ignore-exif --ignore-xmp --yuv 420"
for q in 78 42 18; do avifenc -q $q $AV "$TMP/fmt.png" "$DEST/z-av$q.avif" >/dev/null 2>&1; done

# 2. chroma subsampling (mozjpeg, one quality so only the chroma sampling varies)
#
# Its OWN slice, because the shared crop above is black bodywork and a gray rim:
# nothing in it has colour, so the three samplings came out looking identical
# and 4:2:0 saved 10%. ch-branches.png is 96x96 of bare branches against red
# glass from XT508316, the night frame where 4:2:0 needs 35% more bytes to match
# 4:4:4 at tile scale (tools/photos/avif-chroma-probe.ts). It is committed rather
# than derived here because its source is a SOOC original that lives outside this
# repository, and the remote workflow runs this script without one. Recipe, from
# the 7728x5152 camera JPEG, through the same resampler that makes the tiles:
#
#   zenc frame XT508316.JPG --orient 8 --fit 900 --out tile.png   # 600x900
#   zenc frame tile.png --crop 480 490 96 96 --out ch-branches.png
#
# --fit 900 on the portrait frame puts the centre 600x600 at y=150, the same
# geometry as the shipped 600px tile, so the slice is tile pixels (480,340).
# q75 rather than the q40 this grid used on the old crop: at q40 quantization
# smears all three cells alike and the grid stops showing subsampling.
"$ZENC" frame "$DEST/ch-branches.png" --out "$TMP/ch.ppm" >/dev/null
"$MOZ_CJPEG" -quality 75 -sample 1x1 "$TMP/ch.ppm" > "$DEST/z-ch444.jpg" 2>/dev/null
"$MOZ_CJPEG" -quality 75 -sample 2x1 "$TMP/ch.ppm" > "$DEST/z-ch422.jpg" 2>/dev/null
"$MOZ_CJPEG" -quality 75 -sample 2x2 "$TMP/ch.ppm" > "$DEST/z-ch420.jpg" 2>/dev/null

# 3. jpeg encoders at the SAME quality setting (q72): baseline vs mozjpeg vs zenc
sips -s format jpeg --setProperty formatOptions 72 "$TMP/crop.png" --out "$DEST/z-enc-baseline.jpg" >/dev/null 2>&1
"$MOZ_CJPEG" -quality 72 "$TMP/crop.ppm" > "$DEST/z-enc-mozjpeg.jpg" 2>/dev/null
"$ZENC" "$TMP/crop.png" "$DEST/z-enc-zenc.jpg" -q 72 >/dev/null 2>&1

exif-sooc -all= -overwrite_original "$DEST"/z-*.jpg >/dev/null

echo "=== generated (96x96 crop) ==="
for f in "$DEST"/z-*; do printf "  %-22s %6s B\n" "$(basename "$f")" "$(sz "$f")"; done
