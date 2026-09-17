# HEIF processing experiments, 2026-09-16

Original experiment base: `206bb3b7bddcba1618ad045f14342103ebacfdbe` (main after #846).
Branch: `codex/heif-memory-decode`.

Verdict: keep the lossless TIFF decoder and cache the shared 16-bit transfer
conversion. The follow-up measured a 12.7% reduction in median time to generate thumbnails
with identical outputs. Native decoding remains an experiment.

## Upstream ownership: halflight

The exact tables now live in halflight as `srgb_lut16()` and `g22_lut16()`,
introduced by [halflight #1](https://github.com/oddharsh/halflight/pull/1).
Zenc pins that commit in its Cargo manifest and lockfile, resolves the source's
transfer curve once per frame, and indexes the selected table. This puts both
8-bit and 16-bit transfer functions beside the resampling kernel; file decoding,
ICC classification and channel policy remain in zenc.

Halflight shares the normalized curve formulas between its two bit depths.
Its exhaustive test compares every 16-bit value against the original scalar
formulas and initializes both tables on a cold 128 KiB thread stack. Debug and
release tests pass, along with its conformance suite, Rust 1.75 check and
WebAssembly tests. The wasm build is 13,613 bytes gzip, below its 40,000-byte gate.

The site-local binary at `3a9ceb21` and the halflight-backed binary produced
identical bytes for all 312 outputs across 52 full-resolution originals:
208 thumbnail files (600px JPEG plus 600/400/200px AVIF), 52 whole-frame PNGs
capped to 1080px width, and 52 q84 JPEG encodes of those PNGs. Sources were all
46 JPEGs directly in the curated source folder and six HIFs: `XT500010`,
`XT500018`, `XT500026`, `XT508174`, `XT509334`, and `XT509986`. The HIFs passed
through lossless TIFF; each source's numeric EXIF orientation was applied.
Both binaries also agreed on all 258 histograms, and the canonical rebake and
packer left the committed index unchanged. The derivation record was regenerated.

Site validation passed: all 38 Rust tests, the exhaustive loader test in release
mode, Clippy including the native example, 57 focused contract tests, lint,
photo validation and the derivation check. Tool typechecking matched its existing
409-error baseline with no new findings.

The timing results below were recorded before this extraction, using the
site-local tables at `3a9ceb21`. They remain measurements of that build; moving
the tables into the library is validated separately for output parity.

## Follow-up: exact 16-bit conversion

The native decoder saved little because both paths repeatedly evaluated a power
function while converting each channel sample to linear light. The shared
loader now evaluates the existing formula once for every possible 16-bit value.
Subsequent samples index those exact results, preserving the original `f32` bits.

There is no interpolation or reduced-precision intermediate. Each transfer
curve lazily initializes one 256 KiB table per process. The 8-bit path, ICC
classification, channel policy, orientation, resampling and encoders retain their
existing behavior. Production ingest continues to pass a lossless TIFF to zenc.

The first table initializer used temporary arrays and overflowed a test
thread's stack in debug builds. The final version constructs a boxed slice
directly on the heap. Debug tests and release parity checks both pass.

Baseline and candidate were built from `b7ab04dc`, which incorporates main
`ee1cc171` into this PR. The candidate adds the table and experiment diagnostics.
The native example now reports decode, linear conversion, orientation and tier
timings; `tiff-tiers` profiles the same stages from an existing lossless TIFF.

Six rounds exercised all six execution orders of three paths. Each timed batch
processed the same two originals described below. Each process initialized its
own table, so startup cost is included. TIFF paths include creation, read and
removal of the intermediate.

| Round | Original TIFF (ms) | TIFF with table (ms) | Native with table (ms) |
|---|---:|---:|---:|
| 1 | 12533.93 | 12664.96 | 9408.20 |
| 2 | 12566.55 | 10258.95 | 10525.45 |
| 3 | 5383.30 | 4726.19 | 5954.49 |
| 4 | 5436.39 | 4501.65 | 4572.96 |
| 5 | 5797.94 | 4583.51 | 4462.64 |
| 6 | 6671.35 | 6159.98 | 5310.36 |
| Median | 6234.65 | 5443.09 | 5632.42 |

Caching the conversion reduced the TIFF path's median time by **12.70%**.
Five rounds were faster; paired improvements ranged from -1.05% to 20.95%, with
a **14.70% median paired improvement**. System load varied during this run:
the baseline alone ranged from 5.38 to 12.57 seconds. The performance result
remains provisional; the bit-for-bit correctness result is independent of timing.

Native decoding was **3.48% slower** by median than optimized TIFF, and slower
in three rounds. It provides no demonstrated additional performance benefit.

All eight tier outputs matched the original TIFF baseline for both candidates,
before timing and after every round. Full-resolution native RGBA16 samples and
ICC bytes also matched TIFF. An exhaustive regression test compares all 65,536
values against the original formula through Luma16, LumaA16, RGB16 and RGBA16,
for both sRGB and gamma 2.2, including alpha stripping and channel order.

These measurements cover thumbnail generation for two Fuji originals on this
Mac. They exclude archive JPEG generation, metadata extraction and upload.
They do not establish a whole-ingest speedup, cold-storage behavior or timing on
another platform. Raw measurements include execution orders, input and binary
hashes, and runtime provenance in
`tools/photos/experiments/heif-transfer-result.json`.

Build the baseline CLI from `b7ab04dc` in an isolated worktree, then build the
candidate CLI and example from this PR:

```sh
cargo build --release --locked --manifest-path tools/photos/zenc/Cargo.toml --features heif-experiment --example heif-memory
cargo build --release --locked --manifest-path tools/photos/zenc/Cargo.toml --bin zenc
bun tools/photos/experiments/bench-heif.ts /absolute/baseline/zenc tools/photos/zenc/target/release/examples/heif-memory /absolute/originals 6 tools/photos/zenc/target/release/zenc
```

The optional final argument enables the third path. Three-path runs require a
multiple of six rounds so each execution order occurs equally often. Omitting
it retains the original two-path experiment below.

Build the TIFF CLI separately with default features, as above. Enabling the
experiment also links ImageIO frameworks into a CLI built in that invocation,
which would change the startup costs being compared. Both timed TIFF CLIs use
default features and link only libavif and libSystem.

Follow-up validation: 38 Rust tests, release-mode exhaustive sample parity,
and Clippy with all targets and the experiment feature passed. All 57 focused
photo/derivation contract tests passed using the repository's 30-second timeout.
A first focused invocation hit Bun's five-second default timeout.

Lint passed; the tool typecheck matched its existing baseline with no new
findings. All 258 histograms were rebaked through the canonical histogram
generator and packer. The packed index stayed byte-identical, its derivation
record was regenerated, and photo and derivation checks passed.

## Original experiment: direct decoding

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
