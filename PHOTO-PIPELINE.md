# Photo pipeline

The photo archive keeps original camera files private while publishing a small,
reproducible artifact graph.

## Install

```bash
brew install exiftool jq libavif mozjpeg
cargo build --release --manifest-path tools/media/zenc/Cargo.toml
```

`zenc` is the Cargo-pinned zenjpeg wrapper used for progressive JPEG fallbacks.
AVIF is primary; JPEG remains the universal fallback.

## Add photographs

```bash
npm run photos -- "/path/to/photo.HIF" "/path/to/folder/"
```

For each source, the pipeline:

1. decodes and orientation-corrects the camera file;
2. creates 600px AVIF and JPEG squares plus a 400px AVIF square;
3. content-addresses those bytes under `assets/photos/thumbs/`;
4. uploads a browser-readable full-resolution JPEG to `aadhar-photos` unless
   `REMOTE_RENDER_ONLY=1` is set;
5. updates `content/data/photo-index.json`;
6. regenerates allowlisted EXIF and Fuji recipe records under
   `assets/photos/data/` without GPS;
7. fills missing factual alt text when model access is available; and
8. validates every index, hash, fingerprint, metadata, caption, and pixel edge.

HEIF/HIF originals stay on the owner's archive media and are never committed or
uploaded. Their R2 companion is a high-quality, EXIF-preserving JPEG because it
is intended for browser viewing, not cold storage.

## Validate

```bash
npm run photos:check
```

The gate requires exact bijection among:

- `content/data/photo-index.json`
- `assets/photos/data/{hashes,fingerprints,metadata,alt}.json`
- the 474 files in `assets/photos/thumbs/`

It also recomputes every byte fingerprint. A missing caption or metadata record
fails before deployment.

## Focused maintenance

```bash
./tools/media/extract-photo-metadata.sh "/path/to/archive"
./tools/media/reencode-thumbnails.sh "/path/to/archive"
./tools/media/hash-thumbnails.sh
python3 tools/media/gen-alt-text.py
node tools/media/gen-photo-semantics.mjs
```

Re-encoding mints new content-addressed URLs. The hash tool prunes superseded
thumbnail files, so always run the full validation afterward.

The remote GitHub Action supports add, re-encode, metadata refresh, and encoding
study regeneration. It downloads R2 source keys to ephemeral storage and opens
a PR with only the resulting public artifacts.

## Recipe integrity

Published recipe matching is exact-data work. Never claim the original camera
recipe from visual similarity. A recipe is identified only when the published
bytes or recorded metadata support it; approximate resemblance must remain an
explicitly separate feature.
