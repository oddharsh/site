#!/usr/bin/env bash
#
# hash-thumbnails.sh — content-address the published thumbnails (migration
# duty 4, first run 2026-07-03) and keep them addressed on every photo add.
#
# For every tier file in public/images/ (<stem>.avif, <stem>.jpg,
# <stem>-400.avif) this computes sha256, copies the bytes to
# public/i/<name-with-.hash8-before-ext>, and writes
# public/images/hashes.json ({stem: {a,j,s}}), which buildImagesManifest
# reads to bake /i/ URLs into the photo manifest. A URL is born with its
# bytes, so the ?v=THUMB_VERSION global-bump class and the 4h edge-404
# poison class both die structurally; /images/<thumb> stays alive as a 301
# layer for old links.
#
# Idempotent: re-running only adds/refreshes entries whose bytes changed
# (a changed file gets a NEW hashed name; the old one is left for git rm).
# The map is MERGED into the existing hashes.json, never rebuilt from scratch:
# an incremental add only stages the NEW stems in public/images/ (the earlier
# tiers were git-rm'd after they were hashed into public/i/), so a from-scratch
# rebuild would drop every prior stem from the map and make buildImagesManifest
# skip those photos. Merging keeps the full 1:1 map across incremental adds.
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

# The addressing, the merge and the prune live in pipeline-json.ts hash-tiers
# since 2026-09-22. This was a Python heredoc until then, a week after the rest
# of the pipeline stopped spawning Python: the contract test that claimed the
# ban read a hand-kept list of three files, and this script was not on it.
bun "$SCRIPT_DIR/pipeline-json.ts" hash-tiers "$SRC_DIR" --out-dir "$OUT_DIR" --map "$MAP"

# The short URL hash above is intentionally kept separate from the full-byte
# fingerprint the exact photo_recipe matcher uses. That full-byte map used to be
# built here into a committed images/fingerprints.json; build.ts step 1a derives
# it into .build/ now, from these same public/i bytes, so there is nothing left
# to run and nothing left that can go stale against a re-encode.
