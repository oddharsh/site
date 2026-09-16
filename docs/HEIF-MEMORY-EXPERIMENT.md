# Direct HEIF decode experiment — 2026-09-16

Base: `206bb3b7bddcba1618ad045f14342103ebacfdbe` (main after #846).
Branch: `codex/heif-memory-decode`.

Verdict: preserve this as an experiment; the measured timing gain is too small
and inconsistent to adopt the native decoder in ingest.

## What it tries

The macOS-only `heif-memory` example asks ImageIO for the HEIF image and renders
it into caller-owned 16-bit RGBA memory in the same color space. It carries the
ICC profile into the existing linear-light conversion, orientation, box resize,
JPEG encoder and AVIF encoder. The production CLI and ingest still use TIFF.
The only shared refactor extracts `pixels::from_decoded`; both loaders then use
one channel, precision and transfer-curve policy.

The source decoder returned packed 10-bit pixels for these HIFs. The context
expands them to 16-bit integers; it does not pass through an 8-bit intermediate.
The experiment compared every RGBA16 sample and every ICC byte against the
existing `sips -s format tiff` + Rust TIFF decode, not just the final thumbnails.

## Result

Two 7,728 × 5,152 Fuji originals (`XT500010.HIF`, `XT509986.HIF`), EXIF
orientations 8 and 1, under macOS 27.0 (26A428), arm64, outside the sandbox. Rust 1.93.0;
libavif 1.4.2 with aom 3.15.0. Five alternating pairs; each timed
batch processes both originals into 600px JPEG and 600/400/200px AVIF tiers.
Baseline includes TIFF creation, read and removal; candidate includes native
HEIF decode. Encoders and settings are shared and pinned identically.

| Pair | TIFF path (ms) | Native path (ms) |
|---|---:|---:|
| 1 | 5997.83 | 6577.64 |
| 2 | 6669.62 | 6205.31 |
| 3 | 6012.22 | 5891.53 |
| 4 | 5863.13 | 5940.45 |
| 5 | 5864.70 | 5891.53 |
| Median | 5997.83 | 5940.45 |

The ratio of medians is **0.96% faster**, with three of five pairs slower.
This is within observed variation, not a demonstrated stable gain. An earlier
harness measured 1.05% with two of five pairs slower; that data is retained in
`heif-initial-result.json`. The table above comes from the committed Bun harness.

Each source avoided writing and reading a roughly 311.35 MiB TIFF, but memory
rendering and decode still cost time. This sample used warm local files and
says nothing about cold storage, other camera formats or other macOS versions.

Both 3,144-byte ICC profiles and all full-resolution 16-bit samples matched
exactly. All eight distinct tier outputs were byte-identical, checked before
timing and again after each pair. No originals or generated tiers are committed.
Raw timing data is in `tools/photos/experiments/heif-result.json`.

## Reproduction

Build baseline from the stated commit in a separate worktree; build candidate:

```sh
cargo build --release --locked --manifest-path tools/photos/zenc/Cargo.toml --features heif-experiment --example heif-memory
bun tools/photos/experiments/bench-heif.ts /absolute/baseline/zenc tools/photos/zenc/target/release/examples/heif-memory /absolute/originals 5
```

Needs macOS ImageIO, the existing libavif prerequisites, and those two originals.
Run outside an App Sandbox: in this environment sandboxed `sips` can exit zero
with a 7,056-byte TIFF containing no pixels. Decode failures are errors, never
timing wins. The benchmark creates and removes only its own temporary directory.
The feature is explicit because this is a platform-specific experiment, not a
fallback or a second production decoder. Default Linux builds do not link it.

Local validation: 35 Rust tests passed; Clippy with all targets and the macOS
experiment feature passed with warnings denied. Full-resolution parity and the
eight output checks passed as described above. Broader HEIF support and a stable
end-to-end benefit remain prerequisites before connecting this to ingest.

The shared loader extraction also rebaked all 258 committed photo histograms;
the packed index remained byte-identical. The derivation digest was regenerated
only after that comparison, so the metadata records the new shared source.

The initial CI run rejected a Python benchmark under the repository retirement
rule. The harness was ported to pinned Bun, the unchanged contract passed, and
the complete experiment was rerun. No test or retirement rule was relaxed.
