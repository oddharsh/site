# aadhar.sh — agent instructions

**Architecture, conventions, and gotchas live in [CLAUDE.md](CLAUDE.md).** Read
it first; it is the single maintained source of truth for how this repo works.
Task-by-task operations (photos, caches, version bumps) are in
[MAINTENANCE.md](MAINTENANCE.md). This file used to mirror CLAUDE.md and
drifted badly (it still described the retired service worker and
`THUMB_VERSION` as live); it now carries only what CLAUDE.md does not: the
release discipline below.

## Collaboration and release discipline

`origin/main` is the production source of truth. Claude, Codex, and local
worktrees may edit freely, but a worktree is not a release surface.

- Start work from a fresh `origin/main`: `git fetch --prune origin`, then make
  a named branch/worktree. Never use a stale local `main` as an agent base.
- Keep each change on its own branch, commit it, push it, and open a PR. Do
  not deploy from a dirty worktree or push agent work directly to `main`.
- PR CI builds the site, enforces the performance budget, dry-runs the single
  site Worker plus the auxiliary Garage/LWE configs, and runs the coffee tests.
- Only a successful CI run for `main` associated with a merged PR can promote
  the exact tested commit to the machine-owned `production` branch. GitHub's
  current free private-repo plan cannot enforce branch protection, so the
  workflow guard is the release backstop. Cloudflare Workers Builds watches
  `production` and is the only production publisher for the site Worker, which
  bundles `holding/`, `cal/`, and `serendipity/`. The Garage and LWE demos remain
  auxiliary Worker projects.
- Configure one Workers Build project for the site Worker with `production` as
  its production branch and repository root `.`. Keep the dashboard Build
  command blank; use the repo's Wrangler-owned build during the Deploy command.
  GitHub should not hold a Cloudflare production API token for this path.
