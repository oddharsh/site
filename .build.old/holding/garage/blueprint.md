---
title: "aadhar.sh/garage/blueprint"
description: "The teardown's sequel: Fable 5 read every file in the repo and drew the blueprint it would rebuild from. What the code already knows (the boutique tricks worth keeping), the architecture as built, the Pages-era scar tissue a Workers-native rewrite would remove, and the sketch itself, before and after, side by side."
path: "/garage/blueprint"
section: "garage"
kind: "content"
updated: "2026-07-23"
source: "https://aadhar.sh/garage/blueprint"
---

> Site index: https://aadhar.sh/llms.txt
> Section index: https://aadhar.sh/garage/llms.txt
> This is the Markdown twin of a page on aadhar.sh. The HTML at the source
> URL below is the original, and is hand-written and unminified on purpose.

# Blueprint

The [teardown](https://aadhar.sh/garage/teardown) put this site on a lift and found what was broken. This is the other document a good shop produces: the drawing you would rebuild from, knowing everything the current build taught you. For this one, Fable 5 read every file in the repo, all ~40 pages, all 20 worker modules, the pipeline scripts, the design brief, the service worker, and asked one question: the site was designed for Cloudflare Pages and now lives on Workers with static assets, so which parts of its cleverness are load-bearing, and which parts are scar tissue from a platform it no longer runs on?

"The smarter model would rewrite it" is cheap to claim, so the sketch below is held to the same rule as everything else in this garage: specific diffs, honest verdicts, and a list of what I would NOT touch that is longer than the list of what I would.

---

## What the code already knowskeep

Before any rewrite talk: the repo is full of decisions that took real bruises to learn, most of them written down next to the code they saved. A rebuild keeps every one of these. A sampler:

| where | the trick, and why it is right |
| --- | --- |
| home.js | The visit counter is read concurrently but awaited INSIDE the footer's HTMLRewriter handler, so a cross-region Durable Object round trip overlaps the whole streaming page and never gates first byte. |
| photos.js, rn.js, reading.js, around.js | Two-key stale-while-revalidate in KV: the value persists forever, a tiny `:fresh` sentinel carries the TTL. When it lapses, the visitor gets the stale copy instantly and the rebuild rides `ctx.waitUntil`. Nobody waits but the true first run. |
| index.html tooltip | EXIF capture times are wall clock with no timezone; `new Date()` would shift them per viewer. `Temporal.PlainDateTime` shows them exactly as the camera wrote them, everywhere. Upload times are instants and get the viewer's zone. Two kinds of time, two APIs. |
| index.html tooltip | `will-change: transform` is an earn-it hint: promoted while the tooltip is open, released the instant it closes. Left on a hidden element it pins a compositor layer for nothing. |
| index.html playlist | Long lists render in ~8-row chunks yielding via `scheduler.yield()`, which resumes at the FRONT of the task queue, with a `setTimeout(0)` shim elsewhere. |
| index.html grid | Suppress tooltips mid-scroll, then on settle re-target via `elementFromPoint`: a fixed tooltip plus wheel scroll means the cursor never moves, so no pointerover fires when a new photo slides under it. |
| index.html + nav.js | The OS-window geometry is inlined in every page at higher specificity than the deferred shell's copy, so first paint is already the windowed layout and nav.js changes nothing when it lands. The teardown found the two-stage pop; this killed it. |
| design/, every page | Zero font bytes (local stacks only), OKLCH-encoded Luna with P3 upgrades for accents while the chrome stays period-sRGB, and gel caption buttons drawn entirely from pseudo-elements with hex traced off the .msstyles bitmap. |
| sw.js | Cache-first with NO background revalidate for content-addressed thumbnails (a refetch can never observe new bytes), SWR for the shells, network-only for everything rendered. Full-res R2 originals deliberately excluded: the browser HTTP cache already holds them immutable, and a second copy is pure disk cost. |
| index.html | Speculation rules prerender on intent, with exclusions chosen for side effects, not size: prerendering `/around` would fire a real crawl, `/whoareyou` would fingerprint a request nobody made, `/` would burn a counter tick. |
| whoareyou.js, botauth.js | The machine surface is honest in both directions: inbound gets system-properties transparency with nothing logged, outbound crawls sign themselves per RFC 9421 with a published JWKS. Plus llms.txt, JSON-LD, markdown content negotiation on `/`, and MCP cards. A 2003 body with 2026 paperwork. |
| verify-routes.mjs, bump-version.sh | The operational spine: a 42-route oracle gates every deploy, and one script bumps the SW version AND logs a D1 checkpoint that both [/updates](https://aadhar.sh/updates) and [/restore](https://aadhar.sh/restore) read, so the changelog cannot drift from reality. |

## The architecture, as built

```
request
  |-- edge-direct (0 worker invocations) ......... nav.js sw.js lens.js notepad.js
  |     _headers rules; SWR + immutable          /garage/* /lwe/* /cars/* *.avif
  |                                              .well-known cards, SEO files
  |-- worker-first
        route() if-chain, ~25 routes
        |-- streamed SSR ......................... /        HTMLRewriter over index.html
        |-- rendered + edge-cached ................ /lens /writing /reading  caches.default
        |-- rendered, deliberately fresh .......... /whoareyou /updates /restore
        |-- data planes ........................... KV (4x SWR caches)  D1 (checkpoints)
        |                                          R2 (originals, edge-cached)  DO (counter)
        |-- ghosts of Pages past .................. SPA-fallback sniffs, ?v= bust scheme,
                                                    per-request asset re-bust, .pages.dev 301
```

Four cache layers, each owning what it is best at: browser (immutable + bfcache), service worker (shells + thumbs), edge (rendered routes + R2), KV (data). That part is already the Workers-native shape. The ghosts are the bottom line.

## The Pages ghostsscar tissue

### Routing is a denylist because Pages saw everything

**Why it is a ghost.** On Pages advanced mode the worker intercepted every request by definition, so the migration naturally inverted that into "everything, minus exceptions." But the exceptions are now the majority: most of this site is static files. An allowlist makes the config read as intent (here is exactly where compute happens), and a new static file can never accidentally cost a worker invocation because someone forgot a negation. Same engine, opposite default.

as built

```
"run_worker_first": [
  "/*",                 // worker sees EVERYTHING...
  "!/nav.js", "!/sw.js",
  "!/garage/*", "!/lwe/*",
  "!/images/*.avif", ...  // ...minus 14 carve-outs
]
```

blueprint

```
"run_worker_first": [
  "/", "/whoareyou", "/around", "/lens*",
  "/writing*", "/rn*", "/reading", "/updates*",
  "/restore", "/security", "/bot", "/agent/*",
  "/oauth2/*", "/images/full/*", ...
]  // the worker EARNS each route; static is the default
```

### Three guards still sniff for an attacker that left

**Why it is a ghost, mostly.** The teardown's biggest find was Pages serving homepage HTML at missing thumbnail URLs with a year-long cache header, and these content-type gates were the fix. Workers static assets answers a missing file with an honest 404, so the masquerade check now tests for a platform behavior that cannot occur. What remains load-bearing is narrower: an edge-cached 404 under `/images/*` would still inherit the 1-year immutable rule, so the cache-control clamp stays. One small guard instead of three sniffing ones. Same logic eventually retired `THUMB_VERSION` outright: atomic deploys plus content-hashed `/i/` URLs removed the race it was built for.

as built

```
// x3: metadata.json, meta/*.json, thumbnails
const res = await env.ASSETS.fetch(request);
const ct = res.headers.get("content-type");
if (res.ok && ct.startsWith("image/")) return res;
// defends against Pages' SPA fallback:
// a missing asset came back 200 text/html
return errorResp("not found", 404);
```

blueprint

```
// Workers returns real 404s; the masquerade
// is extinct. keep ONLY the half that still
// earns its keep: clamp 404 cache-control so
// a miss can't inherit /images/* immutable.
const res = await env.ASSETS.fetch(request);
if (res.status === 404) return uncacheable404();
return res;
```

### Smaller ghosts, listed for the record

- `serveFreshAsset` re-busts the asset cache on every request for the extensionless discovery files, a fix for a Pages read-through-cache poisoning. Worth re-testing on Workers; if the canonical-URL staleness no longer reproduces, it is a delete.
- The `.pages.dev` 301 stays exactly as long as the parked Pages project does, and leaves with it.
- The docs still narrate some Pages lore as present-tense gotchas. True history, wrong tense.

## The rewrite sketchblueprint

The honest headline: this is not a rewrite of what the site does, it is a consolidation of how many times the code says it. Same behavior, fewer hand-rolled copies of the same idea.

### Four hand-rolled SWR caches become one primitive

**What it buys.** The pattern is identical everywhere: persistent value, `:fresh` sentinel, stale-instant serve, background rebuild, first-run inline. Four implementations means four places a subtle rule can drift (one of them protects empty rebuilds from clobbering good stale data; the others learned that separately). One primitive with the empty-guard built in makes the next cache a one-liner. Two thirds of this kit already exists: `cachedRender` and the R2 edge layer landed this week. This finishes the set.

as built

```
// photos.js ~30 lines: manifest + sentinel
// rn.js     ~25 lines: tracks + sentinel
// reading.js ~25 lines: curius + sentinel
// around.js  ~30 lines: report + sentinel
// same shape, four dialects, drift risk
```

blueprint

```
// lib/cache.js — the whole caching kit:
swrKV(env, ctx, key, ttl, build)
cachedRender(request, ctx, render)  // exists
cachedR2(request, env, ctx, key)    // exists

// callers become one-liners:
const tracks = await swrKV(env, ctx,
  `tracks:${pid}`, 3600, () => scrape(pid));
```

### Nine handlers stop hand-assembling the same window

**What it buys.** Not wire bytes (brotli already crushes the repeated CSS per response) but change-amplification: when the window chrome changed this week (the back/forward buttons), one function would have updated nine pages. Correction, post-audit: an earlier sweep claimed /updates shipped the chrome CSS twice; the migration audit refuted it (the two `xpChromeCss` call sites are two routes, /updates and /restore, one copy each). The honest case for the layout kit is maintenance, and it is sufficient. The XP shell is the site's strongest abstraction; the server should treat it as one.

as built

```
// whoareyou.js, around.js, reading.js, bot.js,
// security.js, updates.js (x2!), rn.js, lens.js
// each: return new Response(`<!DOCTYPE html>
// <html>...${xpChromeCss(W)}...` + headers)
```

blueprint

```
lunaPage({ title, path, width,
           css, body, cache })
// one function owns DOCTYPE, chrome, geometry,
// nav.js include, security posture. handlers
// return { title, css, body } — content only.
```

### The if-chain becomes a table, and comments become the contract

**And the comments.** The essay-grade comments are the best documentation this repo has; a rewrite keeps authoring them exactly as-is and lets the build own the split: readable in git and in every `.src.js` twin, minified on the wire. That bargain already shipped for the four shells. The worker modules get it for free (wrangler strips nothing, but they are never served). `index.html` keeps its comments on the wire forever, because the homepage's View Source is the exhibit itself.

as built

```
// index.js: 240 lines of
// if (url.pathname === "/x") return handleX(...)
// order-dependent, prefix rules interleaved
```

blueprint

```
const ROUTES = new Map([...]);   // exact
const PREFIX = [...];            // ordered
// dispatch is 10 lines; the table IS the
// sitemap, and mirrors run_worker_first
// one-to-one — config and code agree.
```

## What I would not touchthe soul

- **Inline everything, one request per page.** The McMaster-Carr school. External stylesheets and bundle graphs buy nothing here and cost a round trip.
- **No framework, no hydration, no client router.** The HTML is the state. The site's interactivity budget goes to one deferred shell script, and that is enough to drag windows around a desktop.
- **Streaming SSR with client fallbacks.** HTMLRewriter starts the response before the data finishes, and every SSR surface has a ~30-line client mirror that detects "already populated" and stands down. Defense in depth that has already paid out.
- **The homepage stays uncacheable.** Random twelve photos and a real counter tick per visit is the site's pulse. ~31KB per visit is what that costs, and it is the best byte-spend on the domain.
- **The honesty rules.** Fallbacks that say so, no fabricated UI, nothing graduates to the homepage until two engines ship it, failures stay parked in the garage next to the wins. This page follows the same rules about itself.
- **Buildless authoring.** The build stays a deploy-time transform of four files with tripwires, and grows only when something else earns it the way the shells did.

**The verdict, honestly.** Half of this blueprint is already the changelog: the Workers migration, the in-house counter DO, granular routing, the build step, the edge-cache kit all landed incrementally, each gated by a 42-route oracle, and the site never went down for any of it. That is the actual argument against a big-bang rewrite: the repo already knows how to become its next self one verified deploy at a time. What remains above is a to-do list, not a demolition order. And the one thing a rewrite must never do is the thing every rewrite wants to do first: modernize the soul. The bevels, the counter, the comments, the Bliss gradient. That is not debt. That is the car.

← back to the [garage](https://aadhar.sh/garage) · [aadhar.sh](https://aadhar.sh/) · the prequel: [teardown](https://aadhar.sh/garage/teardown) · kin: [off Pages, onto Workers](https://aadhar.sh/garage/workers), [bytes on the wire](https://aadhar.sh/garage/wire)

read by Fable 5, 2026-07-01: every page, module, script, and design doc in the repo. the diffs are sketches; the keep-list is a promise.

Source: https://aadhar.sh/garage/blueprint
