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

# The LOCKFILE decides, not what happens to be on PATH. The build image
# preinstalls a bun of its own, so probing `command -v bun` would quietly run
# main's production deploy under a bun that tree never asked for.
if [ -f bun.lock ]; then
  entry=node_modules/wrangler/bin/wrangler.js
  if [ ! -f "$entry" ]; then
    echo "deploy-wrangler.sh: $entry is missing; the install step did not complete" >&2
    exit 1
  fi
  # Wrangler's own entry rather than `bun x wrangler`: measured 2026-08-18 with
  # node replaced by a stub exiting 127, `bun x --no-install wrangler` INVOKES
  # NODE through the `#!/usr/bin/env node` shebang and fails, while running the
  # entry directly stays inside bun.
  echo "deploy-wrangler.sh: bun tree, running $entry"
  exec bun "$entry" "$@"
fi

if [ -f pnpm-lock.yaml ]; then
  echo "deploy-wrangler.sh: pnpm tree, running pnpm exec wrangler"
  exec pnpm exec wrangler "$@"
fi

echo "deploy-wrangler.sh: no bun.lock or pnpm-lock.yaml at $(pwd); cannot tell which toolchain this tree wants" >&2
exit 1
