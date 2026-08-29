#!/usr/bin/env bash
#
# hash-thumbnails.sh — content-address the published thumbnails (migration
# duty 4, first run 2026-07-03) and keep them addressed on every photo add.
#
# For every tier file in public/images/ (<stem>.avif, <stem>.jpg,
# <stem>-400.avif) this computes sha256, copies the bytes to
# public/i/<name-with-.hash8-before-ext>, and writes
# public/images/hashes.json ({stem: {a,j,s}}), which buildImagesManifest
# reads to bake /i/ URLs into the photo manifest. A URL is born with its
# bytes, so the ?v=THUMB_VERSION global-bump class and the 4h edge-404
# poison class both die structurally; /images/<thumb> stays alive as a 301
# layer for old links.
#
# Idempotent: re-running only adds/refreshes entries whose bytes changed
# (a changed file gets a NEW hashed name; the old one is left for git rm).
# The map is MERGED into the existing hashes.json, never rebuilt from scratch:
# an incremental add only stages the NEW stems in public/images/ (the earlier
# tiers were git-rm'd after they were hashed into public/i/), so a from-scratch
# rebuild would drop every prior stem from the map and make buildImagesManifest
# skip those photos. Merging keeps the full 1:1 map across incremental adds.
#
#   ./tools/photos/hash-thumbnails.sh
#
set -euo pipefail

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
PUBLIC_DIR="$( cd "$SCRIPT_DIR/../.." && pwd )/public"
SRC_DIR="$PUBLIC_DIR/images"
OUT_DIR="$PUBLIC_DIR/i"
MAP="$SRC_DIR/hashes.json"

mkdir -p "$OUT_DIR"

python3 - "$SRC_DIR" "$OUT_DIR" "$MAP" <<'EOF'
import hashlib, json, os, shutil, sys

src_dir, out_dir, map_path = sys.argv[1], sys.argv[2], sys.argv[3]

def h8(path):
    with open(path, "rb") as f:
        return hashlib.sha256(f.read()).hexdigest()[:8]

# Stems come from ANY tier present, not just the JPG. A full re-encode writes
# every tier so the JPG was a fine proxy; an ADDITIVE run (TIERS=xs in
# reencode-thumbnails.sh, which is how the 200px tier was backfilled without
# reminting the other three hashes) writes one AVIF and no JPG at all, and a
# JPG-only scan finds nothing and silently hashes zero photos.
def _stem(f):
    for suffix in ("-400.avif", "-200.avif"):
        if f.endswith(suffix):
            return f[: -len(suffix)]
    if f.endswith(".jpg"):
        return f[:-4]
    if f.endswith(".avif"):
        return f[:-5]
    return None

stems = sorted({st for st in (_stem(f) for f in os.listdir(src_dir)) if st})
# MERGE into the existing map (see header): start from what's already hashed so
# an incremental add adds/refreshes its stems without dropping the rest.
hashes = {}
if os.path.exists(map_path):
    try:
        with open(map_path) as f:
            hashes = json.load(f)
    except Exception:
        hashes = {}

# The j-tier hash each histogram was computed from, snapshotted before this run
# mutates `hashes`. images/histograms.json is a pure function of those exact JPEG
# bytes, and a re-encode mints a NEW hash, so a run that moves any j leaves the
# committed bars describing pixels nobody is served.
#
# Not hypothetical: #394 re-encoded 316 thumbnails on 2026-08-14 and re-baked
# nothing, and it went unseen for nine days because check-photo-pipeline compares
# histograms.json against images/meta/, which build.mjs derives FROM
# histograms.json. Those two agree no matter what the JPEGs say.
prev_j = {st: e.get("j") for st, e in hashes.items() if isinstance(e, dict)}
copied = 0
for stem in stems:
    tiers = {
        "a": (f"{stem}.avif",     f"{stem}.{{h}}.avif"),
        "j": (f"{stem}.jpg",      f"{stem}.{{h}}.jpg"),
        "s": (f"{stem}-400.avif", f"{stem}-400.{{h}}.avif"),
        "x": (f"{stem}-200.avif", f"{stem}-200.{{h}}.avif"),
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
        # MERGE rather than replace. An additive run carries only the tier it
        # generated, so assigning the entry outright would drop a, j and s for
        # every stem it touched — and the tiers would still be on disk in public/i/,
        # so the damage reads as a map that forgot them rather than as missing
        # files. The file's header has always described this as a merge; the
        # per-stem write was the one place that was not one.
        hashes.setdefault(stem, {}).update(entry)

with open(map_path, "w") as f:
    json.dump(hashes, f, separators=(",", ":"), sort_keys=True)

# Clean up so the tree matches the map (automates the old manual git rm):
#   1. drop the un-hashed source tiers we just addressed — they live in /i/ now.
#      metadata.json / alt.json / hashes.json / meta/ stay put.
#   2. drop /i/ files a re-encode superseded (not referenced by the merged map),
#      so public/i/ is 1:1 with hashes.json and check-photo-pipeline.ts passes.
pruned_src = pruned_i = 0
for stem in stems:
    for name in (f"{stem}.avif", f"{stem}.jpg", f"{stem}-400.avif", f"{stem}-200.avif"):
        p = os.path.join(src_dir, name)
        if os.path.exists(p):
            os.remove(p); pruned_src += 1
expected = set()
for st, e in hashes.items():
    if "a" in e: expected.add(f"{st}.{e['a']}.avif")
    if "j" in e: expected.add(f"{st}.{e['j']}.jpg")
    if "s" in e: expected.add(f"{st}-400.{e['s']}.avif")
    if "x" in e: expected.add(f"{st}-200.{e['x']}.avif")
for f in os.listdir(out_dir):
    if f.endswith((".avif", ".jpg")) and f not in expected:
        os.remove(os.path.join(out_dir, f)); pruned_i += 1

print(f"hashed {len(hashes)} stems, copied {copied} new files -> {out_dir}")
print(f"pruned {pruned_src} un-hashed source tiers, {pruned_i} superseded /i/ files")
print(f"map: {map_path}")

restale = sorted(st for st, e in hashes.items()
                 if prev_j.get(st) and isinstance(e, dict) and e.get("j") != prev_j[st])
if restale:
    shown = ", ".join(restale[:8]) + (" ..." if len(restale) > 8 else "")
    print("")
    print(f"WARNING: the JPEG tier changed for {len(restale)} photo(s): {shown}")
    print("  images/histograms.json is computed from those exact bytes, so the")
    print("  tooltip bars are now stale. Re-bake before committing:")
    print("    ./tools/photos/extract-photo-metadata.sh /path/to/sooc-originals/")
    print("  add-photos.sh already runs that; a standalone re-encode does not.")
EOF

# The short URL hash above is intentionally kept separate from the full-byte
# fingerprint the exact photo_recipe matcher uses. That full-byte map used to be
# built here into a committed images/fingerprints.json; build.ts step 1a derives
# it into .build/ now, from these same public/i bytes, so there is nothing left
# to run and nothing left that can go stale against a re-encode.
