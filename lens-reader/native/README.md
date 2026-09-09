# Native Lens extraction draft

This crate starts the bounded Rust extraction component. It is an experiment
against the existing Reader corpus, not a replacement for the deployed reader.
The TypeScript Worker still uses its existing DOM and Readability engine.

The CLI reads HTML from stdin and emits versioned JSON containing the first
title, named/property meta tags, and link elements. Attribute entities are
decoded; link URLs remain source references, not resolved or approved fetch
locations. There is no networking in this crate.

Input is read in 8 KiB chunks with a 2 MiB total limit. Parser-accounted buffers
are limited to 1 MiB; this is not a total-process RSS guarantee. Retained fields
are capped at 4096 UTF-8 bytes and meta/link entries share a 256-entry budget.
Field or entry truncation is explicit in the result. Input, I/O, and parser
failures emit no partial JSON. Limits are configurable in the Rust API.

## Validation

From the repository root:

```sh
cargo test --locked --manifest-path lens-reader/native/Cargo.toml
cargo clippy --locked --manifest-path lens-reader/native/Cargo.toml --all-targets -- -D warnings
cargo fmt --manifest-path lens-reader/native/Cargo.toml --check
cargo run --release --locked --manifest-path lens-reader/native/Cargo.toml < src/pages/index.html
```

After the existing locked dependency install in lens-reader, its normal test
suite includes `test/native-metadata.test.mjs`. That test compares titles and
meta tags with the current DOM across all ten compressed external fixtures.
Seven Rust tests cover streaming UTF-8/entity boundaries, Unicode truncation,
input and parser budgets, retained-entry limits, and read failures.

## Unresolved parsing contract

Titles and meta tags match all ten corpus fixtures. Links match eight. In the
Rust blog fixture, the current DOM includes three links inside noscript whereas
lol_html treats that content as raw text. In the New York Times fixture, the
native token stream includes links that the existing DOM's query traversal does
not return. Its traversal explicitly excludes template contents.

The corpus test reports these link mismatches as diagnostics; it does not assert
full extraction parity. This must be resolved before runtime integration, likely
by selecting a tree-building parser with the required scripting/template model.
Do not add a production toggle or a fixture-specific exception to hide it.

The parser was selected for this experiment because it supports streaming and
accounted-buffer limits. See [lol_html settings](https://docs.rs/lol_html/3.0.1/lol_html/struct.Settings.html)
and [memory accounting](https://docs.rs/lol_html/3.0.1/lol_html/struct.MemorySettings.html).
Those capabilities alone do not establish suitability for article extraction.

## Remaining component scope

- Resolve the DOM semantics and build a bounded compact article tree.
- Implement and compare article selection, Markdown, controls, and provenance
  against the complete existing Reader contract and corpus.
- Generate typed runtime contracts and add native/Wasm adapters.
- Measure extraction quality, throughput, working memory, module size, and cold
  initialization, including data transfer at the Wasm boundary.
- Integrate the verified engine into the Reader Worker without changing its
  fetch validation, rate limits, or public error boundaries.

No runtime speedup or full extraction parity is claimed by this draft.
