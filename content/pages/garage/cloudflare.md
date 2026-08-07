---
title: "aadhar.sh/garage/four free Cloudflare features, live"
description: "Live demos of four free Cloudflare Workers platform features (Durable Objects atomic counter, Workers AI photo captioning, Workers Logs structured observability, and custom trace spans) behind a tiny worker. A fifth, Browser Rendering, is wired but parked on the free tier's daily cap."
path: "/garage/cloudflare"
section: "garage"
kind: "content"
updated: "2026-06-07"
source: "https://aadhar.sh/garage/cloudflare"
---

# Four free Cloudflare features, live

The free Workers plan quietly bundles things that used to cost money or a separate service. I wired four of them to live demos here (**Durable Objects**, **Workers AI**, **Workers Logs**, and **custom trace spans**), behind a tiny worker (`cf-garage`) routed at `/garage/cf/*`. The buttons hit real endpoints; nothing is faked. A fifth, **Browser Rendering**, I bound and deployed, then parked on the free tier's daily cap. Noted honestly below.

## 1 · Durable Objects: an atomic counter

A **strongly-consistent, single-instance** stateful object. The homepage's visitor counter uses KV, which is eventually-consistent and capped at 1,000 writes/day, so a busy day silently stalls it. A DO increments *exactly once*, no race, 100k writes/day. It used to cost money; it's free now, and it fixes that counter cleanly.

—

```
env.COUNTER.get(id).fetch()  // SQLite-backed, atomic put
```

## 2 · Workers AI: caption a photo

Every model in the catalog, **10,000 neurons/day free**. This runs `@cf/llava-1.5-7b` over a real grid photo to generate alt-text. A small, fast vision model hallucinates charmingly now and then (it once called a cloudy sky a UFO). One binding call does it: no GPU, no key.

—

```
env.AI.run("@cf/llava-1.5-7b", { image, prompt })
```

## 3 · Workers Logs: structured observability

**200,000 events/day, 3-day retention, free.** Every button above emitted a structured log line from the worker (`{ feature, ms, … }`), filterable and searchable in the dashboard. I can't show it *here* (the logs live in Cloudflare, not the page), but it's on: `[observability] enabled = true` in `wrangler.toml`. Click around, then watch them stream in `Workers & Pages → cf-garage → Logs`.

```
console.log(JSON.stringify({ path, feature, ms }))
```

## 4 · Custom spans: trace a request

Workers **auto-trace** every platform call (each `fetch`, KV read, DO call) into a waterfall in Observability. As of **Jun 16 2026** you can wrap your *own* logic in spans with `ctx.tracing.enterSpan()`, nested correctly. This endpoint runs a three-step pipeline (a Durable Object peek, a subrequest, and a compute loop), each in its own span with attributes. The canonical trace lands in Observability; the waterfall below is reconstructed live from the same span timings. (Run it twice: a cold Durable Object shows up as a fat first bar, then the warm path collapses to a few ms.)

—

```
ctx.tracing.enterSpan("do.counter.peek", async (span) => { span.setAttribute("counter.value", n) })
```

## The honest scorecard

All four ride the free Workers plan and **work live above**. Click them. They're shipped: a Durable Object increments with no race, Workers AI captions a real photo on a free GPU, every click leaves a structured log line, and a hand-instrumented request shows its own spans in the trace waterfall.

**The fifth, parked honestly: Browser Rendering.** Headless Chromium in a Worker (Puppeteer): `puppeteer.launch(env.BROWSER) → page.goto() →
      page.screenshot()`, the basis for on-the-fly `og:image` cards. I bind it and the worker deploys; no enable toggle exists (the binding is the access). The browser *does* provision. The catch was on my side: a timeout race that abandoned the in-flight browser stranded its websocket session (the free plan caps concurrency at 2), so each probe leaked a session and the next launch errored. The handler now bounds every launch and always releases the browser, and a bare hit no-ops instead of launching, so crawlers can't burn the **10 browser-minutes/day** budget. It's unbuttoned here until the OG-image use case earns that budget; trigger it by hand at `/garage/cf/screenshot?go=1`.

← back to the [garage](https://aadhar.sh/garage) · [aadhar.sh](https://aadhar.sh/)

demos hit a real worker (`cf-garage`) on the free Workers plan. nothing mocked.

Source: https://aadhar.sh/garage/cloudflare
