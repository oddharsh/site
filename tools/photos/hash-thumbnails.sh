#!/usr/bin/env bash
#
# hash-thumbnails.sh — content-address the published thumbnails (migration
# duty 4, first run 2026-07-03) and keep them addressed on every photo add.
#
# For every tier file in public/images/ (<stem>.avif, <stem>.jpg,
# <stem>-400.avif, <stem>-200.avif) this computes sha256, copies the bytes to
# public/i/<name-with-.hash8-before-ext>, and writes
# public/images/hashes.json ({stem: {a,j,s,x}}), which the photo pool in
# src/worker/photos.ts reads to bake /i/ URLs. A URL is born with its
# bytes, so the ?v=THUMB_VERSION global-bump class and the 4h edge-404
# poison class both die structurally; /images/<thumb> stays alive as a 301
# layer for old links.
#
# Idempotent: re-running only adds/refreshes entries whose bytes changed
# (a changed file gets a NEW hashed name, and the run prunes the /i/ file it
# superseded). The map is MERGED into the existing hashes.json, never rebuilt
# from scratch: an incremental add only stages the NEW stems in public/images/
# (the run deletes each source tier once it is hashed into public/i/), so a
# from-scratch rebuild would drop every prior stem from the map and the photo
# pool would skip those photos. Merging keeps the full 1:1 map across
# incremental adds.
#
#   ./tools/photos/hash-thumbnails.sh
#
set -euo pipefail

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
PUBLIC_DIR="$( cd "$SCRIPT_DIR/../.." && pwd )/public"
SRC_DIR="$PUBLIC_DIR/images"
OUT_DIR="$PUBLIC_DIR/i"
MAP="$SRC_DIR/hashes.json"

mkdir -p "$OUT_DIR"

# The addressing, the merge and the prune live in pipeline-json.ts hash-tiers,
# ported from a Python heredoc on 2026-09-22.
bun "$SCRIPT_DIR/pipeline-json.ts" hash-tiers "$SRC_DIR" --out-dir "$OUT_DIR" --map "$MAP"

# The short URL hash above is intentionally kept separate from the full-byte
# fingerprint the exact photo_recipe matcher uses. That full-byte map used to be
# built here into a committed images/fingerprints.json; build.ts step 1a derives
# it into .build/ now, from these same public/i bytes, so there is nothing left
# to run and nothing left that can go stale against a re-encode.
