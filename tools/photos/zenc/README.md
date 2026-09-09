# Native photo pipeline

This branch implements the unified photo-pipeline component of the site's Rust
work. It extends zenc and its existing halflight dependency. It is a draft:
the completed pipeline must coordinate tiers, metadata, histograms, and
provenance through typed stages with shared decoded buffers.

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

## Validation

Run from the repository root:

```sh
cargo test --locked --manifest-path tools/photos/zenc/Cargo.toml
cargo clippy --locked --manifest-path tools/photos/zenc/Cargo.toml -- -D warnings
cargo build --release --locked --manifest-path tools/photos/zenc/Cargo.toml
```

The 15 unit tests cover pixel permutations and inverses, RGB channel integrity,
8/16-bit monochrome decoding, transfer preservation, rejected EXIF values, and
allocation reuse for the upright transform. CI runs the tests and Clippy inside
the required validate job.

Local comparison against the parent binary produced 432 byte-identical PNGs:
six committed JPEGs, eight orientations, three transfer settings, and three
square tiers (60/40/20 px, box filter). A further 96 resize outputs matched
across the same six photos, eight orientations, and both capped axes at 90 px.
This covers the changed transformation
path; it does not establish full-resolution ingest performance. All 165 photo
histograms were regenerated, and the packed committed index stayed identical.

## Remaining work

- Carry typed source depth and colour information through the complete pipeline.
- Share buffers with encoders instead of serializing intermediate PNGs between
  zenc processes.
- Integrate metadata extraction and encoded-output histogram production into
  the same coordinated operation.
- Record input, policy, and encoder provenance for the complete artifact set.
- Validate full-resolution ingest, every output tier, and resource use against
  the existing photo workflow before replacing its orchestration.
