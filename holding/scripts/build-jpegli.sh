#!/usr/bin/env bash
# build-jpegli.sh — build cjpegli + djpegli from source and install to
# ~/.local/bin. jpegli is Google's psychovisually-tuned JPEG encoder, the
# active successor to mozjpeg. it produces ~25% smaller JPEGs than mozjpeg
# at indistinguishable visual quality. there's no Homebrew formula as of
# this writing, but the build is straightforward.
#
# this script is idempotent — pulls latest, configures, builds, copies.
# safe to re-run when jpegli upstream pushes a fix. about a 90-second
# build on an M-series Mac (one-shot first time; ninja's incremental
# afterwards).
#
# usage: ./holding/scripts/build-jpegli.sh
# requires: cmake, ninja, clang, git (cmake+ninja: brew install cmake ninja)

set -euo pipefail

SRC_DIR="$HOME/src/jpegli"
INSTALL_DIR="$HOME/.local/bin"

# preflight
for cmd in cmake ninja git clang; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "error: $cmd not found in PATH" >&2
    case "$cmd" in
      cmake|ninja) echo "  install with: brew install cmake ninja" >&2 ;;
    esac
    exit 1
  fi
done

mkdir -p "$(dirname "$SRC_DIR")" "$INSTALL_DIR"

# clone or pull
if [ -d "$SRC_DIR" ]; then
  echo "→ pulling latest jpegli into $SRC_DIR"
  git -C "$SRC_DIR" pull --quiet
else
  echo "→ cloning google/jpegli into $SRC_DIR"
  git clone --depth 1 https://github.com/google/jpegli.git "$SRC_DIR"
fi

# submodules (highway, brotli, libpng, zlib, etc.)
echo "→ updating submodules"
git -C "$SRC_DIR" submodule update --init --recursive --depth 1

# configure (Release, tools only)
BUILD_DIR="$SRC_DIR/build"
mkdir -p "$BUILD_DIR"
echo "→ configuring ($BUILD_DIR)"
( cd "$BUILD_DIR" && cmake -G Ninja \
    -DCMAKE_BUILD_TYPE=Release \
    -DBUILD_TESTING=OFF \
    -DJPEGLI_ENABLE_DEVTOOLS=OFF \
    -DJPEGLI_ENABLE_BENCHMARK=OFF \
    -DJPEGLI_ENABLE_MANPAGES=OFF \
    .. )

# build just the two CLIs we need
echo "→ building cjpegli + djpegli"
ninja -C "$BUILD_DIR" cjpegli djpegli

# install
cp "$BUILD_DIR/tools/cjpegli" "$INSTALL_DIR/"
cp "$BUILD_DIR/tools/djpegli" "$INSTALL_DIR/"

echo ""
echo "✓ installed:"
ls -la "$INSTALL_DIR/cjpegli" "$INSTALL_DIR/djpegli"
echo ""
echo "next: rerun ./holding/scripts/add-photos.sh on your source folder"
echo "      to re-encode existing thumbnails with the new encoder."
