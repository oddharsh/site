#!/usr/bin/env bash
# deploy-wrangler.sh — the ONE command Cloudflare Workers Builds runs, for both
# shapes this repository takes.
#
# WHY THIS EXISTS. The dashboard holds a single command string per trigger, and
# it has to work on whatever branch is being built. Today `main` is a pnpm tree.
# The bun migration (#443) makes it a bun tree, and the two cannot share an
# invocation:
#
#   * `pnpm exec wrangler` REFUSES on a bun tree. pnpm reads package.json's
#     `packageManager` field and exits with "This project is configured to use
#     bun" (reproduced on pnpm 11.22.0; the build image ships 10.11.1, which
#     enforces the same field).
#   * `bun …/wrangler.js` cannot run on a pnpm tree in the build image, because
#     the image installs bun only when the tree asks for it.
#
# Without this script the dashboard string can only ever suit one branch, so the
# migration would need the dashboard edited at the exact moment it merges, with
# every other branch's build broken on whichever side of the switch it sat.
#
# WHAT CHANGED, 2026-08-20. It used to branch on the lockfile and run wrangler
# under bun for a bun tree. It runs wrangler under NODE for both, because
# WRANGLER DOES NOT SUPPORT BUN and says so itself on 4.124.0:
#
#     Wrangler does not support the Bun runtime. Please try this command again
#     using Node.js via `npm` or `pnpm`.
#
# The refusal is per-COMMAND, which is why the first bun deploy looked fine:
# `versions upload` under bun published a version whose assets Cloudflare
# deduplicated to 0 of 1443 changed files, while `check startup` under the same
# bun did no work at all. A deploy path should not sit one subcommand away from
# a runtime the vendor disclaims.
#
# One invocation now serves both trees, so the lockfile branch is gone. Node
# runs wrangler's entry the same way on a pnpm tree and a bun tree, since both
# put the package at node_modules/wrangler.
#
# WHAT IT DOES NOT DO. It takes no opinion on wrangler's arguments: everything
# after the script name is passed through untouched, so the two provisioning
# flags and the `versions upload` form still live in the dashboard string where
# `check-infra.mjs` can read them. It also never fetches anything. `bunx`/`npx`
# resolve missing binaries from the registry (gotcha 29), which on the one path
# that publishes production would mean deploying with a wrangler nobody pinned.
set -euo pipefail

if [ "$#" -eq 0 ]; then
  echo "deploy-wrangler.sh: refusing to run wrangler with no arguments" >&2
  exit 2
fi

entry=node_modules/wrangler/bin/wrangler.js
if [ ! -f "$entry" ]; then
  echo "deploy-wrangler.sh: $entry is missing; the install step did not complete" >&2
  exit 1
fi

# NODE IS REQUIRED, and a missing one FAILS rather than falling back to bun.
# The build image installs node because `.node-version` is in the tree, so this
# fires only if that file is deleted, and a loud failure there costs a deploy
# that never shipped while a quiet fallback ships one from a runtime wrangler
# refuses. The message names the cause because nothing else in the log would.
if ! command -v node >/dev/null 2>&1; then
  echo "deploy-wrangler.sh: node is not on PATH. Wrangler does not support bun, so this needs node." >&2
  echo "deploy-wrangler.sh: the build image installs it from .node-version; check that file still exists." >&2
  exit 1
fi

# The ENTRY FILE, never `npx`/`bunx`, which FETCH what they cannot resolve
# (gotcha 29) and would let the one path that publishes production deploy with
# a wrangler nobody pinned.
echo "deploy-wrangler.sh: running $entry under $(node --version)"
exec node "$entry" "$@"
