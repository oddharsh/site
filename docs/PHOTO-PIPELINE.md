# Photo ingestion and rerenders

The photo scripts own encoding, metadata, histograms, captions, and search terms.
The [remote workflow](../.github/workflows/photo-pipeline.yml) runs them on a
GitHub-hosted macOS runner and opens an artifact PR. The
[local procedure](MAINTENANCE.md#local-fallback-setup) uses the same scripts.

## Remote input contract

Sources must already exist as flat object keys in the `aadhar-photos` R2 bucket.
The downloader reads them through `/images/full/<key>` into disposable runner
storage. It accepts one exact key per line; `all` selects the published manifest.
The workflow sets `REMOTE_RENDER_ONLY=1`, so processing never uploads to R2.

Choose a routine in GitHub Actions → Remote photo pipeline:

- `reencode-thumbnails`: rerender selected published photos, or use `all` for
  the library. Rebuild hashes, metadata, packed histograms, and search terms.
- `refresh-metadata`: reread a selected batch, preserve other records, then
  rebuild histograms and search terms.
- `add-car-photo`: supply one source key and the car stem. Generate the static
  car tooltip images.
- `regenerate-encoding-study`: regenerate the study from the committed
  `public/garage/enc/c-png.png` fixture. Review the page's claims against the new
  samples; the generator comments record where encoder changes affect them.
- `add-photo`: run the ingest script over the downloaded batch. The fresh-photo
  limits below also apply to this routine.

## Fresh-photo limits

The current remote job cannot complete every fresh ingest. It carries no
Workers AI credential, and the credential-free caption service can only read
photos already deployed. A new uncaptioned photo therefore fails `photos:check`.
Do not remove that check to publish it.

HEIC, HEIF, and HIF inputs have another constraint: the ingest script creates a
full-resolution JPEG companion locally, but remote mode skips its R2 upload.
It also normalizes the extension in the photo index, so an existing R2 key whose
extension has different casing may not match that entry. The workflow does not
yet verify these click-through objects before opening its PR.

For a fresh photo, use the local ingest procedure with its R2 upload access and
a Workers AI token scoped for captioning. It handles JPG, JPEG, HEIC, HEIF, and
HIF sources. Until the remote input and credential path covers these cases,
use `add-photo` only for rerenders of existing photos.

## Artifact contract

Grid photos have four content-addressed tiers under `public/i/`: a 600px JPEG,
a 600px AVIF, a 400px AVIF, and a 200px AVIF. Source EXIF orientation is baked
into the pixels; the thumbnails carry no camera metadata.

The committed records are:

- `src/worker/photo-index.json`: published stems and their full-resolution R2 keys;
- `public/images/hashes.json`: the four tier identities;
- `public/images/metadata.json`: EXIF and Fuji recipe records;
- `public/images/histograms.json`: four packed 64-bin channels per photo;
- `public/images/alt.json` and `semantics.json`: captions and search terms.

Per-photo files under `public/images/meta/` are local pipeline intermediates.
The build reconstructs their served versions from the committed records.
Rerenders use `extract-photo-metadata.sh --merge` to populate those intermediates,
bake histograms from the shipped JPEGs, and pack the histogram index in order.

The workflow checks derivations before processing, records only the derivations
it regenerated, and verifies the result. Its PR includes those records, their
lock file, and the routine's output paths. Unexpected output stops publication.
An encoder failure also stops the rerender before hashing can accept partial tiers.
Local ingest requires a successful outcome for every scheduled R2 upload before
hashing or updating the photo index. A failed transfer names its key and stops
the run. Earlier successful uploads and generated local tiers remain; this is
not a batch rollback. Rerunning retries the uploads.

Review the artifact diff and use the [site release path](MAINTENANCE.md#cicd-release-path).
The Worker bundles the photo index and hash map. There is no post-release
manifest cache to bust.

## Toolchain

The runner installs the tools named by the workflow, including `jaq`, and builds
`zenc` with the repository's Rust toolchain and Cargo lock. Grid ingest and
thumbnail rerenders also build the pinned AVIF encoder from
[`tools/photos/libavif/build.sh`](../tools/photos/libavif/build.sh). The car and
encoding-study routines use Homebrew's encoder. The mozjpeg commands resolve
its keg through Homebrew, so the install prefix is not tied to one workstation.

Dependabot tracks the Cargo dependencies; the AVIF source pin changes by hand.
See [DEPENDENCIES.md](DEPENDENCIES.md) for dependency ownership.

To validate existing artifacts without ingesting or uploading:

```bash
bun run photos:check
bun run derive:check
```
