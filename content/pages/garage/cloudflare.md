---
title: "aadhar.sh/garage/four Cloudflare building blocks"
description: "A compact field note on Durable Objects, Workers AI through AI Gateway, structured Workers Logs, custom trace spans, and Browser Rendering."
path: "/garage/cloudflare"
section: "garage"
kind: "content"
updated: "2026-08-07"
source: "https://aadhar.sh/garage/cloudflare"
---

# Four Cloudflare building blocks

Cloudflare Workers exposes several useful primitives through one runtime. This note records four of them—**Durable Objects**, **Workers AI**, **Workers Logs**, and **custom trace spans**—plus the honest boundary around **Browser Rendering**.

The original interactive lab is retired. Its `/garage/cf/*` Worker is now a tiny `410 Gone` migration adapter, kept only until request logs show the old API can disappear. The durable ideas and the two offline photo pipelines remain.

## 1 · Durable Objects: an atomic counter

A **strongly-consistent, single-instance** stateful object. The homepage's visitor counter uses KV, which is eventually-consistent and capped at 1,000 writes/day, so a busy day silently stalls it. A DO increments *exactly once*, no race, 100k writes/day. It used to cost money; it's free now, and it fixes that counter cleanly.

—

```
env.COUNTER.get(id).fetch()  // SQLite-backed, atomic put
```

## 2 · Workers AI: caption a photo

The photo pipeline runs `@cf/llava-hf/llava-1.5-7b-hf` over committed thumbnail bytes to generate alt text and search terms. A small, fast vision model hallucinates charmingly now and then, so generated output stays reviewable source data rather than request-time truth.

—

```
POST /ai/run/@cf/llava-hf/llava-1.5-7b-hf
cf-aig-gateway-id: default
```

Both offline callers route through AI Gateway for payload logs, per-model usage, and cost attribution. Setting `CLOUDFLARE_AI_GATEWAY` to an empty string disables that routing. Caching stays off: rerunning an identical request is how a bad generated caption gets replaced.

## 3 · Workers Logs: structured observability

Structured lines such as `{ feature, ms, … }` are filterable and searchable in the dashboard. The migration adapter keeps observability enabled specifically so retirement can follow measured traffic instead of a guess.

```
console.log(JSON.stringify({ path, feature, ms }))
```

## 4 · Custom spans: trace a request

Workers **auto-trace** platform calls such as `fetch`, KV reads, and Durable Object calls into a waterfall in Observability. Custom spans can wrap application work and attach bounded attributes, making the trace useful without inventing a second telemetry system.

—

```
ctx.tracing.enterSpan("do.counter.peek", async (span) => { span.setAttribute("counter.value", n) })
```

## The honest scorecard

This site keeps the pieces that earn their complexity: Durable Objects serialize the counter and booking-slot instances; offline Workers AI callers route through AI Gateway; the site Worker and migration adapters emit structured observability; bounded live routes can add custom spans when a waterfall answers a real operational question.

**The fifth, parked honestly: Browser Rendering.** Headless Chromium in a Worker can create screenshots and inspect rendered pages, but its binding grants access to a scarce runtime. The rewrite keeps Browser only for the bounded Lens route, behind explicit authorization and deadlines; it does not spend browser minutes on decorative cards or public demo buttons.

← back to the [garage](https://aadhar.sh/garage) · [aadhar.sh](https://aadhar.sh/)

the ideas remain current; the retired demo endpoints say so plainly with `410 Gone`.

Source: https://aadhar.sh/garage/cloudflare
