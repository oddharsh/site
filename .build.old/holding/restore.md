---
title: "System Restore · aadhar.sh"
description: "Roll the site back through its real deploy history, in a Windows System Restore reskin backed by Cloudflare D1. Read-only."
path: "/restore"
section: "status"
kind: "page"
source: "https://aadhar.sh/restore"
---

> Site index: https://aadhar.sh/llms.txt
> This is the Markdown twin of a page on aadhar.sh. The HTML at the source
> URL below is the original, and is hand-written and unminified on purpose.

# System Restore

**You are here.**

current system: aadhar-v162-hit-route · counter tick endpoint renamed /hit.svg to /hit · shipped 2026-07-22

Windows kept a calendar of restore points so you could roll the system back to an earlier day. These are real: one point per deploy, logged in a Cloudflare D1 database and seeded from this site's own git history. Drag the scrubber to preview the system as it stood at any point. Nothing here changes anything.

Restore points

2026-05-212026-07-22

Restoring for real is a destructive **D1 Time Travel** operation: a point-in-time restore run from the CLI, with a 7-day window on the free plan. This page never fires it; it only reads the log. See what shipped at each point in [Windows Update](https://aadhar.sh/updates).

Source: https://aadhar.sh/restore
