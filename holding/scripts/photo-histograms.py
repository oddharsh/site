#!/usr/bin/env python3
"""
photo-histograms.py — compute 64-bin luminance histograms for a folder
of photos and emit JSON keyed by stem. used by extract-photo-metadata.sh
to inline real histograms into metadata.json, which the Fuji LCD tooltip
renders on hover.

output shape: {"<stem>": [0..100, 0..100, ...] (64 values), ...}
the 64 values are normalized so the tallest bin reads 100; the rest are
proportional. that matches what a camera-back histogram shows (relative
distribution, not absolute pixel counts), and keeps the JSON small.

requires: Pillow. install with:
  pip3 install --user pillow
  # or, if you prefer a venv:
  python3 -m venv ~/.venvs/aadhar-sh && source ~/.venvs/aadhar-sh/bin/activate && pip install pillow

usage:
  ./photo-histograms.py /path/to/sooc-folder/  > histograms.json
"""
import json
import sys
from pathlib import Path

try:
    from PIL import Image, ImageOps
except ImportError:
    sys.stderr.write(
        "error: Pillow not installed. run:\n"
        "  pip3 install --user pillow pillow-heif\n"
    )
    sys.exit(2)

# Fuji X-T cameras (and Leica Q) write HEIF with a .HIF extension. base
# Pillow doesn't know HEIF; pillow-heif registers it as a format. without
# this, 60%+ of the photos in the SOOC folder would silently fail.
try:
    import pillow_heif  # noqa: F401
    pillow_heif.register_heif_opener()
except ImportError:
    sys.stderr.write(
        "warn: pillow-heif not installed. HIF/HEIF photos will be skipped.\n"
        "       install with:  pip3 install --user pillow-heif\n"
    )

EXTS = {".jpg", ".jpeg", ".heic", ".heif", ".hif"}
BINS = 64
THUMB_MAX = 512  # downsample for speed; histogram shape is preserved


def histogram_bars(path: Path) -> list[int]:
    """64-bin luminance histogram, normalized so the tallest bar reads 100."""
    with Image.open(path) as img:
        # respect EXIF orientation so the histogram matches what the viewer sees
        oriented = ImageOps.exif_transpose(img)
        # downsample to keep this fast on a folder of 100+ photos
        oriented.thumbnail((THUMB_MAX, THUMB_MAX))
        luma = oriented.convert("L")
        raw = luma.histogram()  # 256 ints
    bin_size = 256 // BINS
    binned = [sum(raw[i * bin_size:(i + 1) * bin_size]) for i in range(BINS)]
    peak = max(binned) or 1
    return [int(round(100 * b / peak)) for b in binned]


def main():
    if len(sys.argv) != 2:
        sys.stderr.write("usage: photo-histograms.py <directory>\n")
        sys.exit(1)
    src = Path(sys.argv[1])
    if not src.is_dir():
        sys.stderr.write(f"error: {src} is not a directory\n")
        sys.exit(1)

    result = {}
    failed = 0
    for f in sorted(src.iterdir()):
        if f.suffix.lower() not in EXTS:
            continue
        try:
            result[f.stem] = histogram_bars(f)
        except Exception as e:
            sys.stderr.write(f"warn: skipped {f.name}: {e}\n")
            failed += 1

    # compact JSON; the file ends up in metadata.json which we want small
    sys.stdout.write(json.dumps(result, separators=(",", ":")))
    sys.stdout.write("\n")
    sys.stderr.write(f"computed histograms for {len(result)} photos")
    if failed:
        sys.stderr.write(f", {failed} skipped")
    sys.stderr.write("\n")


if __name__ == "__main__":
    main()
