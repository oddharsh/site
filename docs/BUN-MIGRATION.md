# The bun migration

Branch `bun/greenfield`. This file is the measured record: what was swapped, what
refused to swap, and which numbers to re-run before trusting any of it again.

The bar throughout is **byte-identical build output**, never "the build succeeds".
`/a/` and `/i/` are content-addressed, so one byte of drift mints a new URL,
orphans every committed `a-dict` and `p-dict` snapshot naming the old hash, and
moves the CSP hashes the documents are served under. A toolchain that is twice as
fast and one byte different is not a faster toolchain.

## Status

| stage | state |
|---|---|
| bun as package manager | done, verified |
| bun as script + build runtime | done, verified |
| bun as test runner | done, verified |
| CI bootstrap | done, digest-pinned |
| Workers Builds (production publisher) | BLOCKED, see below |
| greenfield source restructure | not started |

Verified on 2026-08-16 against `origin/main` at `5ac65094`, bun
`1.4.0-canary.1+8326d1bd3`, node `v26.7.0`:

- build output **byte-identical to node across all 1484 files**, both with
  bun installing and node building, and with bun doing both
- contract suite **291 pass, 0 fail**
- cal Vitest **59 pass**, lens-reader **13 pass**
- lint, typecheck, `pages:check`, `tools:check`, `check-wrangler` all clean
- build wall clock 3.1s under node, 1.3s under bun

## The version is not a pin, so the digest is

bun 1.4 is not released. It is on npm in **no form**: the registry's newest bun is
1.3.14 (2026-05-13) and its `canary` dist-tag points at a 1.3.13 canary. The 1.4
line ships only as a GitHub release asset under the tag `canary`, and that tag
**rolls**. Measured: the `bun-darwin-aarch64.zip` asset reported `updated_at` of
2026-08-16T11:26:46Z, the release is titled after a different commit than the
binary reports, and no immutable per-canary tag exists (`bun-v1.4.0-canary.1`
answers 404).

So `1.4.0-canary.1` is a label that stays fixed while the binary under it changes
daily. `packageManager` still carries it because tooling reads that field, but
[`config/bun-canary.json`](../config/bun-canary.json) is the real declaration and
the pin is the binary's SHA-256. `.github/actions/setup-bun` verifies it on every
run and fails by name when it moves, so a canary bump is a reviewed commit rather
than a compiler swapped underneath a content-addressed artifact graph.

Re-verify with `bun run bun:canary:check`.

## The capability that decides the version

bun 1.3.14 accepts `zstdCompressSync`'s `dictionary` option and **silently
ignores it**. Measured the same day, compressing one target three ways:

| runtime | no dictionary | right dictionary | wrong dictionary |
|---|--:|--:|--:|
| node v26.7.0 | 65 | **18** | 64 |
| bun 1.3.14 | 65 | **65** | 65 |
| bun 1.4.0-canary.1 | 65 | **18** | 64 |

Three equal numbers means the option is being ignored, and the failure is silent
in both directions: a frame compressed WITHOUT the dictionary still decodes fine
WITH it, so nothing throws and the only signal is a byte count that never shrank.
That ships no-op dcz deltas (gotcha 28). `build.mjs` feature-detects it and
throws, but 40 seconds into a build, so the setup action runs the same control
first and names it.

## What refused to swap

**The route oracle, and it is the one hard blocker.** `pnpm run routes:check`
boots this repo's Worker in-process through wrangler's `createTestHarness()`.
Under bun that HANGS: no output, no error, 5 workerd children idle at 0.7% CPU,
killed at 13 minutes. The identical call under node sweeps 136 routes and exits 0.

Narrowed to a minimal repro. `createTestHarness()` itself constructs fine under
bun; the hang is at **`listen()`**, which is where workerd is actually spawned and
`build.command` runs:

```
execPath: /Users/aadharsh/.bun-canary/bun
1. createTestHarness({workers:[{configPath}]})
2. created; calling listen() - this boots workerd and runs build.command
   (nothing further, ever)
```

`routes:check` and `routes:check:remote` therefore still say `node`, deliberately.
This is wrangler, miniflare and workerd being node-pinned, which was known going
in, rather than a bun defect to route around. Re-test when 1.4 ships stable.

## Traps hit on the way

**`bunx` fetches from the registry.** In an empty directory with no local install,
`bun x wrangler --version` resolved, downloaded and ran 4.123.0. That is exactly
the npx hole gotcha 29 closed, wearing bun's name. So `pnpm exec X` became bare
`X` inside package scripts, where bun puts `node_modules/.bin` on PATH, and
`bun x --no-install X` in the eight scripts that spawn wrangler outside a script
and cannot assume that PATH. `--no-install` errors on a missing package rather
than downloading it, which was probed rather than assumed.

**`bun test` needs `.test` in the filename**, even when handed an explicit path.
`scripts/contract-tests.mjs` is `scripts/contract-tests.test.mjs` now. Not a
preference; the runner reports "1302 files were searched" and matches nothing.

**bun does NOT walk up out of `lens-reader/`.** Under pnpm a bare install there
walked up to `pnpm-workspace.yaml`, installed the five workspace projects, and
never created `lens-reader/node_modules`, which is why gotcha 29 requires
`--ignore-workspace`. bun has no such flag and needs none: a plain `bun install`
resolved that `package.json` alone and installed 21 packages locally. Do not add a
flag looking for parity, because there is nothing left to preserve.

**Two policies lost fidelity in translation, both silently.**

The nanoid override was `nanoid@<3.3.17: ^3.3.17` under pnpm, a SELECTOR matching
only the versions the advisory names, so it expired on its own the day postcss
raised its floor. bun overrides map a bare name to a version and support no
selector, so the pin is now unconditional and will hold every future nanoid
resolution at a 2026 patch release. Same shape for `minimumReleaseAgeExcludes`:
pnpm excluded by `name@version` and bun excludes by NAME, so each entry now
exempts that package forever at any version. Prune the list on every bump; an
unpruned entry is a permanently disabled check rather than a stale one.

**`minimumReleaseAge` changed units.** pnpm counted minutes and wrote `1440`. bun
counts seconds. The same 24 hour policy is `86400`. Copying the number across
would have cut the window to 24 minutes while looking like a faithful port.

## What is still blocked

**Workers Builds cannot publish this yet, and the reason is the canary.** The
dashboard's two deploy commands are recorded in
[`config/infra.json`](../config/infra.json) and `check-infra.mjs` compares them
against the live values by exact string match. They are deliberately UNCHANGED on
this branch, because this repo's rule is dashboard first and strings second: an
edit here fails `infra:check` on drift it invented itself and blocks its own merge.

Changing them is also not merely a string swap. The build image would need bun
1.4 on PATH before wrangler runs, and it cannot get it: the image's `BUN_VERSION`
knob resolves released versions, and 1.4 is not one. The only route is fetching
the rolling asset inside the deploy command and verifying its digest there, which
puts an unpinnable daily-moving binary in the one path that publishes production.

That is gotcha 30's lesson pointed at bun: check that the build image can RUN the
version you pin before checking that it can READ what that version writes. The
recommendation is to leave Workers Builds on the current publisher until bun 1.4
ships stable, then flip the dashboard first and the strings second.
