---
title: "aadhar.sh/garage/teardown"
description: "What Fable 5's multi-agent audit found and fixed across aadhar.sh: a live cache-poisoning hole, a frontier feature whose fallback broke old browsers, and a stack of make-it-feel-instant changes. Before and after, side by side."
path: "/garage/teardown"
section: "garage"
kind: "content"
updated: "2026-06-11"
source: "https://aadhar.sh/garage/teardown"
---

> Site index: https://aadhar.sh/llms.txt
> Section index: https://aadhar.sh/garage/llms.txt
> This is the Markdown twin of a page on aadhar.sh. The HTML at the source
> URL below is the original, and is hand-written and unminified on purpose.

# Teardown

A resto-mod gets pulled apart on a lift before anyone trusts it on the road. This site got the same treatment. Fable 5 ran a multi-agent audit over the whole thing, eight finders sweeping in parallel, and handed every finding to a skeptic that tried to refute it before it counted. Here is what came back, and what changed. Before on the left, after on the right.

The harness: eight finders (payload, caching, two consistency passes, compatibility fallbacks, frontier adoption, perceived speed, live behavior), then one adversarial verifier per finding that re-read the code or re-hit the live URL and tried to prove it wrong. Sixty agents in all. Every claim below survived a second pass.

---

## Actually broken2 × correctness

### Missing thumbnails were serving the homepage as a 200, cached for a year

**What it does.** Cloudflare Pages answers a missing `/images/x.jpg` with its SPA fallback: a 200 carrying the whole homepage HTML. Gating on `res.ok` let that HTML through, and the headers rule then stamped it `max-age=31536000, immutable`, so a real thumbnail URL could end up pinned to homepage HTML at the edge for a year. Gating on the content-type instead lets only `image/*` pass and turns everything else into an uncacheable 404. I confirmed this one live before the fix: a made-up thumbnail URL really was returning 79KB of HTML with a 1-year cache.

before

```
const res = await env.ASSETS.fetch(request);
// only rewrote the cache header on a 4xx/5xx
if (!res.ok) { /* short cache */ }
return res;  // a 200 text/html sails through
```

after

```
const res = await env.ASSETS.fetch(request);
const ct = res.headers.get("content-type") || "";
if (res.ok && ct.startsWith("image/")) return res;
return errorResp("not found", 404);  // no masquerade
```

### The /writing notes broke in any browser without the Popover API

**What it does.** In an engine that has not shipped the Popover API, `:popover-open` is an unknown pseudo-class. `:not()` is non-forgiving, so the engine throws the entire rule away, and with no UA rule to hide them, all three Notepad windows render stacked on top of the folder. Inverting it to hide-by-default means any parser hides the notes. Only an engine that understands `:popover-open` (and therefore actually supports popovers) reveals one. The fallback now degrades the right direction.

before

```
.np-note:not(:popover-open) {
  display: none !important;
}
```

after

```
.np-note { display: none !important; }
.np-note:popover-open { display: flex !important; }
```

## Made it feel fasterperceived speed

### The window shell popped into place after first paint

**What it does.** The shared shell script is deferred, so it used to apply the OS-window geometry (clip the body, pin the window, reserve the taskbar strip) a beat after the page first painted. The very first load visibly popped in two stages. Inlining the exact same geometry into each page makes first paint already the windowed layout. nav.js's later rules are byte-identical, so when it runs, nothing moves. It still degrades with JS off: the content scrolls natively and a CSS strip stands in for the taskbar.

before

```
// page paints in document-scroll mode;
// the deferred nav.js flips it to the
// windowed model AFTER first paint, so
// the window visibly jumps + the taskbar
// pops in a frame or two later
```

after

```
/* inline, in every page's <style> */
html { height: 100dvh; overflow: hidden; }
body { height: calc(100dvh - 30px); overflow: hidden;
  display: flex; flex-direction: column; padding: 8px; }
.window > .content { flex: 1; min-height: 0; overflow: auto; }
```

### The homepage first byte waited on a single-homed counter

**What it does.** The homepage is `no-store`, so the worker runs on every visit and the visitor counter is a single-homed Durable Object. A visitor far from its home region paid a cross-region round trip before the first byte, just to fill in a hit-counter pill that already has a static placeholder. Racing it against 75ms means on a miss the pill keeps the placeholder and the real increment still completes in the background. Measured TTFB dropped from ~0.12-0.25s back toward the ~0.07s the static pages serve.

before

```
const counterP = DO.fetch(...).then(r => r.json());
await Promise.all([assets, tracks, photos,
                   counterP, alt]);
// every visit blocks on a cross-region RTT
// for a footer pill that has a static fallback
```

after

```
const raw = DO.fetch(...).then(r => r.json());
const counterP = Promise.race([raw,
  new Promise(r => setTimeout(() => r(null), 75))]);
ctx.waitUntil(raw);  // increment still lands
```

### One visitor an hour ate the full Spotify scrape

**What it does.** The tracklist lived in a single KV key with a one-hour TTL. The moment it expired, the next visitor triggered the inline three-tier scrape of Spotify (one to three seconds, and a transient failure showed no music at all). The photo manifest already solved this shape, so the tracks got the same two-key stale-while-revalidate: the value persists with no TTL, a tiny `:fresh` sentinel carries the hour, and a lapsed sentinel serves the stale list instantly while a rescrape rides `ctx.waitUntil`. Nobody waits on Spotify anymore.

before

```
const hit = await KV.get(key, "json");
if (hit) return hit;
return await scrapeSpotify(pid);  // 1-3s inline
// one key, expires hourly: when it lapses the
// next visitor pays the 3-tier scrape on the hot path
```

after

```
// value persists; a :fresh sentinel holds the hour
const hit = await getTracksSWR(env, ctx, pid);
if (hit) return hit;  // stale serves now,
                       // rescrape rides waitUntil
```

### The service worker rewrote immutable photos on every view

**What it does.** Thumbnails are content-addressed: their URL carries a `?v=N` version and they are served immutable. The cache-first handler still fired a background refetch and `cache.put` on every single photo view, which could never observe new bytes because the HTTP cache absorbs it. It was a redundant disk write per thumbnail, felt most on low-power devices. Invalidation already comes from the `?v` bump and the activate-event cache sweep, so the background write just had to go.

before

```
if (hit) {
  fetch(req).then(res => cache.put(req, res.clone()));
  return hit;  // background refetch, every view
}
```

after

```
if (hit) return hit;
// thumbnails are ?v=N + immutable: a refetch can
// never see new bytes, so the write was pure waste
```

## Polishlow severity

### The Run palette yanked your keyboard selection to the top

**What it does.** Open the palette with the keyboard, arrow down to a row, and the lazy photo and writing lists would finish loading, re-render, and snap your selection back to row 0 right as you pressed Enter. Now the selection is preserved by item identity across an async re-render with the same query, and only resets to the top when the query actually changes, which is the one case where selecting the new best match is correct.

before

```
results = items;
sel = items.length ? 0 : -1;
// the async photo/writing load re-renders and
// resets sel to 0, mid-aim, under your arrow keys
```

after

```
var keep = (q === lastQuery && sel >= 0) ? results[sel] : null;
results = items;
sel = keep ? indexOfIdentity(items, keep)
           : (items.length ? 0 : -1);
// only reset to top on an actual keystroke
```

## The restverified, shipped

Smaller findings that did not need a diagram, each confirmed and fixed:

| where | what |
| --- | --- |
| \_worker.js | Speculative loads (prefetch, prerender, Speed Brain) now *peek* the visitor counter instead of ticking it, via a `Sec-Purpose` guard. A page that may never be seen no longer counts as a visit. |
| \_worker.js | The JSON helper caps a transient Spotify 5xx at a 30s browser cache instead of pinning the error for 5 minutes, matching the rest of the codebase's error discipline. |
| nav.js | `prefers-reduced-motion` now also stills the view-transition *group* that morphs the window, not just the old and new snapshots. |
| serendipity | The standalone events worker now sends the same locked-down `Permissions-Policy` every Pages route carries. It is a first-class page of the site, so it should deny the same unused APIs. |
| \_headers | The shared shell scripts (`nav.js`, `notepad.js`) gained a short cache plus stale-while-revalidate, so a first-visit or SW-less session stops paying a conditional request for them on every navigation. |
| chrome | cal, serendipity, and the worker-rendered windows were realigned to the canonical Luna design tokens (window frame, link colors, caption-button gel skin, font stacks, focus-visible parity). A duplicate token in the canon itself was de-duped. |
| docs | CLAUDE.md stopped hardcoding a stale cache version and a wrong "no git remote" claim; the sitemap, llms.txt, and the garage pages' social-share tags were brought back in sync with reality. |

---

Two findings were left on the bench on purpose, the same honesty rule the rest of the site follows: no OAuth metadata where there is no authorization server, no A2A agent card where there is no Agent2Agent server. You do not advertise an engine the car does not have.

Every change above is live and committed. The harness is a workflow of finders plus adversarial verifiers, and the interesting part is that nothing reached this page until a second agent tried to tear the finding apart and failed.

[← back to the garage](https://aadhar.sh/garage)

Source: https://aadhar.sh/garage/teardown
