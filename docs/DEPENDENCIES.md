# Dependency updates and site leverage

Dependabot watches FIVE ecosystems, and this paragraph named two of them until
2026-08-14:

| ecosystem | directory | what it owns |
|---|---|---|
| npm | `/` | the shared deploy toolchain and the one shipped dependency |
| npm | `/lens-reader` | the Reader lens Worker, which is outside the workspace on purpose |
| github-actions | `/` | the five digest-pinned actions |
| cargo | `/tools/photos/zenc` | the JPEG thumbnail encoder's zenjpeg pin |
| pip | `/tools/photos` | Pillow, for one page generator |

Each update PR keeps the upstream release notes/changelog in its Dependabot
description and gets a persistent site-review comment containing the exact
version change, update type, and questions for the site.

Before merging a dependency PR, future agents should record whether the new
release changes any of these surfaces:

- Cloudflare Workers, Wrangler, R2/KV/D1, Browser Run, or Workers Builds APIs;
- bundle size, runtime compatibility, browser support, or performance budgets;
- local photo tooling, metadata extraction, the image encoders (zenjpeg through
  `zenc`, and the system binaries `config/tools.json` declares), or CI behavior.

If there is no useful leverage, say so explicitly in the PR review. The merged
PR and its review comment are the changelog record; this file is the durable
review policy and entry point for future agent runs.

## Current baseline

- Wrangler 4.125.0 is the exact root pin shared by all Worker projects.
  `cal`'s @cloudflare/vitest-pool-workers floor is 0.22.0, which resolves the
  same Wrangler, Miniflare, and Workerd stack as the root. Measured on
  2026-08-15 across five warm-store, clean installs, that alignment cut median
  install time from 4.62 s to 3.03 s and `node_modules` from 781 MiB to 562 MiB.
  Review these two updates together when either package changes its Cloudflare
  toolchain dependencies.
- Oxc Minify 0.146.0 and Lightning CSS 1.33.0 are exact root pins for the
  deploy-time JavaScript and CSS minifiers. Their platform-specific optional
  packages run only in the build environment; they add no browser or Worker
  runtime dependency. Dependabot should review their release notes for output,
  target-browser, and native-install changes.
- Oxlint 1.79.0 and oxlint-tsgolint 7.0.2001 are exact root pins for
  `bun run lint`, a required step in `validate`. The tsgolint version tracks the
  TypeScript pin below on purpose: TypeScript 7.0 ships no stable programmatic
  API, so typescript-eslint cannot run on it, and tsgolint is the door oxlint
  uses to reach the same type-aware rules. Dependabot should review oxlint
  releases for NEW rules, since a new rule in an enabled category fails CI on
  unchanged code, and should treat any tsgolint release as paired with a
  TypeScript one. Every rule this repo turns off is turned off in
  `.oxlintrc.json` beside the measurement that decided it.
- @oxlint/plugins 1.79.0 is the runtime for the three rules vendored from
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
  build's parser. Both now call `parseCss` in `tools/lib/css-parse.mjs`, which
  owns the tolerated-warning family and re-proves the pass-through on every call.
  The staged tree is byte-identical across all 1476 files.

  Two esbuild copies REMAIN in the tree and neither is ours to remove. Wrangler
  hard-depends on 0.28.1 for Cloudflare's Worker bundler. Vite 8 keeps 0.28.2 as
  an OPTIONAL peer through `cal`'s vitest chain, so `pnpm why esbuild` still
  reports it; dropping the root pin removed the root's path to it without
  shrinking the store. Do not read the removal as a disk saving.
- minify-html 0.18.1 is the exact root pin for the deploy-time HTML pass over
  `index.html` and the worker shells.
- TypeScript 7.0.2 and @cloudflare/workers-types are exact root pins for
  `bun run typecheck`, which runs `tsc --noEmit` over JSDoc-annotated JavaScript.
  **Nothing is compiled and no source is converted.** The site stays JavaScript:
  types erase at build time, so workerd runs identical bytes either way, and a
  conversion would cost the buildless authoring, the honest View Source, and the
  plain-node imports contract-tests.mjs depends on. These two packages exist so
  the checker can read the annotations; they add no runtime and no served byte.
  Dependabot should review TypeScript releases for new checks that could fail CI
  on unchanged code, and workers-types for binding-shape changes.
- @types/bun 1.4.0 is the exact root pin for the SECOND type program,
  `config/tsconfig.tools.json`, which checks `tools/`. It carries the node globals
  as well, so it is one entry rather than two, and it declares the bun-only
  globals the tools now use directly (HTMLRewriter among them). Types only: no
  runtime, no served byte, same standing as workers-types above.

  It exists because tools/ CANNOT be checked by the Worker's program. Point
  tsconfig.json at both and 169 of 337 errors are `Cannot find name 'process'`:
  node programs judged against a Workers global scope. Two programs is what
  separates a real finding from a missing global.

  **It is pinned at 1.3.14 while bun runs 1.4.0, and that gap is the release-age
  policy working rather than an oversight.** `minimumReleaseAge: 86400` in
  bunfig.toml refused the same-day 1.4.0 publish, so `bun add` resolved the
  previous version. It will catch up on its own once 1.4.0 turns a day old;
  nothing here needs the newer types today, and forcing it would mean an
  exclude entry that outlives its reason.
- playwright-core is a scripts-only devDep (caret-ranged, not pinned: it drives
  the locally installed Google Chrome rather than a bundled browser). Only
  `tools/photos/gen-og-cards.mjs` uses it, and only on demand; no CI job and
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
`tools/lib/dependency-docs.mjs` reads them alongside the root `package.json`
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

- **`cal/`** carries `vitest` and `@cloudflare/vitest-pool-workers`, both
  caret-ranged. This is the chain that pulls Vite 8, and therefore Rolldown and
  the second esbuild copy the baseline section describes. It runs the booking
  and calendar policy tests inside workerd, so a pool-workers bump should be
  read against the miniflare version it carries.

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
`cal/` is the only Vitest project here and its 7 test files use real seams
today, so it arms a tripwire rather than starting a cleanup, on the surface
where a wrong assertion means a real person got double-booked.

Adding it surfaced a trap worth more than the rule. **Naming any plugin in
`plugins` REPLACES the default set rather than appending to it**, silently: with
`"plugins": ["vitest"]`, a planted `Promise.all([p])` stopped reporting
`unicorn/no-single-promise-in-promise-methods`, the lint still exited 0, and the
tree read as clean because most of the rules checking it were gone. The config
now lists all five explicitly with that measurement at the array.

To re-run the whole evaluation, clone the repo, `pnpm install` inside it, and
point a scratch config at `src/index.ts` through `jsPlugins`. The pinned Oxlint
1.79.0 does support custom JS plugins and `@oxlint/plugins` is published at a
matching 1.79.0, so feasibility was never the blocker; applicability was.
