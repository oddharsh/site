#!/usr/bin/env bash
# add-photos.sh — process one or more SOOC photos into the site.
#
# per source file, this script:
#   1. generates the grid thumbnails at public/images/<stem>.{jpg,avif} +
#      <stem>-<SQ_SM>.avif — PRE-CROPPED CENTER SQUARES (what the grid shows:
#      aspect-ratio:1 + object-fit:cover), metadata-stripped. mirrors
#      reencode-thumbnails.sh exactly (keep the two encode paths in sync).
#      One `zenc square` decodes the source once, orients it, and writes all
#      three tiers from that same linear-light frame, so each output is ONE
#      JPEG encode away from the source rather than three, and the 400 and 200
#      tiers are no longer resamples of the 600.
#   2. prepares the browser-renderable full-resolution JPEG. An existing JPEG
#      (the requested source or a HEIF's same-folder companion) is rearranged
#      to progressive with lossless jpegtran, preserving EXIF. A HEIF without
#      a companion is exported at q100 4:2:2 with source EXIF restored. The
#      original files stay untouched; HEIF originals are never uploaded.
#   3. uploads those exact prepared bytes to R2. Input selection fixes the key
#      once, and indexing measures the same file the upload used. Every upload
#      must succeed before the run can reach hashing or the photo index.
#
# post-processing:
#   4. regenerates public/images/metadata.json + per-stem images/meta/<stem>.json
#      (EXIF for the tooltip) and bakes the 64-bin RGB+luma histograms into
#      meta.hist via `zenc histogram` — the tooltip renders the bars from
#      that field, and the metadata regen drops it, so the bake runs right after
#   5. writes the stem's entry into src/worker/photo-index.json — the
#      committed photo index the worker BUNDLES (which photos exist: R2 key,
#      size, upload date). This is what makes a photo appear in the grid, and
#      it ships at deploy like every other committed artifact. (It replaced the
#      manifest:images KV cache over a runtime R2 list(); there is no cache to
#      bust anymore.)
#   6. captions anything still missing alt text (gen-alt-text.py), rebuilds the
#      retrieval terms queryPhotos ranks on (gen-photo-semantics.ts, which reads
#      those captions and so must follow them), then validates the whole artifact
#      graph — pixels, EXIF, histograms, captions, the index — via
#      check-photo-pipeline.ts, which fails the run rather than let an
#      unlabelled image reach a deploy
#
# ALBUM=<slug> stamps every index entry this run writes with that album, which
# keeps the photos OUT of the homepage draw and /photos and puts them at /<slug>
# (src/worker/albums.ts holds the registry; the slug must be declared there).
# HEIF=1 also uploads each HEIF source to R2 beside its JPEG export, under the
# source's own filename, and records the key as `heif` on the index entry so the
# album page can offer both formats. Off by default: for the site-wide pool the
# HEIF original stays local-only, as it always has.
#
# REMOTE_RENDER_ONLY=1 skips R2 uploads. The GitHub Actions pipeline uses it
# because the source object is already in R2 and every generated artifact —
# tiers, metadata, the index entry — comes back as a normal PR.
#
# safe to re-run. skips thumbnail generation when all four thumb files are
# already newer than the source. always uploads to R2 (wrangler r2 put is
# idempotent). to add only new shots, pass just their paths (not the whole
# folder) so the 100+ existing originals aren't re-uploaded.
#
# NB: this only ADDS at the current SQ/SQ_SM. to change the square size for the
# whole library, that's reencode-thumbnails.sh's job (then hash-thumbnails.sh
# mints the new content-addressed /i/ URLs).
#
# usage:
#   ./tools/photos/add-photos.sh /path/to/photo.HIF
#   ./tools/photos/add-photos.sh /path/to/folder/
#   ./tools/photos/add-photos.sh /path/a.jpg /path/b.HIF /path/folder/

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

# resolve from anywhere — assumes script lives at tools/photos/
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

# How many photos phases 1 and 2 encode at once. Every photo is independent (its
# own source, its own output stems), so this is the one place in the pipeline
# where the machine's cores were sitting idle: those two loops ran one photo at
# a time while phase 3 had been uploading four at a time for months.
#
# The default is deliberately BELOW the core count, and the reason is what
# happens when the machine is NOT idle. Measured over a mixed 12-photo sample
# (8 JPG, 4 HIF) on an otherwise quiet 14-core M-series:
#
#   serial  114s  1.00x        JOBS  8   29s  3.93x
#   JOBS 2   77s  1.48x        JOBS 10   29s  3.93x
#   JOBS 4   53s  2.15x        JOBS 12   30s  3.80x
#   JOBS 6   48s  2.38x        JOBS 14   28s  4.07x
#
# It plateaus at 8 rather than turning over: past that the wall clock is the
# SLOWEST SINGLE PHOTO (a HIF full-res export, ~28s here), so on a sample this
# size there is no parallelism left to extract at any width. 8 reaches the
# plateau at half the cores, which leaves headroom for the two things that scale
# with N and are invisible in the table above. avifenc already spends `--jobs 4`
# per photo, so N photos in flight ask for up to 4N threads. And each worker
# holds a full-resolution frame: a 40MP linear-light f32 frame is ~480MB, on top
# of the ~311MB TIFF phase 1 writes and the bigger PNG phase 2 writes, all of
# which live in $TMP at once.
#
# THAT SECOND COST IS NOT THEORETICAL, and the same sweep on a loaded box is the
# evidence: at a 5-minute load average of 25 on those 14 cores with 14.7GB
# already swapped, the serial arm took 679s while JOBS=4/8/12 took 1704s, 1910s
# and 4373s. Parallel was 2.5x to 6.4x SLOWER than serial, because serial holds
# one frame and eight workers hold eight. A machine with other agent sessions on
# it is the normal case in this repo (see the collaboration rule in CLAUDE.md),
# so lower this rather than raise it when in doubt.
#
# The general trap is worth more than the number: a first pass took the loaded
# figures at face value and read them as a verdict on the change. Both sweeps
# were real measurements of different machines. Capture load and swap either side
# of each arm, which tools/photos is now in the habit of doing, or a busy box
# will quietly answer a question you did not ask.
#
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

# A worker runs in a subshell, so it cannot increment a counter in the parent.
# Each one drops an empty file named by its loop index into a per-outcome
# directory instead, and the parent counts files once every job has finished.
# The index is unique per photo, so concurrent workers never write the same name
# and none of this needs a lock.
st_init() { ST_ROOT="$1"; rm -rf "$ST_ROOT"; mkdir -p "$ST_ROOT/ok" "$ST_ROOT/skip" "$ST_ROOT/fail" "$ST_ROOT/na"; }
mark()    { : > "$ST_ROOT/$1/$2"; }
tally()   { ls -1 "$ST_ROOT/$1" 2>/dev/null | wc -l | tr -d ' '; }

# A worker that dies takes its outcome with it. Under `set -e` a failing command
# used to kill the whole run, which was loud; inside a subshell it kills one
# worker and `wait` still returns 0, which is not. So every photo records
# exactly one outcome. A failed or missing outcome stops the pipeline before
# the next phase can accept an incomplete set.
reconcile() {  # reconcile <phase-label>
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
run_parallel() {  # run_parallel <worker-fn> [limit]
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

# square thumbnail edges (px). the file IS the displayed pixels (center square),
# so no off-square bytes ship. MUST match reencode-thumbnails.sh + THUMB_SMALL_PX
# in _worker.js (the -<N>.avif suffix). override per run with SQ=/SQ_SM=.
SQ="${SQ:-600}"        # desktop square edge (the 184px tile at DPR-3)
SQ_SM="${SQ_SM:-400}"  # DPR-2 square edge
SQ_XS="${SQ_XS:-200}"  # DPR-1 square edge

# The three edges are the srcset candidates lib/photo-grid.js emits against a
# fixed 184px tile: 184, 368 and 552 device pixels at DPR 1, 2 and 3. Before the
# 200px tier existed every visitor got the 400px file, which is 2.3x what a 1x
# display can show (measured over a 12-photo draw: 113.3 KiB served against 42.5
# KiB displayable) while a DPR-3 phone got a 400px file for a 552px need.

# preconditions
if [ $# -eq 0 ]; then
  echo "usage: $0 <file-or-dir>..." >&2
  exit 1
fi
# zenc (tools/photos/zenc) is the JPEG encoder: a zenjpeg wrapper running
# hybrid trellis + progressive scan search, ~4% smaller than the retired cjpegli
# at equal quality (see /garage/encoding). It builds from source with cargo, so
# any machine with rust runs this pipeline; dependabot tracks the zenjpeg pin.
# q84 is calibrated to match the old cjpegli q82 quality at fewer bytes. mozjpeg's
# jpegtran survives ONLY for phase 3's progressive rearrangement of the R2 copies,
# which reorders coefficients and has no alignment constraint. It did the
# EXIF-orientation rotation until 2026-08-26; that is `zenc square --orient` now,
# for the reason CLAUDE.md gotcha 3 measures.
ZENC_DIR="$(cd "$(dirname "$0")/zenc" && pwd)"
ZENC="$ZENC_DIR/target/release/zenc"
ZENC_Q=84   # The linear-light geometry preserves high-frequency energy that sips'
            # gamma-incorrect average destroyed, so correct pixels compress worse
            # and the quality knob had to be chosen rather than inherited.
            #
            # Measured over 181 photos and all four tiers, q80/avif-58 against
            # q84/avif-63: jpg 600 +14.3%, avif 600 +21.8%, avif 400 +20.2%,
            # avif 200 +19.4%, tier total +17.6% or +2.39 MiB. So q84 is not free.
            #
            # It is kept anyway, because the alternative traded encoder quality
            # DOWN while trading geometry UP: the old corpus was sips geometry at
            # q84/63, and q80/58 would have been better pixels with more
            # quantization. q84/63 changes one variable instead of two, so the
            # corpus is strictly better than what it replaced rather than better
            # on one axis and worse on another.
MOZJPEG_DIR="$(brew --prefix mozjpeg)/bin"
MOZ_JTRAN="$MOZJPEG_DIR/jpegtran"

if [ ! -x "$WRANGLER" ]; then
  echo "error: pinned wrangler not found at $WRANGLER" >&2
  echo "  run: pnpm install" >&2
  exit 1
fi
for cmd in sips exif-sooc; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "error: $cmd not found in PATH" >&2
    case "$cmd" in
      exif-sooc) echo "  install with: cargo install --git https://github.com/oddharsh/exif-sooc exif-sooc" >&2 ;;
    esac
    exit 1
  fi
done

source "$SCRIPT_DIR/require-exif-sooc.sh"
# Cargo's incremental check also upgrades an existing binary when this script
# starts using a new native pipeline operation.
command -v cargo >/dev/null 2>&1 || { echo "error: cargo (rust) not found; install from https://rustup.rs" >&2; exit 1; }
(cd "$PROJECT_DIR" && cargo build --release --locked --manifest-path "$ZENC_DIR/Cargo.toml" --target-dir "$ZENC_DIR/target") >&2 || { echo "error: zenc build failed" >&2; exit 1; }

if [ ! -x "$MOZ_JTRAN" ]; then
  echo "error: jpegtran not installed at $MOZJPEG_DIR" >&2
  echo "  install with: brew install mozjpeg" >&2
  exit 1
fi
# AVIF encoder, in preference order: the INSTALLED avifenc first, the vendored
# build second, sips last. Owner call 2026-09-12, reversing the 2026-08-26 order
# that put the vendored build first: the installed encoder is the one to track,
# and a fresh machine should not spend ten minutes building an older libavif to
# match a pin when a newer one is already on PATH. What the pin bought was
# protection against a `brew upgrade` re-minting URLs silently (gotcha 46), and
# that protection now lives in config/tools.json's `recorded` version, which
# `bun run tools:check` compares against `avifenc --version` and reports as
# drift. Adding a photo on a moved encoder re-mints NOTHING already shipped,
# since /i/ is content-addressed per file; what it changes is the bytes of the
# photo being added, which is exactly what the recorded version is for.
#
# Measured before the flip rather than assumed: brew's aom 3.15.0 against the
# vendored aom 3.14.1, shipping flags verbatim, 3 stems (1 JPG, 2 HIF), all three
# tiers each: 9 of 9 byte-identical. The library is therefore mixed by
# PROVENANCE and not by bytes, so far. Re-run that control before trusting the
# next aom bump, since two versions agreeing is evidence about those two.
#
# The vendored build stays for two reasons: it is the fallback on a machine with
# no avifenc at all, and it is the only build here with `--sharpyuv`, which this
# script deliberately does NOT pass (see avif_encode).
VENDORED_AVIFENC="$(cd "$(dirname "$0")" && pwd)/libavif/build/avifenc"
if command -v avifenc >/dev/null 2>&1; then
  AVIF_ENCODER="avifenc"; AVIF_KIND="brew"
elif [ -x "$VENDORED_AVIFENC" ]; then
  AVIF_ENCODER="$VENDORED_AVIFENC"; AVIF_KIND="vendored"
else
  AVIF_ENCODER="sips"; AVIF_KIND="sips"
fi
# The sips fallback is a DIFFERENT ENCODER at a different quality, so say so
# rather than let a missing avifenc quietly change what ships.
if [ "$AVIF_KIND" = "sips" ]; then
  echo "warning: no avifenc found; falling back to sips, which encodes the AVIF" >&2
  echo "         tier differently. brew install libavif, or build one: tools/photos/libavif/build.sh" >&2
fi

mkdir -p "$DEST" "$TMP"
trap 'rm -rf "$TMP"' EXIT

# Resolve every stem before encoding. A same-folder HEIF/JPEG pair has one
# pixel/metadata source and one click-through source; all other collisions fail.
INPUTS="$TMP/inputs"
node "$SCRIPT_DIR/photo-inputs.ts" ingest "$@" > "$INPUTS"
TOTAL=$(( $(tr -cd '\000' < "$INPUTS" | wc -c) / 4 ))
echo "found $TOTAL photo(s) to process"
echo ""

avif_encode() {  # avif_encode <src.jpg> <out.avif>
  if [ "$AVIF_KIND" != "sips" ]; then
    # 4:0:0 for grayscale (Leica Monochrom — no chroma planes), else 4:2:0.
    # strip ICC/EXIF/XMP: the grid reads EXIF from metadata.json, so embedded
    # metadata is dead weight (and avifenc copies source EXIF by default).
    # `|| space=""` keeps this tolerant under pipefail: a sips that cannot read
    # the colorspace should fall through to 4:2:0, never abort the encode.
    local space; space=$(sips -g space "$1" 2>/dev/null | awk '/space:/{print $2}') || space=""
    local yuv; [ "$space" = "Gray" ] && yuv=400 || yuv=420
    # -q 63, unchanged from the sips era on purpose: see ZENC_Q above for why
    # the geometry change did not drag the encoder settings with it. Ladder if it
    # ever needs revisiting, against the old sips-q63 baseline on a skewed
    # 8-photo sample: q54 -10.2%, q56/57 +0.9%, q58 +6.8%, q59 +12.4%, q63 +28.8%.
    # Note q56 and q57 produce identical bytes, so the quantizer mapping is
    # coarser than the flag suggests.
    # --sharpyuv is available on the vendored build and is NOT passed. Measured
    # 2026-08-26 over 12 Fuji colour frames at this exact tier: it looks like
    # +1.218 mean SSIMULACRA2, but it also spends +4.54% more bytes, and the
    # matched-bytes probe (raise q until plain costs the same, the test
    # matched-bytes-probe.py runs for the resampling work) puts the real figure
    # at +0.411 mean with sharpyuv LOSING on 5 of 12. Turning it on is a
    # deliberate decision that also re-mints every /i/ URL it touches.
    #
    # --speed 2 since 2026-08-28, up from 4, because it wins on BOTH axes at
    # once. Measured over 6 stems covering both yuv paths through this exact
    # geometry (sips to TIFF, then zenc square at 600/400/200), shipping flags
    # verbatim and varying only --speed: the 600 tier goes 153,138 -> 150,948 B
    # (-1.43%) and all three tiers 262,158 -> 257,836 B (-1.65%), while mean
    # ssimulacra2 on the 600 tier RISES 79.439 -> 79.601. The bill is +0.21 s
    # per photo serial (0.515 -> 1.078), so an incremental add of 5 goes
    # 0.7 s -> 1.7 s and a full 165-photo run goes 21.8 s -> 57 s.
    #
    # speed 0 is REJECTED on its own numbers rather than on principle: it beats
    # speed 2 by 0.09 ssimulacra2 for 3.6x the time (2.942 s per photo), and it
    # produced LARGER files than speed 2 on 2 of the 6 stems.
    #
    # THE LIBRARY IS MIXED, deliberately. Every tile committed before that date
    # is speed 4 and stays speed 4. Re-encoding to collect the difference buys
    # 118.6 KiB spread over 495 immutable-1y AVIF files, about 245 B per tile,
    # of which a homepage visit fetches 12. It costs 495 re-minted /i/ URLs, 495
    # rewritten rows in public/images/fingerprints.json, the a/s/x keys of all
    # 165 stems in hashes.json, a hand-edit to src/pages/garage/tooltips.html
    # (12 literal /i/ refs across 3 stems), and a p-dict roll for that page.
    # That is the trade that has broken this build twice.
    #
    # Two speeds cost nothing operationally, because a /i/ URL names exact bytes
    # PER FILE and nothing downstream reads encoder settings. config/tools.json
    # already makes this argument about its own `recorded` versions: "Nothing
    # recorded which encoder made the 632 files in public/i, and #394 re-encoded
    # 316 of them on 2026-08-14, so claiming these versions produced them would
    # be inventing provenance." The remaining 118.6 KiB gets collected whenever
    # something forces a full re-encode anyway: a LIBAVIF_TAG bump, a geometry
    # change, or another reencode-thumbnails.sh run.
    "$AVIF_ENCODER" -q 63 -d 10 --ignore-icc --ignore-exif --ignore-xmp --speed 2 --jobs 4 --yuv "$yuv" "$1" "$2" >/dev/null 2>&1
  else
    sips -s format avif --setProperty formatOptions 60 "$1" --out "$2" >/dev/null 2>&1
  fi
}

# ── phase 1: square thumbnails (zenc q84 JPG + 10-bit AVIF, + mobile AVIF) ──
echo "phase 1 — square thumbnails (${SQ}×${SQ} / ${SQ_SM}×${SQ_SM}, zenc q84 + AVIF via $AVIF_KIND, metadata-stripped, parallel $JOBS)"
INTER="$TMP/inter"; mkdir -p "$INTER"
st_init "$TMP/status1"
thumb_one() {  # thumb_one <source-file> <index>
  local f="$1" idx="$2"
  local base stem jpg avif smavif xs xsavif tif sq sm input o profile transfer file current stage
  base=$(basename "$f"); stem="${base%.*}"
  current=1
  for file in "$DEST/$stem.jpg" "$DEST/$stem.avif" "$DEST/$stem-${SQ_SM}.avif" "$DEST/$stem-${SQ_XS}.avif"; do
    if [ ! -s "$file" ] || [ ! "$file" -nt "$f" ]; then current=0; break; fi
  done
  if [ "$current" -eq 1 ]; then
    mark skip "$idx"; printf "·"; return
  fi
  # Failed metadata or tier generation must not leave a fresh partial set for
  # the next run to mistake for a cached success. Publish only completed tiers.
  stage="$INTER/$idx"; mkdir -p "$stage"
  jpg="$stage/${stem}.jpg"; avif="$stage/${stem}.avif"
  smavif="$stage/${stem}-${SQ_SM}.avif"; xsavif="$stage/${stem}-${SQ_XS}.avif"
  xs="$INTER/${stem}.xs.png"
  # The intermediates are LOSSLESS: a TIFF for the HEIF decode, PNGs out.
  tif="$INTER/${stem}.tif"
  sq="$INTER/${stem}.sq.png"; sm="$INTER/${stem}.sm.png"

  # 1-3. decode → orient → all three tiers, ONE zenc invocation, in linear light.
  # The full argument lives at the twin site in reencode-thumbnails.sh; short
  # form: the `sips -Z 2000` first reduction was itself a gamma-incorrect
  # resample (+27.5 ssimulacra2 mean when removed, measured against a
  # linear-light ground truth — the earlier decline recorded here used a weaker
  # instrument and was wrong), jpegtran's DCT rotation silently garbled
  # non-iMCU-aligned frames (XT507876 shipped damaged), the smaller tiers were
  # resamples of the 600 tier, and a 10-bit HIF was quantised to 8 bits before
  # anything else happened. zenc --orient re-indexes samples in f32 (exact at
  # any dimensions) and --transfer g22 linearises the Monochrom's Gray Gamma
  # 2.2 with the curve its profile declares instead of sRGB.
  input="$f"
  case "${f##*.}" in
    [Hh][Ii][Ff]|[Hh][Ee][Ii][Cc]|[Hh][Ee][Ii][Ff])
      if ! sips -s format tiff "$f" --out "$tif" >/dev/null 2>&1; then mark fail "$idx"; printf "✗"; return; fi
      input="$tif" ;;
  esac
  o=$(exif-sooc -s -s -s -n -Orientation "$f" 2>/dev/null) || o=""
  case "$o" in [1-8]) ;; *) o=1 ;; esac
  # The transfer curve is zenc's to decide, from the file's own ICC, since
  # 2026-08-26. This used to be `sips -g profile` plus a literal match on
  # "Gray Gamma 2.2": a 123ms process per photo whose failure direction was
  # silent, because any other spelling falls back to sRGB and sRGB on Monochrom
  # data is wrong by up to 4 codes in the shadows. Classification is unchanged
  # on this corpus (2 g22, 179 srgb) and the outputs are byte-identical.
  if ! "$ZENC" square "$input" --orient "$o" --filter box \
      --size "$SQ" --out "$sq" --jpeg-out "$jpg" --jpeg-quality "$ZENC_Q" --size "$SQ_SM" --out "$sm" --size "$SQ_XS" --out "$xs" >/dev/null 2>&1; then
    rm -f "$tif"; mark fail "$idx"; printf "✗"; return
  fi
  # Deleted per photo rather than by the EXIT trap: a full-res TIFF is ~311MB
  # (326,474,696 B for a 7728x5152 HIF, 16-bit RGBA).
  #
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
  # 4. desktop square JPG was emitted with the PNG above (zenc: zenjpeg hybrid+scan, q84 ≈ old jpegli q82) + strip
  #    any residual metadata (sips can leave a grayscale ICC on B&W frames; keep
  #    formats consistent / sRGB).
  if ! exif-sooc -all= -overwrite_original "$jpg" >/dev/null; then mark fail "$idx"; printf "✗"; return; fi
  # 5. desktop square AVIF
  if ! avif_encode "$sq" "$avif"; then mark fail "$idx"; printf "✗"; return; fi
  # 6. mobile square AVIF — from the same full-resolution frame as the 600
  # tier since 2026-08-26 (it used to be a resize of the 600 square, and before
  # that a JPEG resized from a JPEG).
  if ! avif_encode "$sm" "$smavif"; then mark fail "$idx"; printf "✗"; return; fi
  # 7. 1x square AVIF, same one-encode-from-the-source property as step 6.
  # (This tier was missed when the geometry first moved on 2026-08-25 — the 600
  # and 400 went linear-light while the 200 stayed on sips — and its next
  # incarnation re-squared the 600. Both found by reading, not by a check.)
  if ! avif_encode "$xs" "$xsavif"; then mark fail "$idx"; printf "✗"; return; fi
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

# ── phase 2: prepare the exact full-resolution bytes ────────────────
echo "phase 2 — full-resolution JPEGs (parallel $JOBS)"
FULLS="$TMP/full-resolution"; RECEIPTS="$TMP/full-paths"; HEIF_RECEIPTS="$TMP/heif-keys"
mkdir -p "$FULLS" "$RECEIPTS" "$HEIF_RECEIPTS"
st_init "$TMP/status2"
prepare_one() {  # source, index, existing JPEG, object key, stem
  local f="$1" idx="$2" original="$3" full="$4" stem="$5" out tmppng
  out="$FULLS/$full"
  if [ -n "$original" ]; then
    if [ "${REMOTE_RENDER_ONLY:-0}" = "1" ]; then
      out="$original"  # these already ARE the remote bytes
    elif ! "$MOZ_JTRAN" -progressive -copy all -outfile "$out" "$original" 2>/dev/null || [ ! -s "$out" ]; then
      # Lossless rearrangement is optional. Discard a rejected partial copy;
      # the receipt must name the untouched bytes that are actually uploaded.
      rm -f "$out"
      out="$original"
    fi
  else
    # This export IS the R2 share/click copy; the .HIF original stays local-only.
    # sips decodes the 10-bit HIF to a lossless PNG (sensor-native pixels, no
    # orientation applied), zenc re-encodes it at q100 4:2:2 (the HIF's native
    # chroma; hybrid trellis + scan search + sharp_yuv), and exif-sooc copies the
    # source EXIF back, including Orientation, so browsers rotate it exactly as the
    # old sips export did. Net: better than sips q100 and source-faithful on chroma
    # (4:4:4 fabricates horizontal chroma the sensor never sampled; 4:2:0 drops the
    # vertical chroma it did record). By Butteraugli 4:2:2 ties/beats both; by
    # SSIMULACRA2 it gives up ~0.1-0.5 pt vs 4:4:4 for ~14% fewer bytes. /garage/encoding.
    tmppng="$FULLS/${stem}.decode.png"
    if ! sips -s format png "$f" --out "$tmppng" >/dev/null 2>&1 \
       || ! "$ZENC" "$tmppng" "$out" -q 100 --yuv 422 >/dev/null 2>&1 \
       || ! exif-sooc -TagsFromFile "$f" -all:all -overwrite_original "$out" >/dev/null 2>&1; then
      rm -f "$tmppng"; mark fail "$idx"; printf "✗"; return
    fi
    rm -f "$tmppng"
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

# ── phase 3: upload the prepared objects to R2 ───────────────────────
if [ "${REMOTE_RENDER_ONLY:-0}" = "1" ]; then
  echo "phase 3 — R2 uploads skipped (source is already remote)"
else
  echo "phase 3 — R2 uploads (parallel 4)"
  upload_one() {
    local f="$1" idx="$2" full="$4" send heif
    send=$(cat "$RECEIPTS/$idx")
    if ! "$WRANGLER" r2 object put "aadhar-photos/$full" --file="$send" --content-type="image/jpeg" --remote >/dev/null 2>&1; then
      mark fail "$idx"; printf "✗"
      echo "error: R2 upload failed: aadhar-photos/$full" >&2
      return
    fi
    # HEIF=1: the source itself goes up too, byte-for-byte, under its own name.
    # The key is written to a receipt phase 4 reads, so the index records a
    # HEIF only when this put actually succeeded. A JPEG-only source writes no
    # receipt and its entry carries no `heif`.
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

# ── phase 4: content-hash the new tiers + photo index + metadata ─────
echo "phase 4 — hash tiers + photo index + metadata regen"
# content-address every tier into public/i/ + refresh hashes.json (the
# worker bakes /i/ URLs from that map; idempotent, only new bytes copy)
"$SCRIPT_DIR/hash-thumbnails.sh" 2>&1 | tail -1

# ── the committed photo index (src/worker/photo-index.json) ──
# One entry per published stem: the R2 key, its byte size, and when it was
# uploaded. The worker BUNDLES this file (photos.js imports it), so the pool
# read costs module memory instead of a KV round trip — and this write step is
# what replaced the retired manifest:images KV bust: a photo goes live at
# deploy, which was already the real gate because its /i/ tiles, hashes.json
# entry, and caption are committed files too.
#
# Size comes from the same prepared-file receipt the uploader used. Object
# keys come from input selection, including exact remote key casing. Existing
# upload dates survive a rerender.
INDEX_FILE="$PROJECT_DIR/src/worker/photo-index.json"
NOW_ISO="$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"
NEW_ENTRIES="$TMP/index-entries.json"
echo '{}' > "$NEW_ENTRIES"
[ -f "$INDEX_FILE" ] || echo '{}' > "$INDEX_FILE"
idx=0
META_SOURCES=()
while read_input; do
  idx=$((idx+1))
  obj=$(cat "$RECEIPTS/$idx")
  size=$(wc -c < "$obj" | tr -d '[:space:]')
  heif=""; [ -s "$HEIF_RECEIPTS/$idx" ] && heif=$(cat "$HEIF_RECEIPTS/$idx")
  # `album` and `heif` are written only when set, so an entry for the site-wide
  # pool keeps the three-key shape it has always had and photo-index.json diffs
  # stay legible. An empty string is never written as a value.
  jaq --arg s "$stem" --arg k "$full" --argjson z "$size" --arg album "$ALBUM" --arg heif "$heif" \
     '. + {($s): ({full: $k, size: $z}
                  + (if $album != "" then {album: $album} else {} end)
                  + (if $heif != "" then {heif: $heif} else {} end))}' "$NEW_ENTRIES" > "$NEW_ENTRIES.tmp"
  mv "$NEW_ENTRIES.tmp" "$NEW_ENTRIES"
  META_SOURCES+=("$f")
done < "$INPUTS"
jaq -S --arg now "$NOW_ISO" --slurpfile new "$NEW_ENTRIES" '
  . as $idx
  | ($new[0] | with_entries(.value += {uploaded: ($idx[.key].uploaded // $now)}))
  | $idx + .
' "$INDEX_FILE" > "$INDEX_FILE.tmp"
mv "$INDEX_FILE.tmp" "$INDEX_FILE"
echo "  photo index: $(jaq 'length' "$INDEX_FILE") entries"
# Ingest is always a batch update: read precisely the selected pixel sources
# and preserve metadata for other published photos, even across input folders.
# The standalone extractor still offers a full replacement with its own guard.
"$SCRIPT_DIR/extract-photo-metadata.sh" --merge "${META_SOURCES[@]}" | tail -1

# A SECOND `zenc histogram --root` stood here until 2026-08-29, and the comment
# that justified it rested on a premise that expired in 2026-08. It claimed
# extract-photo-metadata.sh "does NOT emit hist", so this "MUST run after it".
# That script bakes at its own line 266 and then builds BOTH indexes from the
# result, so the outer call ran after the artifacts it was supposed to feed and
# nothing rebuilt from what it wrote.
#
# Verified equivalent before removal rather than assumed. The two --root values
# spell the same path ($SCRIPT_DIR/../.. plus /public), neither passed a STEM, so
# zenc took every key in hashes.json both times: 165 photos baked twice. Measured
# 2026-08-29, one library: 0.954s cold, 0.332s and 0.316s warm, and the second
# bake is always the warm one because the first left every file correct.
#
# Idempotence is why this was invisible and is not a reason to keep it. The one
# thing left reading meta/ down here is check-photo-pipeline.ts, which COMPARES
# the two indexes against it and rebuilds nothing, so a second bake that ever
# disagreed could only turn a good run red. Keeping the bake beside the index
# builds makes the last bake to run always the one they read.
#
# At removal, metadata regen was guarded on exif-sooc and jaq, so on a
# machine missing either, this call had been the ONLY bake
# and it wrote a meta/ carrying `hi` and no EXIF. check-photo-pipeline.ts then
# rebuilt exif.json from that and failed 165 of 165 photos pointing at
# build-exif-index.ts, which is not where the fault was. With no meta/ at all
# it skips the drift tier by design and reports the real gap instead.

# caption anything still missing alt text. runs AFTER hash-thumbnails.sh because
# it reads the committed public/i/ square via hashes.json and posts those exact
# bytes to Workers AI — no round trip to production, so a photo added seconds ago
# gets captioned here rather than waiting for a deploy. resumable and idempotent:
# already-captioned stems cost nothing. a 429 (the free 10k neurons/day) stops it
# early, which is why the failure is tolerated here and the real gate is
# check-photo-pipeline.ts below.
if command -v python3 >/dev/null 2>&1; then
  python3 "$SCRIPT_DIR/gen-alt-text.py" || \
    echo "  captions incomplete — re-run 'bun run captions' before deploying"
else
  echo "  python3 missing — skipping alt-text generation"
fi

# retrieval terms for every stem, and the ONE stem-keyed artifact this script has
# never regenerated. The other five reach it: hashes and fingerprints through
# hash-thumbnails.sh, histograms through extract-photo-metadata.sh plus the zenc
# bake, alt text through the block above. #609's `covers` verdict found
# semantics.json at 158 of 165 and repaired the generator, which had been joining
# a deleted www/ for a week (gotcha 40). That fixed the producer and left the hole
# that let seven photos drift out of it, so the next add would open it again.
#
# It runs AFTER gen-alt-text.py because the derived tier folds alt[stem] into
# `terms`. Captioning second leaves a new stem carrying camera vocabulary and no
# subject, which is the quiet half of this failure: the photo stays findable one
# tier down and nothing errors.
#
# No credential and no network. It reads metadata.json, hashes.json and alt.json,
# so unlike the captioner it cannot be rate-limited, and `set -e` makes a failure
# stop the run rather than degrade it. Re-running over the whole library is a
# byte-identical no-op, measured on all 165 stems at 95ms. --vision is the opt-in
# model tier and is deliberately not passed here, since it wants a token and this
# path has to work without one.
node "$PROJECT_DIR/tools/photos/gen-photo-semantics.ts"

node "$PROJECT_DIR/tools/photos/check-photo-pipeline.ts"
echo ""

echo "✓ photo artifacts generated. Review them and their derivation locks in a PR."
echo "  release through the site promotion and ramp; see docs/MAINTENANCE.md."
