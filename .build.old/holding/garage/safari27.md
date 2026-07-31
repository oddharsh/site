---
title: "aadhar.sh/garage/safari 27"
description: "What WWDC26's Safari 27 (macOS 27 Golden Gate) ships that this site already leans on: base-select going stable, anchor-positioning upgrades, scroll anchoring, plus live 'does your browser have it' checks."
path: "/garage/safari27"
section: "garage"
kind: "content"
updated: "2026-06-09"
source: "https://aadhar.sh/garage/safari27"
---

> Site index: https://aadhar.sh/llms.txt
> Section index: https://aadhar.sh/garage/llms.txt
> This is the Markdown twin of a page on aadhar.sh. The HTML at the source
> URL below is the original, and is hand-written and unminified on purpose.

# Safari 27, through this site's lens

WWDC26 shipped **Safari 27** (macOS 27 "Golden Gate," iOS/iPadOS 27, visionOS 27): ~58 new web-platform features. This site already leans on a bunch of them, so this cut shows where the platform caught up rather than the whole changelog. Source: the WebKit team's [News from WWDC26: WebKit in Safari 27 beta](https://webkit.org/blog/17967/news-from-wwdc26-webkit-in-safari-27-beta/).

Every card says what Safari 27 brings, and the strip below runs a **live check of *your* browser**. This whole site bets on high-octane fuel: when the engine has a feature it burns it, otherwise it falls back. "Not in your browser" never means broken.

---

## `appearance: base-select` now stable

Style a real `<select>`, dropdown and all, with CSS. No JS rebuild, no accessibility loss. Safari 27 takes it stable and adds the `::picker-icon` and `::checkmark` pseudo-elements.

On this site: the homepage and the [horizon](https://aadhar.sh/garage/horizon) demo already ship a Luna-styled base-select with a beveled drop-button, behind an `@supports` guard, so browsers without it get the native dropdown. Safari going stable just means more visitors see the styled one, with zero code change here.

## Anchor positioning upgrades Safari 27

Safari 27 makes anchored elements follow *transformed* positions, and adds `position-anchor: normal | none` plus refined `anchor-valid` / `anchor-visible` matching.

I'm pinned to that button with `position-anchor` \+ `anchor()`, no JS measuring. In Safari 27 I'd track it even through CSS transforms.

On this site: the photo and track tooltips use CSS anchor positioning as the JS-free keyboard fallback. Transform-aware anchoring matters here because windows move via `transform` when you drag them, so an anchored popover can stay glued to a window mid-drag.

## Scroll anchoring Safari 27

When content loads *above* the viewport, the browser keeps your scroll position instead of jumping. Controlled with `overflow-anchor`.

On this site: every page is a pinned window whose `.content` scrolls internally. When content lands above the fold late (a lazy image, the server-injected tracklist), scroll anchoring kills exactly that jump, native in Safari now, no JS scroll-restoration to hand-write.

## The `:heading` pseudo-class Safari 27

Match `<h1>`–`<h6>` in one selector instead of enumerating them (and one day `:heading(2,3)` for levels).

### If your browser has `:heading`, this is green.

#### So is this one. One rule, every level.

(Body text stays the default color.)

On this site: a small win. The design tokens already style captions and headings off one font stack; `:heading` would let the shared nav.js CSS reach every page's headings without knowing the tag.

## CSS odds & ends Safari 27

A grab-bag that tidies things we hand-roll:

```
width: stretch;          /* fill the container, margins accounted for  */
color: revert-rule;      /* roll one cascade rule back, not the whole property */
contain: style;          /* scope CSS counters / quotes to a subtree    */
color: oklch(... );      /* + new srgb-linear / display-p3-linear spaces */
```

On this site: `contain: style` is the honest version of the quote/counter scoping we avoid; the linear color spaces pair with the OKLCH + P3 work already in the homepage.

## Platform & worker upgrades Safari 27

The structural, less visible upgrades:

- **Top-level `await`**, off a full ESM-loader rewrite for standards compliance.
- **WebAssembly JSPI**, so synchronous Wasm can suspend and await JS promises.
- **Service Worker static routing**, routing rules that skip the SW entirely.
- **Transferable streams**, plus `ReadableStream.from()` and async iteration.
- **Cookie Store API `maxAge`**.

On this site: Service Worker static routing is the one I keep eyeing for `sw.js`. The cache-first / SWR / network-only split lives in JS in the fetch handler today; static routes could declare some of it and skip waking the worker at all.

## Spatial web Safari 27

The `<model>` element graduates from visionOS-only to iOS, iPadOS, and macOS; visionOS 27 adds immersive website environments and spatial-photo `controls` on `<img>`.

On this site: not used (no 3D), but filed. A resto-mod car site has obvious one-day uses for a real `<model>` viewer.

## The talks WWDC26

WebKit's [web-technology sessions roundup](https://webkit.org/blog/17974/web-technology-sessions-at-wwdc26/). Six worth a watch; I flag the two that land squarely on this site.

- [**Grid Lanes**](https://developer.apple.com/videos/play/wwdc2026/314/): CSS-only masonry, no JavaScript. On this site: the [horizon](https://aadhar.sh/garage/horizon) page flagged masonry as "not shipped" mid-2026, and here it is shipping. A direct fit for the photo grid: a ragged-height contact sheet, no fixed-square crop.
- [**Customizable Select**](https://developer.apple.com/videos/play/wwdc2026/315/): the full `appearance: base-select` deep dive. On this site: the talk behind the first card above, the Luna combobox we already ship.
- [What's New in Safari 27](https://developer.apple.com/videos/play/wwdc2026/204/): the overview (everything on this page, from the source).
- [Meet the `model` element](https://developer.apple.com/videos/play/wwdc2026/215/): embedding 3D, now cross-platform.
- [Immersive website environments](https://developer.apple.com/videos/play/wwdc2026/320/): spatial experiences on visionOS.
- [Web Extensions](https://developer.apple.com/videos/play/wwdc2026/216/): building and distributing browser extensions.

---

I paraphrase the feature names and scope from the WebKit post up top; the chips run real `CSS.supports()` and interface probes in your browser. Drag this window by its title bar; ⌘K jumps anywhere.

Source: https://aadhar.sh/garage/safari27
