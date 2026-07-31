---
title: "aadhar.sh/garage/masonry"
description: "Prototype: a ragged-height contact-sheet photo grid with CSS Grid Lanes (display: grid-lanes), falling back to the fixed-square grid the homepage ships today."
path: "/garage/masonry"
section: "garage"
kind: "content"
updated: "2026-06-09"
source: "https://aadhar.sh/garage/masonry"
---

> Site index: https://aadhar.sh/llms.txt
> Section index: https://aadhar.sh/garage/llms.txt
> This is the Markdown twin of a page on aadhar.sh. The HTML at the source
> URL below is the original, and is hand-written and unminified on purpose.

# A masonry contact sheet

The homepage grid crops every photo to a 1:1 square: `object-fit: cover` drops each one into the same cell. **CSS Grid Lanes** (`display: grid-lanes`, shipped in Safari 27; see [the Safari 27 notes](https://aadhar.sh/garage/safari27)) lays the columns on a grid but stacks the rows masonry-style, so a portrait and a landscape sit side by side at their true heights. No JavaScript lays anything out, no media queries fire.

checking `display: grid-lanes`…

Loading the pool…

---

Same markup both ways. One line differs: `display: grid-lanes` behind an `@supports` guard, with EXIF pinning each photo's `aspect-ratio` so nothing reflows as the images load. Browsers without Grid Lanes fall back to the squares. Still a prototype: the live homepage ships the squares.

Source: https://aadhar.sh/garage/masonry
