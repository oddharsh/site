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
- esbuild 0.28.1 left the minification path when Oxc took over, but it stays a
  direct pin: `scripts/check-page-contracts.mjs` uses its `transform()` to parse
  each garage/LWE page's inline JS while validating page contracts. Wrangler
  also carries its own nested copy for Cloudflare's Worker bundler; that
  transitive package is separate from this pin.
- minify-html 0.18.1 is the exact root pin for the deploy-time HTML pass over
  `index.html` and the worker shells.
- playwright-core is a scripts-only devDep (caret-ranged, not pinned: it drives
  the locally installed Google Chrome rather than a bundled browser). Only
  `holding/scripts/gen-og-cards.mjs` uses it, and only on demand; no CI job and
  no deploy path touches it.
- Pillow 12.3.0 is pinned in `holding/scripts/requirements.txt` for the
  histogram bake.
- The root workspace lockfile is authoritative; workspace-local Wrangler pins
  are rejected by `npm run check-wrangler`.
