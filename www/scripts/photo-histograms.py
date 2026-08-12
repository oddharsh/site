#!/usr/bin/env python3
"""
photo-histograms.py — bake 64-bin RGB + luminance histograms into the
per-photo meta files (www/images/meta/<stem>.json), at photo-add time.

Resurrected 2026-07-03 (blueprint: histograms move to encode time). The
browser used to decode the on-screen thumbnail into a canvas and bin it on
the main thread per hover; now the bins ride the same meta JSON the tooltip
already fetches, the client renderer draws the identical SVG from them, and
the decode/getImageData path is deleted.

Honesty rule: bins are computed from the SHIPPED thumbnail bytes — the
encoded JPG twin in www/i/ (content-hashed, found via hashes.json) —
so the histogram measures exactly what the visitor sees, the same property
the client-side compute had. Merges into existing meta files (EXIF fields
untouched); creates the file if extract-photo-metadata.sh hasn't yet.

output per photo, merged under "hi" (short key; the per-photo files use the
compact schema documented in extract-photo-metadata.sh and tooltip.js):
  {"hi": {"l": [64 x 0..100], "r": [...], "g": [...], "b": [...]}}
each channel normalized so its tallest bin reads 100, matching a camera
back's per-channel display.

requires: Pillow (shipped thumbs are JPG, so no pillow-heif needed).

usage:
  ./photo-histograms.py            # bake/refresh every stem in hashes.json
  ./photo-histograms.py STEM ...   # just these stems (add-photos fast path)
"""
import json
import sys
from pathlib import Path

try:
    from PIL import Image
except ImportError:
    sys.stderr.write("error: Pillow not installed. run: python3 -m pip install -r www/scripts/requirements.txt\n")
    sys.exit(2)

BINS = 64
HOLDING = Path(__file__).resolve().parent.parent
IMAGES = HOLDING / "images"
HASHED = HOLDING / "i"
META = IMAGES / "meta"


def _bin_normalize(raw):
    """256-int channel histogram -> 64 bins normalized 0..100."""
    size = 256 // BINS
    binned = [sum(raw[i * size:(i + 1) * size]) for i in range(BINS)]
    peak = max(binned) or 1
    return [int(round(100 * b / peak)) for b in binned]


def histogram_bars(path):
    with Image.open(path) as img:
        rgb = img.convert("RGB")
        luma = img.convert("L")
        rgb_raw = rgb.histogram()   # 768 ints: R then G then B
        l_raw = luma.histogram()    # 256 ints
    return {
        "l": _bin_normalize(l_raw),
        "r": _bin_normalize(rgb_raw[0:256]),
        "g": _bin_normalize(rgb_raw[256:512]),
        "b": _bin_normalize(rgb_raw[512:768]),
    }


def main():
    hashes = json.loads((IMAGES / "hashes.json").read_text())
    stems = sys.argv[1:] or sorted(hashes.keys())
    META.mkdir(exist_ok=True)

    done = failed = 0
    for stem in stems:
        h = hashes.get(stem, {})
        if "j" not in h:
            sys.stderr.write(f"warn: {stem}: no hashed JPG in hashes.json, skipped\n")
            failed += 1
            continue
        jpg = HASHED / f"{stem}.{h['j']}.jpg"
        if not jpg.exists():
            sys.stderr.write(f"warn: {stem}: {jpg.name} missing, skipped\n")
            failed += 1
            continue
        try:
            hist = histogram_bars(jpg)
        except Exception as e:
            sys.stderr.write(f"warn: {stem}: {e}\n")
            failed += 1
            continue

        meta_path = META / f"{stem}.json"
        meta = {}
        if meta_path.exists():
            try:
                meta = json.loads(meta_path.read_text())
            except Exception:
                meta = {}
        meta["hi"] = hist
        meta_path.write_text(json.dumps(meta, separators=(",", ":")) + "\n")
        done += 1

    sys.stderr.write(f"baked histograms into {done} meta files")
    if failed:
        sys.stderr.write(f", {failed} skipped")
    sys.stderr.write("\n")


if __name__ == "__main__":
    main()
