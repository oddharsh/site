#!/usr/bin/env bash
# download-remote-photos.sh — fetch source images from the public R2-backed
# photo route for the GitHub-hosted photo pipeline.
#
# Input is one R2 object key per line. The special key "all" expands the
# current public manifest and is intended for full thumbnail re-encodes.
# Originals never enter the repository: this directory is disposable runner
# state.

set -euo pipefail
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"

if [ "$#" -ne 2 ]; then
  echo "usage: $0 <keys-file> <destination-dir>" >&2
  exit 1
fi

KEYS_FILE="$1"
DEST_DIR="$2"
ORIGIN="${PHOTO_SOURCE_ORIGIN:-https://aadhar.sh}"

for cmd in curl exif-sooc; do
  command -v "$cmd" >/dev/null 2>&1 || {
    echo "error: $cmd not found in PATH" >&2
    exit 1
  }
done

[ -f "$KEYS_FILE" ] || { echo "error: keys file not found: $KEYS_FILE" >&2; exit 1; }
mkdir -p "$DEST_DIR"
# Beside the destination, never inside it: see the JPEG XL note below.
R2_DIR="${DEST_DIR%/}.r2"

NORMALIZED="$(mktemp)"
STEMS_FILE="$(mktemp)"
trap 'rm -f "$NORMALIZED" "$STEMS_FILE"' EXIT

if grep -Eq '^[[:space:]]*all[[:space:]]*$' "$KEYS_FILE"; then
  if grep -Evq '^[[:space:]]*(all)?[[:space:]]*$' "$KEYS_FILE"; then
    echo "error: all must be the only source-key entry" >&2
    exit 1
  fi
  curl --fail --silent --show-error --location --retry 3 --retry-all-errors \
    "${ORIGIN%/}/images/manifest.json" |
    bun "$SCRIPT_DIR/pipeline-json.ts" manifest-keys - > "$NORMALIZED"
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

  encoded="$(bun "$SCRIPT_DIR/pipeline-json.ts" uri "$key")"
  output="$DEST_DIR/$key"
  echo "fetching $key"
  curl --fail --silent --show-error --location --retry 3 --retry-all-errors \
    --connect-timeout 20 \
    "${ORIGIN%/}/images/full/$encoded" \
    --output "$output"

  # Every original is JPEG XL, in one of two kinds (pipeline-json.ts jxl-kind
  # reads which from its boxes; djxl cannot, because asked for a .jpg it
  # rebuilds a transcode and silently ENCODES a fresh JPEG from anything else):
  #
  #   transcode  a JPEG losslessly repacked. djxl gives back that JPEG byte for
  #              byte, so every tool downstream reads it as before: zenc
  #              rebuilds identical tiers, exif-sooc the same metadata. The
  #              .jxl moves to $R2_DIR, OUTSIDE the scanned folder: its
  #              metadata is Brotli-compressed, and exif-sooc 0.4.0, which reads
  #              JPEG XL, would otherwise read the photo twice and fail once.
  #   direct     encoded from a HIF's pixels (hif-archive.ts), so there is no
  #              JPEG to give back. djxl decodes it to a 16-bit PNG for zenc,
  #              orientation applied, and the .jxl stays in the folder as the
  #              metadata source: it carries the HIF's EXIF, uncompressed.
  #
  # photo-inputs.ts finds the .jxl in either place for the R2 key and size an
  # index entry records.
  pixels="$output"
  case "$key" in
    *.jxl)
      command -v djxl >/dev/null 2>&1 || { echo "error: djxl not found (brew install jpeg-xl)" >&2; exit 1; }
      kind="$(bun "$SCRIPT_DIR/pipeline-json.ts" jxl-kind "$output")" || { echo "error: $key is not a readable JPEG XL" >&2; exit 1; }
      if [ "$kind" = transcode ]; then
        pixels="$DEST_DIR/$stem.jpg"
        if ! djxl "$output" "$pixels" >/dev/null 2>&1; then
          echo "error: could not rebuild the JPEG inside $key" >&2
          exit 1
        fi
        mkdir -p "$R2_DIR"
        mv "$output" "$R2_DIR/$key"
        output="$R2_DIR/$key"
      else
        if ! djxl "$output" "$DEST_DIR/$stem.png" --bits_per_sample=16 >/dev/null 2>&1; then
          echo "error: could not decode $key" >&2
          exit 1
        fi
        # the metadata lives in the .jxl; the PNG carries pixels only
        pixels="$output"
      fi ;;
  esac

  if [ ! -s "$output" ] ||
     ! exif-sooc -q -s3 -ImageWidth -ImageHeight "$pixels" | grep -Eq '[0-9]'; then
    echo "error: downloaded object is not a readable image: $key" >&2
    exit 1
  fi
  count=$((count + 1))
done < "$NORMALIZED"

[ "$count" -gt 0 ] || { echo "error: no source images selected" >&2; exit 1; }
echo "downloaded $count source image(s) into $DEST_DIR"
