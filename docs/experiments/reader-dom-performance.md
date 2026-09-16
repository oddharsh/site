# Reader DOM performance experiment

The candidate reduces local extraction time by **11.9%** while preserving the Reader payload across the corpus. Retained Node heap rises about **1.8%** in two measurement batches. Peak RSS changes direction between probes, so production memory impact remains unresolved.

Baseline and candidate started at `f55e946965ff58acbde85f740e261858a8e4066f`. Measurements use Node 26.8.2 on macOS arm64. They cover parsing, the control census, Readability, and Markdown conversion; network time and production Worker latency are outside the measurement.

## Changes

`textContent` caches subtree text until a child or descendant text mutation invalidates it. A dirty node implies dirty ancestors, so appending during parsing stops at the first already-dirty node. Each tree owns its caches.

`querySelector` and `getElementById` stop at the first match. They retain the existing root-inclusion, case, and template rules. Clearing children now detaches their parent links. Replacing a node with an earlier sibling recalculates its position after the move; differential tests exposed the old ordering defect.

An initial candidate also reused cached element arrays for every traversal. That measured 14.8% faster with 11.8% higher peak RSS in the exploratory probe. The retained candidate walks existing child arrays instead. The later RSS cross-check below limits what that earlier memory comparison can establish.

## Measurements

Twenty-one alternating pairs over the ten captured pages, totaling 3,867,251 source bytes:

| Metric | Baseline | Candidate |
|---|---:|---:|
| Median time per ten-page sweep | 127.82 ms | 112.64 ms |
| Peak RSS, exploratory probe, five fresh processes | 352,032 KiB | 373,184 KiB |
| Retained heap after GC, exploratory probe | 25,148,000 B | 25,595,600 B |
| Peak RSS, committed probe, five fresh processes | 293,056 KiB | 283,280 KiB |
| Retained heap after GC, committed probe | 23,933,880 B | 24,368,536 B |
| Wrangler dry-run bundle, gzip | 47.20 KiB | 47.34 KiB |

The RSS runs each perform fifteen sweeps before requesting GC, alternating fresh baseline and candidate processes. The exploratory probe and committed probe execute the same extraction pipeline but differ in their harness code. Peak RSS moves from +6.0% to -3.3%, while retained heap rises 1.8% in both batches. Peak process RSS includes Node and V8 overhead and is sensitive to GC timing; it does not measure Cloudflare's per-request memory. The conflicting RSS results remain inconclusive. The timing result is local extraction wall time, not production latency.

## Correctness and reproduction

The existing differential suite compares the fitted DOM with linkedom across **53 documents**, including ten captured external pages. It also checks serialized trees and SVG behavior. New tests cover edits, moves, replacements, clears, detached-node reuse, and first-match selection. The benchmark compares every Readability article field, Markdown, and control labels against the baseline before timing.

From a candidate worktree with frozen root and Reader dependencies installed:

```sh
node lens-reader/test/bench-dom.mjs /absolute/baseline 21
node --expose-gc lens-reader/test/bench-dom-memory.mjs /absolute/baseline
node --expose-gc lens-reader/test/bench-dom-memory.mjs /absolute/candidate
cd lens-reader
bun run typecheck
bun test
bun run test
node ../node_modules/wrangler/bin/wrangler.js deploy --dry-run -c wrangler.toml
```

The timing benchmark records the runtime, base revisions, source hashes, and every sample. Alternate the two memory commands for five fresh processes per side; the Markdown checksums must match. The baseline worktree must have its own frozen Reader installation. Build both worktrees from the same commit before comparing bundle sizes.

## Validation

All 25 Reader tests pass under both Node and the pinned Bun. Reader source and test typechecks are clean; root lint and typecheck pass against the existing ratchets. The root suites pass too: Bun initially ran 775 cases with two build-dependent skips, then all seven tests in that build-dependent file passed after building. Node initially passed 766 with eleven skips, then passed the same seven build-dependent tests; the other nine skips require Bun's HTMLRewriter.

A local workerd harness also compared the baseline and candidate extraction pipelines on all ten captured pages twice, alternating order. All 20 paired responses matched every article field, Markdown, and control label. This exercises the actual local Worker runtime, but does not establish production CPU time or peak Worker memory. Both deployment dry runs succeeded. Nothing was deployed.
