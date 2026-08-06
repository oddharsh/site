#!/usr/bin/env bash
# bump-version.sh — stage a release entry for /updates and /restore.
#
# WRITES ONE FILE AND NOTHING ELSE. No D1, no wrangler, no network, no account
# selection. Run it inside the PR that is being released; the entry ships with
# the merge, and `npm run deploy:promote` records it in D1 once traffic actually
# reaches 100%.
#
#   ./holding/scripts/bump-version.sh <slug> "<title>"
#   e.g. ./holding/scripts/bump-version.sh confetti "Run palette: Raycast confetti easter egg"
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
# actually SHIPPED, written at 100% by the one thing that knows traffic moved.
# `npm run checkpoints:check` allows the projection to run ahead by a contiguous
# tail of unreleased entries and fails on every other kind of divergence.
set -euo pipefail

slug="${1:-}"; title="${2:-}"
if [ -z "$slug" ] || [ -z "$title" ]; then
  echo "usage: $0 <slug> \"<title>\"" >&2; exit 1
fi
# slug is part of the version string + the changelog tag: lowercase alnum + dashes
if ! printf '%s' "$slug" | grep -qE '^[a-z0-9][a-z0-9-]*$'; then
  echo "slug must be lowercase alnum/dashes, e.g. 'sysprop' or 'instant-nav'" >&2; exit 1
fi
# The title still reaches D1 through a single-quoted SQL literal at ramp time.
case "$title" in *\'*) echo "title cannot contain a single quote (')" >&2; exit 1;; esac

ROOT="$( cd "$( dirname "${BASH_SOURCE[0]}" )/../.." && pwd )"
OUT="$ROOT/holding/_worker.js/checkpoints.json"

SLUG="$slug" TITLE="$title" YMD="$(date -u +%Y-%m-%d)" python3 - "$OUT" <<'PY'
import json, os, sys

path = sys.argv[1]
slug, title, ymd = os.environ["SLUG"], os.environ["TITLE"], os.environ["YMD"]
rows = json.load(open(path))

# The high-water mark comes from the PROJECTION, which is the whole point: this
# script no longer needs to reach D1 to know what number it is minting, so it
# runs on a plane, in CI, or on a machine with no Cloudflare credentials at all.
vnum = max((r["vnum"] for r in rows), default=0) + 1
version = f"aadhar-v{vnum}-{slug}"

if any(r["slug"] == slug for r in rows):
    sys.exit(f"error:  slug '{slug}' is already in the log — pick another")

rows.append({"slug": slug, "title": title, "version": version, "vnum": vnum, "ymd": ymd})
rows.sort(key=lambda r: r["vnum"])
open(path, "w").write(json.dumps(rows, indent=2, sort_keys=True) + "\n")
print(f"staged: v{vnum} ({ymd}) as {version}")
print(f"        {title}")
PY

echo "next:   commit holding/_worker.js/checkpoints.json with the change it describes."
echo "        /updates + /restore show it as soon as that version serves;"
echo "        npm run deploy:promote records it in D1 at 100%."
