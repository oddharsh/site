---
title: "aadhar.sh/garage/off Pages, onto Workers"
description: "Why this site moved from Cloudflare Pages advanced mode to Cloudflare Workers with static assets: the same bytes, an atomic deploy, and the whole configuration (bindings, routing, the Durable Object) as one checked-in wrangler.jsonc instead of dashboard clicks. Plus a live routing prober."
path: "/garage/workers"
section: "garage"
kind: "content"
updated: "2026-07-23"
source: "https://aadhar.sh/garage/workers"
---

> Site index: https://aadhar.sh/llms.txt
> Section index: https://aadhar.sh/garage/llms.txt
> This is the Markdown twin of a page on aadhar.sh. The HTML at the source
> URL below is the original, and is hand-written and unminified on purpose.

# Off Pages, onto Workers

This site ran on **Cloudflare Pages** its whole life: a static `index.html` plus a `_worker.js` in Pages advanced mode. On **2026-06-30** it moved to **Cloudflare Workers with static assets**. Same `holding/` folder, same worker code, byte-for-byte identical responses (I diffed them before flipping the domain). What changed is everything *around* the bytes: how it deploys, what it can bind, and where its configuration lives.

## Why it moved

Not for a feature. For an outage. A git-connected Pages build deployed the static files but silently dropped the Function, so every static path answered `200` and every worker route answered `404`. From the outside the site looked up; underneath, half of it was gone. That failure is structural to how the Pages build treated this repo, so rather than paper over it, I moved to Workers, where a deploy is **atomic**: the worker and its assets ship together or not at all. There is no window where the shell is live and the brain is missing.

## The real unlock: configuration as code

On Pages, the project's wiring lived in the dashboard. The KV namespace, the R2 bucket, the D1 database, the Durable Object, the environment variables: all clicked in through a web UI, invisible to git, undocumented outside my own memory, impossible to diff or review. Rebuilding the project meant remembering every toggle I had ever flipped.

On Workers, all of it is one checked-in file, `wrangler.jsonc`. One line needs a primer before you hit it: `run_worker_first` opens with `"/*"`, meaning every request wakes the worker, and each entry starting with `!` carves that path back out to serve straight from the edge:

```
{
  "name": "aadhar-sh",
  "main": "holding/_worker.js/index.js",
  "assets": {
    "directory": "holding",
    "binding": "ASSETS",
    "run_worker_first": ["/*", "!/nav.js", "!/garage/*", "!/images/*.avif", ...]
  },
  "kv_namespaces":  [{ "binding": "RN_KV",   "id": "..." }],
  "r2_buckets":     [{ "binding": "PHOTOS_R2", "bucket_name": "aadhar-photos" }],
  "d1_databases":   [{ "binding": "RESTORE_DB", "database_id": "..." }],
  "durable_objects": { "bindings": [{ "name": "COUNTER", "class_name": "Counter" }] },
  "migrations":      [{ "tag": "v1", "new_sqlite_classes": ["Counter"] }]
}
```

The binding list is now a code review, not a screenshot. A clean checkout plus one `wrangler deploy` reconstructs the entire project. There is exactly one honest exception: **secrets**. The signing key, the render token, and the cache-bust secret stay out of git on purpose, set once with `wrangler secret put`. A checkout is reproducible; it is deliberately not turnkey without those three.

## What it opened up

Given the constraint I care about most here (this site is frameworkless and buildless, and staying that way), the interesting question was never "which framework." It was: what can the platform do once the config is code? Four things I have already used, and a few more now in reach.

## 1 · Granular routing (already shipped)

That `run_worker_first` array is a denylist. The worker sees every request except the paths I negate with `!`, which serve straight from the edge and never wake it. I just cut the **avif thumbnails** loose: they are the primary, highest-volume image format (every modern browser takes the avif `<source>`), so serving them edge-direct drops a worker invocation off the busiest request on the site.

I proved it with `wrangler tail`: fetched one avif and one jpg with unique query strings and watched the live log. The avif logged **zero** invocations; the jpg logged one. The jpg deliberately stays worker-first, because `/images/*.jpg` would deep-match the R2 originals at `/images/full/*.jpg` and starve that route. avif has no such twin, so it is a clean cut. You can watch the same split live in the prober below.

## 2 · Durable Objects, in-house (already shipped)

Pages cannot host a Durable Object at all. The homepage visit counter (the little odometer at the bottom of the front page) had to reach *across* to a separate Worker, `cf-garage`, and borrow its `Counter` class by cross-script binding. On Workers the class lives right here, in `holding/_worker.js/counter.js`, exported from the entry, with its migration in the same config. To keep the number honest across the move, the new object self-seeds once from the count it had on the old one (about 2,375) instead of resetting to zero. Same odometer, now wired into its own dashboard.

```
export class Counter { async fetch(req){ /* atomic ++ in state.storage */ } }
```

## 3 · Atomic deploys and versions (relying on it)

A Worker deploy is all-or-nothing, and that is precisely what makes the avif cut safe. The old Pages hazard was a deploy race: a real thumbnail could 404 for a blink during a deploy, and Cloudflare's edge would then cache that 404 for hours. Atomic deploys remove the blink, so there is no transient miss of a file that actually exists. Workers also supports versioned, gradual rollouts (ship a version to 10% of traffic first), which Pages never offered for production.

## 4 · Observability and tail (already using it)

Structured logs are one line in the config (`"observability": { "enabled": true }`), and `wrangler tail` streams the live worker to my terminal. That is how I verified the routing change against production without guessing, and how I confirmed the counter migration ticked correctly. On Pages this was second-class; on Workers it is the default.

## Still on the table

Things the move makes reachable that I have not built yet, kept honest because none of them ship today:

- **Cron Triggers.** A Worker can run on a schedule; Pages cannot. The Spotify now-playing cache, the [/around](https://aadhar.sh/around) crawl, and the (undeployed) `cal/` booking sweep are all lazy-on-request today. Any of them could move to a scheduled handler that warms the cache before a visitor ever asks.
- **Service bindings, Queues, Workflows, Containers.** All bindable from the same config, none of which fit Pages advanced mode cleanly. I do not need them for a personal site, but the ceiling moved.
- **Compression.** Left at the platform default in this move. The old plan to ship precompressed brotli twins died on Pages (it ignored uploaded `.br` siblings). On Workers it is revisitable, just not done.

## See the routing split yourself

This fetches three live paths and prints their real response headers. The two static paths come back **cacheable** (a long `max-age`, `immutable`), which is exactly why they can serve from the edge without the worker. The homepage comes back **no-cache**: the worker renders it on every request (it re-randomizes the photo grid and reads the visit counter), so it can never be an edge-cached file. Nothing here is mocked; it is your browser hitting production.

## The honest scorecard

|  | Pages (before) | Workers + assets (now) |
| --- | --- | --- |
| deploy | git build, could drop the Function | atomic, all-or-nothing |
| config | dashboard clicks, off git | one `wrangler.jsonc`, in git |
| routing | worker saw everything | per-path denylist, static skips it |
| Durable Objects | not possible, cross-script only | in-house class + migration |
| cron | none | scheduled handlers available |
| bytes served | identical | identical |
| secrets | dashboard | out of git, by hand (correct) |

← back to the [garage](https://aadhar.sh/garage) · [aadhar.sh](https://aadhar.sh/) · see also [four free Cloudflare features](https://aadhar.sh/garage/cloudflare)

the prober hits production headers on this live Worker. nothing mocked.

Source: https://aadhar.sh/garage/workers
