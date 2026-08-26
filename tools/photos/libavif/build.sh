#!/usr/bin/env bash
# build.sh — build avifenc from PINNED SOURCE, with sharpyuv.
#
# WHY THIS EXISTS. The AVIF tier is the one most visitors actually get, and until
# now it was produced by whatever `brew install libavif` happened to put on one
# laptop. Two consequences, both bad:
#
#   1. `/i/` is content-addressed, so the encoder decides shipped URLs. A
#      `brew upgrade` could re-mint them silently, which is gotcha 41 waiting to
#      happen. config/tools.json carries a whole `recorded`-version tier to
#      DETECT that drift; a pinned build removes the drift instead.
#   2. Homebrew's libavif is built WITHOUT libsharpyuv, so `--sharpyuv` is
#      unavailable. Measured 2026-08-26: brew's avifenc exits 1 with "Conversion
#      to YUV failed" when the flag is passed. Its `--help` says "(if supported)",
#      so the flag reads as optional rather than absent.
#
# WHAT IT PRODUCES. libavif at the pinned tag below, built with aom, libsharpyuv
# and libyuv all LOCAL (libavif's own ext/*.cmd fetch and build each at ITS OWN
# pinned revision, which is why this script pins one tag and inherits three).
# libavif 1.4.2 pins aom v3.14.1, which is what brew was already giving us, so
# the encoder does not move.
#
# BYTE-IDENTICAL TO BREW at the pipeline's current settings, verified 2026-08-26
# on a real 600px square: q63 -d 10 --speed 4 --yuv 420 produced the same 26,594
# bytes from both binaries. That is the bar that matters here, because a single
# differing byte re-mints an `/i/` URL and orphans every a-dict snapshot naming
# the old hash. So adopting this changes nothing until somebody passes
# --sharpyuv, which is a separate, deliberate decision (see MAINTENANCE.md).
#
# NETWORK. libavif's ext scripts git-clone aom, libwebp and libyuv, so the first
# run needs network and about 10 minutes. Everything lands under src/ and build/,
# both gitignored: this vendors a BUILD, not 30 MB of C source in the repo.
#
#   ./build.sh            build if missing
#   ./build.sh --force    rebuild from scratch
set -euo pipefail

LIBAVIF_TAG="v1.4.2"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SRC="$SCRIPT_DIR/src"
OUT="$SCRIPT_DIR/build"
AVIFENC="$OUT/avifenc"

if [ "${1:-}" = "--force" ]; then rm -rf "$SRC" "$OUT"; fi

if [ -x "$AVIFENC" ]; then
  echo "avifenc already built: $AVIFENC"
  "$AVIFENC" --version | head -2
  exit 0
fi

for cmd in cmake ninja git; do
  command -v "$cmd" >/dev/null 2>&1 || {
    echo "error: $cmd not found (brew install cmake ninja)" >&2; exit 1; }
done

if [ ! -d "$SRC" ]; then
  echo "cloning libavif $LIBAVIF_TAG…" >&2
  git clone --depth 1 --branch "$LIBAVIF_TAG" \
    https://github.com/AOMediaCodec/libavif.git "$SRC" >&2
fi

# Each ext script clones and builds one dependency at libavif's own pinned rev.
# aom is the long one (a few minutes); the other two are quick.
cd "$SRC/ext"
[ -d aom/build.libavif ]  || { echo "building aom…"        >&2; bash aom.cmd        >&2; }
[ -d libwebp/build ]      || { echo "building libsharpyuv…" >&2; bash libsharpyuv.cmd >&2; }
[ -d libyuv/build ]       || { echo "building libyuv…"     >&2; bash libyuv.cmd     >&2; }

cd "$SRC"
cmake -G Ninja -S . -B "$OUT" \
  -DCMAKE_BUILD_TYPE=Release \
  -DBUILD_SHARED_LIBS=OFF \
  -DAVIF_CODEC_AOM=LOCAL \
  -DAVIF_LIBSHARPYUV=LOCAL \
  -DAVIF_LIBYUV=LOCAL \
  -DAVIF_BUILD_APPS=ON \
  -DAVIF_JPEG=SYSTEM \
  -DAVIF_ZLIBPNG=SYSTEM >&2
cmake --build "$OUT" --parallel >&2

# A build that produced a binary WITHOUT sharpyuv is the exact failure this
# script exists to prevent, and it is silent: the encoder still works, and every
# later --sharpyuv run just fails one photo at a time. Assert it here instead.
if ! "$AVIFENC" --help 2>&1 | grep -q -- "--sharpyuv"; then
  echo "error: built avifenc has no --sharpyuv; libsharpyuv did not link" >&2
  exit 1
fi

echo "built: $AVIFENC"
"$AVIFENC" --version | head -2
