#!/usr/bin/env bash
# Source before image processing. exif-sooc 0.1.0 could truncate progressive
# JPEGs while stripping metadata, and before 0.3.0 -TagsFromFile dropped a
# HEIF's XMP item, which is where an X-T50 records an in-camera star rating;
# tools:check keeps this floor aligned with config/tools.json. A failed or
# malformed version probe must also refuse work.
set -euo pipefail

EXIF_SOOC_MIN=0.3.0
sooc_ver=$(exif-sooc --version 2>/dev/null) || sooc_ver=''
if [[ "$sooc_ver" =~ ^exif-sooc[[:space:]]([0-9]+\.[0-9]+\.[0-9]+)$ ]]; then
  sooc_ver="${BASH_REMATCH[1]}"
else
  sooc_ver=''
fi
if [ -z "$sooc_ver" ] || [ "$(printf '%s\n%s\n' "$EXIF_SOOC_MIN" "$sooc_ver" | sort -V | head -1)" != "$EXIF_SOOC_MIN" ]; then
  echo "error: exif-sooc ${sooc_ver:-not found or unreadable} is older than $EXIF_SOOC_MIN or could not be verified; refusing metadata writes." >&2
  echo "  update with: cargo install --git https://github.com/oddharsh/exif-sooc exif-sooc --force" >&2
  exit 1
fi
