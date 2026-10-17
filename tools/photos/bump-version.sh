#!/usr/bin/env bash
# bump-version.sh — stage a release entry for /updates and /restore.
#
# WRITES ONE FILE AND NOTHING ELSE. No D1, no wrangler, no network, no account
# selection. Run it inside the PR that is being released; the entry ships with
# the merge, and `bun run checkpoints:record` copies it into D1 once production
# carries it.
#
#   ./tools/photos/bump-version.sh <slug> "<title>"
#   e.g. ./tools/photos/bump-version.sh confetti "Run palette: Raycast confetti easter egg"
#
# slug   becomes the version suffix (aadhar-v<N+1>-<slug>) and the changelog tag.
# title  is the human description shown on /updates and /restore.
#
# ── why this stopped writing D1 ───────────────────────────────────────────
# It used to INSERT first and derive the projection second, which meant the
# changelog could only be logged AFTER the deploy it describes — and since
# /updates, /updates.json and /restore all render from the committed projection
# at BUILD time, publishing that entry then needed a SECOND deploy. Observed
# 2026-08-06: v173 was logged, the live page kept serving v172, and the only way
# out was to ride the projection on an unrelated open PR.
#
# Now the order matches reality. The repo says what a release CLAIMS to be, in
# the PR, where the title can be reviewed like any other prose. D1 says what
# actually SHIPPED. Since 2026-09-28 (#1002) nothing on the release path writes
# it, because CI holds a read-only token, so `bun run checkpoints:record` does,
# from a workstation (tools/lib/checkpoints.ts defines "released").
# `bun run checkpoints:check` allows a contiguous tail of staged entries and
# fails on every other divergence, including a released entry D1 lacks.
set -euo pipefail

slug="${1:-}"; title="${2:-}"
if [ -z "$slug" ] || [ -z "$title" ]; then
  echo "usage: $0 <slug> \"<title>\"" >&2; exit 1
fi
# slug is part of the version string + the changelog tag: lowercase alnum + dashes
if ! printf '%s' "$slug" | grep -qE '^[a-z0-9][a-z0-9-]*$'; then
  echo "slug must be lowercase alnum/dashes, e.g. 'sysprop' or 'instant-nav'" >&2; exit 1
fi
# The title reaches D1 through a single-quoted SQL literal when it is recorded.
case "$title" in *\'*) echo "title cannot contain a single quote (')" >&2; exit 1;; esac

ROOT="$( cd "$( dirname "${BASH_SOURCE[0]}" )/../.." && pwd )"
OUT="$ROOT/src/worker/checkpoints.json"

# pipeline-json.ts checkpoint-add since 2026-09-22; a Python heredoc until then,
# a week after the ban, and found only once the no-python test stopped reading a
# hand-kept list. The file it writes is committed, so the port keeps Python's
# json.dumps(indent=2, sort_keys=True) bytes, and it mints the vnum from the
# PROJECTION, which is why this runs with no D1 and no credential at all.
bun "$ROOT/tools/photos/pipeline-json.ts" checkpoint-add "$OUT" --slug "$slug" --title "$title" --ymd "$(date -u +%Y-%m-%d)"

echo "next:   commit src/worker/checkpoints.json with the change it describes."
echo "        /updates + /restore show it as soon as that version serves;"
echo "        after production carries it: bun run checkpoints:record"
