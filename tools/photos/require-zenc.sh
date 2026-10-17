#!/usr/bin/env bash
# Sourced by grid ingest and rerender. An older binary must not silently keep
# the PNG/avifenc path after its source has acquired in-memory AVIF output.
set -euo pipefail

require_zenc_avif() {
  local directory="$1" binary="$1/target/release/zenc"
  for cmd in cargo pkg-config; do
      command -v "$cmd" >/dev/null 2>&1 || {
        echo "error: $cmd is required to build zenc (install Rust and brew install libavif pkgconf)" >&2; return 1;
      }
  done
  pkg-config --atleast-version=1.0.0 libavif || {
      echo "error: libavif development files >= 1.0 are required (brew install libavif)" >&2; return 1;
  }
  # Run even for an existing binary: Cargo checks sources, compiler and lock.
  (cd "$directory/../../.." && cargo build --release --locked \
    --manifest-path "$directory/Cargo.toml" --target-dir "$directory/target") >&2 || return 1
  # config/tools.json names this second version query zenc-avif: it records
  # the codec actually loaded, separately from the Rust/zenjpeg version.
  "$binary" --avif-version
}
