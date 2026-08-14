# Dependency updates and site leverage

Dependabot watches the root npm workspace and GitHub Actions. Each update PR
keeps the upstream release notes/changelog in its Dependabot description and
gets a persistent site-review comment containing the exact version change,
update type, and questions for the site.

Before merging a dependency PR, future agents should record whether the new
release changes any of these surfaces:

- Cloudflare Workers, Wrangler, R2/KV/D1, Browser Run, or Workers Builds APIs;
- bundle size, runtime compatibility, browser support, or performance budgets;
- local photo tooling, metadata extraction, image encoders, Pillow, or CI behavior.

If there is no useful leverage, say so explicitly in the PR review. The merged
PR and its review comment are the changelog record; this file is the durable
review policy and entry point for future agent runs.

## Current baseline

- Wrangler 4.112.0 is the exact root pin shared by all Worker projects.
- Oxc Minify 0.140.0 and Lightning CSS 1.33.0 are exact root pins for the
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
- esbuild 0.28.2 left the minification path when Oxc took over, but it stays a
  direct pin: `scripts/check-page-contracts.mjs` uses its `transform()` with
  `loader: "css"` to parse the garage scaffold's inline CSS while validating page
  contracts. (It parses CSS, never JS; this line said "inline JS" until
  2026-08-14.) Lightning CSS is the obvious replacement and is NOT a drop-in:
  measured the same day, esbuild is stricter on lexical sloppiness while
  Lightning CSS throws on structurally broken input and warns on the CSS
  Overflow 5 selectors `/garage/horizon` ships deliberately, so a swap needs the
  tolerated-warning family `minifyCss` already carries. Wrangler
  also carries its own nested copy for Cloudflare's Worker bundler; that
  transitive package is separate from this pin.
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
- The root workspace lockfile is authoritative; workspace-local Wrangler pins
  are rejected by `pnpm run check-wrangler`.
