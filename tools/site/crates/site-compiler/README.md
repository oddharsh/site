# Native artifact compiler

This is the first compiler stage, on a branch stacked above the site model draft.
It accepts a typed versioned plan, executes independent transforms with up to eight
workers, and returns source/output hashes and sizes for its dependency records.
Identity and HTTP-compatible Brotli transforms are implemented. The site build
uses this stage for all four Brotli batches: shell assets, pages, the family
dictionary and static text. The build continues publishing only smaller twins.

```sh
cargo build --release --locked --manifest-path tools/site/Cargo.toml -p site-compiler
tools/site/target/release/site-compiler plan.json source-root output-root cache-dir
```

A plan has `version: 1` and a nonempty `jobs` array. Each job has a relative
`source`, a unique relative `output`, and an `action`: either `{ "kind": "identity" }`
or `{ "kind": "brotli", "quality": 11, "window": 24 }`. The compiler validates the
whole plan before creating outputs. It compiles all inputs before publishing any
artifact. Publication is atomic per file, not a transaction across the directory;
an I/O failure during publication can leave a mixture of old and new artifacts.
The future complete build publisher must provide the directory-level boundary.

Cache keys include the format version, source digest, action and actual compiler
binary digest. Cache records carry a digest of the encoded bytes; missing or
corrupt records are recomputed. The cache stores binary payloads directly rather
than encoding each byte as a JSON number. Output publication uses rename after a
completed write. It does not force each disposable build artifact to durable disk.

The engine uses the existing C Brotli codec through a safe Rust binding. An initial
pure Rust encoder experiment produced slightly smaller bytes but a slower cold
pass, so it was not retained as the production encoder. The independent Rust
decoder remains a test-only dependency for roundtrip checks.

Initial local measurements on 55 staged HTML pages (591,823 compressed bytes):

| Pass | Observations in seconds |
| --- | --- |
| Existing Node codec, fresh outputs | 0.271, 0.312, 0.280 |
| Native engine, cold cache and fresh outputs | 0.498, 0.289, 0.291 |
| Native engine, warm cache and fresh outputs | 0.023, 0.024, 0.024 |

All 55 native outputs matched the existing compressed files byte-for-byte. These
are exploratory stage timings on one workstation, not whole-build or production
performance claims. Node timing includes the verification reads and decompression;
native timing includes process startup, hashing, cache and output writes. A matched
benchmark was subsequently run through the integrated build, below. Raw measurements are in the task's local evidence folder
`/tmp/site-native-compiler-benchmark`.

Tests cover selective invalidation, compiler/action invalidation, corrupt-cache
repair, decoder roundtrips, invalid plans, symlink output rejection and preservation
of existing outputs when an input fails. Remaining compiler work includes parsed
document and asset transforms, multi-input dependencies, native minification,
directory publication, a Garage document's
complete representation pipeline, and matched full-build measurements.

## Integrated build measurement

Three paired local builds compared the model branch's existing build with this
branch. All 1,887 pre-existing staged files matched byte-for-byte in every pair;
new plans, candidate bytes and dependency records live outside the served tree
under `.build/compiler`. The native cache is outside staging and survives rebuilds.

| Pair | Existing build | Native build | Native cache |
| --- | ---: | ---: | --- |
| 1 | 2.2065 s | 2.4661 s | empty, compiler already built |
| 2 | 1.9682 s | 1.8036 s | warm |
| 3 | 1.8874 s | 1.7145 s | warm |

The two warm observations improved by about 8–9%; the empty-cache observation
was slower. An earlier first build that also compiled the native executable took
5.6594 s. These are local samples, not a production or universal speed guarantee.
Cloudflare's preview build must also validate availability of the Rust toolchain
before this draft is ready to merge. The Cargo executable is read from its JSON
artifact message, so `CARGO_TARGET_DIR` cannot make a successful build execute a
stale binary from the default directory.
