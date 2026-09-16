# Shell dictionary refresh experiment — 2026-09-16

Base: `206bb3b7bddcba1618ad045f14342103ebacfdbe` (main after #846).
Branch: `codex/shell-dictionary-refresh`.

The canonical live roll adopted 15 currently served JS/CSS snapshots and
pruned nine older snapshots under the existing three-per-asset retention rule.
All 22 live assets are now represented; the read-only production `dcz:check`
passes its shell coverage and delivery probes. SSR dictionary compression is
still reported blocked by workerd's dictionary implementation.

This is coverage maintenance for the next asset change, not a measured current
page-load improvement. An identical hashed asset is already cached, so the
build intentionally emits no delta from it to itself. The new snapshots can
compress a later changed asset for browsers holding today's version.

## Measured build effect

Both builds used the pinned Bun and the same main commit. Compared every file
under `.build/public` by path, length and SHA-256:

- Baseline: 2,447 files. Candidate: 2,438 files.
- Nine `/ad/` deltas removed, totaling 6,853 bytes.
- No files added; all 2,438 retained files are byte-identical.
- HTML, CSS, JS, JSON, media and the page/family dictionary tiers are unchanged.

There is a real retention cost: a browser offering only one of the nine evicted
hashes falls back to a full compressed response. For one request to each of
those nine target assets, the built Brotli responses total 55,027 bytes versus
6,853 bytes for the evicted deltas: +48,174 bytes across that synthetic cohort.
This is not a visitor-weighted estimate; we have no cohort traffic counts.
It does not affect a browser already caching the current hashed URL.

The result supports refreshing coverage with the established retention policy.
It does not justify claiming immediate transfer savings or changing retention
without evidence about returning visitors.

## Reproduction and validation

From a fresh baseline worktree and the refreshed branch:

```sh
bun tools/roll-shell-dictionary.ts --shell --live
bun run build
bun run derive:check
bun run dcz:check
bun test tools/contract-family-dictionary-is-committed.test.mjs tools/contract-dictionary-preference-model.test.mjs tools/contract-perf-snapshot-counts-dictionary-acquisition.test.mjs
```

The baseline also ran `bun run build`, without the roll. Both builds passed;
derivations passed (5 fresh, 0 stale, 0 undeclared); all nine focused tests
passed. The roll reads a moving production snapshot, so a later run can adopt
different filenames. No runtime or serving-policy code changed.
