#!/usr/bin/env bash
# export-for-instagram.sh — export a photo at the LOWEST JPEG quality that still
# clears a perceptual floor, at phone-delivery scale.
#
# This is the tool /pixel-peeper was built to calibrate. The exam asks which of
# three real encodes you can tell apart; this asks the same question with a
# metric standing in for your eye, and writes the file at the answer.
#
# per source file:
#   1. decode to a lossless PNG, bake in the EXIF rotation, and resample so the
#      WIDTH lands on --width. Two traps live in that one step, both measured
#      rather than assumed (2026-08-13):
#        - sips does NOT apply EXIF Orientation on decode. XT500010 is
#          Orientation 8 and comes out of `sips -s format png` still 7728x5152
#          landscape, while metadata.json records it as 5152x7728. So the
#          rotation is applied explicitly, on the PNG, where it costs nothing.
#        - the cap goes on WIDTH. Instagram's constraint is horizontal
#          resolution, so a 4:5 portrait wants 1080x1350; `sips -Z 1080` fits
#          the LONGEST edge and would have handed it 864x1080, throwing away a
#          fifth of the pixels.
#   2. binary-search zenc's quality knob for the SMALLEST q whose ssimulacra2
#      score against that PNG still clears --target (and, when you set one, whose
#      butteraugli distance stays under --ba-max).
#   3. write <out>/<stem>.jpg and report the q, the bytes, both metric scores,
#      and what the search saved against a flat --qmax export.
#
# Every measurement references the DOWNSCALED PNG, never the original frame.
# Scoring against the full-res source would score the resample, which is not the
# decision being made here.
#
# WHAT THIS IS NOT FOR, and this one is measured too: uploading to Instagram.
# IG re-encodes whatever you hand it, so bytes a search saves are discarded
# before anyone sees them, while the two lossy passes compound. XT500010 at 1080
# wide, through a simulated q75 re-encode:
#
#     ref -> IG q75            116,462 B    ssimulacra2 68.00
#     ref -> q95 -> IG q75     114,803 B    ssimulacra2 66.92
#     ref -> q85 -> IG q75     115,872 B    ssimulacra2 65.39
#
# Under 2% apart on bytes, and every pre-compression pass costs score. So for an
# actual IG upload use --max, which skips the search and hands the platform the
# cleanest source it will take. The search earns its keep on exports you deliver
# YOURSELF: a site, an AirDrop, a DM carrying the real file.
#
# --target has no universally right value and this script does not pretend
# otherwise. The default is 84, DERIVED (see the block at TARGET= below) rather
# than taken off ssimulacra2's published scale, and it is still a PLACEHOLDER for
# a number only your own eye can set. Run --calibrate, which writes every rung as
# a real file next to the reference PNG, put them on the phone you actually post
# from, and find where you stop seeing the difference. Pass that as --target from
# then on.
#
# CALIBRATE AGAIN IF YOU CALIBRATED BEFORE 2026-08-25. The resample changed that
# day, and this target is scored against the resized frame, so a number tuned
# against the old one does not carry over. That is the whole argument at TARGET=.
#
# Expect the ladder to sit high, because 1080 wide is a dense delivery scale: a
# downscaled 40MP frame is high-frequency in every tile, so there is nothing
# cheap left for the encoder to throw away. At 84 the winning q runs about 91 to
# 95 on the Fuji files and 83 to 88 on the Leica ones.
#
# The 5-frame measurement that used to sit here (winning q 78 to 95, saving
# 46-65% against a flat q95, with XT509346's Nostalgic Neg grain unable to clear
# 70 at any quality) was taken against the SIPS reference and does not describe
# this tool any more. Grain being expensive is still true and is still why a miss
# is reported by name instead of being rounded away; the numbers are not, and are
# left here named as stale rather than quietly deleted, because somebody who
# remembers them needs to know they expired.
#
# usage:
#   ./tools/photos/export-for-instagram.sh photo.HIF
#   ./tools/photos/export-for-instagram.sh -t 84 "/path/to/folder/"
#   ./tools/photos/export-for-instagram.sh --calibrate XT500010.HIF
#   ./tools/photos/export-for-instagram.sh --max XT500010.HIF     # for IG itself
#
# options:
#   -o, --out DIR      output directory        (default ~/Desktop/ig-export)
#   -w, --width N      delivery width cap      (default 1080)
#   -t, --target N     ssimulacra2 floor       (default 84)
#   -q, --qmax N       quality ceiling         (default 95)
#       --qmin N       quality floor           (default 50)
#       --ba-max N     butteraugli ceiling, second gate  (default off)
#       --yuv X        444 | 422 | 420         (default 420)
#       --calibrate    write the ladder + reference, export nothing
#       --max          skip the search, encode at --qmax
#       --keep-exif    carry the source EXIF across, GPS and all. the default
#                      strips everything, which is what you want for anything
#                      leaving your machine.
#   -n, --dry-run      search and report, write no exports

set -euo pipefail

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
ZENC_DIR="$SCRIPT_DIR/zenc"
ZENC="$ZENC_DIR/target/release/zenc"
SSIMULACRA2="$(command -v ssimulacra2 || echo /opt/zerobrew/prefix/bin/ssimulacra2)"
BUTTERAUGLI="$(command -v butteraugli_main || echo /opt/zerobrew/prefix/bin/butteraugli_main)"

OUT="$HOME/Desktop/ig-export"
WIDTH=1080
# 84 rather than the 70 this carried until 2026-08-25, and the reason is that
# THE TARGET IS CALIBRATED AGAINST THE REFERENCE, so replacing the reference
# silently rescaled it. ssimulacra2 here scores the encode against the resized
# frame, which measures encode FIDELITY and says nothing about whether the frame
# itself is any good. sips left aliasing the DCT could not reproduce, so 70 was
# expensive and often unreachable; a clean reference is easy to match, so the
# same 70 was suddenly bought at q50 and shipped a heavily compressed file.
#
# Scored against a common ground truth (an independent PIL Lanczos downscale in
# linear light), delivered quality, KB beside it:
#
#                      old (sips)      t=70        t=78        t=84
#     L1000069_3      76.55   73KB   69.91 24KB  75.94 29KB  80.80  39KB
#     L1009920        76.64  235KB   67.64 60KB  74.94 84KB  80.31 133KB
#     XT509996        64.66  155KB     --        75.50 336KB 79.38 548KB
#     XT507399        59.67  232KB     --        72.31 380KB 77.02 585KB
#
# So t=70 on the new reference is WORSE than the tool it replaced, which is the
# regression this fixes. t=84 lands ~80 on both cameras: the Leica beats the old
# output at 43% fewer bytes, and the Fuji gains 16 points at about 3x the bytes
# because the old tool had been delivering it at 60, not because 84 is greedy.
#
# Two things worth keeping past this number. A RELATIVE metric's threshold is a
# property of the reference, so any future change to prepare_reference has to
# re-derive it rather than inherit it. And the old tool's own report was lying in
# BOTH directions: L1000069_3 scored 58.41 against sips' reference while scoring
# 76.55 against truth, because JPEG's low-pass was quietly undoing some of the
# aliasing, so a file it declared a failure was the better one.
#
# Expect the occasional MISSED at q95. That is the report being honest about a
# frame the encoder cannot carry, and it is preferable to a target low enough
# that nothing ever misses.
TARGET=84
QMAX=95
QMIN=50
BA_MAX=""
YUV=420
MODE=search
KEEP_EXIF=0
DRY=0

LADDER="60 70 75 80 85 88 90 92 95"

# ── arguments ─────────────────────────────────────────────────────────
ARGS=()
while [ $# -gt 0 ]; do
  case "$1" in
    -o|--out)      OUT="$2"; shift 2 ;;
    -w|--width)    WIDTH="$2"; shift 2 ;;
    -t|--target)   TARGET="$2"; shift 2 ;;
    -q|--qmax)     QMAX="$2"; shift 2 ;;
    --qmin)        QMIN="$2"; shift 2 ;;
    --ba-max)      BA_MAX="$2"; shift 2 ;;
    --yuv)         YUV="$2"; shift 2 ;;
    --calibrate)   MODE=calibrate; shift ;;
    --max)         MODE=max; shift ;;
    --keep-exif)   KEEP_EXIF=1; shift ;;
    -n|--dry-run)  DRY=1; shift ;;
    # the header block IS the help, read to wherever it happens to end. A
    # hardcoded line range silently truncates the last option the day someone
    # adds a sentence above it, which it already did once.
    -h|--help)     awk 'NR>1 && /^#/{sub(/^# ?/,""); print; next} NR>1{exit}' "$0"; exit 0 ;;
    -*)            echo "unknown option: $1" >&2; exit 1 ;;
    *)             ARGS+=("$1"); shift ;;
  esac
done

if [ ${#ARGS[@]} -eq 0 ]; then
  echo "usage: $0 [options] <file-or-dir>...   ($0 --help)" >&2
  exit 1
fi
case "$YUV" in 444|422|420) ;; *) echo "error: --yuv must be 444, 422 or 420" >&2; exit 1 ;; esac
whole() {  # whole <flag> <value>
  case "$2" in ''|*[!0-9]*) echo "error: $1 needs a whole number, got '$2'" >&2; exit 1 ;; esac
}
whole --width "$WIDTH"; whole --qmax "$QMAX"; whole --qmin "$QMIN"
[ "$QMIN" -le "$QMAX" ] || { echo "error: --qmin ($QMIN) is above --qmax ($QMAX)" >&2; exit 1; }

# ── preconditions ─────────────────────────────────────────────────────
for cmd in sips exif-sooc; do
  command -v "$cmd" >/dev/null 2>&1 || { echo "error: $cmd not found in PATH" >&2; exit 1; }
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
for tool in "$SSIMULACRA2" "$BUTTERAUGLI"; do
  [ -x "$tool" ] || { echo "error: $(basename "$tool") not found (brew install jpeg-xl)" >&2; exit 1; }
done
if [ ! -x "$ZENC" ]; then
  command -v cargo >/dev/null 2>&1 || { echo "error: cargo (rust) not found; install from https://rustup.rs" >&2; exit 1; }
  echo "building zenc (zenjpeg encoder) — first run only…" >&2
  cargo build --release --manifest-path "$ZENC_DIR/Cargo.toml" >&2
fi

TMP="$(mktemp -d "/tmp/ig-export-$$-XXXX")"
trap 'rm -rf "$TMP"' EXIT

# ── helpers ───────────────────────────────────────────────────────────
# float comparison, since the shell only does integers
ge() { awk -v a="$1" -v b="$2" 'BEGIN{exit !(a>=b)}'; }
le() { awk -v a="$1" -v b="$2" 'BEGIN{exit !(a<=b)}'; }

s2()  { "$SSIMULACRA2" "$1" "$2" 2>/dev/null | awk 'NR==1{printf "%.2f", $1}'; }
ba()  { "$BUTTERAUGLI" "$1" "$2" 2>/dev/null | awk 'NR==1{printf "%.3f", $1}'; }
kb()  { awk -v b="$1" 'BEGIN{printf "%.1f KB", b/1024}'; }
pct() { awk -v a="$1" -v b="$2" 'BEGIN{printf "%+.0f%%", (a-b)*100/b}'; }

# EXIF Orientation → the clockwise rotation + flip that brings pixels upright.
# sips ignores the tag on decode, so this is applied by hand on the PNG.
orient_ops() {
  local o; o=$(exif-sooc -s -s -s -n -Orientation "$1" 2>/dev/null || echo "")
  case "$o" in
    ""|1) echo "" ;;      2) echo "f:horizontal" ;;   3) echo "r:180" ;;
    4)    echo "f:vertical" ;;  5) echo "r:90 f:horizontal" ;;  6) echo "r:90" ;;
    7)    echo "r:270 f:horizontal" ;;  8) echo "r:270" ;;  *) echo "" ;;
  esac
}

# decode → upright → width-capped PNG. This is the reference every score is
# measured against, and the only input the encoder ever sees.
#
# THE RESAMPLE IS zenc's, NOT sips', AND THE REASON IS GAMMA. sips averages
# pixels in ENCODED sRGB, which is a curve, so the mean of two samples is not
# the mean of the light they stand for. Measured on a 1px black/white
# checkerboard reduced 16x, where the correct answer is sRGB 187.5:
#
#     sips -Z                 127.75
#     sips --resampleWidth    127.75    <- what this script used until 2026-08-25
#     zenc resize             188.00    <- the 0.5 is 8-bit quantisation
#
# 127.75 is the average of 0 and 255 as CODES. Every reduction this tool
# performed was darkening the frame it was about to spend a quality search on,
# and then scoring that frame against itself, so nothing in the report could see
# it. ig-prep has been correct here all along (fast_image_resize in linear
# light); this brings the shell path level with it.
#
# THE INTERMEDIATE IS TIFF BECAUSE IT HAS TO BE LOSSLESS AND PNG IS TOO SLOW.
# zenc cannot decode HEIF, so sips still owns the decode, and asking it for a
# full-resolution lossless frame is the only way to hand zenc every pixel. On a
# 7728x5152 HIF, `sips -s format png` spends 6222ms deflating 160MB where
# `sips -s format tiff` spends 509ms writing 311MB. Same pixels, 10.6x apart.
#
# WHAT IT COSTS, measured on that frame, since this is slower than what it
# replaced and pretending otherwise would be the easy mistake:
#
#     old   sips -s format png --resampleWidth 1080          549 ms
#     new   sips -s format tiff  +  zenc resize --width      937 ms
#
# 388ms a photo, plus a 311MB temp file that is deleted before the next one is
# read. Paid deliberately: this is a tool whose entire job is squeezing the last
# ssimulacra2 point out of an encode, and it was feeding that search a reference
# that had already lost more than the search could ever win back.
#
# GAMMA IS NOT THE ONLY DEFECT, and the first draft of this comment claimed it
# was. It said box is what sips was approximating so the swap is gamma alone.
# Measured against five encoded-sRGB kernels on the same frame, sips matches
# NONE of them: box 57.77, hamming 58.03, bilinear 59.34, bicubic 59.71,
# lanczos 58.72. A real kernel family difference puts one of those near 90, and
# a flat low cluster means the thing being compared is not a clean filter.
#
# The checkerboard says what it is. Reduced 16x, a correct average leaves ONE
# value and therefore no variance:
#
#     PIL box, encoded sRGB    mean 128.00   std 0.00   range 128..128
#     zenc box, linear light   mean 188.00   std 0.00   range 188..188
#     sips --resampleWidth     mean 127.75   std 1.77   range  96..159
#
# So sips low-passes roughly right and leaves +/-32 codes of aliasing on a field
# that has one correct answer. Two defects, and zenc fixes both. Read the low
# ssimulacra2 between the old and new references (51-60 across three frames) as
# sips being wrong twice rather than as box being soft.
#
# --filter box because the corpus pipeline already chose it and matching sips is
# not a goal once sips is not a clean anything. Lanczos3 is available and
# sharper, and this tool can price it directly, since it searches for the lowest
# q clearing the target and a sharper reference costs the encoder bits. Same
# three frames, same q on all three:
#
#     box        24.1 KB   292.3 KB   184.7 KB
#     lanczos3   24.9 KB   312.9 KB   197.0 KB      +3.3%  +7.0%  +6.7%
#
# So lanczos3 is a real option that costs about 6% for sharpness, not a free
# upgrade. Reach for it per-run if a frame needs it.
#
# Which AXIS to cap is the subtle half, and it survives the rewrite unchanged
# because zenc reads the same stored pixels sips wrote: a frame the camera
# tagged Orientation 5-8 is stored on its side, so capping its stored width
# would cap the delivered HEIGHT. Same swap rule as metadata.json's (CLAUDE.md
# gotcha 6), applied before the rotation rather than after.
#
# ROTATION STAYS ON sips. `-r` and `-f` move samples without inventing any, so
# there is no averaging to get wrong, and they run on the 1080px output rather
# than the 40MP source.
prepare_reference() {  # prepare_reference <src> <out.png>
  local src="$1" ref="$2" o ops axis w h
  o=$(exif-sooc -s -s -s -n -Orientation "$src" 2>/dev/null || echo "")
  ops=$(orient_ops "$src")
  # One spawn for both, the same shape dims() below already used.
  srcdims=$(sips -g pixelWidth -g pixelHeight "$src" 2>/dev/null)
  w=$(printf '%s\n' "$srcdims" | awk '/pixelWidth/{print $2}')
  h=$(printf '%s\n' "$srcdims" | awk '/pixelHeight/{print $2}')
  # sips answers `<nil>` rather than failing when handed something that is not
  # an image, and `<nil>` is non-empty, so an emptiness check passes it straight
  # into an integer comparison and spills a bash error over the report.
  case "$w$h" in ''|*[!0-9]*) return 1 ;; esac
  case "$o" in
    5|6|7|8) axis="--height" ;;
    *)       axis="--width"  ;;
  esac
  # `--width N` is a CAP rather than a target, so a source already inside it
  # passes through untouched and there is no branch to keep in step. That is why
  # the old if/else is gone rather than translated.
  local mid="$TMP/$(basename "$ref" .png)-mid.tiff"
  sips -s format tiff "$src" --out "$mid" >/dev/null 2>&1 || { rm -f "$mid"; return 1; }
  "$ZENC" resize "$mid" "$axis" "$WIDTH" --filter box --out "$ref" >/dev/null 2>&1 || { rm -f "$mid"; return 1; }
  # Deleted HERE rather than by the EXIT trap: these are ~311MB apiece, and a
  # 160-photo run holding them all would want 50GB of /tmp.
  rm -f "$mid"
  for op in $ops; do
    case "$op" in
      r:*) sips -r "${op#r:}" "$ref" >/dev/null 2>&1 || return 1 ;;
      f:*) sips -f "${op#f:}" "$ref" >/dev/null 2>&1 || return 1 ;;
    esac
  done
  return 0
}

dims() { sips -g pixelWidth -g pixelHeight "$1" 2>/dev/null | awk '/pixelWidth/{w=$2} /pixelHeight/{h=$2} END{print w"x"h}'; }

# does this encode clear every gate it was given?
clears() {  # clears <s2> <ba>
  ge "$1" "$TARGET" || return 1
  [ -z "$BA_MAX" ] || le "$2" "$BA_MAX" || return 1
  return 0
}

finish() {  # finish <candidate.jpg> <stem> <source> — place it, metadata handled
  local cand="$1" stem="$2" src="$3" dest="$OUT/$stem.jpg"
  mkdir -p "$OUT"
  cp "$cand" "$dest"
  if [ "$KEEP_EXIF" -eq 1 ]; then
    # Orientation is FORCED to 1, and the export is wrong without it. The
    # rotation is already baked into these pixels, so carrying the source tag
    # across tells every viewer that honours EXIF to turn the frame a second
    # time — a portrait shot lands on its side, in the one mode that was
    # supposed to preserve more.
    exif-sooc -TagsFromFile "$src" -all:all "-Orientation#=1" -overwrite_original "$dest" >/dev/null 2>&1 || true
  else
    exif-sooc -all= -overwrite_original "$dest" >/dev/null 2>&1 || true
  fi
  stat -f%z "$dest"
}

# ── enumerate inputs ──────────────────────────────────────────────────
SOURCES="$TMP/sources.txt"; : > "$SOURCES"
for arg in "${ARGS[@]}"; do
  if [ -d "$arg" ]; then
    find "$arg" -maxdepth 1 -type f \( -iname "*.jpg" -o -iname "*.jpeg" \
      -o -iname "*.heic" -o -iname "*.heif" -o -iname "*.hif" -o -iname "*.png" \
      -o -iname "*.tif" -o -iname "*.tiff" \) >> "$SOURCES"
  elif [ -f "$arg" ]; then
    echo "$arg" >> "$SOURCES"
  else
    echo "warning: skipping $arg (not a file or directory)" >&2
  fi
done
sort -u "$SOURCES" -o "$SOURCES"
TOTAL=$(wc -l < "$SOURCES" | tr -d ' ')
[ "$TOTAL" -gt 0 ] || { echo "no eligible photos found in input(s)" >&2; exit 1; }

# ── report the run before it starts ───────────────────────────────────
case "$MODE" in
  search)    echo "searching $TOTAL file(s) for the lowest q clearing ssimulacra2 >= $TARGET${BA_MAX:+ and butteraugli <= $BA_MAX}" ;;
  max)       echo "encoding $TOTAL file(s) flat at q$QMAX — the mode for handing Instagram a source it will re-encode" ;;
  calibrate) echo "building the quality ladder for $TOTAL file(s) — flip through these on the phone you post from" ;;
esac
echo "  ${WIDTH}px wide · zenc ${YUV:0:1}:${YUV:1:1}:${YUV:2:1} · $([ "$KEEP_EXIF" -eq 1 ] && echo "EXIF carried" || echo "metadata stripped")"
[ "$DRY" -eq 1 ] && echo "  DRY RUN — measuring only, nothing will be written"
echo ""

OK=0; MISS=0; FAIL=0
while IFS= read -r f; do
  base=$(basename "$f"); stem="${base%.*}"
  ref="$TMP/$stem-ref.png"
  if ! prepare_reference "$f" "$ref"; then
    echo "  $stem — could not decode, skipped"; FAIL=$((FAIL+1)); continue
  fi
  size=$(dims "$ref")

  # ---- calibrate: every rung as a real file, next to the reference ----
  if [ "$MODE" = calibrate ]; then
    dir="$OUT/$stem-ladder"
    [ "$DRY" -eq 0 ] && { mkdir -p "$dir"; cp "$ref" "$dir/original.png"; }
    echo "$stem  $size"
    printf "    %-4s %-11s %-8s %-8s %s\n" q bytes ssim2 butter ""
    for q in $LADDER; do
      cand="$TMP/$stem-$q.jpg"
      "$ZENC" "$ref" "$cand" -q "$q" --yuv "$YUV" >/dev/null 2>&1 || continue
      b=$(stat -f%z "$cand"); sc=$(s2 "$ref" "$cand"); bc=$(ba "$ref" "$cand")
      mark=""; clears "$sc" "$bc" && mark="← clears $TARGET"
      printf "    %-4s %-11s %-8s %-8s %s\n" "$q" "$(kb "$b")" "$sc" "$bc" "$mark"
      [ "$DRY" -eq 0 ] && cp "$cand" "$dir/q$q.jpg"
    done
    echo ""
    OK=$((OK+1)); continue
  fi

  # ---- the q95 baseline, so the search can report what it saved ----
  top="$TMP/$stem-top.jpg"
  "$ZENC" "$ref" "$top" -q "$QMAX" --yuv "$YUV" >/dev/null 2>&1 || { echo "  $stem — encode failed"; FAIL=$((FAIL+1)); continue; }
  top_bytes=$(stat -f%z "$top")

  # ---- max: no search, hand over the cleanest source ----
  if [ "$MODE" = max ]; then
    sc=$(s2 "$ref" "$top"); bc=$(ba "$ref" "$top")
    if [ "$DRY" -eq 0 ]; then out_bytes=$(finish "$top" "$stem" "$f"); else out_bytes=$top_bytes; fi
    printf "  %-14s %-11s q%-3s %-11s s2 %-7s ba %s\n" "$stem" "$size" "$QMAX" "$(kb "$out_bytes")" "$sc" "$bc"
    OK=$((OK+1)); continue
  fi

  # ---- search: smallest q clearing every gate ----
  # both gates move monotonically with q, so bisection is sound: every q above a
  # passing one also passes, every q below a failing one also fails.
  lo=$QMIN; hi=$QMAX; best=""; best_s2=""; best_ba=""; best_file=""
  while [ "$lo" -le "$hi" ]; do
    mid=$(( (lo + hi) / 2 ))
    cand="$TMP/$stem-try.jpg"
    "$ZENC" "$ref" "$cand" -q "$mid" --yuv "$YUV" >/dev/null 2>&1 || break
    sc=$(s2 "$ref" "$cand")
    # butteraugli runs inside the loop only when it is actually a gate. Left on
    # unconditionally it doubled the metric cost of every probe to produce a
    # number nothing read until the winner was already picked.
    if [ -n "$BA_MAX" ]; then bc=$(ba "$ref" "$cand"); else bc=""; fi
    if clears "$sc" "$bc"; then
      best=$mid; best_s2=$sc; best_ba=$bc
      best_file="$TMP/$stem-best.jpg"; cp "$cand" "$best_file"
      hi=$(( mid - 1 ))
    else
      lo=$(( mid + 1 ))
    fi
  done

  if [ -z "$best" ]; then
    # nothing in range clears it. ship the ceiling and say so rather than
    # silently writing a file that misses the bar you asked for.
    sc=$(s2 "$ref" "$top"); bc=$(ba "$ref" "$top")
    if [ "$DRY" -eq 0 ]; then out_bytes=$(finish "$top" "$stem" "$f"); else out_bytes=$top_bytes; fi
    printf "  %-14s %-11s q%-3s %-11s s2 %-7s ba %-7s MISSED target %s at q%s\n" \
      "$stem" "$size" "$QMAX" "$(kb "$out_bytes")" "$sc" "$bc" "$TARGET" "$QMAX"
    MISS=$((MISS+1)); continue
  fi

  best_bytes=$(stat -f%z "$best_file")
  [ -n "$best_ba" ] || best_ba=$(ba "$ref" "$best_file")
  if [ "$DRY" -eq 0 ]; then out_bytes=$(finish "$best_file" "$stem" "$f"); else out_bytes=$best_bytes; fi
  printf "  %-14s %-11s q%-3s %-11s s2 %-7s ba %-7s %s vs q%s\n" \
    "$stem" "$size" "$best" "$(kb "$out_bytes")" "$best_s2" "$best_ba" "$(pct "$best_bytes" "$top_bytes")" "$QMAX"
  OK=$((OK+1))
done < "$SOURCES"

echo ""
echo "done — $OK ok · $MISS missed target · $FAIL failed"
[ "$DRY" -eq 0 ] && [ "$MODE" != calibrate ] && echo "written to $OUT"
[ "$DRY" -eq 0 ] && [ "$MODE" = calibrate ] && echo "ladders in $OUT — the rung you stop seeing is your --target"
exit 0
