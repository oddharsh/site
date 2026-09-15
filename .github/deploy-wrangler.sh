#!/usr/bin/env bash
# Workers Builds calls this wrapper with the arguments declared in
# config/infra.json. It OWNS THE TOOLCHAIN since 2026-09-15: it installs the
# bun that packageManager names, runs the frozen install with it, and then
# runs the installed Wrangler entrypoint under node. Arguments pass through
# unchanged.
#
# WHY THE WRAPPER INSTALLS ITS OWN BUN. Cloudflare's build image bootstraps a
# bun from `packageManager` before any command of ours runs, and it cannot
# resolve a canary version (measured 2026-09-15: a dated-canary pin fails the
# image's bootstrap, a release pin does not, with everything else equal). The
# repo wants the compiler on the canary channel, so the image has to stop
# bootstrapping: `SKIP_DEPENDENCY_INSTALL=true` in the build settings turns
# its install off, and this script does the same work with the SAME installer
# the setup-bun action uses (.github/install-bun.sh: npm tarball, sha512,
# manifest version and binary revision all checked). The image's own bun is
# then never on the path that builds, whatever version it happens to be.
#
# It bootstraps ONLY WHEN THE FLAG SAYS THE IMAGE WON'T. With
# SKIP_DEPENDENCY_INSTALL unset the image has already installed a bun and the
# dependencies, and this wrapper runs the installed wrangler exactly as it
# always did; with it set, the wrapper installs the pinned bun, lays out
# node_modules with it, and only then runs wrangler. One variable decides
# both halves, on both sides, so the two cannot disagree about who installs.
# The contract suite runs this script against fixture trees with no network,
# which is the other reason the bootstrap is not unconditional.
#
# Keep runtime selection here: Wrangler rejects Bun for commands such as
# check startup, even when other commands appear to work under it.
# No npx/bunx lookup: publishing must use the repository's installed pin.
set -euo pipefail

if [ "$#" -eq 0 ]; then
  echo "deploy-wrangler.sh: refusing to run wrangler with no arguments" >&2
  exit 2
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

# The pinned bun, first on PATH, so wrangler.jsonc's `bun tools/build.ts` and
# the install below both run under the compiler the repository declares.
if [ -n "${SKIP_DEPENDENCY_INSTALL:-}" ]; then
  bundir="${RUNNER_TEMP:-${TMPDIR:-/tmp}}/aadhar-sh-bun"
  mkdir -p "$bundir"
  bash .github/install-bun.sh "$bundir"
  export PATH="$bundir:$PATH"
  echo "deploy-wrangler.sh: SKIP_DEPENDENCY_INSTALL is set; bun install --frozen-lockfile under $(bun --version) ($(bun --revision))"
  bun install --frozen-lockfile
fi

entry=node_modules/wrangler/bin/wrangler.js
if [ ! -f "$entry" ]; then
  echo "deploy-wrangler.sh: $entry is missing; the install step did not complete (with SKIP_DEPENDENCY_INSTALL set, that step is the bun install this script runs above)" >&2
  exit 1
fi

# The ENTRY FILE, never `npx`/`bunx`, which FETCH what they cannot resolve
# (gotcha 29) and would let the one path that publishes production deploy with
# a wrangler nobody pinned.
echo "deploy-wrangler.sh: running $entry under $(node --version)"
exec node "$entry" "$@"
