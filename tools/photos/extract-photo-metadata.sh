#!/usr/bin/env bash
# extract-photo-metadata.sh — read EXIF from SOOC photo files or folders and
# emit /images/metadata.json keyed by R2 filename. the worker doesn't read
# EXIF itself (would require bundling a JS library); this script runs in the
# remote photo workflow once per upload batch.

set -euo pipefail

MERGE=0
if [ "${1:-}" = "--merge" ]; then
  MERGE=1
  shift
fi

if [ $# -eq 0 ]; then
  echo "usage: $0 [--merge] <source-file-or-dir>..." >&2
  exit 1
fi

SRC_DIR="$*"
for source in "$@"; do
  if [ ! -d "$source" ] && [ ! -f "$source" ]; then
    echo "error: source not found: $source" >&2
    exit 1
  fi
done

if ! command -v exif-sooc >/dev/null 2>&1; then
  echo "error: exif-sooc not found. install with:" >&2
  echo "  cargo install --git https://github.com/oddharsh/exif-sooc exif-sooc" >&2
  exit 1
fi
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
PUBLIC_DIR="$( cd "$SCRIPT_DIR/../.." && pwd )/public"
OUT="$PUBLIC_DIR/images/metadata.json"

ZENC_DIR="$(cd "$SCRIPT_DIR/zenc" && pwd)"
ZENC="$ZENC_DIR/target/release/zenc"
if [ ! -x "$ZENC" ]; then
  echo "building zenc (histogram bake) — first run only…" >&2
  cargo build --release --locked --manifest-path "$ZENC_DIR/Cargo.toml" >&2 || { echo "error: zenc build failed" >&2; exit 1; }
fi

if [ "$MERGE" -eq 1 ]; then
  exif-sooc --keyed --merge-into "$OUT" -q -r "$@" > "$OUT.tmp"
else
  exif-sooc --keyed -q -r "$@" > "$OUT.tmp"
fi

HASHES_JSON="$PUBLIC_DIR/images/hashes.json"
PJ="$SCRIPT_DIR/pipeline-json.ts"
read_count=$(bun "$PJ" length "$OUT.tmp")
if [ -s "$HASHES_JSON" ] && [ "$(bun "$PJ" length "$HASHES_JSON")" -gt 0 ]; then
  dropped=$(bun "$PJ" prune "$OUT.tmp" --published "$HASHES_JSON" --out "$OUT.pruned")
  kept_count=$(bun "$PJ" length "$OUT.pruned")

  if [ "$kept_count" -eq 0 ]; then
    rm -f "$OUT.tmp" "$OUT.pruned"
    echo "error: none of the $read_count photos read from $SRC_DIR are published." >&2
    echo "  metadata.json left untouched. is that the right source folder?" >&2
    exit 1
  fi
  mv "$OUT.pruned" "$OUT.tmp"

  if [ -n "$dropped" ]; then
    echo "  $((read_count - kept_count)) photo(s) here are not published; metadata scoped to the $kept_count that are:" >&2
    printf '%s\n' "$dropped" | sed 's/^/    /' >&2
  fi

  unread=$(bun "$PJ" unread "$HASHES_JSON" --against "$OUT.tmp")
  if [ -n "$unread" ]; then
    unread_count=$(printf '%s\n' "$unread" | wc -l | tr -d ' ')
    {
      echo "error: $unread_count published photo(s) have no source file in $SRC_DIR."
      printf '%s\n' "$unread" | sed -n '1,8s/^/    /p'
      [ "$unread_count" -gt 8 ] && echo "    (+$((unread_count - 8)) more)"
      echo "  a full regen REPLACES metadata.json, so writing this would delete their EXIF."
      echo "  point at the folder holding every published photo, or pass --merge to update just this batch."
    } >&2
    rm -f "$OUT.tmp"
    exit 1
  fi
else
  echo "  no hashes.json yet, so every photo read is kept; the prune needs a published set."
fi
mv "$OUT.tmp" "$OUT"

META_DIR="$PUBLIC_DIR/images/meta"
mkdir -p "$META_DIR"
if [ "$MERGE" -eq 0 ]; then
  rm -f "$META_DIR"/*.json
fi
bun "$PJ" meta-split "$OUT" --out-dir "$META_DIR"

# NOT piped into `tail -1`, matching the sibling call #566 unpiped. The status
# half of gotcha 40 was never open here, because this script has carried
# `set -euo pipefail` since before that PR and pipefail already hands the
# pipeline zenc's status over tail's. What the pipe cost was narrower and had
# no other cover: the per-stem warnings. Measured 2026-08-29 against a root
# whose hashes.json names a tile that is not on disk, both shapes exit 1 and
# stop the run, and only the unpiped one prints `warn: L1009919_2:
# L1009919_2.6e03d6df.jpg missing, skipped`. Piped, the run died on a summary
# reading "1 skipped" and named no stem.
"$ZENC" histogram --root "$PUBLIC_DIR"

bun "$SCRIPT_DIR/build-histogram-index.ts"

COUNT=$(bun "$PJ" length "$OUT")
if [ "$MERGE" -eq 1 ]; then
  echo "✓ merged metadata for $COUNT photos → $OUT (+ per-stem files in images/meta/, histograms baked)"
else
  echo "✓ extracted metadata for $COUNT photos → $OUT (+ $COUNT per-stem files in images/meta/, histograms baked)"
fi
echo "  next: bump META_V in tooltip.js if fields changed, commit + deploy."
