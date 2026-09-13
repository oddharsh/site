# Native Lens extraction draft

This crate starts the bounded Rust extraction component. It does not replace the
deployed Reader: the TypeScript Worker still uses its existing DOM and Readability.

html5ever constructs a flat node store with integer handles. The store retains
text, attributes, parent/child relationships, and separate template fragments.
Traversal and destruction do not recursively follow the input's nesting.
Scripting is disabled during parsing so noscript contents remain available for
Reader-style lazy-image recovery. No script execution or networking exists here.

The CLI reads HTML from stdin and emits versioned JSON containing the first
title, named/property meta tags, and active-document link elements. Templates
are outside that traversal. Link URLs remain source references, not resolved or
approved fetch locations. This is a metadata projection of the tree; article
selection is not implemented yet. Passing `--document` adds source control labels
alongside metadata, collected from the same tree before any future article
selection. The default CLI metadata response remains unchanged.

Controls use the existing Reader's button/role/input selector, text-or-value
fallback, trimmed UTF-16 length range (4–59), deduplication, and document order.
Each label retains bounded text even when a control has extensive whitespace.
The entry budget applies independently to control labels; `controlsTruncated`
reports omitted distinct labels rather than presenting partial counts as complete.

## Resource contract

Defaults are 2 MiB of input, 65,536 nodes, nesting depth 256, and 16 MiB of
accounted tree storage. Retained metadata fields are capped at 4096 UTF-8 bytes;
meta/link entries share a 256-entry budget. Field/entry truncation is explicit.
Input, I/O, or tree-budget failures emit no partial JSON.

Parsing uses 1 KiB feeds. Node/depth limits are checked after each feed and at
EOF, so the current feed can temporarily exceed them. Tree storage accounting
charges nodes, attributes, edges, and retained text conservatively; it is not
exact allocator accounting or a process RSS ceiling. Once its budget is exceeded,
the sink stops retaining additional payload while keeping valid handles/names
until the current feed ends; the caller then rejects the entire result. Parser-internal and transient allocations are outside that accounting;
the input cap limits individual token size.
The Rust API exposes the limits for different callers.

## Validation

From the repository root:

```sh
cargo test --locked --manifest-path lens-reader/native/Cargo.toml
cargo clippy --locked --manifest-path lens-reader/native/Cargo.toml --all-targets -- -D warnings
cargo fmt --manifest-path lens-reader/native/Cargo.toml --check
cargo run --release --locked --manifest-path lens-reader/native/Cargo.toml < src/pages/index.html
```

After the existing locked dependency install in lens-reader, its normal test
suite includes `test/native-metadata.test.mjs`. Titles, meta tags, and links are
required to equal the existing DOM across all ten compressed external fixtures.
Source control labels must also equal the deployed Reader's collector, with a
synthetic case covering nested labels, Unicode, fallback, and template exclusion.
Before registering tests, the module allows up to 120 seconds for a cold locked
release build through the subprocess timeout; the
corpus test has a separate 30-second ceiling and each invocation a 10-second
ceiling. These are test-harness deadlines, not Worker performance claims.

Fifteen Rust tests cover control selection/bounds, streaming UTF-8/entities, Unicode truncation, resource
limits, I/O failure, noscript/template semantics, parent-link integrity after
HTML repair, and iterative traversal/destruction at 10,000 levels with an
explicitly larger test-only depth limit. The default depth limit rejects that
hostile nesting separately.

The previous streaming-token prototype differed on links in two fixtures. The
replacement resolves both with one tree-building model; link comparison is now
an assertion, not a diagnostic. This establishes metadata parity on this corpus,
not article-extraction parity or arbitrary malformed-document equivalence. In
particular, the existing DOM searches only its first root element for an HTML
fragment with multiple roots; html5ever repairs that input into a document and
therefore discovers later controls too. The synthetic differential fixture uses
an explicit HTML/body document; the fragment difference remains a runtime
integration decision, not a claim of parity.

## Remaining component scope

- Implement and compare article selection, Markdown, controls, and provenance
  against the complete existing Reader contract and corpus.
- Generate typed runtime contracts and add native/Wasm adapters.
- Measure extraction quality, throughput, working memory, module size, and cold
  initialization, including data transfer at the Wasm boundary.
- Integrate the verified engine into the Reader Worker without changing its
  fetch validation, rate limits, or public error boundaries.

No runtime speedup or full extraction parity is claimed by this draft.
