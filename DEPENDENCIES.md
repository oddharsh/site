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
- Pillow 12.2.0 is pinned in `holding/scripts/requirements.txt` for the
  histogram bake.
- The root workspace lockfile is authoritative; workspace-local Wrangler pins
  are rejected by `npm run check-wrangler`.
