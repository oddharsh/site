# Complete search coverage without repeated corpus preparation

This pass addresses the search findings in [the repository audit](PERFORMANCE-AUDIT-2026-09-08.md), starting from `origin/main` at `8045082f`. Search previously kept only 1,800 characters per document. A query for `scheduler.yield` returned no results despite the feature's section in Horizon.

The generated index now retains complete authored text and uses each HTML page's authored description when available. It reuses the Markdown twin parser's content selection, removing scripts, controls, and window chrome. Metadata-only app shells remain searchable.

The index remains a static asset loaded on the first search request in an isolate. The homepage fetches no search index or search application bundle. The JSON schema, scoring weights, ordering rules, result limit, and snippet length remain unchanged.

## Cost and benefit

| Measurement | Baseline | This pass |
|---|---:|---:|
| Indexed records | 60 | 60 |
| Body text, characters | 80,186 | 519,737 |
| Index JSON, bytes | 102,527 | 542,111 |
| Index Brotli q11, bytes | 29,117 | 165,546 |
| Warm query median | 0.146 ms | 0.154 ms |
| Warm query p95 | 1.054 ms | 0.268 ms |
| First query, including local load and preparation | 0.869 ms | 4.648 ms |

The larger asset is the explicit cost of complete document coverage. First-query preparation adds about 3.8 ms in this local benchmark. Warm median latency stays close to the baseline, and p95 falls about 75%.

The runtime prepares lowercase scoring fields and normalized excerpt text once after loading the corpus. It reuses those strings across queries and constructs snippets only for returned rows. Loading the complete corpus into the old scorer instead measured 2.424 ms median and 7.564 ms p95 in one comparison.

These are Bun 1.4.2 workstation measurements, not production latency claims. The table takes the median of five fresh-process trials. Each trial measures the first query, warms 100 queries, and times 1,000 queries cycling through ten inputs with a five-result limit.

The query set was `scheduler.yield`, `field-sizing`, `cloudflare`, `compression`, `agents`, `histogram`, `quantum encryption`, `xylophonenotpresent`, `text-box-trim`, and `what does he think about agents`. The asset fixture creates a real JSON response from local bytes, so timings include parsing and preparation but exclude network latency.

The prepared cache retains the original records plus lowercase strings. It therefore also increases isolate memory use relative to the truncated index. This pass measured serialized corpus size, not a production heap profile; it makes no claim that the larger corpus is free.

## Correctness boundaries

- The actual search function now returns Horizon in the first five results for `scheduler.yield`, `field-sizing`, and `text-box-trim`. The Worker route oracle also asserts the first query's result.
- Sixty comparisons against the old scorer, using identical complete-corpus input, produced identical rankings, scores, and snippets. They covered fifteen queries at limits of 1, 5, 20, and 50.
- Cache failures can recover on the next request. Previously, a thrown asset read or JSON parse error pinned an empty corpus to the isolate. Only completed corpus data is cached; no request-owned I/O promise is shared.
- The extraction tests cover late article and writing text, metadata, inline word continuity, image alt text, escaped code, and omitted controls and scripts.
- Reusing the document parser exposed its failure to recognize some legal raw-text closing tags. It now uses the existing shared closing-tag rule. Default Markdown extraction remained identical for all 43 current source HTML documents.

Corpus contents intentionally change which pages match. The scorer's behavior on identical inputs does not change. Utilities whose prose lives only in Worker code still use their registry descriptions; this pass does not claim to index live private data or every dynamically generated page body.

## Validation

`bun run check:fast` passed lint, type checks, and 588 tests. The Node replay passed 579 tests with nine runtime-specific skips. The route oracle passed 160 cases with five remote-only skips.

The site build, Worker dry-run, page contracts, and performance budget passed. Derivations reported five fresh, zero stale, and six unverifiable external-input families. The existing Lens bundle advisory and Wrangler asset-route overlap warning remain.

Deterministic snapshots show unchanged client, page, and dictionary bytes. The site Worker grew by 0.06 KiB gzip. Those snapshot categories exclude the search index; its increase is reported explicitly above.

The shared search-record type also removed all thirteen historical diagnostics in `src/worker/search.ts`; the Worker diagnostic baseline was regenerated downward. Other files retain their existing type-check ratchets.

Initial validation exposed test-process cache sharing and a concurrent build replacing files under a read-only test. Cache scenarios now run in isolated processes, and final build-dependent checks ran sequentially. No test or validation gate was disabled.

No production deployment or traffic change was performed. The remaining audit opportunities, including Markdown negotiation consistency and negotiated-text compression, remain separate work.
