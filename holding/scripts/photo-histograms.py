#!/usr/bin/env python3
"""
photo-histograms.py — compute 64-bin RGB + luminance histograms for a
folder of photos and emit JSON keyed by stem. used by
extract-photo-metadata.sh to inline real histograms into metadata.json,
which the Fuji LCD tooltip renders on hover.

output shape per photo:
  {"l": [0..100, ...], "r": [...], "g": [...], "b": [...]}
each channel is 64 bins, normalized so the tallest bin in that channel
reads 100. matches what a camera-back RGB histogram shows: relative
distribution per channel, each scaled independently so a heavily
blue-shifted shot still reads its red and green channels clearly.

requires: Pillow + pillow-heif (for Fuji .HIF files). install with:
  pip3 install --user pillow pillow-heif

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


def _bin_normalize(raw: list[int]) -> list[int]:
    """take a 256-int channel histogram, return 64 bins normalized 0..100."""
    bin_size = 256 // BINS
    binned = [sum(raw[i * bin_size:(i + 1) * bin_size]) for i in range(BINS)]
    peak = max(binned) or 1
    return [int(round(100 * b / peak)) for b in binned]


def histogram_bars(path: Path) -> dict[str, list[int]]:
    """RGB + luminance histograms, each 64 bins, each normalized 0..100."""
    with Image.open(path) as img:
        # respect EXIF orientation so the histogram matches what the viewer sees
        oriented = ImageOps.exif_transpose(img)
        # downsample to keep this fast on a folder of 100+ photos
        oriented.thumbnail((THUMB_MAX, THUMB_MAX))
        rgb = oriented.convert("RGB")
        luma = oriented.convert("L")
        rgb_raw = rgb.histogram()   # 768 ints: R then G then B
        l_raw = luma.histogram()    # 256 ints
    return {
        "l": _bin_normalize(l_raw),
        "r": _bin_normalize(rgb_raw[0:256]),
        "g": _bin_normalize(rgb_raw[256:512]),
        "b": _bin_normalize(rgb_raw[512:768]),
    }


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
