#!/usr/bin/env bash
#
# gen-encoding-samples.sh — regenerate the COLOR sample set for the
# /garage/encoding study from a single SOOC original, through every encoder the
# page compares. Prints real byte counts + bytes-per-pixel so the figcaptions and
# prose can be updated to match. The grayscale (g-*) set is generated separately
# from a Leica B&W frame and is NOT touched here.
#
# Subject must be a genuinely COLORFUL, detailed frame (the study is about color
# formats + chroma subsampling) — XT509338 (Porsche: red calipers, yellow car,
# blue accent, silver wheel, cobblestone) replaces the old near-monochrome tree.
#
#   ./holding/scripts/gen-encoding-samples.sh [STEM] [SRC_DIR_OR_FILE]
# With no source argument, the committed 400×266 PNG fixture is used, so the
# study can be regenerated remotely without the private SOOC archive.
#
set -euo pipefail

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
DEST="$( cd "$SCRIPT_DIR/.." && pwd )/garage/enc"
STEM="${1:-XT509338}"
SOURCE_ARG="${2:-$DEST/c-png.png}"
CJPEGLI="$HOME/.local/bin/cjpegli"
TMP="/tmp/enc-gen-$$"; mkdir -p "$TMP"; trap 'rm -rf "$TMP"' EXIT

src=""
if [ -f "$SOURCE_ARG" ]; then
  src="$SOURCE_ARG"
else
  SRC_DIR="$SOURCE_ARG"
  for e in HIF hif HEIC heic jpg JPG; do [ -f "$SRC_DIR/$STEM.$e" ] && src="$SRC_DIR/$STEM.$e" && break; done
fi
[ -n "$src" ] || { echo "no source for $STEM in $SOURCE_ARG" >&2; exit 1; }
for c in "$CJPEGLI" avifenc cwebp sips exiftool; do command -v "$c" >/dev/null 2>&1 || [ -x "$c" ] || { echo "missing: $c" >&2; exit 1; }; done

echo "source: $src"

# lossless PNG intermediate at exact 400x266 (3:2). every encoder reads this same
# base, so the comparison is apples-to-apples.
base="$TMP/base400.png"
sips -s format png -Z 400 "$src" --out "$TMP/b.png" >/dev/null 2>&1
sips -c 266 400 "$TMP/b.png" --out "$base" >/dev/null 2>&1

W=400; H=266; PX=$((W*H))
bpp() { awk -v b="$1" -v p="$PX" 'BEGIN{printf "%.2f", b/p}'; }
kb()  { awk -v b="$1" 'BEGIN{printf "%.1f", b/1024}'; }
sz()  { stat -f%z "$1"; }
report() { local f="$1" b; b=$(sz "$f"); printf "  %-18s %8s B   %6s KB   %s b/px\n" "$(basename "$f")" "$b" "$(kb "$b")" "$(bpp "$b")"; }

# ── color set ────────────────────────────────────────────────────────────────
cp "$base" "$DEST/c-png.png"                                                   # lossless baseline

sips -s format jpeg --setProperty formatOptions 82 "$base" --out "$DEST/c-sips82.jpg" >/dev/null 2>&1
for q in 60 82 95; do "$CJPEGLI" "$base" "$DEST/c-jl$q.jpg" -q "$q" -p 2 >/dev/null 2>&1; done
exiftool -all= -overwrite_original "$DEST"/c-sips82.jpg "$DEST"/c-jl*.jpg >/dev/null 2>&1 || true

for q in 60 80; do cwebp -q "$q" "$base" -o "$DEST/c-wp$q.webp" >/dev/null 2>&1; done

AV="--speed 4 --jobs 4 --ignore-icc --ignore-exif --ignore-xmp"
avifenc -q 40 --yuv 420 $AV "$base" "$DEST/c-av40.avif" >/dev/null 2>&1
avifenc -q 63 --yuv 420 $AV "$base" "$DEST/c-av63.avif" >/dev/null 2>&1
avifenc -q 85 --yuv 420 $AV "$base" "$DEST/c-av85.avif" >/dev/null 2>&1
avifenc -q 63 --yuv 444 $AV "$base" "$DEST/c-av63-444.avif" >/dev/null 2>&1

echo ""; echo "COLOR set (${W}x${H}, ${PX}px):"
for f in c-png.png c-sips82.jpg c-jl60.jpg c-jl82.jpg c-jl95.jpg c-wp60.webp c-wp80.webp c-av40.avif c-av63.avif c-av85.avif c-av63-444.avif; do report "$DEST/$f"; done

# ── resolution table: avif q63 4:2:0 vs jpegli q82 at 400 / 800 / 1200 ───────
echo ""; echo "RESOLUTION table (avif q63 4:2:0  ·  jpegli q82):"
for long in 400 800 1200; do
  case $long in 400) w=400 h=266;; 800) w=800 h=533;; 1200) w=1200 h=800;; esac
  b="$TMP/r$long.png"
  sips -s format png -Z "$long" "$src" --out "$TMP/rb.png" >/dev/null 2>&1
  sips -c "$h" "$w" "$TMP/rb.png" --out "$b" >/dev/null 2>&1
  avifenc -q 63 --yuv 420 $AV "$b" "$TMP/r$long.avif" >/dev/null 2>&1
  "$CJPEGLI" "$b" "$TMP/r$long.jpg" -q 82 -p 2 >/dev/null 2>&1
  exiftool -all= -overwrite_original "$TMP/r$long.jpg" >/dev/null 2>&1 || true
  av=$(sz "$TMP/r$long.avif"); jl=$(sz "$TMP/r$long.jpg")
  save=$(awk -v a="$av" -v j="$jl" 'BEGIN{printf "%.0f", (1-a/j)*100}')
  printf "  %sx%s   AVIF %6s KB   jpegli %6s KB   AVIF saves %s%%\n" "$w" "$h" "$(kb "$av")" "$(kb "$jl")" "$save"
done
echo ""; echo "done — update figcaptions/prose/table in holding/garage/encoding.html to match."
