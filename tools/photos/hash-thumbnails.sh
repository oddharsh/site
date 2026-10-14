#!/usr/bin/env bash
# hash-thumbnails.sh — content-address the published thumbnails (migration
# duty 4, first run 2026-07-03) and keep them addressed on every photo add.
set -euo pipefail

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
PUBLIC_DIR="$( cd "$SCRIPT_DIR/../.." && pwd )/public"
SRC_DIR="$PUBLIC_DIR/images"
OUT_DIR="$PUBLIC_DIR/i"
MAP="$SRC_DIR/hashes.json"

mkdir -p "$OUT_DIR"

bun "$SCRIPT_DIR/pipeline-json.ts" hash-tiers "$SRC_DIR" --out-dir "$OUT_DIR" --map "$MAP"
