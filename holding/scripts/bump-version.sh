#!/usr/bin/env bash
# bump-version.sh — bump the service-worker CACHE_VERSION AND log the deploy to D1
# in one step, so /updates (Windows Update) and /restore (System Restore) both
# stay current. Both pages now read the same `checkpoints` table, so this single
# insert keeps them in sync and they cannot drift apart again.
#
# Run this INSTEAD of hand-editing CACHE_VERSION, then deploy.
#
#   ./holding/scripts/bump-version.sh <slug> "<title>"
#   e.g. ./holding/scripts/bump-version.sh confetti "Run palette: Raycast confetti easter egg"
#
# slug   becomes the version suffix (aadhar-v<N+1>-<slug>) and the changelog tag.
# title  is the human description shown on /updates and /restore.
set -euo pipefail

DB="aadhar-restore"
SW="$(cd "$(dirname "$0")/.." && pwd)/sw.js"   # holding/sw.js

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

cur="$(grep -oE 'aadhar-v[0-9]+-[a-z0-9-]+' "$SW" | head -1)"
curnum="$(printf '%s' "$cur" | grep -oE 'v[0-9]+' | tr -d 'v')"
next=$((curnum + 1))
ver="aadhar-v${next}-${slug}"
ymd="$(date -u +%Y-%m-%d)"
ts="$(date -u +%s)"

# 1) bump the service worker version string
perl -0pi -e "s/const CACHE_VERSION = \"[^\"]*\";/const CACHE_VERSION = \"${ver}\";/" "$SW"
echo "sw.js:  ${cur}  ->  ${ver}"

# 2) log the deploy to D1 — both /updates and /restore read this one row
wrangler d1 execute "$DB" --remote --command \
  "INSERT OR IGNORE INTO checkpoints (vnum, ts, ymd, version, slug, title) VALUES (${next}, ${ts}, '${ymd}', '${ver}', '${slug}', '${title}');"

echo "d1:     logged checkpoint v${next} (${ymd})  ->  /updates + /restore"
echo "next:   wrangler pages deploy holding --project-name aadhar-sh --branch holding --commit-dirty=true"
