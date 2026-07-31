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

ROOT="$( cd "$( dirname "${BASH_SOURCE[0]}" )/../.." && pwd )"

# The committed projection of the checkpoints table.
#
# D1 stays the SOURCE OF TRUTH; this file is a derived read of it, and build.mjs
# renders /updates and /restore from the file so both earn the q11 twin and the dcz
# delta tiers every authored page already has. Those two are the only dynamic pages
# whose data changes solely at deploy — this insert happens moments before one — so
# baking them costs no freshness, unlike /reading or /around whose feeds move on
# their own schedule.
#
# Written AFTER a successful insert, so it always reflects a row that really landed.
# `npm run checkpoints:check` re-reads D1 and fails on drift, which is the guard for
# the case this cannot cover: a row inserted by any other means.
write_projection() {
  local out="$ROOT/holding/_worker.js/checkpoints.json"
  local rows
  if ! rows="$(wrangler d1 execute "$DB" --remote --json --command \
    "SELECT vnum, ymd, version, slug, title FROM checkpoints ORDER BY vnum;")"; then
    echo "warn:   could not re-read D1 for the projection — /updates and /restore will" >&2
    echo "warn:   ship the PREVIOUS log until you re-run this or fix the read" >&2
    return 0
  fi
  printf '%s' "$rows" | python3 -c '
import json, sys
rows = json.load(sys.stdin)[0]["results"]
sys.stdout.write(json.dumps(rows, indent=2, sort_keys=True) + "\n")
' > "$out"
  echo "proj:   $(python3 -c "import json,sys; print(len(json.load(open(sys.argv[1]))))" "$out") checkpoints -> holding/_worker.js/checkpoints.json"
}

next=$((curnum + 1))
for attempt in 1 2 3 4; do
  ver="aadhar-v${next}-${slug}"
  if wrangler d1 execute "$DB" --remote --command \
    "INSERT INTO checkpoints (vnum, ts, ymd, version, slug, title) VALUES (${next}, ${ts}, '${ymd}', '${ver}', '${slug}', '${title}');" >/dev/null 2>&1; then
    echo "d1:     logged checkpoint v${next} (${ymd}) as ${ver}  ->  /updates + /restore"
    write_projection
    echo "next:   commit holding/_worker.js/checkpoints.json, then npm run deploy"
    exit 0
  fi
  echo "d1:     vnum ${next} taken (stale replica read?) — retrying with $((next + 1))" >&2
  next=$((next + 1))
done
echo "error: could not insert a checkpoint after 4 attempts" >&2
exit 1
