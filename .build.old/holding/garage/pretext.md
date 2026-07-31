---
title: "aadhar.sh/garage/pretext: DOM-free text measurement"
description: "chenglou/pretext measures and lays out multiline text with canvas as ground truth instead of the DOM, sidestepping reflow. A live demo, where it'd help aadhar.sh, and the tradeoffs."
path: "/garage/pretext"
section: "garage"
kind: "content"
updated: "2026-06-07"
source: "https://aadhar.sh/garage/pretext"
---

> Site index: https://aadhar.sh/llms.txt
> Section index: https://aadhar.sh/garage/llms.txt
> This is the Markdown twin of a page on aadhar.sh. The HTML at the source
> URL below is the original, and is hand-written and unminified on purpose.

# pretext: text measurement off the DOM

[chenglou/pretext](https://github.com/chenglou/pretext) measures & lays out multiline text using the **canvas** as ground truth instead of the DOM, so you never trigger a reflow just to ask "how tall is this paragraph at 320px?"

---

## 1 · Why the DOM is the slow path

To measure text the browser-native way, you put it in an element and read `offsetHeight` / `getBoundingClientRect()`. But those reads *force a synchronous reflow*: the browser must lay out the page right then to answer. Do it once and it's fine; do it in a loop (virtualized lists, measuring hundreds of items, re-measuring on every resize frame) and a reflow becomes one of the costliest things on the main thread. pretext splits the work in two:

- **`prepare(text, font)`**: the one-time cost: normalize whitespace, segment (graphemes, not just chars, since it handles CJK, Arabic, emoji, ZWJ), then measure each segment with canvas `measureText`. Cache it. Never re-run for the same text+font.
- **`layout(prepared, width, lineHeight)`**: the cheap part: *pure arithmetic* over the cached widths. Re-run it free on every resize tick. No DOM, no reflow.

## 2 · The technique, live

This runs **the real [pretext](https://github.com/chenglou/pretext)** (v0.0.7, vendored locally; see the closing note on keeping its bytes off every other page). Left: the browser laying the text out and reporting `offsetHeight` (a reflow). Right: pretext's `layout()` over a one-time `prepare()`, same line count, zero DOM. Drag the width:

### DOM: offsetHeight (reflow)–

### pretext: layout()–

## 3 · Dynamic wrapping: flow around a float

The thing a width-only measure can't do: text whose available width *changes per line*. pretext's `layoutNextLine(prepared,
      cursor, width)` lays out one line at a time, so you feed it a narrow width while the line sits beside the floated box and the full width once the text clears it. The result is real shaped wrapping, drawn to a canvas, no DOM. Drag the box bigger and watch the text reflow around it:

floated  
object

## 4 · International text: why a toy isn't enough

Here's the gap a 30-line re-creation falls into. A naïve `split(/\s+/)` assumes spaces separate words, so CJK (which has none) becomes one giant token that overflows, and scripts it can't segment get mangled. pretext segments by grapheme via `Intl.Segmenter` and breaks the same string correctly:

### naïve `split(/\\s+/)`

### pretext

## 5 · The payoff: re-layout cost

Same paragraph, re-laid-out at many widths (the resize / virtualization pattern). The DOM path forces a reflow each time; the canvas path just crunches arithmetic over the prepared widths (prepared *once*, outside the loop). Run it:

press the button

## 6 · Where it'd actually help aadhar.sh

- **Honestly: not much yet.** The site's text is tiny: a dozen track rows, a 3×4 photo grid, one tooltip at a time. A handful of one-off measurements is exactly the case where the DOM is fine. pretext earns its keep at *volume*, which this homepage doesn't have.
- **The real candidate is serendipity.** If the event / attendee lists ever get *virtualized* (only render what's on-screen), you need accurate row heights without mounting every row. That's pretext's home turf.
- **CLS / scroll anchoring:** measure incoming text before it paints to reserve the exact box, instead of `aspect-ratio` guesses. Niche here, but real.
- **The Fuji-LCD tooltip** could pre-size itself to its recipe text without a measure-then-reposition reflow on hover: a micro-win, probably below the noise floor.

## 7 · Tradeoffs (why it stays "watching")

- **Fonts must be loaded first.** Measure before the webfont swaps and every number is wrong. (aadhar.sh dodges this: it uses system Tahoma/Verdana, no webfont, which is also why the demo above agrees so closely.)
- **Canvas widths ≠ glyph-exact.** Good enough for line breaking; not a font-rendering engine. `system-ui` is explicitly unsafe for accuracy on macOS.
- **CSS subset.** Only `white-space: normal/pre-wrap`, a few break modes, pixel `letter-spacing`; no `font-feature-settings` / optical sizing.
- **It's a JS layout path** that must mirror the browser's CSS line-breaker. That cuts against this site's whole "let CSS do layout" ethos: you're taking on a model that can drift from the real engine.
- **Deps:**`Intl.Segmenter` \+ Canvas 2D (both broadly shipped now, incl. Safari).

**Verdict:** a genuinely clever inversion. Treat the canvas as the measurement oracle and keep re-layout in pure arithmetic. But its win scales with how often you measure, and aadhar.sh measures almost nothing. Filed under *watching*: the moment a virtualized list shows up (most likely in serendipity), this is the tool to reach for.

**On the dependency:** this page runs the real [github.com/chenglou/pretext](https://github.com/chenglou/pretext), bundled to a single 12 KB-brotli ES module and *vendored same-origin* at `/garage/pretext.lib.js`. Because it's served from `'self'`, the existing CSP needs *no change*, so pretext's bytes load only when you open this page and never touch the homepage or any other page. The only other demo here that's mine is the naïve `split(/\\s+/)` wrapper in section 4, kept deliberately bad to show the gap.

← back to the [garage](https://aadhar.sh/garage) · [aadhar.sh](https://aadhar.sh/)

real @chenglou/pretext, vendored same-origin (this page only) · the naïve split() comparison is mine

Source: https://aadhar.sh/garage/pretext
