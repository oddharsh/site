# Native Zstandard batch experiment

Keep the current compressor. The native prototype preserves every staged byte, but this workload does not show a repeatable build-time improvement.

Both worktrees started at `f55e946965ff58acbde85f740e261858a8e4066f`. Measurements ran on macOS arm64 with the repository's pinned Bun, `1.4.2-canary.20260913.1+09bb546`, and eight workers. The native helper statically links libzstd 1.5.7. Bun reports its zstd revision as `f8745da6ff1ad1e7bab384bd1f9d742439278e99`.

## What the experiment changes

The current wrapper launches JavaScript workers for each batch and performs separate synchronous compression calls. The C prototype runs one process per batch, with eight pthread workers and one compression context per thread. It deduplicates dictionary transport and keeps the current dictionary loaded until that worker needs another.

A second mode prepares each unique dictionary once with `ZSTD_createCDict`, then shares those immutable dictionaries across compression threads. This follows the [upstream bulk dictionary API](https://facebook.github.io/zstd/zstd_manual.html). The experiment includes serialization, process launch, dictionary preparation, compression, and result transport in the timed region.

## Results

Nine alternating trials on actual built pages, in milliseconds per complete batch:

| Workload | Current Bun workers | Native context reuse | Prepared dictionaries |
|---|---:|---:|---:|
| 57 pages, one family dictionary | 66.00 | 61.73 | 61.05 |
| 111 page/snapshot pairs | 61.60 | 70.00 | 182.87 |

Both native modes matched all 168 compressed frames byte for byte and decompressed to the original documents. Preparing the per-page dictionaries up front costs more than this batch can recover.

Five alternating complete builds then compared the current wrapper with native context reuse. Median wall time moved from **3,068.66 ms to 2,992.13 ms**, a 2.49% reduction. Individual paired changes ranged from **12.93% slower to 9.06% faster**. All **2,543 staged files were byte-identical**. That spread does not establish a repeatable end-to-end win.

The production import remains unchanged. `native-batch.ts` is an explicit experiment adapter and requires `SITE_ZSTD_EXPERIMENT_BIN`; it provides no fallback. Linux and other libzstd versions have not been measured. Reopen this only for a workload with more reuse per dictionary, or a larger measured share of build time in dictionary setup.

## Reproduce

Install the repository-pinned Bun and frozen dependencies. Build the baseline once with `bun run build`. Compile the helper against an explicitly selected static libzstd:

```sh
cc -O3 -Wall -Wextra -Werror -std=c11 -pthread \
  -I"$(pkg-config --variable=includedir libzstd)" \
  tools/experiments/zstd/batch.c \
  "$(pkg-config --variable=libdir libzstd)/libzstd.a" \
  -o /tmp/site-zstd-batch
bun tools/experiments/zstd/bench.ts /absolute/baseline /tmp/site-zstd-batch 9
```

The benchmark refuses a collapsed corpus, checks byte identity and dictionary round trips, and verifies malformed inputs fail without output. Compiler or native failures stop the measurement.

For the complete-build comparison, make two disposable worktrees at the same base. In the candidate alone, replace `tools/lib/zstd-batch.ts` with:

```ts
export { zstdCompressDictionaryBatch } from "../experiments/zstd/native-batch.ts";
```

Run `bun tools/build.ts` alternately in the two worktrees, with `SITE_ZSTD_EXPERIMENT_BIN=/tmp/site-zstd-batch` on the candidate. Compare SHA-256 hashes of every `.build` file after the run. Keep this temporary import change out of any production patch.

## Validation

The C helper compiles with `-Wall -Wextra -Werror`. Root lint, typecheck against the existing ratchets, and derivation checks pass. The root Bun suite passes all 777 tests; Node passes 768 and skips nine cases requiring Bun's HTMLRewriter. The complete-build parity comparison above used the experimental adapter; the committed production compressor is unchanged.
