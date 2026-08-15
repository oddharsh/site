# Photo ingestion workflow

This is the canonical path for adding photos. Source objects live in the
aadhar-photos R2 bucket; the GitHub Actions photo workflow downloads only the
requested batch into ephemeral runner storage, generates the public derived
tiers, and opens a normal artifact PR. Git receives only the public derived
tiers and metadata. No image decoder or source archive is required on the
author's machine.

## Input contract

Upload a full-quality JPG, JPEG, HEIC, HEIF, or HIF object to the aadhar-photos
R2 bucket using the Cloudflare dashboard or another remote upload path. Keep
the exact flat object key; that is the value entered into the workflow. HEIF/HIF
sources remain archive objects when possible, while a browser-renderable q100
JPG companion remains the public click-through copy.

Run GitHub Actions → Remote photo pipeline and choose a routine:

- add-photo with one or more R2 keys, one per line;
- reencode-thumbnails with all for the complete archive or selected keys;
- refresh-metadata with the selected keys;
- add-car-photo with one R2 key plus the car stem; or
- regenerate-encoding-study, which uses the committed c-png.png fixture.

The workflow runs on an ephemeral GitHub-hosted macOS runner because the
current decoder path deliberately uses macOS sips. It builds the JPEG encoder
(www/scripts/zenc, a Cargo crate wrapping zenjpeg) with cargo, installs
Homebrew's mozjpeg/libavif/jq tools plus exif-sooc, and never commits the downloaded
sources or the built encoder binary.

## Derived output

For every input, the pipeline:

1. decodes and bakes EXIF orientation;
2. emits a 600px JPG fallback, a 600px AVIF, and a 400px mobile AVIF;
3. content-addresses those three tiers under `www/i/`;
4. regenerates nullable EXIF/Fuji-recipe metadata;
5. bakes four 64-bin RGB/luminance histograms from the shipped hashed JPG;
6. validates the complete artifact graph with `pnpm run photos:check`;
7. opens a PR containing the public files.

After reviewing the generated diff, merge through the normal release path.
Once Workers Builds has deployed the merged photo PR, run the separate Bust
remote photo manifest workflow. It deletes manifest:images and its freshness
sentinel so the Worker re-derives the R2-backed listing against the new hashes.

The local shell scripts remain the implementation source used by the runner
and an emergency fallback; they are no longer the normal execution surface.

## Toolchain refresh

The JPEG encoder pins zenjpeg through Cargo (`www/scripts/zenc`), so Dependabot's cargo ecosystem opens the version-bump PRs on the weekly cadence, the same as npm, GitHub Actions, and Pillow. This replaced the hand-rolled `Refresh image toolchain` workflow that used to track the from-source `google/jpegli` commit and regenerate the study; a bumped zenjpeg goes through normal CI and merge review like any other Dependabot PR.

Homebrew formulas (mozjpeg for `jpegtran`, libavif for `avifenc`) stay outside Dependabot's reach and update on their own cadence.

To validate without rerunning ingestion:

```bash
pnpm run photos:check
```
