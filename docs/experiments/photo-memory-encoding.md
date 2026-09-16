# Photo encoding in memory

The production integration keeps pixels in memory between resizing and AVIF
encoding. A normal-macOS repeat over all six originals, including both HEIFs,
measured **9.45 s to 9.15 s (3.1%)**, with all 24 tier outputs byte-identical.
The earlier 41.3% JPEG-only result below ran inside the execution sandbox and
must not be used as a production speedup claim. A nine-run control measured the
same `sips -g space` probe at 262 ms inside the sandbox versus 21 ms normally.
Removing those subprocesses therefore removed sandbox overhead as well as work.

Baseline and candidate started at `f55e946965ff58acbde85f740e261858a8e4066f`. Measurements ran on macOS arm64 with the pinned Rust toolchain and Bun, libavif 1.4.2, and aom 3.15.0. This libavif build has no libyuv. The prototype borrows libavif through its [public API](https://github.com/AOMediaCodec/libavif/blob/main/include/avif/avif.h); it does not replace the codec.

## Changes

The previous pipeline decoded and resized once, wrote three PNG tiers, asked `sips` for each tier's color space, then started `avifenc` for each PNG. The integrated encoder passes the same 8-bit gray or RGB tier buffers directly to libavif. It retains the production transfer curve, linear-light resize, EXIF orientation, crop, JPEG encoder, and AVIF settings, including automatic tiling.

`square::tier` is extracted from the existing production loop so both paths use one geometry implementation. The normal `zenc square` interface now accepts `--avif-out` beside `--jpeg-out` and optional `--out` for PNG. Ingest and rerender use that interface; the benchmark example delegates to the same AVIF module. Builds require installed libavif development files and pkg-config.

A second command decodes a JPEG reference once and reuses it for five fixed quality trials. This isolates decode and process-launch overhead. It does not implement adaptive quality search or measure SSIMULACRA2/Butteraugli.

## Original sandbox measurements (superseded for production timing)

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

## HEIF resolution and normal-macOS measurement

The failed `XT500010.HIF` conversion was an instrument failure. Sandboxed
`sips` returned success but wrote a 7,056-byte TIFF without pixel offsets.
Outside the sandbox the same command wrote the complete 326,474,696-byte
16-bit TIFF. No decoder change or lower-precision conversion was needed.

Three alternating pairs over all six originals, with the shared HEIF-to-TIFF
preparation excluded from both sides:

| Metric | Baseline | Native candidate |
|---|---:|---:|
| Tier batch median | 9,450.43 ms | 9,153.66 ms |
| Pair 1 | 9,450.43 ms | 9,153.66 ms |
| Pair 2 | 9,393.77 ms | 9,013.31 ms |
| Pair 3 | 9,690.31 ms | 9,708.44 ms |
| Fixed JPEG trials median | 1,563.11 ms | 1,430.25 ms |

All 24 tier files and 30 trial JPEGs matched byte for byte. The tier gain is
small and one pair is slightly slower; these observations do not establish a
large ingestion speedup. The integration removes the PNG handoffs and keeps
one encoder path. JPEG trial reuse remains a benchmark-only experiment.

## Reproduce

Use separate baseline and candidate worktrees at the same base, install the repository-pinned toolchain, and provide libavif development files through `pkg-config`. Build the baseline from the experiment base commit; the candidate now uses the default native module:

```sh
cargo build --release --locked --manifest-path /absolute/baseline/tools/photos/zenc/Cargo.toml
cargo build --release --locked --manifest-path tools/photos/zenc/Cargo.toml \
  --example memory-encode
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

The benchmark writes only to its own temporary directory and deletes it afterward. It prints the selected sample and all timings, requires exact output parity, and stops on any failed input. For HEIF it shares an untimed lossless TIFF preparation step between both sides. Timing comparisons require normal macOS execution: a sandbox that restricts sips changes the instrument. Linux CI exercises native encoding and CLI parity, but is not a macOS ingest timing measurement.

## Validation

The 35 Rust tests cover production geometry, paired JPEGs, and byte parity with the installed `avifenc` for gray and color tiers. Clippy checks all targets with warnings denied; the C adapter compiles with warnings denied too. The shell contracts cover failed encodes preserving every previous tier and `TIERS=xs` leaving the larger tiers untouched. The 258-photo histogram bake was rerun because its locked build inputs changed; its output is byte-identical. No photo was uploaded or re-encoded in the committed library.
