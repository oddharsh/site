# Dependency updates and site leverage

Dependabot watches FIVE ecosystems, and this paragraph named two of them until
2026-08-14:

| ecosystem | directory | what it owns |
|---|---|---|
| npm | `/` | the shared deploy toolchain and the one shipped dependency |
| npm | `/lens-reader` | the Reader lens Worker, which is outside the workspace on purpose |
| github-actions | `/`, `/.github/actions/*` | the six digest-pinned actions |
| cargo | `/tools/photos/zenc` | the JPEG thumbnail encoder's zenjpeg pin |
| pip | `/tools/photos` | Pillow, for one page generator |

Each update PR keeps the upstream release notes/changelog in its Dependabot
description and gets a persistent site-review comment containing the exact
version change, update type, and questions for the site.

Two of those cells were wrong until 2026-08-24, in the same direction: they
described coverage the config did not have. The count read five while six
distinct third-party action repositories are pinned across `.github/`, because
`codeql.yml` arrived with the move to CodeQL advanced setup and nobody re-counted.
And the glob is new, because `directory: "/"` reaches `action.yml` at the
REPOSITORY ROOT plus everything in `.github/workflows`, and never a composite
action in a subdirectory, so `.github/actions/setup-bun` was unwatched from the
day it was written. That one costs nothing yet: the action is pure shell and
names no `uses:`, which is also why it was invisible.

Every ecosystem carries `cooldown: default-days: 1`, which is the same 24 hours
`bunfig.toml` sets as `minimumReleaseAge = 86400`. For the two npm blocks it is
load-bearing rather than tidy, since bun refuses to RESOLVE a pin younger than
that window and an exact pin gets no fallback: measured 2026-08-24 on bun 1.4.0,
`bun install` exits 1 with `failed to resolve`, and exits 0 on the same tree with
the policy off. A dependency PR opened inside the window is therefore one nobody
can carry into `bun.lock` until the package turns a day old. Cooldown governs
version updates alone and never security updates, so it delays no advisory.

Before merging a dependency PR, future agents should record whether the new
release changes any of these surfaces:

- Cloudflare Workers, Wrangler, R2/KV/D1, Browser Run, or Workers Builds APIs;
- bundle size, runtime compatibility, browser support, or performance budgets;
- local photo tooling, metadata extraction, the image encoders (zenjpeg through
  `zenc`, and the system binaries `config/tools.json` declares), or CI behavior.

If there is no useful leverage, say so explicitly in the PR review. The merged
PR and its review comment are the changelog record; this file is the durable
review policy and entry point for future agent runs.

## The two versions no ecosystem owns

### bun, in `packageManager`

`package.json`'s `packageManager` field names the bun this repository runs, and
none of the five ecosystems above reaches it. The npm updater bumps `@types/bun`
and leaves the runtime alone. Dependabot's own `bun` ecosystem would not help
either: it reads `bun.lock` rather than the field, and it cannot run here at all
while dependabot-core pins `MAX_SUPPORTED_LOCKFILE_VERSION = 1` against our v2
lockfiles.

That is the worst version to leave unowned, because it is the one that compiles
the site. `wrangler.jsonc`'s build command is `bun tools/build.ts`, so the pinned
bun mints every content-addressed `/a/` and `/i/` URL production serves. A bump
that changes one output byte is a dictionary roll and a CSP hash change wearing a
version string.

`bun run bun:pin` is what owns it, and
[`.github/workflows/bun-pin.yml`](../.github/workflows/bun-pin.yml) runs it
nightly and opens a PR when a candidate earns one. Five gates, ordered so the
cheapest disqualifier runs first:

| gate | refuses |
|---|---|
| newest STABLE release, carried by npm too | a rolling `canary`, and a version only half the resolvers can see |
| older than `minimumReleaseAge` | a runtime younger than the window bunfig applies to a lightningcss patch |
| zstd honours `dictionary` | the silent one: a runtime that accepts the option and ignores it ships plain zstd as every dcz delta |
| reads the committed lockfile, writes the same `lockfileVersion` | a format change, which is what 1.4 actually did and what broke dependabot's bun updater |
| byte-identical build, and the suite | a differing byte, which mints a URL and orphans every `a-dict` snapshot naming the old hash |

The control is permanent, because the previous bun is a known-bad runtime:

```bash
bun run bun:pin --from 1.3.13 --to 1.3.14
```

That must fail at the zstd gate with `73 none / 73 good / 73 wrong`, the collapse
that means the option was ignored. Without it, a run reporting "nothing to do" on
a day when the pin is already current proves only that the comparison ran.

`@types/bun` stays dependabot's, and the two are allowed to disagree for a day.
The baseline below already worked that through: the release-age policy once held
the types pin a release behind the runtime and it caught up on its own, which is
a wait rather than a fork.

### node, in `.node-version`

Also unowned, and it needs a DIFFERENT tool rather than the same one pointed
elsewhere. Three facts make the bun design wrong here:

- **The file holds a bare major** (`26`), and `actions/setup-node` resolves the
  newest release of it on every run. Patches and minors are already current
  everywhere, with no PR and nothing to remember. There is no drift to close.
- **The only decision left is the major**, which is a policy call rather than a
  version comparison. Node ships one every April and October and half of them
  never become LTS, so a job proposing node 27 the day it lands would be
  proposing to leave the LTS line.
- **Node builds nothing here.** `node tools/build.ts` cannot run at all since
  `lib/link-integrity.ts` began parsing with HTMLRewriter. What node does is run
  wrangler, on the path that publishes production, plus the route oracle and the
  gzip measurements.

What is unowned is therefore the SUPPORT WINDOW. A major has published dates for
entering maintenance and for end of life, nothing here read them, and an
end-of-life node in the deploy path is obvious in hindsight and invisible in
advance.

`bun run node:pin` reads those dates from nodejs/Release's own `schedule.json`
rather than from a copy in this repository, which would go stale in exactly the
way the check exists to catch. It reports the phase and escalates on three
states, and only three:

| state | why it is escalated |
|---|---|
| end of life | the runtime on the publish path takes no fixes at all |
| within 180 days of end of life | enough runway to take the gates below deliberately |
| entered maintenance | security fixes only, so the clock is running |

A pin sitting on a pre-LTS **Current** release is reported and never escalated,
because it resolves itself on a date already in the schedule. That is the state
today: node 26 became Current on 2026-05-05 and enters Active LTS on 2026-10-28.

[`.github/workflows/node-support-window.yml`](../.github/workflows/node-support-window.yml)
runs it weekly, since the events are years apart, and files an ISSUE rather than
opening a PR. The title carries the phase, so a repeat of the same news is
suppressed while the next, more urgent state still gets through.

The controls are permanent too, because node's schedule keeps every major it has
ever shipped and each retired one is frozen in a state this must catch:

```bash
bun run node:pin --pretend 23   # never became LTS, ended 2025-06-01
bun run node:pin --pretend 22   # in maintenance since 2025-10-21
```

The tree half of the check has no network and lives in
`contract-the-node-pin-is-declared-once.test.mjs`, so `validate` already runs it:
the pin is a bare major, the three node numbers below stay in order, and every
workflow reads the file rather than naming a version inline.

**THERE ARE TWO FLOORS, and they were welded into one until 2026-08-31.** The
distinction is the useful part, because the weld was correct on the day it was
written and came apart without anything going red:

| number | means | lives in |
|---|---|---|
| zstd floor, **24** | the lowest node that HONOURS `node:zlib`'s `dictionary` option | `ZSTD_DICTIONARY_NODE_FLOOR` in `tools/build.ts`, beside the check that enforces it |
| `engines.node`, **26** | the highest node any constraint in this repo demands | `package.json` |
| `.node-version`, **26** | what CI installs | `.node-version` |

The test asserts `zstd floor <= engines.node <= pin` and that build.ts's tripwire
INTERPOLATES its constant rather than repeating the number. Each floor moves for
its own reason.

The zstd one is measured rather than asserted, as of 2026-08-24. One 8800-byte
buffer compressed against itself at level 19, on darwin-arm64:

| node | no dictionary | with dictionary | honours it |
|---|--:|--:|---|
| v23.11.1 | 63 | 63 | no, silently |
| v24.19.0 | 63 | 19 | yes |
| v26.7.0 | 63 | 19 | yes |

That measurement was right and the conclusion drawn from it was too wide. It
said the zstd option "sets the floor", and a floor is the MAXIMUM of every
constraint, so the claim held only while zstd was the only one. It stopped
holding when `Map.prototype.getOrInsertComputed` arrived in
[`inbox.ts`](../src/worker/inbox.ts), [`around.ts`](../src/worker/around.ts) and
[`census.ts`](../src/worker/census.ts): probed 2026-08-31, `typeof
Map.prototype.getOrInsertComputed` is `undefined` on v24.20.0 and v25.4.0 and
`function` on v26.8.1. So `package.json` advertised node 24 while the repository's
own suite could not run below 26.

**Production was never affected, which is exactly why nothing caught it.**
workerd has the method, probed through `createTestHarness`, and the call works;
`/around` and `/inbox` both answer 200. The only casualty was a contributor on a
node this repo claimed to support, who would get two failures reading like real
defects. It surfaced as a side effect of testing an unrelated flag against the
declared floor, which nothing else in the repo had ever done.

Note that `engines.node` now EQUALS the pin. That is worth keeping where it can
be: a floor equal to the pin is the version CI exercises on every run, while any
gap below it is a support claim nothing tests. The test still allows a gap, since
closing it by rule would make every `.node-version` move a two-file edit, but the
gap is where this class of bug lives.

The general rule, which the zstd measurement already stated one level down: a
floor written `>=N` is a claim about N-1 as much as about N, and measuring only
the versions you happen to have running leaves the boundary untested. It applies
to the floor itself as much as to any one feature behind it.

### the system binaries, in `config/tools.json`

A third shape again, and the reason is worth stating because it inverts the two
above. bun and node are versions you want CURRENT. The encoders here are versions
you want RECORDED.

Seven of the thirteen declared binaries produce bytes that ship: `exif-sooc`,
`sips`, `jpegtran`, `cjpeg`, `avifenc`, `cwebp`, `ffmpeg`. `public/i` is
content-addressed, so re-encoding under a different encoder mints 632 new URLs,
orphans every `src/dict/a-dict` snapshot naming the old hash, and can leave
derived data describing pixels nobody serves. That last one is not hypothetical:
gotcha 41 is the record of exactly it, where #394 re-encoded 316 thumbnails and
the histograms went on describing the old pixels for nine days.

So `tools:check` gained a VERSION tier that reads each binary's version and
compares it against a `recorded` field, and drift is a NOTICE rather than a
failure. Taking a newer encoder is a deliberate job (re-encode, re-hash,
`bun run dict:roll`) rather than a side effect, and `brew outdated` already
answers whether one exists. What nothing answered before is whether the binary on
this machine is the one the committed bytes came from.

**`recorded` is a baseline observed on 2026-08-24, not a reconstruction.** Nothing
recorded which encoder made the current artifacts, so claiming these versions
produced them would be inventing provenance. What is true is that they are the
versions the next run will use, and a future re-encode updates them.

Reading a version has no convention, so each tool declares its own flag and
pattern: `exif-sooc 0.2.0`, `jq-1.7.1-apple`, `sips-316`, `Version: 1.4.2 (...)`,
a bare `1.6.0`, and mozjpeg's two answering `mozjpeg version 4.1.5` on stderr.
`ssimulacra2` and `butteraugli_main` report nothing at all and say so with a
reason; both are metrics rather than encoders, so no shipped byte depends on
them. A declared pattern that stops matching FAILS, because a version tier that
silently reads nothing is the rot the floors exist to catch.

**One number lived in six places and the canonical one was unread.**
`EXIF_SOOC_MIN=0.2.0` is written out in five shell scripts, and
`config/tools.json` carried `min_version` that nothing consulted, which is the
failure that file's own header says it was created to fix, one field further in.
The declaration tier now asserts both directions: a guard must match the
declaration, and a declared minimum nothing enforces is an error.

## Current baseline

- Wrangler 4.127.1 is the exact root pin shared by all Worker projects, and
  since 2026-09-02 it is also cal's test harness: `cal/test` runs on bun:test
  against `createTestHarness`, so the tree carries exactly one Wrangler, one
  Miniflare and one Workerd by construction. Until that day `cal` declared
  @cloudflare/vitest-pool-workers to reach the same stack, and keeping its
  floor aligned with the root pin was measured on 2026-08-15 (five warm-store
  clean installs) to cut median install time from 4.62 s to 3.03 s and
  `node_modules` from 781 MiB to 562 MiB. The alignment is structural now
  rather than maintained.
- Oxc Minify 0.148.0 and Lightning CSS 1.33.0 are exact root pins for the
  deploy-time JavaScript and CSS minifiers. Their platform-specific optional
  packages run only in the build environment; they add no browser or Worker
  runtime dependency. Dependabot should review their release notes for output,
  target-browser, and native-install changes.
- Oxlint 1.81.0 and oxlint-tsgolint 7.0.2001 are exact root pins for
  `bun run lint`, a required step in `validate`. The tsgolint version tracks the
  TypeScript pin below on purpose: TypeScript 7.0 ships no stable programmatic
  API, so typescript-eslint cannot run on it, and tsgolint is the door oxlint
  uses to reach the same type-aware rules. Dependabot should review oxlint
  releases for NEW rules, since a new rule in an enabled category fails CI on
  unchanged code, and should treat any tsgolint release as paired with a
  TypeScript one. Every rule this repo turns off is turned off in
  `.oxlintrc.json` beside the measurement that decided it.
- @oxlint/plugins 1.81.0 is the runtime for the three rules vendored from
  anti-slop at `tools/oxlint/anti-slop`. **Bump it in lockstep with oxlint and
  never on its own**: it is the ABI between the linter and a JS plugin, the two
  ship one version number, and a mismatch would fail at plugin load rather than
  at install. It carries no transitive dependencies. Since the rules themselves
  are vendored rather than depended on, an anti-slop release is NOT a Dependabot
  event here; re-syncing is a deliberate copy, and the section at the end of this
  file says which three files it covers.
- **esbuild is no longer a direct dependency, as of 2026-08-14.** It had left the
  minification path when Oxc took over and stayed pinned for ONE call:
  `tools/check-page-contracts.ts` parsed the garage scaffold's inline CSS with
  `transform(css, { loader: "css" })`. (It parsed CSS, never JS; this line said
  "inline JS" until 2026-08-14.) That was 20MB of Go binary for one call, and the
  size was the smaller problem. **The two CSS parsers disagree in both
  directions**, measured the same day: esbuild is stricter on lexical sloppiness
  (it warns on an unclosed block, which the CSS spec says to recover from), while
  Lightning CSS throws on structurally broken input and warns on the CSS Overflow
  5 selectors `/garage/horizon` ships deliberately. So a page could pass the
  contract check and fail the build, which is the wrong way round: the build
  decides what reaches a visitor, so a pre-build check should agree with the
  build's parser. Both now call `parseCss` in `tools/lib/css-parse.ts`, which
  owns the tolerated-warning family and re-proves the pass-through on every call.
  The staged tree is byte-identical across all 1476 files.

  ONE esbuild copy remains in the tree and it is not ours to remove: Wrangler
  hard-depends on it for Cloudflare's Worker bundler. A second, Vite 8's
  optional peer through `cal`'s vitest chain, left with vitest on 2026-09-02,
  and `bun why esbuild` reports one position now. Dropping the root pin had
  removed the root's path to it without shrinking the store; do not read that
  removal as the disk saving, the vitest removal is.
- minify-html 0.18.1 is the exact root pin for the deploy-time HTML pass over
  `index.html` and the worker shells.
- TypeScript 7.0.2 is the exact root pin for `bun run typecheck`, which runs
  TEN programs, every one of them `noEmit`. **The type checker never writes a
  file**, so nothing here is tsc-compiled and no config can start emitting one
  by accident.

  **@cloudflare/workers-types LEFT the tree on 2026-09-02.** It was 12 of the
  29 Dependabot PRs in the preceding thirty days, each a date-stamped release
  describing a runtime this repo did not yet run on, and each needing the hand
  relock commit. The four Worker programs now include
  `config/.generated/workers-runtime.d.ts`, which `tools/gen-runtime-types.ts`
  writes from the PINNED workerd through `wrangler types --include-runtime`
  (wrangler's own notice says the command supersedes the package). So the
  runtime surface moves when wrangler moves, a lane already reviewed here, and
  it describes the workerd that runs the dry-runs, the route oracle and the
  cal harness rather than a newer one. Measured before the switch: all four
  programs produced byte-identical diagnostics either way, and the 23 names
  the package carried that the generated set does not (Buffer, process, the
  Performance family, two Hyperdrive and one Browser Run shape) are referenced
  nowhere. The file is generated, never committed, and cached on wrangler's
  version plus the config bytes, so a warm typecheck pays 0.02s for it.

  One thing survives the removal and is worth knowing: wrangler declares the
  package as an OPTIONAL peer and its own `cli.d.ts` imports a handful of types
  from it. With the peer absent those imports resolve to `any` under
  `skipLibCheck`, which costs nothing this repo reads (the harness types cal
  uses are declared locally in that file) and is stated here so the next reader
  of a suspiciously loose wrangler type knows where it came from.

  That is the claim worth making, and it is narrower than the one this entry
  carried until 2026-08-24. That version said the checker runs "over
  JSDoc-annotated JavaScript", that "nothing is compiled and no source is
  converted", and that "the site stays JavaScript", with a conversion listed as
  a cost the repo declined to pay. The conversion happened: `src/worker/` is 69
  TypeScript files and no JavaScript, and `wrangler.jsonc` points `main`
  straight at `.build/src/worker/index.ts`, so esbuild erases the types while
  bundling. A paragraph arguing against a move the tree had already made is
  worse than no paragraph, because it reads as current policy.

  Two of the three things that conversion was supposed to cost were never
  charged, which is why it is worth naming them rather than deleting the
  sentence. **View Source is untouched**: `src/client/` is 16 JavaScript
  islands and the only two `.ts` files in it are `.d.ts` declarations that ship
  nothing, and the build still writes a readable `/<name>.src.js` twin beside
  every minified one. And types still erase, so they add no runtime and no
  served byte; that half of the old argument survives intact and is the reason
  these two packages cost the visitor nothing.

  The third did change. The suite no longer runs on plain node and
  `contract-tests.mjs` no longer exists: it was split into 50 files on
  2026-08-20 and `bun test` runs them, which is what made a TypeScript import
  in a test a non-question. Read gotcha 16 in CLAUDE.md alongside this, since
  the `cloudflare:workers` rule it protects is unchanged while both symptoms it
  described expired with that same move.

  Dependabot should review TypeScript releases for new checks that could fail CI
  on unchanged code; binding-shape changes arrive with wrangler now. The ten
  programs are not decoration: three go through a wrapper because they hold
  files from two runtimes at once, and `bun run typecheck:coverage` asserts
  every file this repo owns belongs to one of them.
- @types/bun 1.4.0 is the exact root pin for the SECOND type program,
  `config/tsconfig.tools.json`, which checks `tools/`. It carries the node globals
  as well, so it is one entry rather than two, and it declares the bun-only
  globals the tools now use directly (HTMLRewriter among them). Types only: no
  runtime, no served byte, same standing as the generated runtime types above.

  It exists because tools/ CANNOT be checked by the Worker's program. Point
  tsconfig.json at both and 169 of 337 errors are `Cannot find name 'process'`:
  node programs judged against a Workers global scope. Two programs is what
  separates a real finding from a missing global.

  **It reached 1.4.0 on 2026-08-24 and now matches the runtime**, which is the
  release-age policy resolving exactly as this entry predicted it would. The
  block here used to record a pin one release BEHIND the runtime, because
  `minimumReleaseAge: 86400` in bunfig.toml refused the same-day 1.4.0 publish
  and `bun add` took the previous version. It said that would catch up on its
  own once 1.4.0 turned a day old. It did, dependabot opened the bump, and the
  types program now reads the bun it actually runs under. The superseded number
  is deliberately not restated: a stale version inside its own correction is
  still a greppable stale version.

  Worth keeping as a worked example rather than deleting, because the prediction
  is the part that was uncertain: a delayed pin under that policy is a wait, not
  a fork, and it needs no exclude entry to clear. The alternative on offer at the
  time was an entry in `minimumReleaseAgeExcludes`, which would have outlived its
  reason the moment the bump landed. bun excludes by NAME rather than
  name@version, so that entry would still be sitting there today exempting
  @types/bun at every future version.
- playwright-core is a scripts-only devDep (caret-ranged, not pinned: it drives
  the locally installed Google Chrome rather than a bundled browser). Only
  `tools/photos/gen-og-cards.ts` uses it, and only on demand; no CI job and
  no deploy path touches it.
- Pillow 12.3.0 is pinned in `tools/photos/requirements.txt` for
  `gen-pixel-peeper.py`, a one-off generator for the /pixel-peeper comparison
  frames. It baked the photo histograms until 2026-08-14, when that moved into
  `zenc histogram` and left the core photo pipeline with no Pillow dependency at
  all. Nothing in CI installs it any more.
- **This repo declares no runtime dependencies.** Everything below is build or
  test tooling. @noble/post-quantum 0.7.0 used to be the exception, the one
  package that reached a visitor, because `lib/botauth.js` imported `ml-dsa.js`
  for AadharshBot's additive `sig2` signature and workerd's WebCrypto ships no
  post-quantum algorithm at any parameter size. That signature was retired on
  2026-08-15 and the package went with it: pure-JS ML-DSA costs ~8.5ms per
  request against a 10ms CPU budget, which was taking down the playlist scrape
  and `/lens`. `/garage/pqc` carries the measurements and the retirement note.
- The root workspace lockfile is authoritative; workspace-local Wrangler pins
  are rejected by `bun run check-wrangler`.

## Outside the root manifest

Four dependency surfaces sit outside `package.json`, and the baseline above
covered none of them until 2026-08-14. One is its own Dependabot ecosystem, so
it drifts on the same cadence the baseline does.

**These four are checked now**, as of 2026-08-14.
`tools/lib/dependency-docs.ts` reads them alongside the root `package.json`
and holds this prose to them in both directions: a stated version that stops
matching fails CI, and a NEW dependency in any of the four fails CI until
somebody either states its version or exempts it with a reason. That is what
makes it safe to write numbers here at all. The previous revision of this
section deliberately wrote none, because an unchecked copy is the exact drift
this file had already shipped twice.

Four of the nine dependencies below carry no version, and the split is the
useful part: `cal` and `cf-garage` caret-range everything, and Cargo reads a
bare `"0.25"` as a caret range too. **A range is a version the prose cannot
honestly state**, so those are exempted by name in `SUB_MANIFEST_POLICY` with
the reason, rather than written here with the caret quietly dropped.

- **`lens-reader/`** is its own npm ecosystem with its OWN lockfile, and it is
  outside the Bun workspace deliberately: its dependencies are megabytes only
  that Worker bundles. Install it with a bare `bun install` from that directory;
  Bun resolves the local manifest without walking up into the root workspace.

  Two dependencies, and each carries a trap worth knowing before reviewing a
  bump. `@mozilla/readability` 0.6.0 is the extractor, swapped in from Defuddle on
  2026-08-14 on a measured control-label win; the argument and the numbers are
  in CLAUDE.md under the `lens-reader/` section, and a bump should be read for
  whether it changes what the extractor DISCARDS, since the discard is the
  lens's whole artifact.

  `linkedom` 0.18.13 is a DEV dependency as of 2026-08-23 and ships in nothing.
  It supplied the DOM that Workers lack, and it was several times the weight of
  the extractor it served: 65.27 KiB gzip of an 80.57 KiB Worker, measured by
  bundling each package alone under that project's wrangler config.
  `src/dom.ts` replaced it with a first-party DOM over the same htmlparser2,
  fitted to the 39 members Readability touches and the 11 reader.ts touches.
  The swap measured 80.57 -> 46.18 KiB gzip (42.7% less) and, over nine
  alternating trials on a 5754 KiB corpus, a 614.5 -> 299.4 ms median for the
  full parse-extract-markdown pipeline (51.3% less CPU, 12.80 -> 6.24 ms/doc).

  A second fitted-DOM pass on 2026-08-25 cached the element-only `children`
  view until a child mutation instead of filtering `childNodes` on every read,
  and imported Readability's extractor directly instead of its CommonJS barrel
  (which also loads an unused readerability heuristic). Across two alternating
  15-trial blocks on the ten captured real-world pages, the pooled median moved
  174.5 -> 144.8 ms (17.0% less CPU). The minified dry-run moved 47.30 ->
  46.97 KiB gzip; five fresh-process sweeps showed no RSS regression. The parity
  gate still compares the complete visitor-visible result and serialized trees,
  and a focused mutation test invalidates the cache through append, insert,
  remove, replace, move, `textContent`, and `innerHTML`.

  It stays INSTALLED because it is the oracle.
  `test/dom-differential.test.mjs` runs the real pipeline twice over 48
  documents, once on each DOM, and compares title, byline, content, markdown and
  control labels byte for byte; a second gate compares the serialized parse tree
  on the 10 captured real-world pages, and a third pins the SVG rules no capture
  can reach. Deleting linkedom would delete the only
  thing that can prove the replacement is faithful, so treat a bump as a change
  to the reference rather than to the product, and expect it to surface as a
  parity failure rather than as a payload change.

  What was tried first and failed is worth knowing before anyone repeats it.
  `@mozilla/readability` ships `JSDOMParser.js`, 1278 lines, described in its own
  header as the minimal DOM Readability needs, and Readability guards for it
  (`_getAllNodesWithTag` falls back to `getElementsByTagName`). Bundled, it took
  a probe from 105.68 to 27.07 KiB gzip. It also failed on 36 of this
  repository's 38 documents with `expected '</meta>' and got </head>`, because
  it is an XHTML parser and HTML5 void elements are not XHTML. Tolerant parsing
  is not the separable part.

  `htmlparser2` 12.0.0 is a DIRECT dependency now, and also still an override on
  linkedom's declared `^10.1.0` range so the oracle resolves the same parser the
  Worker bundles. A parity gate whose reference parses differently proves
  nothing. Version 10 carried domhandler 5, domutils 3, dom-serializer 2, and
  two older entity-table generations beside the newer stack linkedom already
  receives through css-select. Version 11 uses that same newer generation, and
  12 keeps it. Measured 2026-08-20 on the move off linkedom, the minified Worker
  went 113.30 -> 80.56 KiB gzip (28.9% less); a fixed four-page corpus produced
  byte-identical extraction payloads. Nine 20-conversion trials moved the median
  1112.5 -> 1084.9 ms (2.5%, within the run-to-run spread), so the supported
  claim is no conversion regression rather than a CPU win.

  **Version 12 was deliberately REFUSED here until 2026-08-24, and the reason it
  is taken now is that a browser was finally asked.** The refusal read: its
  WHATWG raw-text change breaks linkedom 0.18.13's self-closing-script
  serialization in linkedom's own upstream suite. That is accurate about the
  suite and says nothing about which parse is right, which is the question this
  Worker actually has, because /lens exists to show what a machine saw rather
  than what a library used to return.

  Asked, Chrome 148.0.7778.280 backs 12 on every one of the three behaviours
  that separate them, and 11 on none:

  | source | 11 | 12 and Chrome |
  |---|---|---|
  | `<script src=x />` | closes at the slash | swallows to `</script>`, so the document close is script data |
  | `<?>` | dropped silently | `<!--?-->`, a bogus comment |
  | SVG `clipPath` | lowercased to `clippath` | case preserved, per foreign content |

  So linkedom's upstream test is pinning the pre-spec string, which is exactly
  what this repository's own test was doing (`test/reader.test.mjs` carried the
  11 serialization as its expectation, with a message naming 12 as the thing
  that would break it). Both were reading a regression where there was a
  correction.

  What it costs in the payload is nothing a visitor sees. Running the real
  extraction pipeline over the 10 captured pages in `lens-reader/test/corpus`
  at both versions, the Markdown is BYTE-IDENTICAL on 10 of 10. Three pages
  differ in the intermediate content HTML and every difference is one of the
  three rows above: `clipPath` on stripe.com, `<!--?-->` on the two MDN pages.
  The parity gate is unmoved, at 4 of 4 across 48 documents plus those 10.

  The override still forces the oracle onto the same generation, which is what
  keeps that gate meaning anything. Re-evaluate it when linkedom changes its
  parser range rather than carrying it by inertia. Its local tests pin the
  self-closing-script behaviour AGAINST THE BROWSER now, with the DOMParser line
  to re-run written at the assertion, and assert the resolved tree has no nested
  domutils under htmlparser2.

  Markdown is a focused first-party walk over Readability's finished article
  node. It replaced `turndown` 7.2.4 after a 36-document corpus preserved every
  word token in order while the Worker bundle moved 613.96 -> 594.61 KiB raw and
  153.32 -> 148.87 KiB gzip; the median of nine alternating 288-conversion
  trials moved 328.6 -> 89.7 ms (72.7% less conversion time).
  Unknown elements are transparent and only script/style bodies are discarded,
  so new semantic wrappers retain their prose instead of needing an allowlist.

  Its tests live in `lens-reader/test/` rather than the root suite, because the
  root suite runs under plain node with the ROOT workspace's dependencies. An
  import from `lens-reader/src/` fails in CI with `ERR_MODULE_NOT_FOUND` while
  passing on any workstation that has installed there.

- **`tools/photos/zenc/`** pins `zenjpeg` 0.8.4, `image` and `serde_json` through Cargo. zenjpeg is
  the production JPEG thumbnail encoder, so a bump changes the BYTES of every
  photo re-encoded after it. Nothing re-encodes automatically, so the risk is
  deferred rather than absent: the next `bun run photos` run mints new
  content-hashed URLs. Read its releases for encoder output changes, and treat
  a quality or scan-search change as a reason to re-measure rather than to
  trust the version number.
  **It also depends on `halflight` by git rev, since 2026-09-02**: the resampling
  kernel that was `src/resample.rs`, now its own public MIT crate at
  `github.com/oddharsh/halflight`, pinned in `Cargo.lock` to a full rev and fetched
  over https. A git dependency is outside the cargo ecosystem dependabot watches,
  so this pin moves only by hand: edit the `rev`, rebuild, and re-run the
  old-binary-against-new A/B that gated the swap (histograms over 165 stems, three
  tiers of 52 photos, resize, encode, all byte-identical the first time).

- **`cal/`** declares no package dependencies, since 2026-09-02. Its suite
  runs on bun:test against the root's wrangler (`createTestHarness`, see
  `cal/test/harness.ts`) with the root's types, so it cannot carry a second
  Cloudflare toolchain. Until that day it carried `vitest` and
  `@cloudflare/vitest-pool-workers`, the chain that pulled Vite 8, Rolldown,
  postcss, the `nanoid` override and a second esbuild: 68 lockfile entries for
  one runner, and one Dependabot lane that could split the miniflare stack.

- **`cf-garage/`** declares no package dependencies. Its one browser operation
  calls the native Browser Run `quickAction("screenshot", ...)` binding directly;
  pulling a general-purpose CDP client into this separately deployed demo Worker
  made a 146.26 KiB gzip bundle where the native action produces 2.77 KiB gzip.


## Evaluated and declined: dmmulroy/anti-slop

[anti-slop](https://github.com/dmmulroy/anti-slop) is 15 Oxlint rules that
reject low-evidence TypeScript and JavaScript patterns. It is designed to be
VENDORED rather than depended on, so adopting it means copying ~20 source files
into this repo and owning them. Measured against this tree on 2026-08-15, one
rule was worth that and it was already available in core Oxlint, so nothing was
vendored and `@oxlint/plugins` was not added.

The measurement, run by pointing a throwaway config's `jsPlugins` at a clone
and enabling all 15 rules at `error` over `www cal serendipity scripts
pipelines lens-reader/src` (165 files):

| rule | findings | verdict |
|---|--:|---|
| `no-runtime-typeof` | 110 | rejected, see below |
| `no-shape-in-symbol-names` | 81 | rejected, see below |
| `no-conditional-empty-object-spread` | 12 | rejected, see below |
| the other 12 | 0 | 10 of them structurally |

**Ten of the fifteen rules can never fire here**, because they visit only
TypeScript AST nodes (`TSAsExpression`, `TSTypeAliasDeclaration`,
`TSIndexSignature`, `TSParameterProperty`) and this tree has no `.ts` source at
all. Everything served is JavaScript, type-checked through JSDoc and tsgolint.
That is 10 rules of vendored code to maintain against a TypeScript migration
nobody has proposed. Revisit only if one starts.

**The three that do fire each disagree with a documented house idiom**, which is
the same test `.oxlintrc.json` already applies to `no-sparse-arrays` and
`unicorn/no-useless-spread`: a rule needing dozens of inline disables is a rule
that disagrees with the codebase, and the disables become the noise.

- `no-runtime-typeof` wants boundary parsing instead of ad hoc `typeof`
  narrowing, which is right in a repo with a schema library. This Worker parses
  third-party HTML, KV JSON and Spotify embeds with no validator anywhere, so
  the rule is asking for a rewrite rather than a fix. Its `allowInTypeGuards`
  escape hatch needs TypeScript predicate signatures, so it buys nothing here.
- `no-shape-in-symbol-names` bans the term outright and is not configurable.
  `documentShape`, `lensSitemapShape` and `lensJsonShape` are `/lens` domain
  vocabulary, and `shape` is a PUBLISHED field on the `/lens/browser` snapshot
  payload. Renaming them to satisfy a linter would change a wire contract.
- `no-conditional-empty-object-spread` flags `...(x ? { k } : {})`, and all 12
  sites are the absent-rather-than-zero discipline this repo applies everywhere
  (the photo pipeline's nullable fields, the span attribute rule, `ranking`'s
  `dropped` and `common` keys). Its suggested repair, building the object across
  separate statements, trades a declarative literal for imperative mutation.

**What was taken is the one rule with zero findings and real teeth**,
`no-module-mocking`, which rejects `vi.mock` in favour of real dependency
seams. Core Oxlint already ships `vitest/no-restricted-vi-methods`, so it is
three lines in `.oxlintrc.json` with nothing vendored and no new dependency.
`cal/` was the only Vitest project here (it runs on bun:test since 2026-09-02)
and its 7 test files use real seams, so it arms a tripwire rather than starting
a cleanup, on the surface where a wrong assertion means a real person got
double-booked. Note what the rule cannot see: bun's spelling is `mock.module`,
which it does not match, so on the bun suite the guard is review plus the one
`mock.module` in the tree being `cal/test/preload.ts`, a virtual module for the
`cloudflare:workers` scheme rather than a seam being faked.

Adding it surfaced a trap worth more than the rule. **Naming any plugin in
`plugins` REPLACES the default set rather than appending to it**, silently: with
`"plugins": ["vitest"]`, a planted `Promise.all([p])` stopped reporting
`unicorn/no-single-promise-in-promise-methods`, the lint still exited 0, and the
tree read as clean because most of the rules checking it were gone. The config
now lists all five explicitly with that measurement at the array.

To re-run the whole evaluation, clone the repo, `bun install` inside it, and
point a scratch config at `src/index.ts` through `jsPlugins`. The pinned Oxlint
1.81.0 does support custom JS plugins and `@oxlint/plugins` is published at a
matching 1.80.0, so feasibility was never the blocker; applicability was.
