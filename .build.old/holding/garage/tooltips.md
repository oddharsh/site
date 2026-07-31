---
title: "aadhar.sh/garage/tooltip experiments"
description: "Cursor-following tooltip styles for the photo grid and tracklist. Hover the slots and rows to compare."
path: "/garage/tooltips"
section: "garage"
kind: "content"
updated: "2026-06-07"
source: "https://aadhar.sh/garage/tooltips"
---

> Site index: https://aadhar.sh/llms.txt
> Section index: https://aadhar.sh/garage/llms.txt
> This is the Markdown twin of a page on aadhar.sh. The HTML at the source
> URL below is the original, and is hand-written and unminified on purpose.

# Tooltip Experiments

Variants I tried for the photo grid and tracklist on [aadhar.sh](https://aadhar.sh/). Hover the slots and rows. The two photo variants below (Fuji LCD and XP-skinned camera readout) carry the same content shape under different chrome; the third (vinyl) targets tracks only. Status pills:  marks a live candidate,  reached the homepage,  got tried and lost,  sits here as a comparison point.

The live candidates share one architecture: popover API for show/hide, `@starting-style` for the entry fade, and two custom-property writes per move (`--x`/`--y`) for cursor tracking, with a clamped CSS transform doing the actual placement. No rAF, no layout reads. Roughly 100 lines of JS total.

← back to [garage](https://aadhar.sh/garage)

---

## Fuji X-T LCD readout (photos)

Hover any slot. The floating panel mimics the camera's image-review screen: histogram band on top, filename, exposure trio, recipe grid, footer. It follows the cursor. The slot itself stays untouched (no in-tooltip thumbnail; you can already see the larger slot image).

Each recipe value is real EXIF, pulled from `/images/metadata.json`. An earlier preview fabricated values (it tagged XT508756 ACROS+R, which shoots B&W only); fixed.

---

## XP-skinned camera readout (photos)

**This is the one that shipped.** It's the live photo-grid tooltip on [the homepage](https://aadhar.sh/) (the `.cam` markup out of `buildContent()`). Same content as the Fuji LCD above (histogram, exposure trio, recipe grid, date) but reskinned in XP visual vocabulary: cream panel, blue gradient title strip, sunken bevel around the histogram, Tahoma body with Courier numerics. Keeps the camera-back density without arguing visually with the surrounding XP shell. The Fuji LCD lost on exactly that (too dark a panel against the Luna page).

---

## Vinyl sleeve at cursor (tracks)

**The cover-at-cursor idea shipped** as the live tracklist tooltip on [the homepage](https://aadhar.sh/), in a contact-sheet-style raised frame rather than this paper-mat `-6°` tilt, but it makes the same move: hover a row, and the square album cover floats at the cursor like a sleeve you pull out to read the front. Same architecture as the photo tooltip; the row text stays put.

1. 3:54
   
   Guild (feat. Mac Miller)—Earl Sweatshirt, Mac Miller
2. 2:14
   
   GAHDAMN—Kairee Doty
3. 4:49
   
   1995—Freddie Gibbs, The Alchemist
4. 3:35
   
   TRICERATOPS—Action Bronson, Paul Wall, Lil Yachty
5. 2:04
   
   GREEN LIGHT—colle$ttye

---

## Luna balloon (tracks)

The authentic XP *balloon*: the rounded, pale-yellow info bubble with a pointer tail (the "Your files are ready to burn" taskbar popup). Cream `#FFFFE1` infotip fill, 1px outline, a CSS-drawn tail aimed back at the cursor. This is the period-correct shape for the *simple* track/artist tooltips; the camera readout stays a Fuji LCD on purpose, because an XP machine never had a tooltip that rich, so calling it XP would be dishonest.

1. 3:54
   
   Guild (feat. Mac Miller)—Earl Sweatshirt, Mac Miller
2. 4:49
   
   1995—Freddie Gibbs, The Alchemist
3. 2:04
   
   GREEN LIGHT—colle$ttye

---

## Polaroid flip (photos)

**Rejected:** hover flips the slot 180° via `transform: rotateY`, so you see the metadata *or* the photo, never both. The grid exists to show the photos, so a tooltip should add to what you can see, not replace it. The same fault killed the first Fuji-LCD overlay (v1, painted on top of the slot). I kept this one as a record.

XT508687.jpg

FUJIFILM X-T50

XF35mmF1.4 R · 53mm

f/5.6 · 1/180 · ISO 3200

Kelvin WB · -0.3 EV

Provia, chrome FX strong with blue strong, grain strong large, +3 saturation. 02-01-2026, 21:53.

XT508940.jpg

FUJIFILM X-T50

XF35mmF1.4 R · 53mm

f/4.0 · 1/500 · ISO 200

Kelvin WB · -1 EV

Classic Chrome, chrome FX strong, grain weak small, +2 saturation. 02-07-2026, 01:46.

XT508756.jpg

FUJIFILM X-T50

XF35mmF1.4 R · 53mm

f/10 · 1/500 · ISO 1000

Kelvin WB · 0 EV · flash fired

Classic Negative, chrome FX strong with blue strong, grain strong small, -2 saturation. 02-03-2026, 22:21.

---

## CSS Anchor Positioning

Element-anchored rather than cursor-anchored. **This shipped.** It's the [homepage](https://aadhar.sh/)'s *keyboard-focus* tooltip path: mouse users get the cursor-follower, but a keyboard user tabbing to a slot has no cursor to track, so on `:focus-visible` the JS sets `anchor-name` on the focused element and the popover tethers to it via `position-anchor` / `position-area` (gated on `CSS.supports`, a clean no-op where unsupported).

**Note: this is a keyboard fallback, and a keyboard fallback only, not a JS-disabled one.** JS orchestrates every live tooltip (here and on serendipity): it populates the popover, calls `showPopover()`, and sets the `anchor-name`. With JS off, the popover stays empty and never opens: no tooltip at all. This pure-CSS `:has(:hover)` demo below *would* work without JS, but it isn't wired into any live page; tooltips are progressive enhancement that simply vanish without script (the photos and links still work).

Your browser doesn't support `anchor-name` yet. Chrome 125+ or Safari TP shows this demo.

XT508687.jpg

FUJIFILM X-T50 · XF35mm 53mm

f/5.6 · 1/180 · ISO 3200

Provia · 02-01-2026, 21:53

XT508940.jpg

FUJIFILM X-T50 · XF35mm 53mm

f/4.0 · 1/500 · ISO 200

Classic Chrome · 02-07-2026, 01:46

XT508756.jpg

FUJIFILM X-T50 · XF35mm 53mm

f/10 · 1/500 · ISO 1000

Classic Negative · 02-03-2026, 22:21

← [garage](https://aadhar.sh/garage) · [aadhar.sh](https://aadhar.sh/)

Source: https://aadhar.sh/garage/tooltips
