# Dependency updates and site leverage

Dependabot watches FIVE ecosystems, and this paragraph named two of them until
2026-08-14:

| ecosystem | directory | what it owns |
|---|---|---|
| npm | `/` | the shared deploy toolchain and the one shipped dependency |
| npm | `/lens-reader` | the Reader lens Worker, which is outside the workspace on purpose |
| github-actions | `/` | the five digest-pinned actions |
| cargo | `/www/scripts/zenc` | the JPEG thumbnail encoder's zenjpeg pin |
| pip | `/www/scripts` | Pillow, for one page generator |

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

- Wrangler 4.120.1 is the exact root pin shared by all Worker projects.
- Oxc Minify 0.144.0 and Lightning CSS 1.33.0 are exact root pins for the
  deploy-time JavaScript and CSS minifiers. Their platform-specific optional
  packages run only in the build environment; they add no browser or Worker
  runtime dependency. Dependabot should review their release notes for output,
  target-browser, and native-install changes.
- Oxlint 1.78.0 and oxlint-tsgolint 7.0.2001 are exact root pins for
  `pnpm run lint`, a required step in `validate`. The tsgolint version tracks the
  TypeScript pin below on purpose: TypeScript 7.0 ships no stable programmatic
  API, so typescript-eslint cannot run on it, and tsgolint is the door oxlint
  uses to reach the same type-aware rules. Dependabot should review oxlint
  releases for NEW rules, since a new rule in an enabled category fails CI on
  unchanged code, and should treat any tsgolint release as paired with a
  TypeScript one. Every rule this repo turns off is turned off in
  `.oxlintrc.json` beside the measurement that decided it.
- @oxlint/plugins 1.78.0 is the runtime for the three rules vendored from
  anti-slop at `tools/oxlint/anti-slop`. **Bump it in lockstep with oxlint and
  never on its own**: it is the ABI between the linter and a JS plugin, the two
  ship one version number, and a mismatch would fail at plugin load rather than
  at install. It carries no transitive dependencies. Since the rules themselves
  are vendored rather than depended on, an anti-slop release is NOT a Dependabot
  event here; re-syncing is a deliberate copy, and the section at the end of this
  file says which three files it covers.
- **esbuild is no longer a direct dependency, as of 2026-08-14.** It had left the
  minification path when Oxc took over and stayed pinned for ONE call:
  `scripts/check-page-contracts.mjs` parsed the garage scaffold's inline CSS with
  `transform(css, { loader: "css" })`. (It parsed CSS, never JS; this line said
  "inline JS" until 2026-08-14.) That was 20MB of Go binary for one call, and the
  size was the smaller problem. **The two CSS parsers disagree in both
  directions**, measured the same day: esbuild is stricter on lexical sloppiness
  (it warns on an unclosed block, which the CSS spec says to recover from), while
  Lightning CSS throws on structurally broken input and warns on the CSS Overflow
  5 selectors `/garage/horizon` ships deliberately. So a page could pass the
  contract check and fail the build, which is the wrong way round: the build
  decides what reaches a visitor, so a pre-build check should agree with the
  build's parser. Both now call `parseCss` in `scripts/lib/css-parse.mjs`, which
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
  `pnpm run typecheck`, which runs `tsc --noEmit` over JSDoc-annotated JavaScript.
  **Nothing is compiled and no source is converted.** The site stays JavaScript:
  types erase at build time, so workerd runs identical bytes either way, and a
  conversion would cost the buildless authoring, the honest View Source, and the
  plain-node imports contract-tests.mjs depends on. These two packages exist so
  the checker can read the annotations; they add no runtime and no served byte.
  Dependabot should review TypeScript releases for new checks that could fail CI
  on unchanged code, and workers-types for binding-shape changes.
- playwright-core is a scripts-only devDep (caret-ranged, not pinned: it drives
  the locally installed Google Chrome rather than a bundled browser). Only
  `www/scripts/gen-og-cards.mjs` uses it, and only on demand; no CI job and
  no deploy path touches it.
- Pillow 12.3.0 is pinned in `www/scripts/requirements.txt` for
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
  are rejected by `pnpm run check-wrangler`.

## Outside the root manifest

Four dependency surfaces sit outside `package.json`, and the baseline above
covered none of them until 2026-08-14. One is its own Dependabot ecosystem, so
it drifts on the same cadence the baseline does.

**These four are checked now**, as of 2026-08-14.
`scripts/lib/dependency-docs.mjs` reads them alongside the root `package.json`
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
  outside the pnpm workspace deliberately: its dependencies are megabytes only
  that Worker bundles. Install it with `pnpm install --ignore-workspace`, since
  a bare `pnpm install` there walks up to the root workspace and never creates
  `lens-reader/node_modules` at all (gotcha 29).

  Three dependencies, and each carries a trap worth knowing before reviewing a
  bump. `@mozilla/readability` 0.6.0 is the extractor, swapped in from Defuddle on
  2026-08-14 on a measured control-label win; the argument and the numbers are
  in CLAUDE.md under the `lens-reader/` section, and a bump should be read for
  whether it changes what the extractor DISCARDS, since the discard is the
  lens's whole artifact. `linkedom` 0.18.13 exists only to supply the DOM that Workers
  lack and is several times the weight of the extractor it serves, so its
  releases matter for bundle size more than for behaviour. `turndown` 7.2.4 ships two
  builds and wrangler resolves the BROWSER one, which throws `document is not
  defined` in a Worker while passing under `node --test`; the fix is to pass it
  a node rather than an HTML string, and a major bump should be re-checked
  against that.

  Its tests live in `lens-reader/test/` rather than the root suite, because the
  root suite runs under plain node with the ROOT workspace's dependencies. An
  import from `lens-reader/src/` fails in CI with `ERR_MODULE_NOT_FOUND` while
  passing on any workstation that has installed there.

- **`www/scripts/zenc/`** pins `zenjpeg` 0.8.4, `image` and `serde_json` through Cargo. zenjpeg is
  the production JPEG thumbnail encoder, so a bump changes the BYTES of every
  photo re-encoded after it. Nothing re-encodes automatically, so the risk is
  deferred rather than absent: the next `pnpm run photos` run mints new
  content-hashed URLs. Read its releases for encoder output changes, and treat
  a quality or scan-search change as a reason to re-measure rather than to
  trust the version number.

- **`cal/`** carries `vitest` and `@cloudflare/vitest-pool-workers`, both
  caret-ranged. This is the chain that pulls Vite 8, and therefore Rolldown and
  the second esbuild copy the baseline section describes. It runs the booking
  and calendar policy tests inside workerd, so a pool-workers bump should be
  read against the miniflare version it carries.

- **`cf-garage/`** carries `@cloudflare/puppeteer`, caret-ranged, for the garage
  demo Worker. It is a separately deployed auxiliary Worker, so nothing here
  reaches production through the site Worker.


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
1.78.0 does support custom JS plugins and `@oxlint/plugins` is published at a
matching 1.78.0, so feasibility was never the blocker; applicability was.
