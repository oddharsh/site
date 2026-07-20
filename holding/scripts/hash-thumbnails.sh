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

# Clean up so the tree matches the map (automates the old manual git rm):
#   1. drop the un-hashed source tiers we just addressed — they live in /i/ now.
#      metadata.json / alt.json / hashes.json / meta/ stay put.
#   2. drop /i/ files a re-encode superseded (not referenced by the merged map),
#      so holding/i/ is 1:1 with hashes.json and check-photo-pipeline.mjs passes.
pruned_src = pruned_i = 0
for stem in stems:
    for name in (f"{stem}.avif", f"{stem}.jpg", f"{stem}-400.avif"):
        p = os.path.join(src_dir, name)
        if os.path.exists(p):
            os.remove(p); pruned_src += 1
expected = set()
for st, e in hashes.items():
    if "a" in e: expected.add(f"{st}.{e['a']}.avif")
    if "j" in e: expected.add(f"{st}.{e['j']}.jpg")
    if "s" in e: expected.add(f"{st}-400.{e['s']}.avif")
for f in os.listdir(out_dir):
    if f.endswith((".avif", ".jpg")) and f not in expected:
        os.remove(os.path.join(out_dir, f)); pruned_i += 1

print(f"hashed {len(hashes)} stems, copied {copied} new files -> {out_dir}")
print(f"pruned {pruned_src} un-hashed source tiers, {pruned_i} superseded /i/ files")
print(f"map: {map_path}")
EOF
