# Photo ingestion workflow

This is the canonical path for adding photos. Full-resolution source files stay
in the curated local source folder; JPGs are also retained in R2 as the public
click-through copy, while HEIF/HIF originals remain local archive files and
their full-resolution q100 JPG exports are retained in R2. Git receives only
the public derived tiers and metadata.

## Input contract

Drop full-quality `.jpg`, `.jpeg`, `.heic`, `.heif`, or `.hif` files into the
canonical source folder:

```text
/Users/aadharsh/Downloads/to post (from ssd)/
```

Then run from the repository root:

```bash
npm run photos -- "/path/to/photo.jpg" "/path/to/photo.HIF"
# or process a curated folder
npm run photos -- "/Users/aadharsh/Downloads/to post (from ssd)/"
```

The local prerequisites are the Homebrew tools in `MAINTENANCE.md` plus the
pinned histogram decoder:

```bash
python3 -m pip install -r holding/scripts/requirements.txt
```

JPG inputs are uploaded to R2 as supplied. HEIF/HIF inputs remain local archive
files and are converted to a full-resolution maximum-quality q100 JPG for the
browser-visible R2 click target. HEIF-to-JPG is necessarily a transcode; q100
is the highest quality exposed by the macOS conversion path.

## Derived output

For every input, the pipeline:

1. decodes and bakes EXIF orientation;
2. emits a 600px JPG fallback, a 600px AVIF, and a 400px mobile AVIF;
3. content-addresses those three tiers under `holding/i/`;
4. regenerates nullable EXIF/Fuji-recipe metadata;
5. bakes four 64-bin RGB/luminance histograms from the shipped hashed JPG;
6. validates the complete artifact graph with `npm run photos:check`;
7. uploads the full-resolution R2 copy and busts the manifest cache.

The cache is not busted if the artifact validation fails. After reviewing the
generated diff, commit the public files and merge through the normal release
path; do not deploy the dirty photo-ingestion checkout directly.

To validate without rerunning ingestion:

```bash
npm run photos:check
```
