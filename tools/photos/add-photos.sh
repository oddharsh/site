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
#   2. uploads a BROWSER-RENDERABLE full-resolution JPG to R2 as
#      aadhar-photos/<stem>.jpg — this is what /images/full/<stem>.jpg returns
#      on click, and the shareable R2 copy. for a JPG-source photo that's the
#      original, rearranged to progressive by jpegtran on the way up (lossless
#      coefficient reorder, not a re-encode; the local source folder is never
#      modified); for a HEIF source it's the maximum-quality q100 export from
#      step 3, which zenc already writes progressive.
#   3. if the original is HEIF (.hif/.heic/.heif), generates a full-res archive
#      JPG (sips decodes to lossless PNG, zenc re-encodes at q100 4:2:2 with the
#      full trellis + scan-search, exif-sooc re-attaches source EXIF incl
#      Orientation) and uploads THAT. 4:2:2 matches the Fuji HIF's native chroma
#      (the sensor records 10-bit 4:2:2): unlike 4:4:4 it doesn't spend bytes on
#      interpolated horizontal chroma the sensor never sampled, and unlike 4:2:0
#      it keeps the vertical chroma the sensor did record. Still a clear win over
#      the old sips q100. The .HIF
#      original is NOT uploaded — it stays local-only (your drive + SSD are the
#      archive). Chrome/Firefox can't render HEIF anyway, and R2 is for
#      serving/sharing, not cold storage of originals.
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
#   6. captions anything still missing alt text (gen-alt-text.py), then validates
#      the whole artifact graph — pixels, EXIF, histograms, captions, the index —
#      via check-photo-pipeline.ts, which fails the run rather than let an
#      unlabelled image reach a deploy
#
# REMOTE_RENDER_ONLY=1 skips R2 uploads. The GitHub Actions pipeline uses it
# because the source object is already in R2 and every generated artifact —
# tiers, metadata, the index entry — comes back as a normal PR.
#
# safe to re-run. skips thumbnail generation when all three thumb files are
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
MOZJPEG_DIR="/opt/homebrew/opt/mozjpeg/bin"
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

# exif-sooc must be new enough to WRITE, and the check is on the version rather
# than on a flag, because every failure mode here is quiet. An older build does
# not reject -all=: it reads it as a tag SELECTION and prints JSON, so the strip
# does nothing. 0.1.0 went further and truncated progressive JPEGs at their
# first scan, and every JPEG this pipeline produces is progressive. Each write
# below is wrapped in `|| true`, so a shipped file would keep the metadata this
# exists to remove, or lose most of its image, and nothing would say a word.
EXIF_SOOC_MIN=0.2.0
# `|| true` matters under `set -euo pipefail`: without it a missing or broken
# binary kills the script at this assignment, silently, before the message
# below can say what is wrong.
sooc_ver=$(exif-sooc --version 2>/dev/null | awk '{print $NF}' || true)
# Anything that is not a plain x.y.z is refused rather than compared. `sort -V`
# happily orders a word against a version and answers, so a garbled --version
# would otherwise read as new enough.
case "$sooc_ver" in
  *[!0-9.]*|'') sooc_ver='' ;;
esac
if [ -z "$sooc_ver" ] || [ "$(printf '%s\n%s\n' "$EXIF_SOOC_MIN" "$sooc_ver" | sort -V | head -1)" != "$EXIF_SOOC_MIN" ]; then
  echo "error: exif-sooc ${sooc_ver:-not found} is older than $EXIF_SOOC_MIN, which cannot write metadata safely." >&2
  echo "  update with: cargo install --git https://github.com/oddharsh/exif-sooc exif-sooc --force" >&2
  exit 1
fi
if [ ! -x "$ZENC" ]; then
  command -v cargo >/dev/null 2>&1 || { echo "error: cargo (rust) not found; install from https://rustup.rs" >&2; exit 1; }
  echo "building zenc (zenjpeg encoder) — first run only…" >&2
  cargo build --release --manifest-path "$ZENC_DIR/Cargo.toml" >&2 || { echo "error: zenc build failed" >&2; exit 1; }
fi
if [ ! -x "$MOZ_JTRAN" ]; then
  echo "error: jpegtran not installed at $MOZJPEG_DIR" >&2
  echo "  install with: brew install mozjpeg" >&2
  exit 1
fi
# AVIF encoder, in preference order. The VENDORED build is first because it is
# the only one this repo can pin: `/i/` is content-addressed, so the encoder
# decides shipped URLs, and a `brew upgrade libavif` could re-mint them silently
# (gotcha 41). tools/photos/libavif/build.sh builds libavif at a pinned tag with
# aom, libsharpyuv and libyuv LOCAL.
#
# Preferring it costs NOTHING today: verified 2026-08-26 that the vendored and
# brew binaries produce BYTE-IDENTICAL output at the settings below (same
# libavif 1.4.2, same aom 3.14.1). What the vendored one adds is `--sharpyuv`,
# which brew's build cannot do at all, and which this script deliberately does
# NOT pass yet (see avif_encode).
VENDORED_AVIFENC="$(cd "$(dirname "$0")" && pwd)/libavif/build/avifenc"
if [ -x "$VENDORED_AVIFENC" ]; then
  AVIF_ENCODER="$VENDORED_AVIFENC"; AVIF_KIND="vendored"
elif command -v avifenc >/dev/null 2>&1; then
  AVIF_ENCODER="avifenc"; AVIF_KIND="brew"
else
  AVIF_ENCODER="sips"; AVIF_KIND="sips"
fi
# The sips fallback is a DIFFERENT ENCODER at a different quality, so say so
# rather than let a missing avifenc quietly change what ships.
if [ "$AVIF_KIND" = "sips" ]; then
  echo "warning: no avifenc found; falling back to sips, which encodes the AVIF" >&2
  echo "         tier differently. build the pinned one: tools/photos/libavif/build.sh" >&2
fi

mkdir -p "$DEST" "$TMP"
trap 'rm -rf "$TMP"' EXIT

# ── enumerate inputs ──────────────────────────────────────────────────
SOURCES="$TMP/sources.txt"
> "$SOURCES"
for arg in "$@"; do
  if [ -d "$arg" ]; then
    find "$arg" -maxdepth 1 -type f \( \
      -iname "*.jpg" -o -iname "*.jpeg" \
      -o -iname "*.heic" -o -iname "*.heif" -o -iname "*.hif" \
      \) >> "$SOURCES"
  elif [ -f "$arg" ]; then
    echo "$arg" >> "$SOURCES"
  else
    echo "warning: skipping $arg (not a file or directory)" >&2
  fi
done

sort -u "$SOURCES" -o "$SOURCES"
TOTAL=$(wc -l < "$SOURCES" | tr -d ' ')
if [ "$TOTAL" -eq 0 ]; then
  echo "no eligible photos found in input(s)" >&2
  exit 1
fi
echo "found $TOTAL source file(s) to process"
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
    "$AVIF_ENCODER" -q 63 -d 10 --ignore-icc --ignore-exif --ignore-xmp --speed 4 --jobs 4 --yuv "$yuv" "$1" "$2" >/dev/null 2>&1
  else
    sips -s format avif --setProperty formatOptions 60 "$1" --out "$2" >/dev/null 2>&1
  fi
}

# ── phase 1: square thumbnails (zenc q84 JPG + 10-bit AVIF, + mobile AVIF) ──
echo "phase 1 — square thumbnails (${SQ}×${SQ} / ${SQ_SM}×${SQ_SM}, zenc q84 + AVIF via $AVIF_KIND, metadata-stripped)"
T_OK=0; T_SKIP=0; T_FAIL=0
INTER="$TMP/inter"; mkdir -p "$INTER"
while IFS= read -r f; do
  base=$(basename "$f"); stem="${base%.*}"
  jpg="$DEST/${stem}.jpg"; avif="$DEST/${stem}.avif"; smavif="$DEST/${stem}-${SQ_SM}.avif"
  # $INTER, like the two tiers above it. This read "$TMP/sq/", a directory
  # NOTHING CREATES, so the 1x tier has never been produced by this script: the
  # 200px files on the 158 published photos all came from reencode-thumbnails.sh.
  # It stayed hidden because `sips -Z` EXITS 0 when its --out directory does not
  # exist (measured 2026-08-24) and writes nothing, so the guard below passes and
  # avif_encode then fails on a missing input, costing one `~` in a progress line
  # of dots. The first photo added after this was noticed crashed
  # build-image-fingerprints.ts on `<stem>-200.undefined.avif`, because hashes.json
  # carried no `x` for it.
  xs="$INTER/${stem}.xs.png"; xsavif="$DEST/${stem}-${SQ_XS}.avif"
  if [ -f "$jpg" ] && [ -f "$avif" ] && [ -f "$smavif" ] && [ "$jpg" -nt "$f" ]; then
    T_SKIP=$((T_SKIP+1)); printf "·"; continue
  fi
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
      if ! sips -s format tiff "$f" --out "$tif" >/dev/null 2>&1; then T_FAIL=$((T_FAIL+1)); printf "✗"; continue; fi
      input="$tif" ;;
  esac
  o=$(exif-sooc -s -s -s -n -Orientation "$f" 2>/dev/null) || o=""
  case "$o" in [1-8]) ;; *) o=1 ;; esac
  transfer=srgb
  profile=$(sips -g profile "$f" 2>/dev/null | awk '/profile:/{sub(/^ *profile: /,""); print}') || profile=""
  [ "$profile" = "Gray Gamma 2.2" ] && transfer=g22
  if ! "$ZENC" square "$input" --orient "$o" --transfer "$transfer" --filter box \
      --size "$SQ" --out "$sq" --size "$SQ_SM" --out "$sm" --size "$SQ_XS" --out "$xs" >/dev/null 2>&1; then
    rm -f "$tif"; T_FAIL=$((T_FAIL+1)); printf "✗"; continue
  fi
  # Deleted per photo rather than by the EXIT trap: a full-res TIFF is ~311MB.
  rm -f "$tif"
  # 4. desktop square JPG (zenc: zenjpeg hybrid+scan, q84 ≈ old jpegli q82) + strip
  #    any residual metadata (sips can leave a grayscale ICC on B&W frames; keep
  #    formats consistent / sRGB).
  if ! "$ZENC" "$sq" "$jpg" -q "$ZENC_Q" >/dev/null 2>&1; then T_FAIL=$((T_FAIL+1)); printf "✗"; continue; fi
  exif-sooc -all= -overwrite_original "$jpg" >/dev/null 2>&1 || true
  # 5. desktop square AVIF
  if ! avif_encode "$sq" "$avif"; then T_FAIL=$((T_FAIL+1)); printf "✗"; continue; fi
  # 6. mobile square AVIF — from the same full-resolution frame as the 600
  # tier since 2026-08-26 (it used to be a resize of the 600 square, and before
  # that a JPEG resized from a JPEG).
  avif_encode "$sm" "$smavif" || printf "~"
  # 7. 1x square AVIF, same one-encode-from-the-source property as step 6.
  # (This tier was missed when the geometry first moved on 2026-08-25 — the 600
  # and 400 went linear-light while the 200 stayed on sips — and its next
  # incarnation re-squared the 600. Both found by reading, not by a check.)
  avif_encode "$xs" "$xsavif" || printf "~"
  T_OK=$((T_OK+1)); printf "."
done < "$SOURCES"
echo ""
echo "  generated: $T_OK  skipped (current): $T_SKIP  failed: $T_FAIL"
echo ""

# ── phase 2: HIF → full-res JPG export (for click-through) ────────────
echo "phase 2 — HIF → full-res JPG exports"
H_OK=0; H_SKIP=0; H_FAIL=0
EXPORTS="$TMP/jpgexports"
mkdir -p "$EXPORTS"
while IFS= read -r f; do
  base=$(basename "$f")
  ext_lc=$(echo "${base##*.}" | tr '[:upper:]' '[:lower:]')
  case "$ext_lc" in
    hif|heic|heif) ;;
    *) continue ;;
  esac
  stem="${base%.*}"
  src_dir=$(dirname "$f")
  # skip if the same folder already has a JPG/JPEG sibling — that's the
  # authoritative click target; no need to make a derived export.
  if ls "$src_dir"/"$stem".[Jj][Pp][Gg] 2>/dev/null  | grep -q . || \
     ls "$src_dir"/"$stem".[Jj][Pp][Ee][Gg] 2>/dev/null | grep -q .; then
    H_SKIP=$((H_SKIP+1)); printf "→"
    continue
  fi
  out="$EXPORTS/${stem}.jpg"
  # This export IS the R2 share/click copy; the .HIF original stays local-only.
  # sips decodes the 10-bit HIF to a lossless PNG (sensor-native pixels, no
  # orientation applied), zenc re-encodes it at q100 4:2:2 (the HIF's native
  # chroma; hybrid trellis + scan search + sharp_yuv), and exif-sooc copies the
  # source EXIF back, including Orientation, so browsers rotate it exactly as the
  # old sips export did. Net: better than sips q100 and source-faithful on chroma
  # (4:4:4 fabricates horizontal chroma the sensor never sampled; 4:2:0 drops the
  # vertical chroma it did record). By Butteraugli 4:2:2 ties/beats both; by
  # SSIMULACRA2 it gives up ~0.1-0.5 pt vs 4:4:4 for ~14% fewer bytes. /garage/encoding.
  tmppng="$EXPORTS/${stem}.decode.png"
  if sips -s format png "$f" --out "$tmppng" >/dev/null 2>&1 \
     && "$ZENC" "$tmppng" "$out" -q 100 --yuv 422 >/dev/null 2>&1 \
     && exif-sooc -TagsFromFile "$f" -all:all -overwrite_original "$out" >/dev/null 2>&1; then
    rm -f "$tmppng"; H_OK=$((H_OK+1)); printf "."
  else
    rm -f "$tmppng"; H_FAIL=$((H_FAIL+1)); printf "✗"
  fi
done < "$SOURCES"
echo ""
echo "  exported: $H_OK  skipped (JPG sibling exists): $H_SKIP  failed: $H_FAIL"
echo ""

# ── phase 3: upload originals + HIF JPG exports to R2 ─────────────────
if [ "${REMOTE_RENDER_ONLY:-0}" = "1" ]; then
  echo "phase 3 — R2 uploads skipped (source is already remote)"
else
  echo "phase 3 — R2 uploads (parallel 4)"
  upload() {
    local key="$1" file="$2" ct="$3"
    if "$WRANGLER" r2 object put "aadhar-photos/$key" --file="$file" --content-type="$ct" --remote >/dev/null 2>&1; then
      printf "."
    else
      printf "✗"
    fi
  }

# originals → R2. NB: HIF/HEIF originals are NOT uploaded — they stay local-only
# (your drive + SSD are the archive); R2 gets their q100 JPG export instead
# (phase 2 / below), which is browser-renderable + shareable. only JPG-source
# originals (already max-quality SOOC) go up. extension lowercased so keys
# are stable; stem case preserved.
#
# The R2 copy is rearranged to PROGRESSIVE on the way up (see prep_original).
# Camera JPGs are written baseline, and /images/full/<stem>.jpg is served as bare
# image/jpeg with no AVIF tier and no <picture> — it is the one surface here where
# a multi-MB file is the whole payload, so scan order is the entire loading
# experience. jpegtran reorders the existing DCT coefficients; it never decodes to
# pixels, so this is not a re-encode and there is no generational loss.
PROGDIR="$TMP/progressive"
mkdir -p "$PROGDIR"

# jpegtran -progressive on a COPY. The file in the source folder is never touched:
# that folder is the SOOC archive and stays byte-for-byte what the camera wrote.
# -copy all keeps EXIF (incl. Orientation) — gotcha 3/4 in CLAUDE.md, and the
# metadata pipeline reads these tags later. Falls back to the untouched original
# if jpegtran fails, so a bad file costs the optimisation and not the upload.
prep_original() {
  local src="$1" out="$2"
  if "$MOZ_JTRAN" -progressive -copy all -outfile "$out" "$src" 2>/dev/null && [ -s "$out" ]; then
    printf "%s" "$out"
  else
    printf "%s" "$src"
  fi
}

PENDING=0
while IFS= read -r f; do
  base=$(basename "$f")
  stem="${base%.*}"
  ext_lc=$(echo "${base##*.}" | tr '[:upper:]' '[:lower:]')
  case "$ext_lc" in
    heic|heif|hif) continue ;;   # local-only; the q100 JPG export is the R2 copy
  esac
  ( send=$(prep_original "$f" "$PROGDIR/$stem.$ext_lc")
    upload "${stem}.${ext_lc}" "$send" "image/jpeg" ) &
  PENDING=$((PENDING+1))
  if [ $PENDING -ge 4 ]; then wait; PENDING=0; fi
done < "$SOURCES"
wait
  echo ""

# HIF JPG exports (the click-through-friendly companion)
if [ "$(ls -A "$EXPORTS" 2>/dev/null)" ]; then
  echo "  HIF JPG exports:"
  PENDING=0
  for jpg in "$EXPORTS"/*.jpg; do
    [ -f "$jpg" ] || continue
    stem=$(basename "$jpg" .jpg)
    upload "${stem}.jpg" "$jpg" "image/jpeg" &
    PENDING=$((PENDING+1))
    if [ $PENDING -ge 4 ]; then wait; PENDING=0; fi
  done
  wait
  echo ""
fi
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
# size = the staged bytes that went (or will go) to R2: the progressive
# rearrangement for a JPG source (falling back to the source file where
# jpegtran fell back, and in REMOTE_RENDER_ONLY mode, where the local file IS
# the R2 object), the q100 export for a HIF source. `uploaded` is preserved
# for a stem that already has an entry, so re-renders don't masquerade as new
# photos in the footer's "Last modified".
INDEX_FILE="$PROJECT_DIR/src/worker/photo-index.json"
NOW_ISO="$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"
NEW_ENTRIES="$TMP/index-entries.json"
echo '{}' > "$NEW_ENTRIES"
[ -f "$INDEX_FILE" ] || echo '{}' > "$INDEX_FILE"
while IFS= read -r f; do
  base=$(basename "$f"); stem="${base%.*}"
  ext_lc=$(echo "${base##*.}" | tr '[:upper:]' '[:lower:]')
  case "$ext_lc" in
    heic|heif|hif) key="${stem}.jpg"; obj="$EXPORTS/$stem.jpg" ;;
    *)             key="${stem}.${ext_lc}"; obj="${PROGDIR:-/nonexistent}/$stem.$ext_lc"; [ -f "$obj" ] || obj="$f" ;;
  esac
  if [ ! -f "$obj" ]; then
    echo "  index: no staged bytes for $stem — entry skipped (photos:check will flag it)" >&2
    continue
  fi
  size=$(wc -c < "$obj" | tr -d '[:space:]')
  jq --arg s "$stem" --arg k "$key" --argjson z "$size" \
     '. + {($s): {full: $k, size: $z}}' "$NEW_ENTRIES" > "$NEW_ENTRIES.tmp" && mv "$NEW_ENTRIES.tmp" "$NEW_ENTRIES"
done < "$SOURCES"
jq -S --arg now "$NOW_ISO" --slurpfile new "$NEW_ENTRIES" '
  . as $idx
  | ($new[0] | with_entries(.value += {uploaded: ($idx[.key].uploaded // $now)}))
  | $idx + .
' "$INDEX_FILE" > "$INDEX_FILE.tmp" && mv "$INDEX_FILE.tmp" "$INDEX_FILE"
echo "  photo index: $(jq 'length' "$INDEX_FILE") entries"
# regenerate from the FIRST input dir if it was a directory; else from the
# parent dir of the first file (metadata script walks one canonical dir).
META_SRC=""
for arg in "$@"; do
  if [ -d "$arg" ]; then META_SRC="$arg"; break; fi
done
if [ -z "$META_SRC" ]; then
  META_SRC="$(dirname "$(head -1 "$SOURCES")")"
fi
if command -v exif-sooc >/dev/null 2>&1 && command -v jq >/dev/null 2>&1; then
  META_MODE=()
  if [ "${REMOTE_RENDER_ONLY:-0}" = "1" ]; then META_MODE=(--merge); fi
  # `${META_MODE+"${META_MODE[@]}"}` rather than a bare `"${META_MODE[@]}"`,
  # because bash 3.2 (the bash macOS ships, and the one `env bash` finds here)
  # treats an EMPTY array as unbound and dies under `set -u`. This is the default
  # path (META_MODE is only non-empty under REMOTE_RENDER_ONLY), so the bare form
  # would have broken every local photo add the moment -u went on. The `:-`
  # spelling is NOT the fix: it expands to one empty-string argument, which this
  # script would hand to extract-photo-metadata.sh as a source directory.
  # stdout is tailed to the one summary line; stderr passes THROUGH, because the
  # unpublished-photo notice and the missing-source warning are printed there and
  # `2>&1` would tail them into nothing.
  "$SCRIPT_DIR/extract-photo-metadata.sh" ${META_MODE+"${META_MODE[@]}"} "$META_SRC" | tail -1
else
  echo "  exif-sooc or jq missing — skipping metadata regen"
fi

# bake 64-bin RGB+luma histograms into per-stem meta. the photo tooltip renders
# the histogram from meta.hist (index.html renderHistogramSvg), and
# extract-photo-metadata.sh above does NOT emit hist — so this MUST run after it,
# or every incremental add strips the bars off all existing photos. computed from
# the shipped /i/ thumbnails via hashes.json; idempotent (unchanged thumbs re-bake
# byte-identically), so running over the whole library each add is a no-op diff.
# zenc does this now (2026-08-14, was photo-histograms.py + Pillow), which is why
# there is no longer a conditional here: $ZENC is built above and is not optional,
# so the bake either runs or the whole script has already failed.
#
# NOT piped into `tail -1`, which is what gotcha 40's five silent days were.
# zenc writes only to stderr and only one summary line on the happy path, so the
# pipe was buying no quiet; what it bought was `tail`'s exit status over zenc's.
# Unpiped, a bad root (2) or a skipped stem (1) stops the run under `set -e`, and
# the per-stem warnings that name WHICH stem are visible instead of dropped.
"$ZENC" histogram --root "$PROJECT_DIR/public"

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

node "$PROJECT_DIR/tools/photos/check-photo-pipeline.ts"
echo ""

echo "✓ done. deploy with:"
echo "    bun run deploy:direct"
