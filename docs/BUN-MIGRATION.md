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

### The first roll, 2026-08-17

It fired the day after it was written, which is the pin behaving as designed
rather than a flake. CI stopped at `Set up bun` naming both digests, and the
linux-x64 asset the runner fetched hashed the same value a workstation fetch got
minutes later, so the asset had genuinely moved rather than being served
inconsistently.

**It rolled again the same day**, hours after that bump, to
`1.4.0-canary.1+7aad38741`. Two bumps in one day is the shape of this pin
rather than bad luck, so expect to re-bump on most days the branch is open, and
expect a reviewer arriving cold to find `validate` red on the setup step. Same
controls each time, and the build stayed byte-identical across all 1499 files
through both.

`1.4.0-canary.1+8326d1bd3` to `1.4.0-canary.1+8bc4d2a88`. The version string
and `packageManager` are untouched, because neither of them moved, which is the
whole reason the digest is the declaration.

What a bump costs is the control, run before the digest was committed:

| control | result |
|---|---|
| build under the new canary against the old one | **1499 files, 0 differing** |
| build under node v26.7.0 against the new canary | **1499 files, 0 differing** |
| zstd dictionary probe | none=65 good=18 wrong=64, unchanged |
| contract / cal / lens-reader | 307, 59, 13 pass |
| routes, typecheck, lint, `pages:check`, `tools:check`, `check-wrangler`, `perf-budget` | clean |

The node comparison is the one worth keeping in the loop. The other two builds
share a compiler lineage, so agreeing with each other is weaker evidence than
agreeing with the runtime this repo shipped every committed hash under.

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
`tools/contract-tests.mjs` is `tools/contract-tests.test.mjs` now. Not a
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

Every place that collected Worker modules by walking `.build/public` and filtering on
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
the literal `public/nav.js` existed to find and the build died at the first shell with
`ENOENT: public/nav.js`. Third time this class has bitten in this migration, after the
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

`public/icons.svg` is generated, and its banner named the generator BY PATH:
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

## The scan before the `www/` split

`icons.svg` re-minted a public URL because a repository path lived inside a
content-addressed artifact. Before splitting `www/` into pages and assets, the
sensible move is to find every other instance rather than discover them from a
red build. `tools/contract-tests.test.mjs` now carries that as a check.

**Two findings, and the first was self-inflicted.**

**Ten stale paths in served bytes.** Most were created by this branch. The
byte-identity discipline says to revert served files so the bytes do not move,
and the cost of that is prose left behind: pages went on naming
`www/_worker.js/index.js`, `www/_worker.js/counter.js`, `www/scripts/zenc/` and
`www/scripts/add-photos.ts` after every one of those had moved. `/garage/workers`
is a page ABOUT the Worker and it was citing a directory that no longer existed.
One (`tools/gen-shell-deltas.mjs`) predates the branch entirely.

Worth stating as a rule, because it cuts against the discipline that produced it:
**preserving bytes preserves stale documentation too.** A move is not finished
when the build is byte-identical; it is finished when the prose still describes
where things are.

**One live coupling in a content-addressed asset.** `/a/lens-browser.<hash>.js`
contains the string `node tools/lens-webmcp.mjs`, which the Browser view prints
so a visitor can run the probe themselves. That is a real path in a real command,
so it cannot be made path-free the way the icons banner was. The consequence is
worth knowing BEFORE the move rather than after: **`scripts/` to `tools/` will
re-mint that asset and orphan its three `a-dict` entries**, unavoidably.

A useful distinction fell out of it. A COMMENT in a client island reaches only its
`.src.js` twin, because minification strips it; a STRING LITERAL reaches the
hashed asset too. So the five stale comments cost nothing but page bytes, and
every `/a/` URL was verified unchanged after fixing them.

### The check, and the three false positives it had to lose

The first version reported `tools/` nine times and every one was MCP's
`tools/list` and `tools/call`. That is the naive-scanner trap this repo has now
caught four times on its own output. It also flagged `cal/coffee` (a route),
`www/ad/` (build output that exists only under `.build`), and `www/scripts`
inside a comment whose whole job is to record that the directory MOVED.

The principle that removed all of them without an exception list: **only a token
naming a FILE is a citation that has to resolve.** A bare directory mention is
prose. One genuine allowlist entry remains, `src/buttcrack/`, which is a file in
somebody else's repository that `/lwe/vigenere` cites as attribution.

It reads the BUILT tree, counts what it scanned so a matcher that stops matching
cannot pass, and was verified by planting a citation to a nonexistent file.

## The restructure, step 5: `www/` splits, and `scripts/` becomes `tools/`

The bar changed here, deliberately. Everything up to this point was gated on a
byte diff; this step is gated on **interoperability** instead, because the point
of the layout is what it makes possible next rather than what it preserves.

| was | is | why |
|---|---|---|
| `www/**/*.html` | `src/pages/` | a page is a document |
| `www/{md,writing,*.md}` | `src/content/` | authored prose and registries |
| `www/{a,p}-dict/` | `src/dict/` | build INPUT, never served |
| everything else in `www/` | `public/` | byte-for-byte assets |
| `scripts/` | `tools/` | merged with `tools/photos` and `tools/oxlint` |

36 documents, 803 assets. The served layout is unchanged, so every public URL is
where it was: **2650 internal references resolve, all 136 routes pass**, the
Worker bundle is unmoved at 666.62 KiB, and 293 contract tests, typecheck, lint,
`pages:check` and `tools:check` are clean.

### The staged root is `public` now, and that is load-bearing

`.build/www` is `.build/public`. Not cosmetic: a relative specifier has to resolve
in the source tree AND the staged tree, which is only possible when the two share
a name. `src/worker/photos.ts` imports `../../public/images/hashes.json`, and with
the staged copy still called `www` that resolves in exactly one of them. This is
the third time the same rule has decided a move, after the Worker and the islands.

### One regex, six blind spots

A negative lookbehind kept the path rewrite out of `.build/www`, and the same
lookbehind hid every reference reached through a prefix or an interpolation. Each
was found by a different failure, and none by reading the code:

| shape | example | found by |
|---|---|---|
| bare directory | `readdir("www")` | ENOENT in an invariant |
| relative prefix | `../../www/images/hashes.json` | module resolution |
| template prefix | `` `${root}/www/sitemap.xml` `` | the feeds generator |
| interpolated segment | `` `www/${dir}` `` | a second invariant |
| no separator | `` `www${p}.html` `` | 9 Markdown twins vanishing |
| no extension | `_headers`, `.assetsignore` | the served-path check |

The last two are the instructive ones. `` `www${p}.html` `` silently degraded 44
twins to 35 and moved most of them from authored source to generated HTML, which
no error reports; the count in the build log is what showed it. And the
extensionless files were skipped because the sweep filtered on extension, so two
stale citations survived into served bytes and only the check written in the
previous commit caught them.

### The lesson that cost the most, twice

`www/a-dict` and `www/p-dict` were classified as assets and sent to `public/`,
because the classifier tested for `a-dict/` WITH a trailing slash and the bare
directory name did not match. The build then found no dictionaries and silently
emitted zero per-page deltas: `144` became `48`, all family, no error. It reads
as a stale-dictionary problem and it was a wrong path.

Then the same blanket rewrite ran over prose and **erased history**: rows in
CLAUDE.md and twelve lines of this file that record what something USED to be
called were rewritten to the new name, so the record of the move destroyed the
record of the move. Restored by hand.

Both are the same mistake. **A path rewrite is a semantic edit, not a textual
one** — it has to know whether a string is a live reference, a historical one, or
a name that merely looks like a path.

### Dev keeps serving readable source

`wrangler dev` pointed at `www/`, which no longer exists as one tree.
`tools/compose-dev.mjs` assembles `.dev/public` from the five source roots with NO
transforms, so `bun run dev` still serves the bytes you authored, comments intact.
It is deliberately not `build.mjs`: dev needs composition, and minification,
hashing, precompression and dictionaries are deploy concerns.

## Should `Bun.build()` replace any of the build's transforms? No, on all three.

`bun run bun:build:check` is the control. It asks three questions, because
"adopt Bun.build" is three decisions with different answers.

| | current | bun | verdict |
|---|--:|--:|---|
| CSS (`luna.css`) | 7,746 br | 11,356 br | keep lightningcss, **+46.6%** |
| JS (15 islands) | 60,706 br | 62,133 br | keep oxc-minify, **+2.4%** |
| HTML entrypoints | bespoke pipeline | fails to build | keep the pipeline |

**The CSS panic is FIXED, and that changes the argument rather than the answer.**
An earlier canary crashed inspecting a `Bun.build()` result for this stylesheet;
this one returns cleanly. What it returns is 69,806 bytes from a 69,503-byte
source, because Bun emits sRGB, P3 and LAB fallbacks by default. So the reason to
keep lightningcss is SIZE now, not a crash, which is both more durable and easier
to re-check.

**Cutting around the CSS does not rescue the JS half.** That was the hypothesis
worth testing and it does not survive: 13 of 15 islands come out larger, the
total is 2.4% worse on the wire, and `tooltip.js` loses the `function start`
marker `build.mjs` asserts. Only `lens-reader` (-2.7%) and `lens-wire` (-2.0%)
improve. On render-blocking shell assets that ship q11-precompressed and carry
dictionary deltas, 2.4% is the wrong direction.

**The HTML entrypoint is the one that would have bought a CAPABILITY**, replacing
SHELLS, STRING_ASSETS and the hashed-asset repointer with a bundler that follows
`<script>` and `<link>`, hashes the outputs and rewrites the paths. It fails, and
the reason is architectural rather than a bug: every page references `/luna.css`,
`/nav.js` and `/quiz.js` as ABSOLUTE URLs so that all 48 documents share ONE
content-hashed copy of each. A bundler cannot resolve those, and making them
relative would give each page its own copy, which is precisely what the `/a/`
tier exists to prevent.

That is the honest shape of the whole question. **Bun is winning where it runs
code and losing where it transforms bytes.** Install, script running, the test
runner, the build runtime and TypeScript for the Worker are all adopted and all
paying. The transform layer is mature, tuned and specialised, and a general
bundler does not beat it here.

Re-run the control when a Bun release lands. Question 3 is the one most likely to
change and the one worth re-checking even while 1 and 2 stay lost.

### Can it be configured to match? No, and the two halves fail differently

The obvious response to those rows is "configure Bun the same way". It cannot be,
and `bun run bun:build:check` now measures that as a fourth question.

**JS: Bun is already at maximum.** `minify: true` produces byte-identical output
to `{ whitespace: true, syntax: true, identifiers: true }`, so there is no more
aggressive setting to reach for. Turning identifier mangling OFF makes nav.js
worse (5,957 to 6,548 brotli), which is the only direction the knob moves. oxc
ships at 5,783 on the same file, and the gap is inherent to the minifier rather
than to how it is configured.

Worth naming what oxc is configured with, since it is the thing Bun has no
equivalent for: `compress.target: "esnext"` plus `mangle: { toplevel: false }`.
Top-level names are deliberately NOT mangled because several islands expose
globals other site code finds by name. Bun exposes `identifiers` as one boolean
with no top-level carve-out, so matching that config is not expressible.

**CSS: the fallbacks are unconditional.** lightningcss is called with NO `targets`
option, which is why it emits no fallbacks and lands at 36,841 bytes. Bun emits
sRGB, P3 and LAB fallbacks and lands at 69,806. A modern `.browserslistrc`
changes that by **zero bytes**, and so does a `browserslist` key in
`package.json`; both were measured, both ignored.

**One methodological note, because it inverts an earlier lesson.** The Kitesurf
probe established that a CLOSED payload schema lets you test support by sending a
bogus key and reading the error. `Bun.build` is the opposite: it IGNORES unknown
option keys, so a missing error proves nothing at all. Every row in that control
is measured by EFFECT on the output bytes, never by whether an option was
accepted. Check which kind of schema you are holding before designing the probe.

## Pulling pnpm and node out

**pnpm is gone.** No lockfile, no workspace file, no invocation, no message
telling anyone to run it. The only surviving mentions are the two Workers Builds
deploy commands in `infra.json`, which RECORD what is typed into the Cloudflare
dashboard rather than anything this repo runs, and prose recording what changed.
Those two strings cannot move first: `check-infra.mjs` compares them against the
live dashboard by exact match, so editing them ahead of the dashboard fails on
drift it invented itself.

**node is down to exactly two things, both measured, both re-testable.**

`wrangler.jsonc`'s `build.command` was still `node tools/build.mjs`, so every
`wrangler deploy` shelled back into node for the build. It is `bun` now, and the
whole deploy path was then verified with node genuinely unavailable: a stub on
PATH that exits 127. `wrangler deploy --dry-run` completed and produced a
**byte-identical bundle** (one sha256 across both runs).

What still needs node:

1. **The wrangler CLI itself**, because `node_modules/.bin/wrangler` carries a
   `#!/usr/bin/env node` shebang. There IS an escape hatch and it is measured:
   `bun ./node_modules/wrangler/bin/wrangler.js --version` answered 4.123.0 with
   node shadowed. `bun x --no-install wrangler` does NOT work, because bunx
   honours the shebang and spawns node. So node can be removed the day it has to
   be, by invoking the entry rather than the shim.
2. **`routes:check`**, which boots workerd through `createTestHarness()` and
   still hangs under bun. Re-tested on this canary: no output, no error, killed
   at the timeout with workerd children idle.

Neither is a bun defect to route around. Both are wrangler, miniflare and workerd
being node-pinned, which was known going in.

### gzip is runtime-dependent, and brotli is not

Worth knowing before anyone compares a number across runtimes. On identical
input, bun's `node:zlib` gzip is consistently ~0.7-0.8% larger than node's:

| | node | bun |
|---|--:|--:|
| `nav.js` gzip | 17,810 | 17,951 |
| `lens.js` gzip | 44,766 | 45,084 |
| `luna.css` gzip | 21,940 | 22,100 |
| all three, brotli q11 | **identical** | **identical** |

**Nothing that reaches a visitor changes**, because the wire is brotli and zstd
and both are byte-identical between runtimes. gzip is a REPORTING path:
`perf-budget.mjs` computes its own with `gzipSync`, and wrangler prints one in
`Total Upload`. That is why the same bundle reported 227.78 KiB gzip under node
and 230.10 under bun while the artifact hashed identically.

The budgets have room (index.html is 9.4 KiB gzip against a 22 KiB envelope), so
nothing needed re-baselining. But a gzip figure is only comparable to another
gzip figure taken on the same runtime, and this repo's budget history is a list
of numbers somebody typed.

### A check that had been agreeing with itself

`check-wrangler.mjs` counts transitive wrangler copies by reading the isolated
linker's store, and it read `node_modules/.pnpm` alone. That directory stopped
existing at the pnpm removal, the `try/catch` swallowed the ENOENT, and it
reported "0 transitive copies" on every run since: a clean pass that had
inspected nothing.

It reads `.bun` and `.pnpm` now, parses both suffix conventions (`+hash` and
`_peer`), and says out loud when it finds neither rather than reporting an
unscanned tree as clean. Verified by planting a `wrangler@3.0.0` in the store.

While fixing it, a second and older weakness: the transitive count was only ever
PRINTED. A drifting wrangler exited 0. That was survivable while the scan was
reading a missing directory and the count was always zero; with the scan working
it would have been a scanner nobody reads. It fails now, exit 1, with the
offending versions named.

## The media scripts are Bun Shell, all ten of them

`tools/photos` holds no shell. Every script was verified equivalent against the
one it replaced BEFORE the shell version was deleted:

| script | how it was verified |
|---|---|
| `add-car-photo` | byte-identical jpg + avif |
| `bump-version` | byte-identical `checkpoints.json`, original restored |
| `download-remote-photos` | byte-identical 8.9 MB download, matching rejection |
| `hash-thumbnails` | sandboxed: identical tree + map across merge, prune, additive tier |
| `gen-encoding-grids` | 16 outputs byte-identical, in a scratch dest |
| `gen-encoding-samples` | 11 outputs byte-identical, in a scratch dest |
| `extract-photo-metadata` | all 158 projections identical to real `jq` |
| `reencode-thumbnails` | 2 real originals through 4 tiers, 8 outputs identical |
| `export-for-instagram` | both branches: same q51, same metrics, same bytes |
| `add-photos` | index merge identical to `jq`; front-half behaviour matched |

**`add-photos` was NOT run end to end, deliberately.** Phase 3 uploads to R2 and
phase 4 rewrites `public/i` and the photo index, so a verification run would have
had to modify the real photo tree to prove anything. What was verified instead is
every piece that was REIMPLEMENTED rather than translated: the index merge
against real `jq` on the real 158-entry index, and the argument and prerequisite
handling against the shell. The geometry it shares with `reencode-thumbnails` is
the code that WAS verified byte-identical on real photos.

### What the conversion was actually for

Not ergonomics. In shell a prerequisite is written `for cmd in sips exif-sooc`,
so the binary name exists only as a loop word and a search for it finds nothing.
That is why four prerequisites stayed undocumented until `tools:check` went
looking, and why that checker carried THREE source-scraping scanners, each with a
floor, so that a scanner which stopped matching could not report a pass.

Every script now exports `REQUIRES = [...]`. The checker READS it: no regex, no
floor, and both directions checked (a binary `tools.json` does not declare, and a
declaration left behind after a script stopped using it).

**All three shell scanners are deleted.** With no shell left they would report
"0 scanned" and pass, which is the decoration this repo's own comments warn about
everywhere else. `git log -- tools/check-tools.mjs` has them if shell returns.

### Seven scripts were already broken and nothing knew

`add-car-photo`, `hash-thumbnails`, `extract-photo-metadata` (twice),
`gen-encoding-grids`, `add-photos` and `reencode`'s sibling all computed a root as
`$(dirname $0)/..`, which was `www/` before the tree split and became `tools/`
after. `SRC_DIR` pointed at `tools/images`, `DEST` at `tools/garage/enc`, the
histogram bake at `tools/`. **No search for `www/` can find any of them, because
the path is COMPUTED rather than written.** That is the same blind spot as
`${OUT}/www`, `` `www/${dir}` ``, `www${p}.html` and the extensionless config
files: four costumes, one lesson.

### Two bugs fixed in flight

`gen-encoding-samples` ran its `exif-sooc` version gate at the very END, after
every write that depends on it. A too-old binary strips nothing (it reads `-all=`
as a tag SELECTION) and 0.1.0 truncated progressive JPEGs at their first scan, so
it would publish damaged files and only then announce the binary was unusable.

And `add-photos` had `inputs.find(async …)` in my own first draft, which returns
the first element whatever it is, because a promise is always truthy.

### Tools that left rather than moved

`python3` from five scripts to two, `curl` and `jq` from the downloader,
`jq` from the metadata extractor. The line held throughout: replace a tool that
was standing in for a language feature, keep the one doing real work. `sips`,
`exif-sooc`, `avifenc`, `cwebp`, `ffmpeg`, `zenc`, mozjpeg and the two libjxl
metrics all stay.

## The histogram bake is build-dependent, and the format amplifies it

Running `add-photos` on one real photo rewrote all 158 histograms with nothing
about the input having changed. Investigated rather than shrugged at, because
"the pipeline rewrites 158 files when you add one" is the kind of thing that
gets normalised and then hides a real defect.

**What was ruled out.** `Cargo.lock` is committed and unchanged, pinning the
decoder at `image` 0.25.10 / `zune-jpeg` 0.5.15. The bake reads
`public/i/<stem>.<j>.jpg` through `hashes.json`, and those hashes are unchanged,
so the input bytes are identical. Two consecutive bakes on this build produce
identical output, so it is not nondeterminism. The only remaining variable is
the BUILD, and there was no `rust-toolchain` file: rustc was whatever the machine
had.

**What actually moved**, measured across all 40,448 bins:

| delta | share |
|---|---|
| ±1 level | 62% |
| ±2 levels | 20% |
| worst case | **37 levels** |

31.2% of bins differ. The ±1 and ±2 band is exactly the decoder noise
`histogram.rs`'s own header measures and says binning absorbs, and it is right
about that. The 37-level tail is not absorbed by anything, and the mechanism is
in the pack:

```rust
let peak = binned.iter().copied().max().unwrap_or(0).max(1);
… ((100.0 * b as f64) / peak as f64).round_ties_even()
```

**The histogram is PEAK-NORMALISED.** Every bar is a percentage of the largest
bar, so a decoder difference that nudges the peak bin rescales all 64 at once.
One pixel moving between bins at the peak is enough to move every bar in that
channel. That is why a 0.07% pixel disagreement produces a 31% bin disagreement.

### What was done, and what was not

Two cheap fixes, because both remove a variable without moving any served byte:

- `tools/photos/zenc/rust-toolchain.toml` pins rustc 1.93.0, so the toolchain
  stops being ambient.
- `ensureZenc` builds with `--locked`, so a build cannot silently update the
  committed lock. It could before, and that would have moved every histogram
  with no visible cause at all.

**Neither fixes the existing mismatch, and that is deliberate.** The committed
histograms came from an unrecorded build, so no pin reproduces them
retroactively. Closing the gap needs ONE deliberate rebake, committed, which
moves the served histogram bytes for all 158 photos and re-mints nothing else.
That is a call for the owner rather than a side effect of a tooling branch.

The deeper fix, if the drift ever costs more than one rebake: normalise against a
STABLE denominator (total pixels, or a fixed ceiling) instead of the peak, so one
noisy bin cannot rescale the other 63. That changes the format and every
committed histogram once, and it would make the bake robust to exactly the
decoder differences the header already documents as unavoidable.

## The CSP hash scan runs on HTMLRewriter, which node cannot do at all

The first thing bun bought that is about the SITE rather than the toolchain.
`build.mjs` step 7c reads every staged document and writes the sha256 map the
enforcing `script-src` is built from. It did that with a hand-rolled tag walker,
and the walker was correct only because it had been patched three times against
the served bytes: minify-html unquotes attributes and decodes character
references inside quoted values, so a scanner written against authored HTML
reads minified HTML wrong. CLAUDE.md records all three incidents.

Bun ships HTMLRewriter as a global. It is lol-html, **the same parser
`src/worker/` runs**, so the build now reads a document the way the Worker does
and the way the browser computing these hashes does. There is no node
equivalent and no way to get one without a dependency.

### The parser and the walker agree exactly, which is the point

Over the 48 served pages, in 35ms:

| inline `<script>` by type | count |
|---|--:|
| no type | 50 |
| `speculationrules` | 46 |
| `module` | 1 |
| `application/json` + `ld+json`, data rather than script | 31 |
| inside `garage/horizon.html`'s `iframe[srcdoc]` | 1 |

97 executable in the documents plus the srcdoc one is the 98 the step has always
reported. **A full build after the swap is byte-identical across all 1499
files**, which is the bar every commit on this branch has had to clear, and it
is the only assertion that could have caught a hash moving.

So this changed no output and bought no speed. What it bought is that the
scanner is now correct because it is a parser rather than correct because
somebody patched it three times.

### What the tests pin, and the controls that prove they can fail

Five tests in `tools/contract-tests.test.mjs`, written for TEETH the way the
link resolver above them is: the real tree has zero event handlers and one
srcdoc, so a test asserting only "the site passes" would survive the scanner
being reduced to `() => []`.

- data blocks are not hashed and `speculationrules` is
- the hash is over the RAW body, pinned to a literal, so the `&amp;` in a script
  body and the chunk split on `<` both stay honest
- srcdoc is descended IN DOCUMENT ORDER, asserted against the flattened
  equivalent, because the map is serialised into `csp-hashes.ts` and a reshuffle
  is a changed Worker bundle for nothing
- `value="&lt;img src=x onerror=alert(1)&gt;"` is text, and a real `onclick` is
  still caught. That false positive is what made the old walker parse attributes
- an empty `<script></script>` still hashes the empty string, and an unterminated
  one throws

Two controls, run and reverted: making every type executable fails the first test
by name, and dropping the srcdoc descent fails the third.

### One runtime now, and the guard sits before the first `rm`

The build can no longer run under node. The one caller that still did,
`dictionary-roll.yml`'s build step, moves to `bun run build`; it already sets up
bun and installs with it, so the node line was a leftover.

`cspRequireParser()` runs BEFORE the first `rm(OUT)` rather than at step 7c.
Checked at 7c it fires two seconds in, after the staging has already deleted the
previous build. That is the same lesson `config/bun-canary.json` records about
the zstd probe, where the feature detection was correct and 40 seconds late: **a
precondition checked after the work is a precondition that costs the work.**

## The photo pipeline runs N photos at a time, and the pool is measured

Every per-photo loop in the photo tooling ran ONE photo at a time on a 14-core
machine, at about 85% of a single core. Phase 1 alone spawns 6 sips, 1 zenc and
3 avifenc per photo. Timed on a real source file, that chain is 1.1s: 273ms in
the first `sips -Z 2000`, 189/126/83ms in the three avifenc calls, the rest in
sips conversions and zenc.

`tools/photos/lib/pool.ts` is now shared by `add-photos.ts` (phases 1, 2 and the
R2 uploads), `reencode-thumbnails.ts` and `export-for-instagram.ts`.

### The number, and why 8

24 real photos through the phase-1 chain:

| concurrency | ms/photo |
|---|--:|
| serial | 836 |
| 4 | 228 |
| 6 | 184 |
| **8** | **159** |
| 10 | 163 |
| 12 | 150 |

The knee is 8 and past it the differences sit inside run-to-run noise, because
avifenc already takes `--jobs 4`, so the machine is oversubscribed either way.
`PHOTO_JOBS` overrides it; uploads keep their own `UPLOAD_JOBS` of 4, since what
bounds them is R2 rather than the CPU.

End to end on the one script that is easy to measure honestly, 30 files through
`export-for-instagram --dry-run`, which is the heaviest loop here (a binary
search over q, each rung scored by ssimulacra2 and butteraugli): **33.7s to
6.2s, with byte-identical stdout.**

### Two controls, and the second one found a real bug

**Encoders first.** Concurrency is only free if the bytes do not move, and `/i/`
is content-addressed, so a moved byte re-mints a URL and orphans dictionaries. 8
photos through the full chain serially and pooled: all 32 encoded outputs (600
JPG, 600/400/200 AVIF) byte-identical. No encoder flag was touched, deliberately,
and `--jobs 4` stays exactly where it was, since threading changes inside an
encoder are precisely the kind of thing that moves output.

**Then stdout, which is where the bug was.** The pooled export printed different
ssimulacra2 scores than the serial run. Cause: intermediates were keyed by STEM
(`${stem}-try.jpg`), and two inputs can share a stem, which is a harmless
overwrite when one photo runs at a time and a race when eight do. The pool hands
each item its INDEX, so intermediates are per item now and cannot collide.
`reencode-thumbnails.ts` keeps stem-keyed temps because its stems are the keys of
a hash map and unique by construction; that invariant is written at the loop.

The lesson generalises past photos: **parallelising a loop makes every shared
name a race, and the shared names are usually the temp files nobody thinks of as
state.** The output comparison is what surfaced it, so run one.

### A queue, not batches

The helper this replaces was `for (let i = 0; i < items.length; i += n) await
Promise.all(items.slice(i, i + n).map(fn))`, which puts a barrier at every batch:
nobody starts item n+1 until the slowest of the first n finishes. Photos are not
uniform, so a batch runs at the speed of its worst member. Four contract tests
pin the difference, and the barrier one FAILS against the old batching helper,
which is the control that makes it worth having.

### Output order survives

`export-for-instagram` prints an aligned per-photo table, so its rows are
buffered per item and flushed in INPUT order as each prefix completes. Finish
order would have been easier and would have shuffled the table.

## Coverage is a report, deliberately

`bun test --coverage` works with no configuration, so `bun run test:coverage`
(`tools/coverage-report.mjs`) reads the lcov and names what the 316 contract
tests never execute. Today that is **7707 of 14063 lines, 54.8%**, with
`src/worker/updates.ts` at 4.7%, `tools/check-agent.mjs` at 11.3% and
`src/worker/whoareyou.ts` at 22.0%.

CI runs it inside `validate` under `continue-on-error` and puts the table in the
job summary. It gates NOTHING, and that is the design rather than timidity: a
coverage floor is one more constant somebody widens, and this repo has the
receipts for what that does, since perf-budget spent an era in breach while
printing "hard checks green" over itself every run. The useful moment for this
number is picking what to test next, which #444 did by hand.

One honesty note is built into the output: `cal/` looks uncovered here and is
not, because its own Vitest suite runs inside workerd. Those files are counted
out and named rather than silently hidden.

## The canary is no longer required to BUILD

`zstdCompressSync`'s `dictionary` option is the only api on this branch that bun
1.4 has and released bun does not. Measured under bun 1.3.14: the build runs
staging, minification, the `/a/` hashing, precompression and the CSP scan, and
dies at exactly that probe. Everything else it needs, released bun already has,
HTMLRewriter included.

So `tools/lib/zstd-batch.mjs` delegates instead of demanding. When the running
runtime ignores the option, the batch goes to `node`, which honours it from 26.
`ZSTD_FORCE_NODE_DELEGATE=1` forces that path on a runtime that does not need
it, which is how it gets tested rather than assumed.

| control | result |
|---|--:|
| canary, in-process (unchanged path) | 1499 files, 0 differing |
| canary, delegation FORCED | 1499 files, 0 differing |
| **released bun 1.3.14, end to end** | **1499 files, 0 differing** |
| contract suite under 1.3.14 | 318 pass |

Build wall clock is 2.1s in-process and 3.1s delegated, the difference being one
spawn per shell delta plus one for the whole page batch.

### The control found a second call site, which is the point of running it

The first version routed only `dczEncodeBatch`. Under released bun the build
then SUCCEEDED and quietly shipped **21 fewer files**: the shell tier called
`zstdCompressSync` directly, so it produced no deltas while the page tier
produced 144. The log said only that every candidate "lost to plain brotli",
which is the same sentence it prints when the shell genuinely has not changed.

That is this repo's oldest dictionary lesson arriving through a new door. A
runtime that ignores the option still returns a valid frame, and that frame
still decodes against the dictionary, so nothing errors and the only signal is a
byte count that never shrank. Both paths go through the one seam now.

### What is still needed to make Workers Builds publish this

The image reads `packageManager` and tries to resolve it as a RELEASE. Measured
in a real build on 2026-08-17:

```
Detected the following tools from environment: bun@1.4.0-canary.1, nodejs@26.7.0
Installing nodejs 26.7.0        <- succeeded
Installing bun 1.4.0-canary.1   <- failed, no release is tagged that
```

Two useful facts in four lines. **The image honours `.node-version: 26`**, which
is what makes the delegate available there. And `packageManager` has to name
something the image can resolve, so pointing it at a released bun is the
remaining repo-side step, with the dashboard commands after it and `infra.json`
after that.
