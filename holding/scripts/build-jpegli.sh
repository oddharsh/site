#!/usr/bin/env bash
# build-jpegli.sh — build cjpegli + djpegli from source and install to
# ~/.local/bin. jpegli is Google's psychovisually-tuned JPEG encoder, the
# active successor to mozjpeg. it produces ~25% smaller JPEGs than mozjpeg
# at indistinguishable visual quality. there's no Homebrew formula as of
# this writing, but the build is straightforward.
#
# this script is idempotent — checks out the pinned upstream revision,
# configures, builds, and copies. Update JPEGLI_COMMIT deliberately when
# adopting a new encoder revision. About a 90-second
# build on an M-series Mac (one-shot first time; ninja's incremental
# afterwards).
#
# usage: ./holding/scripts/build-jpegli.sh
# requires: cmake, ninja, clang, git (cmake+ninja: brew install cmake ninja)

set -euo pipefail

SRC_DIR="$HOME/src/jpegli"
INSTALL_DIR="$HOME/.local/bin"
JPEGLI_COMMIT="${JPEGLI_COMMIT:-7cdf212790241868c77dca777dbee14e98128cba}"

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

# clone or fetch the pinned revision
if [ -e "$SRC_DIR" ] && [ ! -d "$SRC_DIR/.git" ]; then
  echo "error: $SRC_DIR exists but is not a git checkout" >&2
  exit 1
fi

if [ -d "$SRC_DIR/.git" ]; then
  if [ -n "$(git -C "$SRC_DIR" status --porcelain)" ]; then
    echo "error: refusing to change a dirty jpegli checkout: $SRC_DIR" >&2
    exit 1
  fi
  if ! git -C "$SRC_DIR" cat-file -e "$JPEGLI_COMMIT^{commit}" 2>/dev/null; then
    echo "→ fetching jpegli revision $JPEGLI_COMMIT"
    git -C "$SRC_DIR" fetch --quiet --depth 1 origin "$JPEGLI_COMMIT"
  fi
else
  echo "→ cloning google/jpegli for revision $JPEGLI_COMMIT"
  git clone --filter=blob:none --no-checkout https://github.com/google/jpegli.git "$SRC_DIR"
  git -C "$SRC_DIR" fetch --quiet --depth 1 origin "$JPEGLI_COMMIT"
fi

git -C "$SRC_DIR" checkout --quiet --detach "$JPEGLI_COMMIT"
echo "→ using jpegli $JPEGLI_COMMIT"

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
