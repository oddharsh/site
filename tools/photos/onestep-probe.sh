#!/usr/bin/env bash
#
# onestep-probe.sh — is the full-resolution ingest actually better than the
# 2000px two-step, and by how much?
#
# THIS EXISTS BECAUSE THE ANSWER FLIPPED ONCE ALREADY, on the instrument rather
# than on the pixels. `add-photos.sh` used to decode with `sips -Z 2000` and hand
# that reduced frame to `zenc square`, so every thumbnail was one gamma-incorrect
# reduction followed by one correct one. Dropping the first was measured on
# 2026-08-25 with mean linear luminance, came out inconsistent in direction
# (closer on 3 of 6, worse on 3), and was declined IN A COMMITTED COMMENT.
# Re-measured on 2026-08-26 with ssimulacra2 it is +27.5 mean over 10 frames and
# better on 10 of 10, and #600 adopted it.
#
# Both numbers were correct about what they measured, which is the whole lesson.
# **Mean linear luminance is one scalar per frame.** A gamma-incorrect reduction
# misplaces energy WITHIN the frame while preserving its average almost exactly,
# so the metric was structurally incapable of seeing the defect — and the
# property that made it attractive (no reference image, therefore no reference
# bias) is exactly the property that blinded it. A reference-free metric is not a
# safer metric, it is a narrower one.
#
# THE REFERENCE IS THE OTHER TRAP, and it is why this script does not simply
# score against `zenc square` at full resolution. That reference IS candidate B,
# so it would be scoring one candidate against itself; `matched-bytes-probe.py`'s
# header records the same warning from the other direction. The way out is that
# ROTATION AND CROPPING RESAMPLE NOTHING — they select and re-index samples — so
# sips can do those with no filter bias at all, and only the final reduction
# needs an independent implementation. That is ffmpeg here, and zenc's own kernel
# is scored alongside it to keep the size of the bias visible rather than
# assumed.
#
# Measured 2026-08-26 over the default sample, ssimulacra2, higher is better:
#
#   reference                        two-step   one-step    delta   B wins
#   ffmpeg lanczos (independent)        51.39      78.64   +27.25    10/10
#   ffmpeg area    (independent)        50.84      80.08   +29.24    10/10
#   zenc lanczos3  (self-referential)   54.48      86.07   +31.59    10/10
#
# So reference bias is real and worth about 4 points here, and the finding
# survives it. Re-run this before touching the ingest geometry again.
#
# ONE ROW OF THE TABLE IS NOT COMPARABLE AND THE SUMMARY DELIBERATELY DOES NOT
# HIDE IT. The Leica frame is Gray Gamma 2.2, so both candidates linearise with
# the curve its profile declares while the ffmpeg references have no notion of a
# source transfer at all. Both candidates therefore score ~37 against those two
# references, far below every sRGB frame, and the gap between them collapses to
# +0.6 — that is the REFERENCE being wrong for that file, not the candidates
# converging. zenc's own kernel, which does know the curve, reads 77.92 against
# 85.48 on the same frame. Over the nine sRGB frames alone the independent
# lanczos delta is +30.21 rather than +27.25, so including the Leica makes the
# headline number CONSERVATIVE, which is the direction to err in and the reason
# it is still in the sample rather than quietly dropped.
#
# ONE VARIABLE MOVES between the candidates: whether the 2000px pre-reduction
# happens. Both use the same binary, the same --orient and the same --transfer,
# so neither the rotation bug (gotcha 3) nor the Monochrom's Gray Gamma 2.2 can
# contaminate the comparison the way they could before #599 and #600.
#
#   A  two-step, the pre-#600 pipeline:  sips -Z 2000  ->  zenc square
#   B  one-step, what ships today:       full-resolution decode -> zenc square
#
# usage:
#   ./tools/photos/onestep-probe.sh                 # the 10-frame default sample
#   ./tools/photos/onestep-probe.sh XT500010.HIF L1000069_3.jpg
#   SRC=/some/folder ./tools/photos/onestep-probe.sh a.HIF
#
# Nothing here is written into the repository: it reads the source folder and
# works in a temp directory it removes on exit.
set -euo pipefail

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
SRC="${SRC:-/Users/aadharsh/Downloads/to post (from ssd)}"
SQ="${SQ:-600}"

ZENC_DIR="$SCRIPT_DIR/zenc"
ZENC="$ZENC_DIR/target/release/zenc"
# Same resolution the metric gets in export-for-instagram.sh: ssimulacra2 is a
# libjxl TOOL, and `brew install jpeg-xl` does not ship it, so a from-source
# build under /opt/zerobrew is the fallback rather than an error.
# Overridable so the failure path below can be CONTROLLED (`SSIMULACRA2=/bin/false
# ./tools/photos/onestep-probe.sh …` must print FAIL and exit 1). A counter that
# has never been seen to fire is not a counter.
SSIMULACRA2="${SSIMULACRA2:-$(command -v ssimulacra2 || echo /opt/zerobrew/prefix/bin/ssimulacra2)}"

for cmd in sips exif-sooc ffmpeg; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "error: $cmd not found in PATH" >&2
    case "$cmd" in
      exif-sooc) echo "  install with: cargo install --git https://github.com/oddharsh/exif-sooc exif-sooc" >&2 ;;
      ffmpeg)    echo "  install with: brew install ffmpeg" >&2 ;;
    esac
    exit 1
  fi
done
if [ ! -x "$SSIMULACRA2" ]; then
  echo "error: ssimulacra2 not found (looked on PATH and at /opt/zerobrew/prefix/bin)" >&2
  echo "  build libjxl with -DJPEGXL_ENABLE_TOOLS=ON; brew's jpeg-xl does not ship it" >&2
  exit 1
fi
if [ ! -x "$ZENC" ]; then
  command -v cargo >/dev/null 2>&1 || { echo "error: cargo (rust) not found; install from https://rustup.rs" >&2; exit 1; }
  echo "building zenc — first run only…" >&2
  cargo build --release --locked --manifest-path "$ZENC_DIR/Cargo.toml" >&2
fi
[ -d "$SRC" ] || { echo "error: source folder not found: $SRC" >&2; exit 1; }

TMP="/tmp/aadhar-onestep-probe-$$"
mkdir -p "$TMP"
trap 'rm -rf "$TMP"' EXIT

# The default sample: 8 Fuji frames spanning orientations 1, 6 and 8, one Leica
# Monochrom frame (the Gray Gamma 2.2 path), and both source containers. Pass
# your own filenames to override.
if [ $# -gt 0 ]; then
  FRAMES=("$@")
else
  FRAMES=(XT500010.HIF XT500026.HIF XT500068.HIF XT500069.HIF XT500132.HIF \
          XT500183.HIF L1000069_3.jpg L1009920.JPG XT507876.JPG XT500144.HIF)
fi

# A metric that cannot run must SAY so rather than score 0 or abort the sweep:
# a silent zero would read as a catastrophic candidate, and gotcha 40 is the bill
# for a pipeline whose status came from the wrong end of it. Failures are counted
# and the run exits non-zero at the bottom.
#
# The tally goes through a FILE rather than a variable, and that is load-bearing
# rather than fussy: `score` is always called as `$(score …)`, which runs it in a
# SUBSHELL, so a `FAILED=$((FAILED+1))` inside it increments a copy that is
# discarded the moment the substitution closes. The counter would read 0 through
# any number of failures and the run would exit 0 over partial means.
FAILS="$TMP/fails"; : > "$FAILS"
score() {  # score <ref.png> <candidate.png>
  local out
  if ! out=$("$SSIMULACRA2" "$1" "$2" 2>/dev/null); then
    echo x >> "$FAILS"; printf 'FAIL'; return 0
  fi
  printf '%s' "$out" | awk 'NR==1{printf "%.2f", $1}'
}

ROWS="$TMP/rows.txt"; : > "$ROWS"
printf "%-14s %3s %-4s | %13s %13s | %13s %13s | %13s %13s\n" \
  stem ori xfer "A ffmpeg-lcz" "B ffmpeg-lcz" "A ffmpeg-area" "B ffmpeg-area" "A zenc-lcz3" "B zenc-lcz3"

for f in "${FRAMES[@]}"; do
  src="$SRC/$f"
  [ -f "$src" ] || { echo "  ${f}: not found in $SRC" >&2; continue; }
  stem="$(basename "${f%.*}")"

  o=$(exif-sooc -s -s -s -n -Orientation "$src" 2>/dev/null) || o=""
  case "$o" in [1-8]) ;; *) o=1 ;; esac
  # The source's transfer curve, exactly as the shipping scripts decide it.
  transfer=srgb
  profile=$(sips -g profile "$src" 2>/dev/null | awk '/profile:/{sub(/^ *profile: /,""); print}') || profile=""
  [ "$profile" = "Gray Gamma 2.2" ] && transfer=g22

  # Full-resolution decode. Used to BUILD THE REFERENCE for every source, and
  # fed to candidate B for the HEIF containers zenc cannot read itself.
  full="$TMP/$stem.full.tif"
  sips -s format tiff "$src" --out "$full" >/dev/null 2>&1 \
    || { echo "  ${stem}: full-resolution decode failed" >&2; continue; }

  # ── the reference, built from EXACT operations only ──────────────────────
  # Rotate, then centre-crop. Both select or re-index samples and neither
  # averages any, so sips contributes no filter bias; only the reduction below
  # is a resampler, and that is the part each reference varies.
  rot="$TMP/$stem.rot.tif"; cp "$full" "$rot"
  case "$o" in
    2) sips -f horizontal "$rot" >/dev/null 2>&1 ;;
    3) sips -r 180 "$rot" >/dev/null 2>&1 ;;
    4) sips -f vertical "$rot" >/dev/null 2>&1 ;;
    5) sips -r 90  "$rot" >/dev/null 2>&1; sips -f horizontal "$rot" >/dev/null 2>&1 ;;
    6) sips -r 90  "$rot" >/dev/null 2>&1 ;;
    7) sips -r 270 "$rot" >/dev/null 2>&1; sips -f horizontal "$rot" >/dev/null 2>&1 ;;
    8) sips -r 270 "$rot" >/dev/null 2>&1 ;;
  esac
  d=$(sips -g pixelWidth -g pixelHeight "$rot" 2>/dev/null)
  rw=$(printf '%s\n' "$d" | awk '/pixelWidth/{print $2}')
  rh=$(printf '%s\n' "$d" | awk '/pixelHeight/{print $2}')
  case "$rw$rh" in ''|*[!0-9]*) echo "  ${stem}: unreadable dimensions" >&2; rm -f "$full" "$rot"; continue ;; esac
  side=$(( rw < rh ? rw : rh ))
  crop="$TMP/$stem.crop.png"
  sips -c "$side" "$side" "$rot" --out "$TMP/$stem.crop.tif" >/dev/null 2>&1
  sips -s format png "$TMP/$stem.crop.tif" --out "$crop" >/dev/null 2>&1

  reflcz="$TMP/$stem.ref-lcz.png"; refarea="$TMP/$stem.ref-area.png"; refzen="$TMP/$stem.ref-zen.png"
  ffmpeg -hide_banner -loglevel error -y -i "$crop" -sws_flags lanczos -vf "scale=$SQ:$SQ" "$reflcz" 2>/dev/null
  ffmpeg -hide_banner -loglevel error -y -i "$crop" -sws_flags area    -vf "scale=$SQ:$SQ" "$refarea" 2>/dev/null
  "$ZENC" square "$full" --orient "$o" --transfer "$transfer" --filter lanczos3 \
    --size "$SQ" --out "$refzen" >/dev/null 2>&1

  # ── candidate A: the two-step, as the pipeline ran it before #600 ────────
  work="$TMP/$stem.work.jpg"; a="$TMP/$stem.a.png"
  sips -Z 2000 -s format jpeg --setProperty formatOptions 100 "$src" --out "$work" >/dev/null 2>&1
  "$ZENC" square "$work" --orient "$o" --transfer "$transfer" --filter box \
    --size "$SQ" --out "$a" >/dev/null 2>&1

  # ── candidate B: one step from full resolution, as it ships today ────────
  # JPEG sources go straight in; zenc decodes those itself, and only the HEIF
  # containers need the TIFF door. Same split the shipping scripts make.
  binput="$full"
  case "${f##*.}" in [Jj][Pp][Gg]|[Jj][Pp][Ee][Gg]) binput="$src" ;; esac
  b="$TMP/$stem.b.png"
  "$ZENC" square "$binput" --orient "$o" --transfer "$transfer" --filter box \
    --size "$SQ" --out "$b" >/dev/null 2>&1

  al=$(score "$reflcz" "$a");   bl=$(score "$reflcz" "$b")
  aa=$(score "$refarea" "$a");  ba=$(score "$refarea" "$b")
  az=$(score "$refzen" "$a");   bz=$(score "$refzen" "$b")
  printf "%-14s %3s %-4s | %13s %13s | %13s %13s | %13s %13s\n" \
    "$stem" "$o" "$transfer" "$al" "$bl" "$aa" "$ba" "$az" "$bz"
  printf "%s %s %s %s %s %s\n" "$al" "$bl" "$aa" "$ba" "$az" "$bz" >> "$ROWS"

  # Deleted per frame rather than by the trap: a full-resolution TIFF is ~311MB,
  # and a 10-frame run holding them all would want 3GB of /tmp.
  rm -f "$full" "$rot" "$TMP/$stem.crop.tif" "$crop" "$work"
done

echo ""
awk '{ if ($1=="FAIL"||$2=="FAIL") next; n++; al+=$1; bl+=$2; aa+=$3; ba+=$4; az+=$5; bz+=$6;
       if ($2>$1) wl++; if ($4>$3) wa++; if ($6>$5) wz++ }
     END {
       if (!n) { print "no frames scored"; exit }
       printf "  %-32s %8s %8s %8s %8s\n", "reference", "two-step", "one-step", "delta", "B wins";
       printf "  %-32s %8.2f %8.2f %+8.2f %5d/%d\n", "ffmpeg lanczos (independent)",     al/n, bl/n, (bl-al)/n, wl, n;
       printf "  %-32s %8.2f %8.2f %+8.2f %5d/%d\n", "ffmpeg area (independent)",        aa/n, ba/n, (ba-aa)/n, wa, n;
       printf "  %-32s %8.2f %8.2f %+8.2f %5d/%d\n", "zenc lanczos3 (self-referential)", az/n, bz/n, (bz-az)/n, wz, n;
     }' "$ROWS"

failed=$(wc -l < "$FAILS" | tr -d ' ')
if [ "$failed" -gt 0 ]; then
  echo "" >&2
  echo "error: ssimulacra2 failed on $failed comparison(s); the means above are PARTIAL" >&2
  exit 1
fi
