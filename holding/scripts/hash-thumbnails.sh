#!/usr/bin/env bash
#
# hash-thumbnails.sh — content-address the published thumbnails (migration
# duty 4, first run 2026-07-03) and keep them addressed on every photo add.
#
# For every tier file in holding/images/ (<stem>.avif, <stem>.jpg,
# <stem>-400.avif) this computes sha256, copies the bytes to
# holding/i/<name-with-.hash8-before-ext>, and writes
# holding/images/hashes.json ({stem: {a,j,s}}), which buildImagesManifest
# reads to bake /i/ URLs into the photo manifest. A URL is born with its
# bytes, so the ?v=THUMB_VERSION global-bump class and the 4h edge-404
# poison class both die structurally; /images/<thumb> stays alive as a 301
# layer for old links.
#
# Idempotent: re-running only adds/refreshes entries whose bytes changed
# (a changed file gets a NEW hashed name; the old one is left for git rm).
# The map is MERGED into the existing hashes.json, never rebuilt from scratch:
# an incremental add only stages the NEW stems in holding/images/ (the earlier
# tiers were git-rm'd after they were hashed into holding/i/), so a from-scratch
# rebuild would drop every prior stem from the map and make buildImagesManifest
# skip those photos. Merging keeps the full 1:1 map across incremental adds.
#
#   ./holding/scripts/hash-thumbnails.sh
#
set -euo pipefail

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
HOLDING="$( cd "$SCRIPT_DIR/.." && pwd )"
SRC_DIR="$HOLDING/images"
OUT_DIR="$HOLDING/i"
MAP="$SRC_DIR/hashes.json"

mkdir -p "$OUT_DIR"

python3 - "$SRC_DIR" "$OUT_DIR" "$MAP" <<'EOF'
import hashlib, json, os, shutil, sys

src_dir, out_dir, map_path = sys.argv[1], sys.argv[2], sys.argv[3]

def h8(path):
    with open(path, "rb") as f:
        return hashlib.sha256(f.read()).hexdigest()[:8]

stems = sorted(f[:-4] for f in os.listdir(src_dir) if f.endswith(".jpg"))
# MERGE into the existing map (see header): start from what's already hashed so
# an incremental add adds/refreshes its stems without dropping the rest.
hashes = {}
if os.path.exists(map_path):
    try:
        with open(map_path) as f:
            hashes = json.load(f)
    except Exception:
        hashes = {}
copied = 0
for stem in stems:
    tiers = {
        "a": (f"{stem}.avif",     f"{stem}.{{h}}.avif"),
        "j": (f"{stem}.jpg",      f"{stem}.{{h}}.jpg"),
        "s": (f"{stem}-400.avif", f"{stem}-400.{{h}}.avif"),
    }
    entry = {}
    for key, (src_name, out_pat) in tiers.items():
        src = os.path.join(src_dir, src_name)
        if not os.path.exists(src):
            continue
        h = h8(src)
        out = os.path.join(out_dir, out_pat.format(h=h))
        if not os.path.exists(out):
            shutil.copyfile(src, out)
            copied += 1
        entry[key] = h
    if entry:
        hashes[stem] = entry

with open(map_path, "w") as f:
    json.dump(hashes, f, separators=(",", ":"), sort_keys=True)

print(f"hashed {len(hashes)} stems, copied {copied} new files -> {out_dir}")
print(f"map: {map_path}")
EOF

echo "next: verify, then 'git rm' the un-hashed tier files from holding/images/"
echo "      (metadata.json, alt.json, hashes.json, meta/ stay put)"
