#!/usr/bin/env bash
# add-photos.sh — process one or more SOOC photos into the site.

# pipefail is load-bearing here rather than housekeeping, and gotcha 40 is the
# bill for its absence. Three steps below run a tool into `| tail -1` to keep
# the summary and drop the chatter, and a pipeline's status is its LAST
# command's, so `tail` reported 0 over every one of them. `zenc histogram`
# returning 2 on an unreadable hashes.json read as success for five days, which
# is how a re-encode shipped 316 thumbnails whose histograms were never re-baked.
# Measured 2026-08-24: the same call is 0 piped, 2 piped under pipefail.
#
# -u is the same consistency the other 9 committed scripts already have. It cost
# one real fix to adopt: `"${META_MODE[@]}"` on an EMPTY array is an unbound
# variable on bash 3.2, which is the bash macOS ships and therefore the one
# `#!/usr/bin/env bash` finds here. See the expansion at the metadata regen.
set -euo pipefail

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
PROJECT_DIR="$( cd "$SCRIPT_DIR/../.." && pwd )"

# The R2 uploads below go through the REPO'S PINNED wrangler, never whatever is
# on PATH. This script used to require a bare `wrangler`, which meant the binary
# writing to the photo bucket was whichever one happened to be installed
# globally: measured 2026-08-14, an `npm i -g wrangler` from June was answering
# 4.105.0 on this workstation against a repo pin of 4.120.x. Same class as
# gotcha 29's npx finding, one layer up, and it would not have surfaced until a
# photo run. `check-wrangler` enforces one version across the Worker projects
# and could not see this, because a shell script is not a package.json.
WRANGLER="$PROJECT_DIR/node_modules/.bin/wrangler"
DEST="$PROJECT_DIR/public/images"
TMP="/tmp/aadhar-add-photos-$$"

# JOBS=1 costs 1% against the serial original, which is the control that says the
# restructuring below is free: the win is concurrency and not a quiet change to
# what the encoders are asked to do. All 48 output tiers came back byte-identical
# at every JOBS value on both boxes, which is the bar that matters here, since
# `/i/` is content-addressed and one moved byte re-mints the URL and orphans the
# baked histogram behind it (gotcha 46). That is also why avifenc's own `--jobs`
# is untouched: measured 2026-08-31, `--jobs 1` and `--jobs 2` disagree on the
# bytes (17,389 against 17,347 on one 600px tile), with everything from 2 up
# identical, so the thread count is baked into the encode and stealing threads
# back from avifenc to widen this knob would re-encode the whole library.
JOBS="${JOBS:-8}"
ALBUM="${ALBUM:-}"
HEIF="${HEIF:-0}"
case "$ALBUM" in
  ""|[a-z0-9]*) ;;
  *) echo "error: ALBUM must be a lowercase slug (got '$ALBUM')" >&2; exit 1 ;;
esac

st_init() { ST_ROOT="$1"; rm -rf "$ST_ROOT"; mkdir -p "$ST_ROOT/ok" "$ST_ROOT/skip" "$ST_ROOT/fail" "$ST_ROOT/na"; }
mark()    { : > "$ST_ROOT/$1/$2"; }
tally()   { ls -1 "$ST_ROOT/$1" 2>/dev/null | wc -l | tr -d ' '; }

reconcile() {
  local seen expected
  seen=$(( $(tally ok) + $(tally skip) + $(tally fail) + $(tally na) ))
  expected=$(cat "$ST_ROOT/launched")
  if [ "$seen" -ne "$expected" ] || [ "$(tally fail)" -gt 0 ]; then
    echo "error: $1 incomplete: $seen of $expected outcomes, $(tally fail) failed; stopping before later phases" >&2
    exit 1
  fi
}

# All phases read the same resolved inputs. NUL fields preserve filenames;
# the fixed batch waits also work on macOS's Bash 3.2 (which has no wait -n).
read_input() {
  IFS= read -r -d '' f && IFS= read -r -d '' original &&
    IFS= read -r -d '' full && IFS= read -r -d '' stem
}
run_parallel() {
  local fn="$1" limit="${2:-$JOBS}" pending=0 idx=0 f original full stem
  while read_input; do
    idx=$((idx+1))
    ( "$fn" "$f" "$idx" "$original" "$full" "$stem" ) &
    pending=$((pending+1))
    if [ "$pending" -ge "$limit" ]; then wait; pending=0; fi
  done < "$INPUTS"
  wait
  echo "$idx" > "$ST_ROOT/launched"
}

SQ="${SQ:-600}"
SQ_SM="${SQ_SM:-400}"
SQ_XS="${SQ_XS:-200}"

if [ $# -eq 0 ]; then
  echo "usage: $0 <file-or-dir>..." >&2
  exit 1
fi
# zenc (tools/photos/zenc) is the JPEG encoder: a zenjpeg wrapper running
# hybrid trellis + progressive scan search, ~4% smaller than the retired cjpegli
# at equal quality (see /garage/encoding). It builds from source with cargo, so
# any machine with rust runs this pipeline; dependabot tracks the zenjpeg pin.
# q84 is calibrated to match the old cjpegli q82 quality at fewer bytes. mozjpeg's
# jpegtran survives ONLY for phase 2's progressive rearrangement of the R2 copies
# (every archive, HIF re-encode or JPG original), which reorders coefficients and
# has no alignment constraint. It did the EXIF-orientation rotation until
# 2026-08-26; that is `zenc square --orient` now, for the reason CLAUDE.md
# gotcha 3 measures.
ZENC_DIR="$(cd "$(dirname "$0")/zenc" && pwd)"
ZENC="$ZENC_DIR/target/release/zenc"
ZENC_Q=84
MOZJPEG_DIR="$(brew --prefix mozjpeg)/bin"
MOZ_JTRAN="$MOZJPEG_DIR/jpegtran"

if [ ! -x "$WRANGLER" ]; then
  echo "error: pinned wrangler not found at $WRANGLER" >&2
  echo "  run: pnpm install" >&2
  exit 1
fi
# cjxl and djxl make and check each original's JPEG XL upload in phase 3, and
# for a HIF hif-archive.ts also scores it against djxl's decode of the bar.
# Its two metrics come from tools/photos/photo-metrics, which it builds with
# the cargo require-zenc.sh already demands, so libjxl's ssimulacra2 and
# butteraugli_main are no longer needed here. A remote render skips phase 3,
# so only an uploading run needs these.
NEEDED=(sips exif-sooc)
[ "${REMOTE_RENDER_ONLY:-0}" = "1" ] || NEEDED+=(cjxl djxl)
for cmd in "${NEEDED[@]}"; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "error: $cmd not found in PATH" >&2
    case "$cmd" in
      exif-sooc) echo "  install with: cargo install --git https://github.com/oddharsh/exif-sooc exif-sooc" >&2 ;;
      cjxl|djxl) echo "  install with: brew install jpeg-xl" >&2 ;;
    esac
    exit 1
  fi
done

source "$SCRIPT_DIR/require-exif-sooc.sh"
source "$SCRIPT_DIR/require-zenc.sh"
require_zenc_avif "$ZENC_DIR"

if [ ! -x "$MOZ_JTRAN" ]; then
  echo "error: jpegtran not installed at $MOZJPEG_DIR" >&2
  echo "  install with: brew install mozjpeg" >&2
  exit 1
fi
mkdir -p "$DEST" "$TMP"
trap 'rm -rf "$TMP"' EXIT

INPUTS="$TMP/inputs"
bun "$SCRIPT_DIR/photo-inputs.ts" ingest "$@" > "$INPUTS"
TOTAL=$(( $(tr -cd '\000' < "$INPUTS" | wc -c) / 4 ))
echo "found $TOTAL photo(s) to process"
echo ""

echo "phase 1 — square thumbnails (${SQ}×${SQ} / ${SQ_SM}×${SQ_SM}, zenc q84 + AVIF via libavif, metadata-stripped, parallel $JOBS)"
INTER="$TMP/inter"; mkdir -p "$INTER"
st_init "$TMP/status1"
thumb_one() {
  local f="$1" idx="$2"
  local base stem jpg avif smavif xsavif tif input o file current stage
  base=$(basename "$f"); stem="${base%.*}"
  current=1
  for file in "$DEST/$stem.jpg" "$DEST/$stem.avif" "$DEST/$stem-${SQ_SM}.avif" "$DEST/$stem-${SQ_XS}.avif"; do
    if [ ! -s "$file" ] || [ ! "$file" -nt "$f" ]; then current=0; break; fi
  done
  if [ "$current" -eq 1 ]; then
    mark skip "$idx"; printf "·"; return
  fi
  stage="$INTER/$idx"; mkdir -p "$stage"
  jpg="$stage/${stem}.jpg"; avif="$stage/${stem}.avif"
  smavif="$stage/${stem}-${SQ_SM}.avif"; xsavif="$stage/${stem}-${SQ_XS}.avif"
  tif="$INTER/${stem}.tif"

  input="$f"
  case "${f##*.}" in
    [Hh][Ii][Ff]|[Hh][Ee][Ii][Cc]|[Hh][Ee][Ii][Ff])
      if ! sips -s format tiff "$f" --out "$tif" >/dev/null 2>&1; then mark fail "$idx"; printf "✗"; return; fi
      input="$tif" ;;
  esac
  o=$(exif-sooc -s -s -s -n -Orientation "$f" 2>/dev/null) || o=""
  case "$o" in [1-8]) ;; *) o=1 ;; esac
  if ! "$ZENC" square "$input" --orient "$o" --filter box \
      --size "$SQ" --avif-out "$avif" --jpeg-out "$jpg" --jpeg-quality "$ZENC_Q" \
      --size "$SQ_SM" --avif-out "$smavif" --size "$SQ_XS" --avif-out "$xsavif" >/dev/null 2>&1; then
    rm -f "$tif"; mark fail "$idx"; printf "✗"; return
  fi
  # `-s formatOptions lzw` is NOT the way to shrink that, and it reads like it
  # should be: `sips -H` documents `[lzw|packbits]` for TIFF. Measured 2026-08-27
  # on sips-316, the bare and lzw writes are BYTE-IDENTICAL at 326,474,696 B and
  # the result reports `formatOptions: default`. Two controls say the property
  # itself works and the BIT DEPTH is what it will not do: on an 8-bit source lzw
  # takes a 587,544 B TIFF to 320,258 B (packbits does nothing there either), and
  # on JPEG output low/normal/best give 29,264/57,595/397,722 B. Timing is a wash,
  # 473-695ms bare against 450-752ms lzw over 5 alternating trials, and zenc's
  # three tiers plus the q84 encode are byte-identical from either TIFF. A bogus
  # value is accepted silently too, so nothing errors in any direction. Dropping
  # to 8 bits to buy the compression is the thing this door exists to avoid.
  rm -f "$tif"
  if ! exif-sooc -all= -overwrite_original "$jpg" >/dev/null; then mark fail "$idx"; printf "✗"; return; fi
  for file in "$jpg" "$avif" "$smavif" "$xsavif"; do
    if [ ! -s "$file" ]; then mark fail "$idx"; printf "✗"; return; fi
  done
  if ! mv "$jpg" "$avif" "$smavif" "$xsavif" "$DEST/"; then mark fail "$idx"; printf "✗"; return; fi
  mark ok "$idx"; printf "."
}
run_parallel thumb_one
echo ""
echo "  generated: $(tally ok)  skipped (current): $(tally skip)  failed: $(tally fail)"
reconcile "phase 1"
echo ""

echo "phase 2 — full-resolution JPEGs (parallel $JOBS)"
FULLS="$TMP/full-resolution"; RECEIPTS="$TMP/full-paths"; HEIF_RECEIPTS="$TMP/heif-keys"
JXLS="$TMP/jxl-originals"; JXL_RECEIPTS="$TMP/jxl-paths"
mkdir -p "$FULLS" "$RECEIPTS" "$HEIF_RECEIPTS" "$JXLS" "$JXL_RECEIPTS"
st_init "$TMP/status2"
prepare_one() {
  local f="$1" idx="$2" original="$3" full="$4" stem="$5" out tmppng
  out="$FULLS/$full"
  if [ -n "$original" ]; then
    if [ "${REMOTE_RENDER_ONLY:-0}" = "1" ]; then
      out="$original"
    elif ! "$MOZ_JTRAN" -progressive -copy all -outfile "$out" "$original" 2>/dev/null || [ ! -s "$out" ]; then
      rm -f "$out"
      out="$original"
    fi
  else
    # jpegtran then rewrites zenc's scan script, losslessly, into one that opens
    # with every channel's DC in a single interleaved scan. zenc's search keeps
    # whichever of two scripts is smaller, and one of them sends ALL of luma before
    # any chroma; Chromium paints nothing until every channel has begun a scan, so
    # 53 of the first 207 HIF archives stayed blank until 66-99% of a ~20 MB
    # download. After this pass the first paint lands ~5 KB in (0.02% of the
    # file). Measured on all 207 HIF archives when they were rewritten the same
    # way: +0.17% bytes in total, -0.70% to +0.98% per file, coefficients
    # identical on every one. The files zenc had made luma-first came out 0.11%
    # smaller; the ones it had made DC-first came out 0.27% larger, which buys
    # a first paint ~800 KB sooner. Unlike the JPG branch
    # above, a failure here fails the photo: falling back to zenc's own file
    # would quietly ship the blank-until-done order again. /garage/encoding.
    tmppng="$FULLS/${stem}.decode.png"; tmpjpg="$FULLS/${stem}.zenc.jpg"
    if ! sips -s format png "$f" --out "$tmppng" >/dev/null 2>&1 \
       || ! "$ZENC" "$tmppng" "$tmpjpg" -q 100 --yuv 422 >/dev/null 2>&1 \
       || ! "$MOZ_JTRAN" -copy all -progressive -outfile "$out" "$tmpjpg" 2>/dev/null \
       || ! exif-sooc -TagsFromFile "$f" -all:all -overwrite_original "$out" >/dev/null 2>&1; then
      rm -f "$tmppng" "$tmpjpg" "$out"; mark fail "$idx"; printf "✗"; return
    fi
    rm -f "$tmppng" "$tmpjpg"
  fi
  if [ ! -s "$out" ]; then mark fail "$idx"; printf "✗"; return; fi
  printf '%s' "$out" > "$RECEIPTS/$idx"
  mark ok "$idx"; printf "."
}
run_parallel prepare_one
echo ""
echo "  prepared: $(tally ok)  failed: $(tally fail)"
reconcile "phase 2"
echo ""

if [ "${REMOTE_RENDER_ONLY:-0}" = "1" ]; then
  echo "phase 3 — R2 uploads skipped (source is already remote)"
else
  echo "phase 3 — R2 uploads (parallel 4)"
  upload_one() {
    local f="$1" idx="$2" full="$4" send heif jxl jxlfile
    send=$(cat "$RECEIPTS/$idx")
    #   a HIF source: JPEG XL encoded from the HIF's own 10-bit pixels by
    #   hif-archive.ts, at the largest distance that still beats the JPEG
    #   prepared above on both ssimulacra2 and butteraugli. That JPEG is only
    #   the bar now, decoded as a browser decodes its repack. Re-measured on
    #   118 HIF photos (2026-10-14), 99 shrink and the total is -8.6%; where
    #   nothing beats the bar, or only a larger file does, hif-archive.ts
    #   falls back to the lossless transcode. About four minutes a photo.
    jxl="${full%.*}.jxl"; jxlfile="$JXLS/$jxl"
    case "${f##*.}" in
      [Hh][Ii][Ff]|[Hh][Ee][Ii][Cc]|[Hh][Ee][Ii][Ff])
        made=$(bun "$SCRIPT_DIR/hif-archive.ts" "$f" "$send" "$jxlfile" 2>>"$TMP/hif-archive.log") || made="" ;;
      *)
        made=""
        if cjxl --quiet --lossless_jpeg=1 -e 9 "$send" "$jxlfile" >/dev/null 2>&1 \
           && djxl "$jxlfile" "$jxlfile.rebuilt.jpg" >/dev/null 2>&1 \
           && cmp -s "$send" "$jxlfile.rebuilt.jpg"; then made=transcode; fi
        rm -f "$jxlfile.rebuilt.jpg" ;;
    esac
    if [ -z "$made" ] || [ ! -s "$jxlfile" ] \
       || ! "$WRANGLER" r2 object put "aadhar-photos/$jxl" --file="$jxlfile" --content-type="image/jxl" --remote >/dev/null 2>&1; then
      rm -f "$jxlfile"
      mark fail "$idx"; printf "✗"
      echo "error: JPEG XL original failed (encode, exact rebuild, or upload): aadhar-photos/$jxl" >&2
      [ ! -s "$TMP/hif-archive.log" ] || tail -n 3 "$TMP/hif-archive.log" >&2
      return
    fi
    printf '%s' "$jxlfile" > "$JXL_RECEIPTS/$idx"
    if [ "$HEIF" = "1" ]; then
      case "${f##*.}" in
        [Hh][Ii][Ff]|[Hh][Ee][Ii][Cc]|[Hh][Ee][Ii][Ff])
          heif=$(basename "$f")
          if ! "$WRANGLER" r2 object put "aadhar-photos/$heif" --file="$f" --content-type="image/heif" --remote >/dev/null 2>&1; then
            mark fail "$idx"; printf "✗"
            echo "error: R2 upload failed: aadhar-photos/$heif" >&2
            return
          fi
          printf '%s' "$heif" > "$HEIF_RECEIPTS/$idx" ;;
      esac
    fi
    mark ok "$idx"; printf "."
  }
  st_init "$TMP/status3"
  run_parallel upload_one 4
  echo ""
  echo "  uploaded: $(tally ok)  failed: $(tally fail)"
  reconcile "phase 3"
fi
echo ""

echo "phase 4 — hash tiers + photo index + metadata regen"
"$SCRIPT_DIR/hash-thumbnails.sh" 2>&1 | tail -1

INDEX_FILE="$PROJECT_DIR/src/worker/photo-index.json"
NOW_ISO="$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"
NEW_ENTRIES="$TMP/index-entries.spool"
: > "$NEW_ENTRIES"
[ -f "$INDEX_FILE" ] || echo '{}' > "$INDEX_FILE"
idx=0
META_SOURCES=()
while read_input; do
  idx=$((idx+1))
  obj=$(cat "$RECEIPTS/$idx")
  if [ -s "$JXL_RECEIPTS/$idx" ]; then obj=$(cat "$JXL_RECEIPTS/$idx"); full="${full%.*}.jxl"; fi
  size=$(wc -c < "$obj" | tr -d '[:space:]')
  heif=""; [ -s "$HEIF_RECEIPTS/$idx" ] && heif=$(cat "$HEIF_RECEIPTS/$idx")
  printf '%s\0%s\0%s\0%s\0%s\0' "$stem" "$full" "$size" "$ALBUM" "$heif" >> "$NEW_ENTRIES"
  META_SOURCES+=("$f")
done < "$INPUTS"
bun "$SCRIPT_DIR/pipeline-json.ts" index-merge "$INDEX_FILE" --entries "$NEW_ENTRIES" --now "$NOW_ISO"
echo "  photo index: $(bun "$SCRIPT_DIR/pipeline-json.ts" length "$INDEX_FILE") entries"
"$SCRIPT_DIR/extract-photo-metadata.sh" --merge "${META_SOURCES[@]}" | tail -1

# caption anything still missing alt text. runs AFTER hash-thumbnails.sh because
# it reads the committed public/i/ square via hashes.json and posts those exact
# bytes to Workers AI — no round trip to production, so a photo added seconds ago
# gets captioned here rather than waiting for a deploy. resumable and idempotent:
# already-captioned stems cost nothing. a 429 (the free 10k neurons/day) stops it
# early, which is why the failure is tolerated here and the real gate is
# check-photo-pipeline.ts below.
# bun rather than python3 since 2026-09-15: the captioner was the last thing
# here that ran under an interpreter the rest of this script does not already
# need (photo-inputs, the histogram index, semantics and the pipeline check all
# run under the tree's own runtime), and gotcha 40's ninth site is what a Python
# file outside the shell sweep cost.
bun "$SCRIPT_DIR/gen-alt-text.ts" || \
  echo "  captions incomplete — re-run 'bun run captions' before deploying"

# retrieval terms for every stem, and the ONE stem-keyed artifact this script has
# never regenerated. The other five reach it: hashes and fingerprints through
# hash-thumbnails.sh, histograms through extract-photo-metadata.sh plus the zenc
# bake, alt text through the block above. #609's `covers` verdict found
# semantics.json at 158 of 165 and repaired the generator, which had been joining
# a deleted www/ for a week (gotcha 40). That fixed the producer and left the hole
# that let seven photos drift out of it, so the next add would open it again.
bun "$PROJECT_DIR/tools/photos/gen-photo-semantics.ts"

bun "$PROJECT_DIR/tools/photos/check-photo-pipeline.ts"
echo ""

echo "✓ photo artifacts generated. Review them and their derivation locks in a PR."
echo "  release through the site promotion and ramp; see docs/MAINTENANCE.md."
