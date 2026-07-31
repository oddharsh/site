---
title: "aadhar.sh/garage/5.6 sol"
description: "The performance pass outlined with 5.6 Sol: the bytes, cache boundaries, first-paint decisions, and Chrome trace checks that make aadhar.sh feel instant without sanding off its XP soul."
path: "/garage/gpt56"
section: "garage"
kind: "content"
updated: "2026-07-10"
source: "https://aadhar.sh/garage/gpt56"
---

> Site index: https://aadhar.sh/llms.txt
> Section index: https://aadhar.sh/garage/llms.txt
> This is the Markdown twin of a page on aadhar.sh. The HTML at the source
> URL below is the original, and is hand-written and unminified on purpose.

# 5.6 Sol's performance pass

A morning review produced a long list of ways to make this site faster. The useful part was not a rewrite: it was moving bytes out of first paint, giving every cacheable thing a stable identity, and making the deploy fail before a regression reaches the edge.

This page is the shop card for that pass. “5.6 Sol” is the reviewer; the evidence is the code, the build gate, and the Chrome trace below. No benchmark theatre, no invented p75.

trace readout

**136 ms**

LCP · localhost trace  
CLS 0.00  
0 external fonts  
64.74 KiB worker gzip

Tags: first paint, immutable bytes, deploy gate, field p75 pending

### Clear first paint

Static desktop markup, a tiny critical shell, native fonts, and no render-blocking JavaScript. The page can look like itself before the deferred nav arrives.

### Give bytes a name

Hashed thumbnails, honest 404s, edge-direct assets, and cache keys that change when bytes change. A cache hit is only useful when it is the right file.

### Make shipping fail loud

Build-time invariants, minified shell budgets, readable source twins, and a route oracle. The fast path includes proving that the fast path shipped.

## performance workbench / three checks

CHECK 01 · FIRST PAINT

Pick a layer of the tune-up. The readout is deliberately small: one concrete decision, one thing to measure, one thing that can still go wrong.

### Make the first frame honest

Keep the desktop and window geometry in the document, preload the shared Luna sheet, and defer the shell behavior. The browser paints the identity before JavaScript has had a chance to help.

## What actually made it onto the lift

| brief | garage translation |
| --- | --- |
| shell + CSS | `luna.css` is one shared, cacheable sheet; the desktop shell is static markup; `nav.js` stays deferred and ships minified with a readable twin. |
| photo bytes | Thumbnails are content-addressed and immutable; the first homepage slot is the designed LCP, with dimensions reserved and the rest lazy. |
| edge work | Static assets answer directly; Worker routes are explicit; KV-backed work uses stale-while-revalidate instead of holding the document hostage. |
| proof before deploy | The build parses CSS, checks the route mirror, caps the gzip bundle, and keeps `/*.src.*` twins so performance never costs View Source. |

**The honesty rule:** 136ms LCP and 0.00 CLS are from a local, unthrottled Chrome trace of this page—not field p75. The next useful measurement is a cold, slow-4G run against production, then a real-device check. A plan is not a result until the browser agrees.

The long-form design ledger lives in [Blueprint](https://aadhar.sh/garage/blueprint); the byte-level history is in [Bytes on the wire](https://aadhar.sh/garage/wire). [Back to the garage](https://aadhar.sh/garage).

Source: https://aadhar.sh/garage/gpt56
