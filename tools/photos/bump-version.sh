#!/usr/bin/env bash
# bump-version.sh — stage a release entry for /updates and /restore.
set -euo pipefail

slug="${1:-}"; title="${2:-}"
if [ -z "$slug" ] || [ -z "$title" ]; then
  echo "usage: $0 <slug> \"<title>\"" >&2; exit 1
fi
if ! printf '%s' "$slug" | grep -qE '^[a-z0-9][a-z0-9-]*$'; then
  echo "slug must be lowercase alnum/dashes, e.g. 'sysprop' or 'instant-nav'" >&2; exit 1
fi
case "$title" in *\'*) echo "title cannot contain a single quote (')" >&2; exit 1;; esac

ROOT="$( cd "$( dirname "${BASH_SOURCE[0]}" )/../.." && pwd )"
OUT="$ROOT/src/worker/checkpoints.json"

bun "$ROOT/tools/photos/pipeline-json.ts" checkpoint-add "$OUT" --slug "$slug" --title "$title" --ymd "$(date -u +%Y-%m-%d)"

echo "next:   commit src/worker/checkpoints.json with the change it describes."
echo "        /updates + /restore show it as soon as that version serves;"
echo "        bun run deploy:promote records it in D1 at 100%."
