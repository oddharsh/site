#!/usr/bin/env bash
#
# reencode-thumbnails.sh — re-encode ALL published grid thumbnails from the
# canonical source folder at a new resolution, in place.
#
# Re-encodes the grid thumbnails as PRE-CROPPED CENTER SQUARES — exactly what the
# homepage grid shows (aspect-ratio:1 + object-fit:cover). The file IS the
# displayed pixels, so no off-square bytes are shipped. Two square tiers:
#   SQ    desktop square (default 600 — the ~197px tile at DPR-3; 800 would be
#         MORE pixels than the old 800-long-edge and bigger for no visible gain)
#   SQ_SM mobile square  (default 400 — the ~100px tile, served via <source media>)
# AVIF for both; a single SQ JPG is the no-AVIF fallback. NB: SQ_SM must match
# THUMB_SMALL_PX in _worker.js (the -<N>.avif suffix).
#
# Deliberately does NOT touch R2 (it now holds only q100 JPG share copies, not
# originals), metadata.json (its width/height are the ORIGINAL dims), or the
# full-res click export. The source folder may be a disposable directory
# downloaded from R2 by the remote GitHub Actions workflow.
#
# FUTURE — native-aspect layout (when CSS masonry / grid-lanes ships in 2+
# engines; today it's Safari 26 only, Chrome behind a flag — see /garage/horizon).
# The square crop here is a CURRENT-ENGINES compromise; the long-term intent is to
# stop cropping and lay photos out at their native aspect, packed creatively
# (masonry) and scaled by SOOC pixel area. To get there: re-encode full-frame
# (NOT square) thumbnails from the local SOOC originals in $SRC (the .HIF files)
# — nothing is lost, the crop only ever lived in these files — and drive the
# layout from metadata.json's original
# width/height. Key gotcha (this bit us before): if a tile is shown LARGER than
# its thumbnail's resolution it pixelates, so the thumbnail's encoded size must
# scale with its DISPLAY area, not be a fixed long-edge. So that variant wants a
# per-photo target size (area-aware), not one global SQ.
#
# Relative TILE AREA = (pixel area) × (sensor area):
#   - pixel area  = metadata.json width × height (already stored).
#   - sensor area = camera model → mm² lookup. Today's bodies:
#       FUJIFILM X-T50            APS-C  ~367 mm²  (40 MP)
#       Leica M Monochrom Typ 246 full   ~864 mm²  (24 MP)
#     so Leica frames land ~1.4× the Fuji tiles — a gentle premium for the
#     bigger sensor, NOT "more megapixels wins" (pure-MP would invert this).
# Normalize the metric into a few DISCRETE area tiers (e.g. 1× / 1.4× / 2×),
# never literal-proportional (that's what caused the earlier imbalance). SHAPE
# comes from native aspect (don't crop); this metric only sets relative AREA.
# With just two bodies it's near-binary today — the visual variety will come
# from aspect ratios, not this — but it future-proofs the moment a 3rd body lands.
#
# After running, re-run hash-thumbnails.sh: it re-hashes each tier into public/i/
# and rewrites images/hashes.json. A re-encode mints a NEW content-addressed URL,
# so there is nothing to bust (THUMB_VERSION is gone; it only ever survived in the
# legacy-fallback URL shape).
#   SQ=600 ./tools/photos/reencode-thumbnails.sh
#   SQ=600 SQ_SM=400 ./tools/photos/reencode-thumbnails.sh "/path/to/source/folder"
#
set -euo pipefail

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
PROJECT_DIR="$( cd "$SCRIPT_DIR/../.." && pwd )"
DEST="$PROJECT_DIR/public/images"
SRC="${1:-/Users/aadharsh/Downloads/to post (from ssd)}"
SQ="${SQ:-600}"        # desktop square edge
SQ_SM="${SQ_SM:-400}"  # mobile square edge (filename suffix; must match THUMB_SMALL_PX)
SQ_XS="${SQ_XS:-200}"  # 1x square edge (the 184px tile at DPR-1)

# WHICH tiers to write. Default is everything, which is what a real re-encode
# wants. The reason this knob exists is that adding a tier must be ADDITIVE: an
# /i/ URL names its bytes, so re-encoding a tier that did not need to change
# mints a new hash, rewrites every page that references it, and orphans the
# a-dict and p-dict snapshots built against the old ones. `TIERS=xs` writes the
# 200px tier and leaves the other three byte-identical, which is how the 158
# committed photos were backfilled without touching a single existing hash.
TIERS="${TIERS:-sq,sm,xs}"
want() { case ",$TIERS," in *",$1,"*) return 0;; *) return 1;; esac; }
TMP="/tmp/aadhar-reencode-$$"
mkdir -p "$TMP"
trap 'rm -rf "$TMP"' EXIT

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

for cmd in sips exif-sooc; do
  command -v "$cmd" >/dev/null 2>&1 || { echo "error: $cmd not in PATH" >&2; exit 1; }
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
  cargo build --release --locked --manifest-path "$ZENC_DIR/Cargo.toml" >&2 || { echo "error: zenc build failed" >&2; exit 1; }
fi
[ -d "$SRC" ]      || { echo "error: source folder not found: $SRC" >&2; exit 1; }
# Same encoder preference as add-photos.sh, and it matters MORE here: this
# script re-encodes the whole published library, so the encoder it picks decides
# every /i/ URL at once. The vendored build is pinned; brew's is whatever the
# machine happens to have. See tools/photos/libavif/build.sh.
VENDORED_AVIFENC="$(cd "$(dirname "$0")" && pwd)/libavif/build/avifenc"
if [ -x "$VENDORED_AVIFENC" ]; then
  AVIF_ENCODER="$VENDORED_AVIFENC"; AVIF_KIND="vendored"
elif command -v avifenc >/dev/null 2>&1; then
  AVIF_ENCODER="avifenc"; AVIF_KIND="brew"
else
  AVIF_ENCODER="sips"; AVIF_KIND="sips"
fi
if [ "$AVIF_KIND" = "sips" ]; then
  echo "warning: no avifenc found; sips encodes the AVIF tier differently, and this" >&2
  echo "         script rewrites the WHOLE library. build tools/photos/libavif/build.sh" >&2
fi

# find the source file for a thumbnail stem (any extension/case)
find_source() {
  local stem="$1" hit
  for hit in "$SRC/$stem".*; do
    case "${hit##*.}" in
      [Jj][Pp][Gg]|[Jj][Pp][Ee][Gg]|[Pp][Nn][Gg]|[Hh][Ii][Ff]|[Hh][Ee][Ii][Cc]|[Hh][Ee][Ii][Ff]) echo "$hit"; return 0 ;;
    esac
  done
  return 1
}

# Enumerate published stems from the content-hashed JPG tiles in public/i/. The
# old images/*.jpg location emptied out in the /i/ cutover, so globbing $DEST would
# match nothing (and, with no nullglob, silently loop once on the literal glob).
STEMS=$(for j in "$PROJECT_DIR/public/i/"*.jpg; do b=$(basename "$j" .jpg); echo "${b%.*}"; done | sort -u)
TOTAL=$(echo "$STEMS" | grep -c . || true)
[ "$TOTAL" -gt 0 ] || { echo "error: no published thumbnails found in public/i/ (expected the content-hashed JPG tiles)" >&2; exit 1; }
echo "re-encoding $TOTAL thumbnails as ${SQ}×${SQ} / ${SQ_SM}×${SQ_SM} center squares  (zenc q${ZENC_Q} + AVIF via $AVIF_KIND)"
echo "  source: $SRC"
echo ""

OK=0; MISS=0; FAIL=0
INTER="$TMP/inter"; mkdir -p "$INTER"
while IFS= read -r stem; do
  [ -n "$stem" ] || continue
  if ! src=$(find_source "$stem"); then MISS=$((MISS+1)); printf "?"; continue; fi

  tif="$INTER/${stem}.tif"
  sqjpg="$INTER/${stem}.sq.png"; smtmp="$INTER/${stem}.sm.png"
  jpg="$DEST/${stem}.jpg"; avif="$DEST/${stem}.avif"; smavif="$DEST/${stem}-${SQ_SM}.avif"
  xstmp="$INTER/${stem}.xs.png"; xsavif="$DEST/${stem}-${SQ_XS}.avif"

  # 1-3. decode → orient → all three tiers, ONE zenc invocation, in linear light.
  #
  # This consolidated four seams on 2026-08-26, each one measured before it moved:
  #
  #   - the `sips -Z 2000` first reduction was a GAMMA-INCORRECT resample feeding
  #     the correct one. An earlier note here declined removing it, measured with
  #     a home-grown mean-luminance metric; re-measured with ssimulacra2 against
  #     a linear-light ground truth, one-step wins +27.5 mean over 10 frames
  #     (57.23 -> 84.77), better on 10 of 10. The instrument was the error.
  #   - jpegtran's DCT rotation is silently non-lossless when the constraint
  #     edge is not iMCU-aligned, and this script never passed -perfect. On the
  #     2000x1333 intermediates, -rotate 270 (133 of 181 photos) was perfect BY
  #     LUCK and -rotate 90/-rotate 180 were not: XT507876 shipped with its
  #     frame displaced 5px and a garbled edge strip. zenc's --orient re-indexes
  #     samples in f32: exact at any dimensions, no MCU grid, no lottery.
  #   - the 400 and 200 tiers were resamples OF THE 600 TIER; all three now come
  #     from the same full-resolution linear-light frame.
  #   - a 10-bit HIF was quantised to 8 bits at this first step. The TIFF door
  #     decodes at 16 bits straight into f32 (sips -s format tiff is also 10.6x
  #     faster than PNG at this size: 509ms vs 6222ms on a 7728x5152 frame).
  #     JPEG sources skip the TIFF entirely: zenc decodes them itself.
  #
  # --transfer g22 for the Monochrom files, whose profile is Gray Gamma 2.2 and
  # not sRGB: linearising them with the sRGB curve was wrong by up to 4 codes,
  # in the shadows a monochrome body exists for. The curve is decode AND encode,
  # so unaveraged values pass through exactly and the shipped tone is unchanged.
  #
  # The probe (tools/photos/resample-probe.ts) and its history stay the record
  # for the kernel itself: gamma 188.0 where sips read 127.6, flat 0.00 where
  # sips read 0.49, ring 0. See also ZENC_Q above for what correct pixels cost.
  input="$src"
  case "${src##*.}" in
    [Hh][Ii][Ff]|[Hh][Ee][Ii][Cc]|[Hh][Ee][Ii][Ff])
      if ! sips -s format tiff "$src" --out "$tif" >/dev/null 2>&1; then FAIL=$((FAIL+1)); printf "✗"; continue; fi
      input="$tif" ;;
  esac
  o=$(exif-sooc -s -s -s -n -Orientation "$src" 2>/dev/null) || o=""
  case "$o" in [1-8]) ;; *) o=1 ;; esac
  # The transfer curve is zenc's to decide, from the file's own ICC, since
  # 2026-08-26. This used to be `sips -g profile` plus a literal match on
  # "Gray Gamma 2.2": a 123ms process per photo whose failure direction was
  # silent, because any other spelling falls back to sRGB and sRGB on Monochrom
  # data is wrong by up to 4 codes in the shadows. Classification is unchanged
  # on this corpus (2 g22, 179 srgb) and the outputs are byte-identical.
  if ! "$ZENC" square "$input" --orient "$o" --filter box \
      --size "$SQ" --out "$sqjpg" --size "$SQ_SM" --out "$smtmp" --size "$SQ_XS" --out "$xstmp" >/dev/null 2>&1; then
    rm -f "$tif"; FAIL=$((FAIL+1)); printf "✗"; continue
  fi
  # Deleted per photo rather than by the EXIT trap: a full-res TIFF is ~311MB,
  # and 158 of them would want 50GB of /tmp. Compressing it instead is not on
  # offer: `sips -s formatOptions lzw` is documented for TIFF and silently
  # ignored at 16 bits, measured at the twin site in add-photos.sh.
  rm -f "$tif"
  # 4. desktop square: zenc (zenjpeg hybrid+scan+sharp_yuv, q84) + AVIF (yuv400 for grayscale, else yuv420).
  #    metadata is stripped: the grid reads EXIF/histogram from metadata.json, so
  #    embedded EXIF/XMP/ICC in the thumbnail files is dead weight (~1.5KB/AVIF
  #    avg, up to ~5KB). avifenc gets --ignore-exif/--ignore-xmp (below); zenc
  #    already emits clean JPGs, but sips can leave a grayscale ICC on B&W frames,
  #    so strip the JPG too. assumes sRGB display (the AVIF primary has no profile
  #    either, so this keeps the two formats consistent).
  #
  #    All three avifenc calls below pass --speed 2, up from 4 on 2026-08-28.
  #    The measurement and the speed-0 rejection live once, at avif_encode() in
  #    add-photos.sh; the short version is -1.65% bytes across the three tiers
  #    AND +0.162 mean ssimulacra2, for +0.21 s per photo.
  #
  #    THIS SCRIPT IS WHERE THE MIXED LIBRARY GOT COLLECTED, on 2026-08-28, by
  #    a run of exactly this command with no arguments. The library is one
  #    speed again. It cost the 495 re-minted /i/ URLs, 495 fingerprint rows,
  #    the a/s/x keys of all 165 stems in hashes.json, the 12 literal /i/ refs
  #    in src/pages/garage/tooltips.html, and a p-dict roll for that one page.
  #
  #    It bought 138,609 bytes, which is 135.4 KiB and MORE than the 118.6 KiB
  #    projected from 6 stems: -1.816% on the 600 tier, -1.968% on 400,
  #    -2.007% on 200, -1.882% across all three. Re-derived from git on
  #    2026-08-29 and exact to the byte.
  #
  #    QUALITY ROSE ON AVERAGE RATHER THAN EVERYWHERE, and the figure first
  #    recorded here said only the first half of that. It read "+0.327 mean
  #    ssimulacra2 over 24 tier comparisons on 8 stems", which is a real
  #    measurement of a small sample and reads as the whole result. A wider
  #    independent scoring against the same reference, 51 comparisons on 17
  #    stems, gives mean +0.2080: better on 39 tiers, WORSE on 12, worst tier
  #    -0.61. That scoring is quoted rather than reproduced, since redoing it
  #    means rebuilding the ingest reference from the SOOC originals.
  #
  #    The decision it justified is unchanged, because every magnitude is far
  #    under perceptual significance and the aggregate direction holds. The
  #    record is what needed fixing: a lone mean gets read later as "quality
  #    rose", and 12 of 51 tiers went the other way. PR #660's description
  #    still carries the +0.327 figure and cannot usefully be edited.
  #
  #    The JPG tier did not move by a single byte on any of the 165, which is
  #    what said no histogram re-bake was owed. Do not read that as a rule: it
  #    holds because --speed reaches avifenc alone, and any change to the zenc
  #    call or to the geometry above moves j and owes the bake.
  space=$(sips -g space "$sqjpg" 2>/dev/null | awk '/space:/{print $2}'); [ "$space" = "Gray" ] && yuv=400 || yuv=420
  if want sq; then
  if ! "$ZENC" "$sqjpg" "$jpg" -q "$ZENC_Q" >/dev/null 2>&1; then FAIL=$((FAIL+1)); printf "✗"; continue; fi
  exif-sooc -all= -overwrite_original "$jpg" >/dev/null 2>&1 || true
  if [ "$AVIF_KIND" != "sips" ]; then
    "$AVIF_ENCODER" -q 63 -d 10 --ignore-icc --ignore-exif --ignore-xmp --speed 2 --jobs 4 --yuv "$yuv" "$sqjpg" "$avif" >/dev/null 2>&1 || { FAIL=$((FAIL+1)); printf "✗"; continue; }
  else
    sips -s format avif --setProperty formatOptions 60 "$sqjpg" --out "$avif" >/dev/null 2>&1 || { FAIL=$((FAIL+1)); printf "✗"; continue; }
  fi
  fi
  # 5. mobile square: from the same full-resolution frame as the 600 tier
  if want sm; then
    if [ "$AVIF_KIND" != "sips" ]; then
      "$AVIF_ENCODER" -q 63 -d 10 --ignore-icc --ignore-exif --ignore-xmp --speed 2 --jobs 4 --yuv "$yuv" "$smtmp" "$smavif" >/dev/null 2>&1 || printf "~"
    else
      sips -s format avif --setProperty formatOptions 60 "$smtmp" --out "$smavif" >/dev/null 2>&1 || printf "~"
    fi
  fi
  # 6. 1x square: from the same full-resolution frame. (Until 2026-08-26 this
  #    and the 400 tier re-squared the 600 square — a resize of a resize, while
  #    this very comment claimed one encode from the source. The multi-size
  #    ingest made the claim true.)
  if want xs; then
    if [ "$AVIF_KIND" != "sips" ]; then
      "$AVIF_ENCODER" -q 63 -d 10 --ignore-icc --ignore-exif --ignore-xmp --speed 2 --jobs 4 --yuv "$yuv" "$xstmp" "$xsavif" >/dev/null 2>&1 || printf "~"
    else
      sips -s format avif --setProperty formatOptions 60 "$xstmp" --out "$xsavif" >/dev/null 2>&1 || printf "~"
    fi
  fi
  OK=$((OK+1)); printf "."
done <<< "$STEMS"
echo ""
echo ""
echo "  re-encoded: $OK   source-missing: $MISS   failed: $FAIL"
echo "  next: re-run hash-thumbnails.sh (new bytes mint new /i/ URLs), then"
echo "  re-bake the histograms, then \`bun run derive:check\`, commit, and deploy."
echo "  the worker bundles photo-index.json + hashes.json, so the deploy IS the"
echo "  cache bust."
echo ""
echo "  the re-bake is not optional and is why gotcha 41 exists: this script is"
echo "  the standalone path, #394 took it, re-encoded 316 tiles, re-baked nothing,"
echo "  and images/histograms.json described pixels nobody was served for nine"
echo "  days. derive:check is what says so now, by name and per file."
