#!/usr/bin/env bash
#
# reencode-thumbnails.sh — re-encode ALL published grid thumbnails from the
# canonical source folder at a new resolution, in place.
set -euo pipefail

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
PROJECT_DIR="$( cd "$SCRIPT_DIR/../.." && pwd )"
DEST="$PROJECT_DIR/public/images"
SRC="${1:-/Users/aadharsh/Downloads/to post (from ssd)}"
SQ="${SQ:-600}"
SQ_SM="${SQ_SM:-400}"
SQ_XS="${SQ_XS:-200}"

TIERS="${TIERS:-sq,sm,xs}"
want() { case ",$TIERS," in *",$1,"*) return 0;; *) return 1;; esac; }
TMP="/tmp/aadhar-reencode-$$"
mkdir -p "$TMP"
trap 'rm -rf "$TMP"' EXIT

ZENC_DIR="$(cd "$(dirname "$0")/zenc" && pwd)"
ZENC="$ZENC_DIR/target/release/zenc"
ZENC_Q=84

for cmd in sips exif-sooc; do
  command -v "$cmd" >/dev/null 2>&1 || { echo "error: $cmd not in PATH" >&2; exit 1; }
done

source "$SCRIPT_DIR/require-exif-sooc.sh"
source "$SCRIPT_DIR/require-zenc.sh"
require_zenc_avif "$ZENC_DIR"
[ -d "$SRC" ]      || { echo "error: source folder not found: $SRC" >&2; exit 1; }
INPUTS="$TMP/inputs"
bun "$SCRIPT_DIR/photo-inputs.ts" rerender "$SRC" "$PROJECT_DIR/public/i" > "$INPUTS"
TOTAL=$(( $(tr -cd '\000' < "$INPUTS" | wc -c) / 4 ))
echo "re-encoding $TOTAL thumbnails as ${SQ}×${SQ} / ${SQ_SM}×${SQ_SM} center squares  (zenc q${ZENC_Q} + AVIF via libavif)"
echo "  source: $SRC"
echo ""

OK=0; MISS=0; FAIL=0
INTER="$TMP/inter"; mkdir -p "$INTER"
while IFS= read -r -d '' src && IFS= read -r -d '' original &&
      IFS= read -r -d '' full && IFS= read -r -d '' stem; do
  if [ -z "$src" ]; then MISS=$((MISS+1)); printf "?"; continue; fi

  tif="$INTER/${stem}.tif"

  input="$src"
  case "${src##*.}" in
    [Hh][Ii][Ff]|[Hh][Ee][Ii][Cc]|[Hh][Ee][Ii][Ff])
      if ! sips -s format tiff "$src" --out "$tif" >/dev/null 2>&1; then FAIL=$((FAIL+1)); printf "✗"; continue; fi
      input="$tif" ;;
  esac
  o=$(exif-sooc -s -s -s -n -Orientation "$src" 2>/dev/null) || o=""
  case "$o" in [1-8]) ;; *) o=1 ;; esac
  stage="$INTER/$stem"; mkdir -p "$stage"
  args=(square "$input" --orient "$o" --filter box --jpeg-quality "$ZENC_Q")
  outputs=()
  if want sq; then
    args+=(--size "$SQ" --avif-out "$stage/${stem}.avif" --jpeg-out "$stage/${stem}.jpg")
    outputs+=("$stage/${stem}.avif" "$stage/${stem}.jpg")
  fi
  if want sm; then
    args+=(--size "$SQ_SM" --avif-out "$stage/${stem}-${SQ_SM}.avif")
    outputs+=("$stage/${stem}-${SQ_SM}.avif")
  fi
  if want xs; then
    args+=(--size "$SQ_XS" --avif-out "$stage/${stem}-${SQ_XS}.avif")
    outputs+=("$stage/${stem}-${SQ_XS}.avif")
  fi
  if [ "${#outputs[@]}" -eq 0 ]; then
    echo "error: TIERS must select sq, sm, or xs" >&2; exit 1
  fi
  if ! "$ZENC" "${args[@]}"; then
    rm -f "$tif"; FAIL=$((FAIL+1)); printf "✗"; continue
  fi
  rm -f "$tif"
  if want sq && ! exif-sooc -all= -overwrite_original "$stage/${stem}.jpg" >/dev/null; then
    FAIL=$((FAIL+1)); printf "✗"; continue
  fi
  complete=1
  for file in "${outputs[@]}"; do [ -s "$file" ] || complete=0; done
  if [ "$complete" -ne 1 ] || ! mv "${outputs[@]}" "$DEST/"; then
    FAIL=$((FAIL+1)); printf "✗"; continue
  fi
  OK=$((OK+1)); printf "."
done < "$INPUTS"
echo ""
echo ""
echo "  re-encoded: $OK   source-missing: $MISS   failed: $FAIL"
if [ "$FAIL" -gt 0 ] || [ "$OK" -eq 0 ]; then
  echo "error: thumbnail re-encode incomplete; do not hash or publish these outputs" >&2
  exit 1
fi
echo "  next: re-run hash-thumbnails.sh (new bytes mint new /i/ URLs), then"
echo "  re-bake the histograms, then \`bun run derive:check\`, commit, and deploy."
echo "  the worker bundles photo-index.json + hashes.json, so the deploy IS the"
echo "  cache bust."
echo ""
echo "  the re-bake is not optional and is why gotcha 46 exists: this script is"
echo "  the standalone path, #394 took it, re-encoded 316 tiles, re-baked nothing,"
echo "  and images/histograms.json described pixels nobody was served for nine"
echo "  days. derive:check is what says so now, by name and per file."
