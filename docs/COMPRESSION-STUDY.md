# Compression study: preference, fragments, and total bytes

Measured 2026-09-15 against `ff6e74e5`, using the pinned Bun
`1.4.2-canary.20260913.1+09bb546`. Public endpoint samples were fetched the same day.
This study changes no serving policy and claims no deployed byte reduction.

## Decision

Exact-page deltas offer the largest measured HTML saving. Changing their preference
requires measuring how often browsers select an exact snapshot the server still supports.
Keep the family preference until that measurement or a complete snapshot-retention contract exists.

Runtime DCZ needs two things: a working encoder and a dictionary that earns its cost.
The workerd encoder still ignores dictionaries. The existing HTML corpus also provides
little benefit for the sampled dynamic fragments, even with a working Node encoder.

For total page bytes, prioritize media demand and correctly sized thumbnails alongside
HTML dictionary coverage. Keep the existing CSS/JS delta path covered across releases.

## HTML: the cost of family preference

The browser sends one dictionary. Selection uses destination, then match-string length,
then fetch recency. A server cannot choose another cached dictionary after receiving an
unsupported exact snapshot. See [RFC 9842 §2.2.3](https://www.rfc-editor.org/rfc/rfc9842.html#section-2.2.3).

`PAGE_FAMILY_MATCH` in `src/worker/lib/assets.ts` deliberately outranks exact page paths.
This avoids a full Brotli response when an uncaptured snapshot wins browser selection.
It also suppresses the much smaller exact delta when a supported snapshot is present.

These are emitted **response-body bytes**, including DCZ's 40-byte dictionary frame.
They exclude HTTP headers, cache hits, and 304 responses. Exact ranges cover committed
candidates; they do not estimate which candidate a visitor actually holds.

| Page | Brotli q11 | Family DCZ | Exact DCZ | Exact hit rate needed to beat family* |
|---|---:|---:|---:|---:|
| `/` | 8,285 | 5,802 | 492–502 | 31.9% |
| `/garage` | 12,438 | 9,908 | 191–201 | 20.7% |
| `/photos` | 8,422 | 6,958 | 107–1,471 | 21.1% |
| `/garage/compression` | 9,801 | 974 | 443–453 | 94.4% |
| `/garage/horizon` | 68,458 | 66,724 | 2,386–2,398 | 2.6% |
| All 56 pages, once each | 595,369 | 468,917 | 21,048–23,305 | 22.1% |

*Uses the largest committed exact delta for each page. Conditional on a browser having
both the family dictionary and an exact snapshot, among requests needing a new body.
On an exact miss, this conservative model charges full Brotli. A browser with no exact
snapshot can still select family; that separate cohort has no preference penalty.

For Brotli size `B`, family size `F`, exact size `E`, and usable-exact probability `p`:

```text
exact-first expected bytes = p × E + (1 − p) × B
exact-first wins when p > (B − F) / (B − E)
```

The 22.1% result assumes equal page traffic and equal hit rates. Neither is measured.
At 50% hits, the conservative exact-first total is 309,337 B versus 468,917 B for family.
The compression page demonstrates why a global average cannot decide every route.

The family dictionary costs **14,754 B** to acquire. Its equal-page mean saving is
2,258 B, so it repays acquisition after **7 subsequent full-body page responses**.
A one-page visitor pays acquisition without using it. Revalidation and cache hits
extend the elapsed time before repayment; stable dictionary URLs reduce repeated acquisition.

### What would justify exact-first

Measure usable-exact coverage across actual releases, including skipped dictionary rolls
and expired snapshots. Compare it with each route's threshold, weighted by actual response counts.
Current `dcz:check` passing is evidence of supported server paths, not a browser hit-rate estimate.
The sampled live homepage exactly matched a committed snapshot on this run.

A structural alternative is to capture every advertised exact snapshot and retain support
for its advertised lifetime. The pages currently allow seven days of stale reuse, while
the rolling snapshot set is count-bounded. Counting releases does not guarantee seven days.
That change must also cover intermediate production versions and rollback before changing preference.

## CSS and JavaScript: preserve the working delta path

These assets already use dictionaries scoped to each asset name and loader type.
The current build emitted these bodies:

| Asset | Brotli q11 | Available DCZ variants |
|---|---:|---:|
| `nav.js` | 6,165 | 71–198 |
| `luna.css` | 7,488 | 696–1,691 |
| `lens.js` | 25,070 | 271–1,818 |
| `tooltip.js` | 2,847 | 113–480 |

Production `dcz:check` passed all checks, including coverage of 22 live shell assets.
An unchanged immutable asset costs zero body bytes on a cache hit. These deltas matter
when its URL changes and the browser holds a supported prior version.

## Runtime DCZ: what the upstream fix would and would not provide

[workerd PR #7106](https://github.com/cloudflare/workerd/pull/7106) was open and unmerged
when checked through GitHub's API. The repository's local harness returned:

```json
{"none":73,"good":73,"wrong":73}
```

The pinned runtime still accepts and ignores `dictionary`. The existing wrangler canary
watch already detects a change in this control. No additional watcher is needed.

With Node 25.4.0's working encoder, these captured public responses produced the following
sizes against the existing 64 KiB HTML family dictionary. Every measured frame decoded
back to the original response. These are capability estimates, not workerd CPU measurements.

| Response | Actual live Brotli | Local q11 | Family DCZ level 3 | Family DCZ level 6 | Family DCZ level 19 |
|---|---:|---:|---:|---:|---:|
| `/photos/grid.html` | 1,588 | 1,334 | 1,665 | 1,605 | 1,548 |
| `/rn/tracks.html` | 2,404 | 2,074 | 2,448 | 2,315 | 2,250 |
| `/rn/tracks` JSON | 2,612 | 2,359 | 2,604 | 2,540 | 2,515 |

The current family offer matches `document`. A fragment fetched through `fetch()` has
destination `empty`, so fixing the encoder alone does not make these requests negotiate DCZ.
The photo fragment is `no-store` and cannot supply a reusable response dictionary itself.

### Worker-rendered documents, measured 2026-09-25

The fragments above are the weak case. Whole documents the Worker renders are requested as
`document`, so the family dictionary does apply to them once the encoder works. Against
production on 2026-09-25, 51 of 66 registered pages answered `dcz` and 15 answered `br`.
Two of those 15, `/whoareyou` (#924) and `/garage/dyno` (#926), moved to a shell baked at
build time the same day. At zstd level 6 the remaining 13 drop from 81,228 to 63,449 B
(21.9%), and each saves 1,178 to 1,672 B: the shared shell, nearly constant across a sixfold
range in page size. Level 6 took a median 0.165 ms per page under Node 26.9 on an M3 Max;
level 19 took up to 9.9 ms.
`node tools/runtime-dcz-probe.ts` reproduces the table, and
[`/garage/dictionary`](https://aadhar.sh/garage/dictionary) is the write-up.

### A held-out fragment dictionary check

Use the first 6,797-byte grid response as a raw dictionary; its q11 acquisition costs 1,334 B.
Two independently fetched, randomized grids provide a small held-out check:

| Held-out grid | Actual live Brotli | Own q11 | Grid dictionary DCZ level 3 | Grid dictionary DCZ level 6 |
|---|---:|---:|---:|---:|
| Second fetch | 1,895 | 1,539 | 1,714 | 1,652 |
| Third fetch | 1,944 | 1,626 | 1,720 | 1,666 |

At level 3, the mean saving is 202.5 B, requiring seven later grids to repay acquisition.
At level 6, repayment takes six. Two samples do not establish performance across the photo pool.
Both level-6 deltas are larger than q11, so dictionary compression does not automatically beat
stronger conventional compression either. CPU cost and caching must decide that comparison.

### The first runtime implementation, once supported

Start with bounded, public photo/music fragments. Use a stable immutable dictionary made
from public templates, an explicit fragment destination, and a verified hash-to-bytes mapping.
Measure a larger held-out set before choosing its corpus, size, or compression level.

Keep the current status and cache policies. Preserve HEAD, conditional requests, encoding-specific
ETags, `Vary`, and `encodeBody: "manual"` through the response wrapper. Unknown dictionaries
must take the ordinary response path. Confirm the whole exchange in a browser with cold and
warm dictionary stores, and measure workerd CPU with an appropriate runtime profiler or request logs.

Runtime compression also needs the dictionary bytes: receiving an exact hash alone cannot
reconstruct an uncaptured historical page. The encoder fix does not repair snapshot coverage.

## JSON and media

Further whitespace minification gave small compressed savings: `search-index.json` fell
from 166,718 to 166,639 B q11, and `images/metadata.json` from 5,579 to 5,351 B.
These experiments preserved parsed values. Keep the complete search corpus; removing content
would change search behavior. The existing inline-JSON minification already shipped in `ff6e74e5`.

For the first sampled grid, the 12 local AVIF candidates total:

| Candidate width | Device scale at the 184px tile width | Body bytes |
|---|---|---:|
| 200px | DPR 1 | 53,767 |
| 400px | DPR 2 | 184,799 |
| 600px | DPR 3 | 397,505 |

This is an inventory of candidate file sizes, not a captured browser waterfall.
The existing `srcset` already selects these tiers. Their quality requirements differ;
forcing the smallest tier everywhere would trade away resolution.

The next media experiment should measure a real cold/warm browser journey at those DPRs:
which thumbnails load, whether hover duplicates a request, and which images remain unseen.
Then test encoder or demand changes against decoded quality, reserved layout, and hover behavior.
The SVG image loader stays off DCZ until a browser test overturns the documented decode failure.

## Reproduce the deterministic preference study

```bash
bun run build
bun tools/measure-dictionary-preference.ts
bun test tools/contract-dictionary-preference-model.test.mjs
node tools/workerd-zstd-probe.ts
bun run dcz:check
```

Use the pinned Bun installed by `.github/install-bun.sh`. The measurement command reads
the last build and prints JSON; it does not build, fetch production, or change files.
It verifies the Brotli twins and every DCZ frame against the original page and dictionary.
This run verified 165 deltas. Missing tiers cost Brotli; alternatives are never added together
as if one browser downloaded every variant. Runtime fragment values above are dated samples
and will change with the randomized grid and playlist.
