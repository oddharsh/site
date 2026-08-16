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

## The restructure, step 1: the Worker is a program, not a document

`www/_worker.js/` is `src/worker/`. It sits beside `cal/` and `serendipity/` now,
for the reason the layout table already gave for those two: it is a program with
its own tests rather than something a browser fetches. It never was fetchable
either, since `.assetsignore` has always listed `_worker.js`.

**Every served byte is unchanged.** 1402 served files, byte-identical, including
every `/a/` and `/i/` hashed URL, all 48 pages, all 144 dcz deltas and the family
dictionary. Nothing was re-minted and no dictionary was orphaned. The only files
that moved are five that reference the moved path, four of which are the
`tools/photos/` photo tooling that `.assetsignore` also excludes from upload.

That is worth stating plainly, because the assumption going in was the opposite.
A relocation does not re-mint content hashes. Only a change of CONTENT does.
The expensive part of the greenfield sketch is the part that rewrites bytes, and
moving files is not that part.

### What the move actually cost

**The staged layout had to mirror the source layout, and this was the real
constraint.** The first attempt kept the Worker staging at `.build/www/_worker.js`
while the source moved, which seemed conservative and is impossible:
`cal/src/templates.js` and `serendipity.js` import the Worker across the project
boundary and are bundled from `.build/`, so one relative specifier has to resolve
in the source tree AND the staged tree. Those only have the same shape if both
trees agree. So the Worker stages to `.build/src/worker/` and `wrangler.jsonc`
points `main` there.

The one import that still could not survive is `photos.js` reaching
`../images/hashes.json`, which worked only because the Worker used to live inside
`www/`. It is `../../www/images/hashes.json` now, which resolves from both trees,
exactly like the `../../cal/src/*` imports that already did.

### Three walks found the Worker by accident, and one of them failed silently

Every place that collected Worker modules by walking `.build/www` and filtering on
a `_worker.js/` prefix stopped finding them:

1. the shell-ref rewrite, which would have left `/a/` specifiers unhashed
2. the hashed-asset **witness** checks, which failed loudly (`ENOENT`)
3. the **client-edge CSS mirror**, which failed SILENTLY

The third is the one worth remembering. `/bot` and `/lens` are rendered by Worker
modules that carry the window geometry, so they quietly lost their client-edge
mirror and shipped 2 pages short. The build said nothing, because its tripwire
was `mirrored < 25` against a real count of 33: eight pages of slack, and the
regression only cost two. Caught by diffing the served bytes, which is the whole
argument for the byte-identical bar over "the build succeeds".

The floor is 32 now, just under the true count, matching how the other counted
tripwires in that file are set.

### One search that could not find what it was looking for

The contract test pinning lens-reader's shared SSRF guard hardcodes the import
path as an escaped regex, `/from "\.\.\/\.\.\/www\/_worker\.js\/lib\/crawl\.js"/`.
The literal string `www/_worker.js` never appears in it, so a tree-wide search for
that path did not see it and the test failed after everything else was green.

Same blind spot gotcha 29 records from the other direction: a path assembled from
parts is invisible to a search for the assembled form. When moving a path, grep
for the escaped spelling too.

## The restructure, step 2: the islands and stylesheets

The 15 client islands and 5 stylesheets moved from the root of `www/` into
`src/client/` and `src/styles/`. They stage back to the root of the served tree,
so their public URLs are still `/nav.js` and `/luna.css`.

**Served surface byte-identical again**, all 1402 files, every `/a/` hash included.
That is the second confirmation of the same rule: source layout and URL layout are
different questions, and moving the first does not disturb the second.

Two things this surfaced.

**A path built from a variable is invisible to a search for the assembled path.**
The shell and stylesheet staging loops read `` `www/${file}` ``, so nothing matching
the literal `www/nav.js` existed to find and the build died at the first shell with
`ENOENT: www/nav.js`. Third time this class has bitten in this migration, after the
`${OUT}/www/_worker.js` template and the escaped regex in the contract test.

**The served URL root is a COMPOSITE now**, assembled by `build.mjs` from `www/`,
`src/client/` and `src/styles/`. `config/tsconfig.browser.json` mapped `/*` at
`../www/*`, so `import "/hoist.js"` inside `nav.js` stopped resolving the moment
the file it names moved. The mapping lists all three directories now. Worth
remembering for anything else that resolves an absolute, URL-shaped specifier:
after a split like this, exactly one of them is right and the others fail quietly.

## The restructure, step 3: the Worker is TypeScript

All 67 Worker modules are `.ts`. The deployed bundle is **byte-identical**:
666.62 KiB / 227.77 KiB gzip, the same numbers as the JavaScript Worker, because
types erase and nothing else changed.

### `.ts` import specifiers, and that is forced rather than stylistic

Measured across the three runtimes that have to agree:

| runtime | `./x.js` naming an x.ts | `./x.ts` |
|---|---|---|
| bun 1.4.0-canary.1 | resolves | resolves |
| wrangler / esbuild | resolves | resolves |
| **node 26.7.0** | **throws** | resolves |

Only `.ts` satisfies all three, and node matters because gotcha 16 exists so
plain node can import these modules. `allowImportingTsExtensions` is what lets
tsc agree, and it requires `noEmit`, which was already set.

### What TypeScript found, and what it did not

381 errors, none of them new defects. The code is what shipped as JavaScript.
What changed is that a `.js` file lets TypeScript treat **every parameter as
optional** and infer object shapes loosely, so two classes were structurally
invisible: TS2554 (arity, 92) and TS2339 (unknown property, 269). That is 361 of
the 381.

36 of the 67 modules were already clean and are now fully checked, which is the
half of the migration that pays immediately. The other 31 carry a
`// @ts-nocheck` header and are declared in
[`config/ts-migration.json`](../config/ts-migration.json) with their per-file
error counts, so progress is measurable rather than asserted. A contract test
pins the two together in both directions and caps the list at 31, so it may only
shrink: an undeclared `@ts-nocheck` fails by name (verified by control), and
fixing a module means deleting its entry in the same commit.

One error was worth fixing on the spot rather than filing. `mcpServer`'s
`result(id, payload, cache)` had three required parameters and three call sites
in `serendipity.js` passed two. Harmless, because `...cache` spreads `undefined`
as a no-op, but the signature was lying about its own contract for as long as it
was JavaScript. `cache?` now says what was always true.

### The lint suppression that was already there, undocumented

`.oxlintrc.json` disabled six type-aware rules for `**/*.js` with no comment
saying why, and that entry turned out to be load-bearing: it is the reason none
of them ever fired on the Worker. Becoming TypeScript switched four of them on
and surfaced 9 findings.

One was real and is fixed: `ledger.ts` built `new Set()`, which infers `Set<any>`,
so `require-array-sort-compare` could not tell a safe default string sort from an
unsafe one. It says `Set<string>` now.

The rest split cleanly. `tui.ts` spreading a string is DELIBERATE, because it
renders fixed 80-column frames and is counting what occupies a column rather than
UTF-16 units; it has its own entry saying so. The others are all modules in the
migration inventory, where a type-aware rule reports the absence of types rather
than a defect, so their entry is pinned to that same inventory by the contract
test and expires with it.

### The third silent walk

The `/*min*/` CSS pass over the Worker modules filtered on `.js` and, after the
rename, matched nothing. It had **no floor**, so it printed "minified 0 literals
across 0 modules" and the build carried on shipping every Worker-rendered page
with unminified CSS. It cost ~3.9 KB and read on the wire as a 3.92 KiB bundle
regression that looked like a TypeScript tax and was not.

Found by diffing served bytes, again. It has a floor of 7 now, which is the true
count. That is three walks in this migration that located Worker modules by
extension, and the two with no counted tripwire are the two that failed silently.

## The restructure, step 4: the photo pipeline leaves the served tree

`www/scripts/` is `tools/photos/`. It is dev tooling that ships nothing, so
`.assetsignore` no longer needs its `scripts` entry and the build stages 28 fewer
files: the served tree goes 1402 to 1374.

**This is the FIRST move that was not byte-neutral**, and the reason is worth
more than the move.

`www/icons.svg` is generated, and its banner named the generator BY PATH:
`<!-- GENERATED by www/scripts/gen-desktop-partial.mjs ... -->`. That sprite is
also content-hashed and served from `/a/`. So a path inside its bytes couples the
repository layout to a public URL: moving the generator changed the banner,
changed the sprite, and re-minted `/a/icons.9ff130b8.svg` to
`/a/icons.8d4b5912.svg`. The build's own invariant caught it (`icons.svg drifted
from shell-data.mjs`), which is the check doing exactly its job.

The cascade is the interesting part and it is fully accounted for: 46 pages
reference that URL, so 46 pages changed, which changed the page-family dictionary,
which changed all 144 dcz deltas. One comment, one asset, 200-odd files.

The banner names the generator by NAME now, with no directory, so this cannot
happen again. Take the general rule: **never put a repository path inside a
content-addressed artifact.** It converts a file move into a public URL change
and orphans every dictionary that named the old one.

Practical consequence for this branch: it needs a `dict:roll` after it deploys,
because the committed `a-dict` entries for the old icons hash are now stale.

The other thing the move surfaced: every script in that directory resolves its
root two levels up, which survives because `www/scripts` and `tools/photos` sit at
the same depth. `gen-photo-semantics.mjs` was the single exception, using
`dirname(dirname(here))` so its root was `www/` rather than the repository, and it
would have silently started reading `tools/images`. It matches its siblings now.
