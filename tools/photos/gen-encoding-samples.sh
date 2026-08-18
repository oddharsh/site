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
#   ./tools/photos/gen-encoding-samples.sh [STEM] [SRC_DIR_OR_FILE]
# With no source argument, the committed 400×266 PNG fixture is used, so the
# study can be regenerated remotely without the private SOOC archive.
#
set -euo pipefail

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
DEST="$( cd "$SCRIPT_DIR/.." && pwd )/garage/enc"
STEM="${1:-XT509338}"
SOURCE_ARG="${2:-$DEST/c-png.png}"
# zenc (zenjpeg hybrid trellis + progressive scan search) is the site's shipped
# JPEG encoder, so the study shows it as the JPEG point. Auto-built via cargo,
# like the pipeline scripts.
ZENC_DIR="$(cd "$SCRIPT_DIR/zenc" && pwd)"
ZENC="$ZENC_DIR/target/release/zenc"
if [ ! -x "$ZENC" ]; then
  command -v cargo >/dev/null 2>&1 || { echo "error: cargo (rust) not found; install from https://rustup.rs" >&2; exit 1; }
  cargo build --release --manifest-path "$ZENC_DIR/Cargo.toml" >&2 || { echo "error: zenc build failed" >&2; exit 1; }
fi
TMP="/tmp/enc-gen-$$"; mkdir -p "$TMP"; trap 'rm -rf "$TMP"' EXIT

src=""
if [ -f "$SOURCE_ARG" ]; then
  src="$SOURCE_ARG"
else
  SRC_DIR="$SOURCE_ARG"
  for e in HIF hif HEIC heic jpg JPG; do [ -f "$SRC_DIR/$STEM.$e" ] && src="$SRC_DIR/$STEM.$e" && break; done
fi
[ -n "$src" ] || { echo "no source for $STEM in $SOURCE_ARG" >&2; exit 1; }
for c in avifenc cwebp sips exif-sooc; do command -v "$c" >/dev/null 2>&1 || [ -x "$c" ] || { echo "missing: $c" >&2; exit 1; }; done

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
# zenc quality ladder; q84 is the shipped thumbnail setting (≈ old jpegli q82).
for q in 62 84 95; do "$ZENC" "$base" "$DEST/c-zc$q.jpg" -q "$q" >/dev/null 2>&1; done
exif-sooc -all= -overwrite_original "$DEST"/c-sips82.jpg "$DEST"/c-zc*.jpg >/dev/null 2>&1 || true

for q in 60 80; do cwebp -q "$q" "$base" -o "$DEST/c-wp$q.webp" >/dev/null 2>&1; done

AV="--speed 4 --jobs 4 --ignore-icc --ignore-exif --ignore-xmp"
avifenc -q 40 --yuv 420 $AV "$base" "$DEST/c-av40.avif" >/dev/null 2>&1
avifenc -q 63 --yuv 420 $AV "$base" "$DEST/c-av63.avif" >/dev/null 2>&1
avifenc -q 85 --yuv 420 $AV "$base" "$DEST/c-av85.avif" >/dev/null 2>&1
avifenc -q 63 --yuv 444 $AV "$base" "$DEST/c-av63-444.avif" >/dev/null 2>&1

echo ""; echo "COLOR set (${W}x${H}, ${PX}px):"
for f in c-png.png c-sips82.jpg c-zc62.jpg c-zc84.jpg c-zc95.jpg c-wp60.webp c-wp80.webp c-av40.avif c-av63.avif c-av85.avif c-av63-444.avif; do report "$DEST/$f"; done

# ── resolution table: avif q63 4:2:0 vs zenc q84 at 400 / 800 / 1200 ─────────
echo ""; echo "RESOLUTION table (avif q63 4:2:0  ·  zenc q84):"
for long in 400 800 1200; do
  case $long in 400) w=400 h=266;; 800) w=800 h=533;; 1200) w=1200 h=800;; esac
  b="$TMP/r$long.png"
  sips -s format png -Z "$long" "$src" --out "$TMP/rb.png" >/dev/null 2>&1
  sips -c "$h" "$w" "$TMP/rb.png" --out "$b" >/dev/null 2>&1
  avifenc -q 63 --yuv 420 $AV "$b" "$TMP/r$long.avif" >/dev/null 2>&1
  av=$(sz "$TMP/r$long.avif")
  "$ZENC" "$b" "$TMP/r$long.jpg" -q 84 >/dev/null 2>&1
  exif-sooc -all= -overwrite_original "$TMP/r$long.jpg" >/dev/null 2>&1 || true
  jl=$(sz "$TMP/r$long.jpg")
  save=$(awk -v a="$av" -v j="$jl" 'BEGIN{printf "%.0f", (1-a/j)*100}')
  printf "  %sx%s   AVIF %6s KB   zenc %6s KB   AVIF saves %s%%\n" "$w" "$h" "$(kb "$av")" "$(kb "$jl")" "$save"
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
echo ""; echo "done — update figcaptions/prose/table in www/garage/encoding.html to match."
