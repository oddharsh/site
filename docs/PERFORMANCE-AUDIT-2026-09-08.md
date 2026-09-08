# Performance and machine access audit, 2026-09-08

The clearest new build saving was an unnecessary site build inside runtime type generation. The clearest machine access defects were HTTP negotiation and an incomplete network deadline. This branch fixes those and corrects the agent-facing corpus description. The next substantial opportunity is search coverage.

The XP presentation, photo selection, public schemas, authentication, and payment behavior remain intact. No traffic was moved during this audit.

## Scope and evidence

The baseline is `origin/main` at `fc9cf633615b1d54c1486ba1d910059817f93fd7`. The audit inventoried and hashed all 1,528 tracked paths: 37,813,271 bytes, including 603 UTF-8 text files. Symlinks count as tracked paths, so `AGENTS.md` and `CLAUDE.md` both appear.

Every tracked text file was scanned for relevant patterns. Manual review followed build dependencies, request dispatch, compression, search/discovery, client loading, and auxiliary service boundaries. This is a repository-wide census with targeted code review and executed checks; it does not establish that every line or browser interaction is defect-free.

| Area | Coverage and result |
|---|---|
| Build, tools, configuration, CI | Inspected build staging, generators, runtime types, toolchain pins, compression, validation, and release workflows. Found and removed a redundant build. |
| Site Worker | Reviewed dispatch, HTML/Markdown negotiation, caches, compression helpers, search, MCP/NLWeb discovery, and large bundled modules. Exercised 159 route cases. |
| Documents, prose, public assets | Scanned all tracked files; checked page contracts, generated twins, discovery descriptions, duplicate hashes, and search coverage. |
| Client and styles | Reviewed loading boundaries and layout/network patterns. Traced the live homepage and `/lens`; checked image dimensions and alt attributes. |
| Photos and dictionaries | Validated 165 photos and 660 hashed tiers, metadata coverage, derivations, and deterministic dictionary transport. No encoder or quality change proposed. |
| Coffee | Ran its 66 tests and root route coverage. Preserved booking and authorization boundaries. |
| Serendipity | Reviewed routing and query shape. Production database cardinality and query plans were not measured. |
| Auxiliary Workers | Dry-ran Garage, LWE, and Lens Reader. Ran Reader extraction tests and its separate type checks. Fixed the stalled-body deadline. |
| Infrastructure and release | Ran offline declarations check and read live release state. Compared deployed bytes with the current build. No infrastructure mutation. |

The only duplicate-content groups in the tracked-file census were the instructions symlink and the intentional MCP descriptor alias. Generated assets and retained historical dictionaries need their own lifecycle; duplicate-looking names alone do not justify deletion.

Measurements used Bun 1.4.2, Node 26.8.1, and the repository's pinned Wrangler 4.129.0. Dependencies were installed from frozen lockfiles. Runtime installations were local to the audit; global tools and lockfiles were unchanged.

## Fixes in this branch

### Runtime types stop rebuilding the site

`tools/gen-runtime-types.ts` previously passed complete Worker configs to `wrangler types --include-env=false`. The pinned Wrangler still resolved the entrypoint and ran its custom build before generating runtime declarations.

The generator now derives temporary configs containing the compatibility date and flags, the inputs Wrangler uses for runtime types. Original configs remain authoritative and remain in the cache key. The existing cross-config equality check still runs.

A forced generation took **6.15 seconds before and 3.03 seconds after**, a 3.12-second reduction in this workstation comparison. The declarations were byte-identical at 590,455 bytes. Hashes of all 1,879 staged files were unchanged by the new generator.

These are single-run timings, not a statistical speedup claim. The stronger evidence is structural: generating declarations no longer invokes the application build or writes its staged files.

### Explicit Markdown refusal wins over a wildcard

`Accept: text/markdown;q=0, */*;q=1` previously selected Markdown. The parser chose the largest matching weight, allowing the wildcard to override an explicit refusal.

`src/worker/lib/http.ts` now chooses the most specific matching media range before comparing representations. This follows [RFC 9110 section 12.5.1](https://www.rfc-editor.org/rfc/rfc9110.html#section-12.5.1). Existing equal-weight ordering behavior remains covered.

The new regression failed before the repair and passed afterward. Seven header combinations cover exclusions, lower explicit weights, wildcard order, and subtype wildcards. Two additional real Worker route cases verify the resulting HTML response.

### Lens Reader's deadline includes the response body

The Reader cleared its eight-second timer when response headers arrived. A server could then stall its body indefinitely, holding the request open despite the declared deadline.

`lens-reader/src/reader.ts` now keeps the abort timer through the capped body read and clears it in `finally`. The existing timeout response remains unchanged. A rejected final redirect also cancels its body.

The baseline reproducer remained pending after 8.3 seconds with no abort. The regression verifies that the upstream stream is aborted and the existing timeout error is returned. Its short test clock keeps CI fast.

Lens Reader is a separately deployed Worker. Merging the site PR does not deploy that auxiliary service.

### The corpus description matches what agents can retrieve

`public/llms.txt` now describes the current build transformations and readable source twins. It identifies `llms-full.txt` as the site map plus full writing, rather than claiming the entire Garage/LWE corpus is included. It also makes the possible payment requirement explicit.

Markdown guidance now points to advertised alternates and distinguishes generated documents from authored service descriptions. It acknowledges the negotiation gaps below instead of promising that every route negotiates.

## Measured opportunities remaining

### 1. Search omits most of long documents

`tools/generate-search-index.ts` slices each page's stripped text at 1,800 characters. Of 60 current records, 38 reach that cap. The generated index is 102,527 raw bytes.

This limits the corpus used by `/search`, MCP `search_site`, and NLWeb `/ask`. Calling the actual search implementation with `scheduler.yield` returned zero results, although `/garage/horizon` contains that feature. Queries for other late sections also omitted Horizon.

The next design should index complete article terms or passages while bounding load time and memory. Preserve the current response schema and ranking expectations. Measure recall against known headings, compressed index size, and first-query cost before choosing a representation.

Generated descriptions also repeat page titles and shell text. Prefer the canonical authored description when present, then derive a body excerpt. Increasing the character cap alone would retain that noise and leave an arbitrary coverage boundary.

### 2. Four twin-bearing routes bypass Markdown negotiation

A local HEAD sweep with `Accept: text/markdown` covered all 52 paths in the generated twin registry. Forty-eight returned Markdown. The exceptions were:

| Path | Observed response |
|---|---|
| `/around` | 200 HTML |
| `/coffee` | 404 HTML |
| `/garage/dyno` | 200 HTML |
| `/terminal` | 200 HTML |

Each has a direct `.md` twin. Their exact handlers bypass the generic static-page negotiation path.

A coherent repair should make the generated registry govern negotiation for eligible document requests. Verify GET and HEAD, query-driven modes, host routing, telemetry, and booking mutations before centralizing dispatch. A blanket early return for every matching path would cross those boundaries.

### 3. Negotiated Markdown can reuse precompressed twins

`serveMarkdownTwin` reads a plain asset and constructs a response. Direct text assets can instead use `servePrecompressedText` and their built Brotli q11 variants.

For `/garage/horizon.md`, the current build's compressed twin is **42,629 bytes**. The live direct and negotiated responses were both **50,624 bytes** during the audit. Decompression produced exactly the same 130,234-byte Markdown document.

That is an available **7,995-byte saving, or 15.8%**, for this document. Direct-twin support is already on `main`; extending it to negotiated responses still requires work.

Reuse one compression path while preserving `Vary: Accept`, cache isolation, token metadata, identity-body handling, and HEAD behavior. Do not trade correct HTML/Markdown cache separation for smaller bytes.

### 4. Deliver improvements already uploaded

At the release-status observation, both `main` and `production` pointed to `fc9cf633`. The newest uploaded version, `059e01fb`, served no traffic. Versions `74b31ba8` and `8c7558c1` served 10% and 90% respectively.

A live sweep found 51 of 52 advertised direct Markdown twins. `/garage/dyno.md` returned 404, although the current source already generates it. These observations explain why source improvements cannot yet be claimed as visitor improvements.

Recheck the current ramp and versions before making a release decision. This audit neither approved a ramp nor changed production traffic.

### 5. Measure the Lens interaction before splitting it further

The post-intent `lens.js` bundle remains above its advisory envelope: 24.5 KiB Brotli against 21 KiB. It is unchanged by this branch.

The live initial `/lens` trace fetched the shell and small loader without fetching that full application. It reported 148 ms LCP and zero CLS. The homepage trace reported 742 ms LCP and zero CLS, with 648 ms attributed to TTFB.

Both are single unthrottled desktop observations; no field p75 or mobile distribution was available. Profile opening and using the Lens before adding chunks or moving computation. The initial-load evidence does not justify extra loading machinery.

### 6. Database and exceptional-cache behavior need separate evidence

Serendipity loads its event collection through `queryEvents`, including aggregate work. Production row counts and query plans would determine whether batching, indexing, or pagination helps. This audit provides no measured database speedup claim.

The search loader also memoizes an empty index after a thrown asset read. A transient failure can therefore persist for that isolate. Reproduce a failure followed by recovery before changing cache semantics; normal query measurements alone cannot validate that path.

## Validation and limits

| Check | Result |
|---|---|
| `bun run check:fast` | Passed: lint, type-check ratchets, and 578 tests |
| `bun run test:node` | 569 passed, 9 skipped, 0 failed |
| `bun run routes:check` | 159 cases, 0 hard failures; 5 remote-only cases skipped |
| Coffee tests | 66 passed |
| Lens Reader tests and type checks | 21 tests passed; its type checks passed |
| Site build and four Worker dry-runs | Passed |
| `bun run perf-budget` | Hard checks passed; existing Lens bundle advisory remains |
| `bun run photos:check` | 165 photos, 660 hashed tiers validated |
| `bun run derive:check` | 5 fresh, 0 stale, 6 unverifiable; all 36 writers classified |
| `bun run pages:check` | Passed |
| `bun run infra:check -- --offline` | 7 checks passed; network tiers excluded |
| Forced runtime type generation | Same declarations; no staged-file changes |
| Deterministic base/head snapshots | Client, page, and dictionary bytes unchanged; site Worker +0.04 KiB gzip |

Type checking uses existing ratchets and does not imply zero historical diagnostics. The checks reported 259 Worker, 164 browser, and 442 tools diagnostics within their declared allowances.

The six unverifiable derivations depend on originals, live pages, or external tooling outside the checkout. Remote-only routes, production database behavior, and browser interactions beyond the sampled pages remain unverified here.

An initial concurrent baseline run collided in `.build` because cold type generation unexpectedly invoked the build. Sequential baseline checks passed; the type-generation fix removes that particular hidden writer. Builds, snapshots, and route harnesses still require a single writer to their shared staging directory.

The first Garage dry-run used an unsupported combination of `--config` and `--x-new-config`. Running the documented root-discovery form succeeded. No validation gate was removed or weakened.

Wrangler also reported its existing asset-route overlap warning for `/coffee*` and `/serendipity*`. The route checks passed; this branch changes neither routing configuration nor bindings.

The standalone baseline build took 2.46 seconds on this workstation. This branch makes no page-load speedup claim: served client and page bytes are unchanged. The new savings concern cold development checks, and the correctness fixes improve representation selection and bounded machine access.
