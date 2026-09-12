# Rust search compiler draft

This is the experimental compiler for the compact-search component, stacked on
the complete-corpus performance change. It does not change the served search
index, Worker, ranking, snippets, or public APIs.

The first candidate losslessly packs a version-1 corpus into a shared UTF-8
token dictionary and unsigned LEB128 document streams. Rust owns validation and
encoding; a typed TypeScript reader validates framing, references, UTF-8, route
uniqueness, and expansion limits before publishing records. Text boundaries are
only a packing choice, not a change to search tokenization or substring scoring.

## First experiment: rejected for serving

Local corpus: 60 complete records, measured with Bun 1.4.2 on this workstation.
Compression used Node-compatible zlib gzip level 9 and default Brotli settings.
These are artifact and microbenchmark measurements, not Worker cold-start results.

| format | raw bytes | gzip bytes | Brotli bytes |
|---|---:|---:|---:|
| Compact JSON | 539,094 | 201,163 | 165,404 |
| Existing pretty JSON | 542,111 | 201,374 | 165,546 |
| Dictionary binary | 357,190 | 203,902 | 184,710 |

Across nine alternating trials of 100 full decodes, median JSON parse was
approximately 0.314 ms and full binary reconstruction was 4.442 ms. Sharing
tokens reduces raw bytes but disrupts patterns Brotli already compresses well;
eager reconstruction also adds many small operations. This candidate does not
meet the performance objective and must not replace the served asset.

## Format and validation

The header is `SSIX` followed by version byte 1. Strings are UTF-8 prefixed by
unsigned LEB128 byte length. Following the header: generation stamp string,
vocabulary count and strings, document count, then each document's URL/title/
description strings, one-byte kind (page/writing/document/utility = 0/1/2/3),
token count and dictionary IDs. Integers are canonical unsigned 32-bit LEB128.
Input and decoded text are bounded; malformed/trailing bytes are rejected.
Rust validates the full input before writing stdout.

```sh
cargo test --locked --manifest-path tools/search/Cargo.toml
cargo clippy --locked --manifest-path tools/search/Cargo.toml --all-targets -- -D warnings
bun test tools/contract-native-search.test.mjs
bun tools/search/benchmark.ts
```

The differential test compiles the actual complete corpus and compares every
decoded field. It also covers Unicode/whitespace and corrupt framing. CI includes
native validation; Cargo.lock and the root Rust toolchain are authoritative.

## Remaining component scope

- Replace the rejected packing candidate with a measured term/posting and
  document/passage layout that avoids loading or reconstructing unused prose.
- Preserve substring recall, field weights, result ordering, snippets, and the
  /search, MCP and /ask contracts. Unicode lowercasing must remain compatible.
- Integrate compilation into the canonical build and use it in real queries.
- Compare TypeScript and Wasm readers, including compressed bytes, cold and warm
  latency, working memory, ranking/recall, and boundary costs.
- Keep the complete corpus; shrinking it by truncating articles is not a gain.

The component remains incomplete. A green round-trip test proves losslessness,
not a performance win or readiness to serve.
