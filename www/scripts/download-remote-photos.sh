#!/usr/bin/env bash
# download-remote-photos.sh — fetch source images from the public R2-backed
# photo route for the GitHub-hosted photo pipeline.
#
# Input is one R2 object key per line. The special key "all" expands the
# current public manifest and is intended for full thumbnail re-encodes.
# Originals never enter the repository: this directory is disposable runner
# state.

set -euo pipefail

if [ "$#" -ne 2 ]; then
  echo "usage: $0 <keys-file> <destination-dir>" >&2
  exit 1
fi

KEYS_FILE="$1"
DEST_DIR="$2"
ORIGIN="${PHOTO_SOURCE_ORIGIN:-https://aadhar.sh}"

for cmd in curl jq exif-sooc; do
  command -v "$cmd" >/dev/null 2>&1 || {
    echo "error: $cmd not found in PATH" >&2
    exit 1
  }
done

[ -f "$KEYS_FILE" ] || { echo "error: keys file not found: $KEYS_FILE" >&2; exit 1; }
mkdir -p "$DEST_DIR"

NORMALIZED="$(mktemp)"
STEMS_FILE="$(mktemp)"
trap 'rm -f "$NORMALIZED" "$STEMS_FILE"' EXIT

if grep -Eq '^[[:space:]]*all[[:space:]]*$' "$KEYS_FILE"; then
  if grep -Ev '^[[:space:]]*(all)?[[:space:]]*$' "$KEYS_FILE" | grep -q .; then
    echo "error: all must be the only source-key entry" >&2
    exit 1
  fi
  curl --fail --silent --show-error --location --retry 3 --retry-all-errors \
    "${ORIGIN%/}/images/manifest.json" |
    jq -r '.photos[]?.full' > "$NORMALIZED"
else
  sed 's/\r$//' "$KEYS_FILE" |
    awk 'NF { sub(/^[[:space:]]+/, ""); sub(/[[:space:]]+$/, ""); print }' > "$NORMALIZED"
fi

count=0
while IFS= read -r key || [ -n "$key" ]; do
  [ -n "$key" ] || continue

  # The current R2 photo contract is flat filenames. Keep workflow input
  # from becoming a path or URL injection surface.
  if [[ ! "$key" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]]; then
    echo "error: invalid flat photo key: $key" >&2
    exit 1
  fi

  stem="${key%.*}"
  if grep -Fqx -- "$stem" "$STEMS_FILE"; then
    echo "error: multiple source objects for stem $stem; choose one key" >&2
    exit 1
  fi
  printf '%s\n' "$stem" >> "$STEMS_FILE"

  encoded="$(jq -nr --arg key "$key" '$key | @uri')"
  output="$DEST_DIR/$key"
  echo "fetching $key"
  curl --fail --silent --show-error --location --retry 3 --retry-all-errors \
    --connect-timeout 20 \
    "${ORIGIN%/}/images/full/$encoded" \
    --output "$output"

  if [ ! -s "$output" ] ||
     ! exif-sooc -q -s3 -ImageWidth -ImageHeight "$output" | grep -Eq '[0-9]'; then
    echo "error: downloaded object is not a readable image: $key" >&2
    exit 1
  fi
  count=$((count + 1))
done < "$NORMALIZED"

[ "$count" -gt 0 ] || { echo "error: no source images selected" >&2; exit 1; }
echo "downloaded $count source image(s) into $DEST_DIR"
