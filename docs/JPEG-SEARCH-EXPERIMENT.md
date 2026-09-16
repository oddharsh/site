# JPEG adaptive search experiment — 2026-09-16

Base: `206bb3b7bddcba1618ad045f14342103ebacfdbe` (main after #846).
Branch: `codex/jpeg-quality-batch`.

`zenc jpeg-search INPUT OUTPUT TARGET_BYTES YUV MIN_Q MAX_Q` decodes the
reference once, runs the existing integer binary-search sequence through the
shared JPEG encoder, and writes the closest visited attempt. A tie keeps the
first attempt. It makes no new claim that JPEG size is monotonic or that binary
search finds a global optimum. Invalid ranges fail before reading or writing.

Pixel Peeper uses that command for zenc byte-budget searches; its other encoders,
fixed quality ladder, crop selection, budget tolerances, ranking and perceptual
scorers retain their existing behavior. No codec or metric dependency changed.
The experiment is independent of the HEIF branch and continues to use TIFF.

## Measurements

The committed Bun harness compares six committed photographs at 320px, in
4:2:0, 4:2:2 and 4:4:4. Eighteen searches plus five boundary controls retain the
same chosen quality, byte count and complete JPEG bytes. Both perceptual scores
also match. Five alternating pairs, no concurrent local benchmark:

| Stage, 18 searches | Baseline median | Candidate median | Difference |
|---|---:|---:|---:|
| Search | 2.961 s | 1.882 s | 36.4% faster |
| Decode and both scorers | 1.748 s | 1.751 s | effectively unchanged |
| Search plus scoring | 4.709 s | 3.630 s | 22.9% faster |

All five combined pairs improved (21.6–23.2%). These are resized committed
photographs, not the native crops that the generator selects from originals.
The following real-generator measurement includes that additional work.

The complete tradeoff axis processes eight configured originals, including
source decode, scored crop selection, target encode, adaptive search, both
metrics, ranking and contact-sheet output. Three alternating pairs:

| Pair | Baseline (s) | Candidate (s) |
|---|---:|---:|
| 1 | 25.032 | 23.893 |
| 2 | 25.181 | 24.132 |
| 3 | 26.663 | 27.473 |
| Median | 25.181 | 24.132 |

That is **4.16% by ratio of medians**, with one of three pairs slower.
The full-workflow benefit is modest and noisier than the isolated search gain.
Every run kept the same three trials; reports, scores, selected qualities and
all six retained JPEG tiles were identical. This dry run did not change any
published assets.

Raw samples, retained-tile digests and the generator report are in
`tools/photos/experiments/jpeg-search-results.json`.

An earlier out-of-tree timing harness reported an apparent 48% combined gain,
but its *unchanged* scoring stage varied from 2.25 to 20.94 seconds on the
baseline. That run is confounded and excluded from the adoption case. Its repeat
reported 30.4%; the committed Bun harness above is the reproducible comparison.
All raw runs, including these preliminary results, are retained in the result
JSON instead of silently selecting the largest improvement.

Scoring now occupies roughly half of search-plus-scoring time. This experiment
does not cache the scorers' decoded references or replace their algorithms;
that remains separate work requiring metric parity. It also makes no measured
claim for the fixed quality ladder, Instagram export, or a full five-axis
Pixel Peeper regeneration.

## Reproduction and checks

Build the baseline in an isolated checkout of the stated commit, then candidate:

```sh
cargo build --release --locked --manifest-path tools/photos/zenc/Cargo.toml
bun tools/photos/experiments/bench-jpeg-search.ts /absolute/baseline/zenc tools/photos/zenc/target/release/zenc 5
bun tools/photos/experiments/bench-pixel-peeper.ts /absolute/baseline/repo /absolute/candidate/repo 3
```

The search harness measures committed photo references and needs the installed
SSIMULACRA2 and Butteraugli binaries. The generator harness invokes the real generator with
`--only tradeoff --sheet` inside a temporary directory; it requires its original
photo folder and macOS tools. `--only` implies `--dry-run`. No published tile or
manifest is rewritten. Run timing commands sequentially outside the App Sandbox.

Platform: macOS 27.0 (26A428), arm64; pinned Bun 1.4.3-canary.1 (09bb54630),
Rust 1.93.0. Metric executable digests are recorded in the result JSON because
these tools expose no useful version flag.

Local checks: 37 Rust tests, 64 relevant repository contract tests, and Clippy
with warnings denied pass. Lint passes;
tool typechecking matches the existing ratchet, with no added errors. Derivation
checks are fresh. No histogram, photo hash, codec pin or committed tile changed.
