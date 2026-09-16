# Photo encoding in memory

Keep pixels in memory between resizing and AVIF encoding. On four full-resolution JPEG originals, the prototype cuts the measured tier batch from **6.43 s to 3.77 s (41.3%)**, with byte-identical outputs. This is the strongest candidate for a production follow-up, once the HEIF input path and supported encoder builds are verified.

Baseline and candidate started at `f55e946965ff58acbde85f740e261858a8e4066f`. Measurements ran on macOS arm64 with the pinned Rust toolchain and Bun, libavif 1.4.2, and aom 3.15.0. This libavif build has no libyuv. The prototype borrows libavif through its [public API](https://github.com/AOMediaCodec/libavif/blob/main/include/avif/avif.h); it does not replace the codec.

## Changes

The normal pipeline decodes and resizes once, writes three PNG tiers, asks `sips` for each tier's color space, then starts `avifenc` for each PNG. The prototype passes the same 8-bit gray or RGB tier buffers directly to libavif. It retains the production transfer curve, linear-light resize, EXIF orientation, crop, JPEG encoder, and AVIF settings, including automatic tiling.

`square::tier` is extracted from the existing production loop so both paths use one geometry implementation. The experimental front end is a Cargo example behind the explicit `avif-memory-experiment` feature. The default binary and ingest script retain their existing behavior and need no libavif development files.

A second command decodes a JPEG reference once and reuses it for five fixed quality trials. This isolates decode and process-launch overhead. It does not implement adaptive quality search or measure SSIMULACRA2/Butteraugli.

## Results

Each sample times the entire selected image batch. Baseline and candidate alternate; byte comparisons run outside the timed region.

| Workload | Pairs | Baseline median | Candidate median | Reduction |
|---|---:|---:|---:|---:|
| Six committed JPEG tiles, three AVIF tiers plus JPEG | 5 | 8,888.46 ms | 4,873.74 ms | 45.2% |
| Four full-resolution JPEG originals, same outputs | 3 | 6,432.94 ms | 3,773.06 ms | 41.3% |
| Five fixed JPEG quality trials, six tile references | 5 | 1,258.43 ms | 1,177.18 ms | 6.5% |
| Five fixed JPEG quality trials, four original-derived references | 3 | 661.36 ms | 617.03 ms | 6.7% |

The committed sample is `L1000069_3`, `L1009919_2`, `L1009920`, `XT500010`, `XT507831`, and `XT509986`. All 24 tier outputs and 30 trial JPEGs match byte for byte.

The original JPEG sample is `L1000069_3`, `L1009919_2`, `L1009920`, and `XT507831`, with orientations 1, 1, 8, and 8. All 16 tier outputs and 20 trial JPEGs match byte for byte. The samples include grayscale and color inputs. Camera originals remain private and are not committed.

These percentages cover decoding, resizing, encoding, and the removed tier handoffs. They exclude metadata extraction, uploads, histogram generation, and quality scoring. They are not an end-to-end photo-ingest speedup claim.

## Unresolved HEIF baseline failure

The six-original run stopped on `XT500010.HIF`. `sips` successfully produced the shared TIFF, but the unchanged baseline and candidate both failed to decode it through the pinned `image` crate:

```text
Format error decoding Tiff: format error: file should contain either
(StripByteCounts and StripOffsets) or (TileByteCounts and TileOffsets),
other combination was found
```

That run is inconclusive. The four-JPEG result is a separately named finite sample, not a skipped-error average. The prototype has not established parity or speed for full-resolution HEIF originals. Resolve the existing TIFF decode failure before extending the adoption claim to that input path.

## Reproduce

Use separate baseline and candidate worktrees at the same base, install the repository-pinned toolchain, and provide libavif development files through `pkg-config`. These commands build the default baseline without the experimental feature:

```sh
cargo build --release --locked --manifest-path /absolute/baseline/tools/photos/zenc/Cargo.toml
cargo build --release --locked --manifest-path tools/photos/zenc/Cargo.toml \
  --features avif-memory-experiment --example memory-encode
bun tools/photos/experiments/bench-memory.ts \
  /absolute/baseline/tools/photos/zenc/target/release/zenc \
  tools/photos/zenc/target/release/examples/memory-encode 5
```

For the original JPEG sample, append the private source directory and explicitly select the four stems:

```sh
PHOTO_BENCH_STEMS=L1000069_3,L1009919_2,L1009920,XT507831 \
  bun tools/photos/experiments/bench-memory.ts \
  /absolute/baseline/tools/photos/zenc/target/release/zenc \
  tools/photos/zenc/target/release/examples/memory-encode 3 /absolute/originals
```

The benchmark writes only to its own temporary directory and deletes it afterward. It prints the selected sample and all timings, requires exact output parity, and stops on any failed input. For HEIF it shares an untimed lossless TIFF preparation step between both sides. Other libavif builds and Linux remain unmeasured.

## Validation

The 34 Rust tests pass, including the production geometry and paired JPEG tests. Default and experimental Clippy checks pass with warnings denied; the C shim compiles with `-Wall -Wextra -Werror`. Root lint, typecheck against the existing ratchets, build, and derivation checks pass. The root Bun suite passes all 777 tests; Node passes 768 and skips nine cases requiring Bun's HTMLRewriter. No committed image or photo metadata was regenerated, and no upload ran.
