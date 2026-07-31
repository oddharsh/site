---
title: "aadhar.sh/garage/scroll"
description: "Scroll-driven animations done in a period-correct Windows XP idiom: the Luna file-copy progress bar, window maximize-on-enter, and the blue gradient scrollbar. animation-timeline, no scroll listeners."
path: "/garage/scroll"
section: "garage"
kind: "content"
updated: "2026-06-07"
source: "https://aadhar.sh/garage/scroll"
---

> Site index: https://aadhar.sh/llms.txt
> Section index: https://aadhar.sh/garage/llms.txt
> This is the Markdown twin of a page on aadhar.sh. The HTML at the source
> URL below is the original, and is hand-written and unminified on purpose.

# Scroll, the XP way

Scroll-driven animation, but in a period-correct Luna idiom: the file-copy progress bar, windows that maximize as they open, the blue gradient scrollbar. All `animation-timeline`, no scroll listeners, no JS. Your browser: animation-timeline: scroll()view()

---

## 1 · "Copying…" (scroll the page to fill it)

The most XP thing imaginable: the green segmented file-copy bar. Here your scroll through the page drives the fill. Your scroll *is* the copy. It'd make a perfect reading-progress indicator.

Copying **Tuthill\_911K.jpg** to **/garage**

Time remaining: depends how fast you scroll

Cancel

`.xp-progress-fill { animation: xp-fill linear both; animation-timeline: scroll(root block); }`. The keyframes just animate `width: 0 → 100%`; the browser maps it to document scroll. Where unsupported it falls back to a static 60%-filled frame.

## 2 · Maximize on open (scroll so each window enters)

XP windows opened with a quick zoom-from-small. Each card below plays that as it rises into the viewport, fast and snappy like the real Luna animation, driven by `animation-timeline: view()`.

Opened as it entered the viewport.

Scale from 0.86 + fade, origin at the bottom.

animation-range: entry 5% → cover 32%. Done quick, then it sits still.

`animation-timeline: view(); animation-range: entry 5% cover 32%;` with a `transform-origin: bottom` zoom. It finishes early (within a third of the way across the viewport) so it reads as a one-shot "open," not a parallax that keeps moving.

## 3 · The Luna scrollbar (scroll inside the box)

The most-missed bit of XP scroll chrome, no animation involved: the blue gradient scrollbar. Pure CSS (`::-webkit-scrollbar` \+ `scrollbar-color` for Firefox). **Shipped.** The `scrollbar-color` tint now paints every page site-wide ([the homepage](https://aadhar.sh/), this garage, serendipity), so this one graduated out of the lab.

The Windows XP scrollbar: a Luna-blue gradient thumb with a 3D bevel, a lighter track, and square arrow buttons top and bottom.

Scroll this box to drive it. WebKit/Blink get the full gradient thumb + buttons; Firefox gets the two-tone `scrollbar-color` (thumb + track), no buttons.

On the homepage the photo wall and tracklist would scroll inside windows that actually look like windows, right down to the chrome.

Keep scrolling… the thumb is the gradient, the track is the lighter channel beside it.

That's the whole trick. No images, no JS, just a styled native scrollbar.

`::-webkit-scrollbar-thumb { background: linear-gradient(90deg, …); }` plus `scrollbar-color` for Firefox. Safari styles the thumb but ignores the arrow buttons.

↑ scroll back up and watch the copy bar empty ↑

← back to the [garage](https://aadhar.sh/garage) · [aadhar.sh](https://aadhar.sh/)

© 2026 Aadharsh Pannirselvam · built in the open · prefers-reduced-motion respected

Source: https://aadhar.sh/garage/scroll
