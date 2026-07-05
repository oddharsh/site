#!/usr/bin/env bash
# bump-version.sh — log a deploy checkpoint to D1, so /updates (Windows Update)
# and /restore (System Restore) both advance. Both pages read the same
# `checkpoints` table, so this single insert keeps them in sync.
#
# The service worker retired in v136, so there is no CACHE_VERSION to rewrite
# anymore: the version number now lives in D1 alone, and this script derives
# the next one from SELECT MAX(vnum). Run this before any deploy you want on
# the changelog.
#
#   ./holding/scripts/bump-version.sh <slug> "<title>"
#   e.g. ./holding/scripts/bump-version.sh confetti "Run palette: Raycast confetti easter egg"
#
# slug   becomes the version suffix (aadhar-v<N+1>-<slug>) and the changelog tag.
# title  is the human description shown on /updates and /restore.
set -euo pipefail

DB="aadhar-restore"

slug="${1:-}"; title="${2:-}"
if [ -z "$slug" ] || [ -z "$title" ]; then
  echo "usage: $0 <slug> \"<title>\"" >&2; exit 1
fi
# slug is part of the version string + the changelog tag: lowercase alnum + dashes
if ! printf '%s' "$slug" | grep -qE '^[a-z0-9][a-z0-9-]*$'; then
  echo "slug must be lowercase alnum/dashes, e.g. 'sysprop' or 'instant-nav'" >&2; exit 1
fi
# keep the SQL single-quoted and simple: no apostrophes in the title
case "$title" in *\'*) echo "title cannot contain a single quote (')" >&2; exit 1;; esac

# current version = the D1 log's high-water mark (the SW string used to carry it).
# REPLICA-LAG HARDENING (this bit three deploys on 2026-07-03): the MAX read can
# hit a stale D1 replica, and INSERT OR IGNORE then swallowed the collision
# silently — a checkpoint just vanished. Now the insert is plain (a collision
# ERRORS), and on conflict we advance vnum and retry a few times.
curnum="$(wrangler d1 execute "$DB" --remote --json --command \
  "SELECT MAX(vnum) AS m FROM checkpoints;" \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)[0]["results"][0]["m"])')"
ymd="$(date -u +%Y-%m-%d)"
ts="$(date -u +%s)"

next=$((curnum + 1))
for attempt in 1 2 3 4; do
  ver="aadhar-v${next}-${slug}"
  if wrangler d1 execute "$DB" --remote --command \
    "INSERT INTO checkpoints (vnum, ts, ymd, version, slug, title) VALUES (${next}, ${ts}, '${ymd}', '${ver}', '${slug}', '${title}');" >/dev/null 2>&1; then
    echo "d1:     logged checkpoint v${next} (${ymd}) as ${ver}  ->  /updates + /restore"
    echo "next:   npm run deploy"
    exit 0
  fi
  echo "d1:     vnum ${next} taken (stale replica read?) — retrying with $((next + 1))" >&2
  next=$((next + 1))
done
echo "error: could not insert a checkpoint after 4 attempts" >&2
exit 1
