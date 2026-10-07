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
Ingest accepts an existing JPEG object and preserves its exact key, including
extension casing. It refuses HEIF inputs that would require uploading a new
JPEG companion; supply that companion's existing key instead.

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

For a fresh photo, use the local ingest procedure with its R2 upload access and
a Workers AI token scoped for captioning. It handles JPG, JPEG, HEIC, HEIF, and
HIF sources. Until the remote input and credential path covers these cases,
use `add-photo` only for rerenders of existing photos.

## Local input selection

Ingest and thumbnail rerenders resolve one source per published stem before
encoding. A requested HEIF and a same-folder JPEG form one photo: the HEIF
supplies pixels and metadata, and the JPEG supplies the full-resolution click
object. An explicit JPEG argument selects that JPEG. A HEIF without a JPEG
companion gets a q100 JPEG export. Other same-stem conflicts are refused;
choose one source rather than relying on directory or upload order.

Ingest merges metadata from precisely those selected files, including batches
from multiple folders, and preserves records for other published photos. The
standalone metadata extractor still supports a guarded full replacement, or
`--merge` with one or more files or directories.

## Artifact contract

Grid photos have four content-addressed tiers under `public/i/`: a 600px JPEG,
a 600px AVIF, a 400px AVIF, and a 200px AVIF. Source EXIF orientation is baked
into the pixels; the thumbnails carry no camera metadata.

Every full-resolution original in R2 is JPEG XL (`<stem>.jxl`): a lossless
transcode (`cjxl --lossless_jpeg=1 -e 9`) of the JPEG ingest prepared, about 8%
smaller, from which `djxl` rebuilds that JPEG byte for byte. Ingest uploads
the .jxl only after `djxl` rebuilds the prepared JPEG from it and `cmp` finds
them identical, and never uploads the JPEG, so the bucket holds one copy per
photo and stays inside R2's 10 GB free tier. A failure at any step fails the
photo. Browsers without JPEG XL (Chrome before 155, and Firefox until it turns
it on, planned for 158) can't open an original; the grid tiers are unaffected.
The tiers stay AVIF: a resize is a re-encode, so no tier can be lossless, and
at matched bytes AVIF beat the transcode on 6 of 9 photos given the original
pixels (/pixel-peeper).

The remote pipeline downloads the .jxl and `djxl` rebuilds the JPEG beside it
(`download-remote-photos.sh`), so zenc and exif-sooc read exactly the bytes
they always did and rerendered tiers come out byte-identical.

`bun tools/photos/migrate-originals.ts` moves the originals published as JPEGs:
it downloads each JPEG (MD5 against R2's ETag), takes or makes its .jxl, proves
the rebuild, records the move in the index (`full` is the .jxl, `jpeg` the
retired key) and, with `--delete`, deletes the JPEG. The Worker answers the
retired URL with a 301 to the .jxl, so old links keep working; `--delete`
refuses to run until production does. It needs R2 write access, so it runs from
a workstation.

The committed records are:

- `src/worker/photo-index.json`: published stems, their full-resolution R2 keys
  and sizes, and for a migrated photo the JPEG key it retired (`jpeg`);
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

The runner installs the tools named by the workflow (no JSON CLI among them
since 2026-09-15: `tools/photos/pipeline-json.ts` runs under bun) and builds
`zenc` with the repository's Rust toolchain and Cargo lock. Grid ingest and
rerenders link the installed libavif directly, retaining tier pixels in memory.
Install `libavif` and `pkgconf` before building (`libavif-dev`, `libavif-bin`,
and `pkg-config` on Debian/Ubuntu). Grid scripts run Cargo's incremental check
before encoding and refuse missing libraries instead of changing codecs.
`zenc --avif-version` reports the linked libavif and codec versions; `avifenc`
remains the byte-parity oracle and is used by the other image routines.
The mozjpeg commands resolve their keg through Homebrew, so the install prefix
is not tied to one workstation.

Dependabot tracks the Cargo dependencies; the AVIF encoder version is RECORDED
in `config/tools.json` rather than pinned, and `bun run tools:check` reports the
installed one drifting from it. See [DEPENDENCIES.md](DEPENDENCIES.md) for
dependency ownership.

To validate existing artifacts without ingesting or uploading:

```bash
bun run photos:check
bun run derive:check
```
