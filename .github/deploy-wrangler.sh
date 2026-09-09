#!/usr/bin/env bash
# Workers Builds calls this wrapper with the arguments declared in
# config/infra.json. Node runs the installed Wrangler entrypoint; missing
# dependencies or Node fail before an upload. Arguments pass through unchanged.
# Keep runtime selection here: Wrangler rejects Bun for commands such as
# check startup, even when other commands appear to work under it.
# No npx/bunx lookup: publishing must use the repository's installed pin.
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
