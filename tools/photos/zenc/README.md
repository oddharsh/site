# Native photo pipeline

zenc supplies the photo pipeline's geometry, JPEG and AVIF encoding, and
histogram bake. Grid ingest and rerender share decoded pixels through the
encoders; the shell still coordinates metadata, uploads, and artifact checks.

## Implemented

`TransferOption` represents the CLI's `auto`, `srgb`, and `g22` choices.
Decoding resolves it into `Transfer`, which contains only actual sample curves.
A `Frame` therefore cannot carry an unresolved setting into an encoder.

`Orientation` admits exactly the eight EXIF transforms. Both `square` and
`resize` validate the argument before decoding. Orientation consumes its input
frame; the upright transform returns the original allocation. Previously this
case copied every linear-light sample into a second allocation. Other
orientations retain the existing exact pixel permutation.

This removes one full-frame copy for upright inputs. For an RGB frame the
avoided allocation is width × height × 3 × 4 bytes. This is an allocation
reduction, not a claim of a measured end-to-end speedup.

`square --size 600 --avif-out tile.avif --jpeg-out tile.jpg --jpeg-quality 84`
emits both formats from one quantized pixel buffer. Each `--size` starts a tier;
`--out` optionally also writes its PNG. JPEG quality is global and defaults to
84. AVIF uses the installed libavif at the existing grid settings: quality 63,
10-bit, speed 2, four threads, automatic tiling, gray YUV400 or color YUV420.
`add-photos.sh` and `reencode-thumbnails.sh` build incrementally before running.
`--version` reports zenjpeg; `--avif-version` reports the linked libavif/codecs.

Local comparison of 54 paired PNG/JPEG outputs against the old two-process path
was byte-identical (six photos, three orientations, all three transfer choices).
The unit suite also checks colour and monochrome paired output against decoding
and encoding the emitted PNG.

## Validation

Install libavif development files and its CLI parity oracle (`brew install
libavif pkgconf` on macOS; `libavif-dev libavif-bin pkg-config` on Debian/Ubuntu).
Run from the repository root:

```sh
cargo test --locked --manifest-path tools/photos/zenc/Cargo.toml
cargo clippy --locked --manifest-path tools/photos/zenc/Cargo.toml --all-targets -- -D warnings
cargo build --release --locked --manifest-path tools/photos/zenc/Cargo.toml
```

The 35 unit tests cover pixel permutations and inverses, RGB channel integrity,
8/16-bit monochrome decoding, transfer preservation, rejected EXIF values, and
allocation reuse for the upright transform, and AVIF byte parity with the
installed CLI. CI runs the tests and Clippy inside the required validate job.
The full-resolution AVIF measurements and their limits are recorded in
[the experiment report](../../../docs/experiments/photo-memory-encoding.md).

Local comparison against the parent binary produced 432 byte-identical PNGs:
six committed JPEGs, eight orientations, three transfer settings, and three
square tiers (60/40/20 px, box filter). A further 96 resize outputs matched
across the same six photos, eight orientations, and both capped axes at 90 px.
This covers the changed transformation
path; it does not establish full-resolution ingest performance. All 165 photo
histograms were regenerated, and the packed committed index stayed identical.

## Optimizing zenc

`bun run zenc:bench` is the instrument, and its gate is the definition of done:
every `square` output and every histogram byte-identical to the baseline. The
rules below are for an agent iterating on speed, adapted from Max Woolf's
agentic-iteration AGENTS.md to a crate whose output is content-addressed.

- Run it once on an unchanged tree first. That run is the baseline and the
  noise floor, and it should report no measurable difference.
- Never edit the bench, its corpus, `TIERS`, or `add-photos.sh` to make a
  result pass. A contract test pins the bench to the production command.
- Encoder settings are off limits. AVIF speed, `--jobs` and quality, JPEG
  quality and subsampling all change bytes (CLAUDE.md gotcha 43), so none of
  them is a speed knob here.
- Read the CPU table for throughput. `add-photos.sh` runs 8 photos at once, so
  the pipeline is CPU-bound, and wall-clock under load can miss a real saving:
  the tiled `orient()` read 1.004x at `--parallel 8` on wall-clock while saving
  5.4-7.0% of CPU per rotated photo. A change that adds threads inside one
  photo also owes a `--parallel 8` run.
- Don't run the bench while something else builds or benchmarks. It prints the
  load average, and a BUSY warning means rerun.
- Stop when a pass moves no source at p < 0.01, or wins under 5%
  while adding a disproportionate amount of code.

The split the bench prints bounds the prize. On the 2026-09-22 corpus, zenc's
own code was 27-28% of a photo, a ceiling of about 1.37x before any encoder.
135 of the 185 sources are rotated, and `orient()` costs 225-360 ms per 26 MP
frame for a permuted full-frame copy. Reading the source through the
orientation inside the resample is the first target, and it is identity-safe
by construction because the same values arrive in the same order.

## Remaining work

- Carry typed source depth and colour information through the complete pipeline.
- Extend buffer sharing to adaptive JPEG quality search; fixed trial reuse
  currently exists only in the benchmark example.
- Integrate metadata extraction and encoded-output histogram production into
  the same coordinated operation.
- Record input, policy, and encoder provenance for the complete artifact set.
- Validate full-resolution ingest, every output tier, and resource use against
  the existing photo workflow before replacing its orchestration.
