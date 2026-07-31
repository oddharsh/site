---
title: "aadhar.sh/garage/horizon"
description: "Test-driving upcoming web-platform features (text-box-trim, contrast-color, interestfor, anchor positioning) before any of them touch the live aadhar.sh homepage."
path: "/garage/horizon"
section: "garage"
kind: "content"
updated: "2026-06-07"
source: "https://aadhar.sh/garage/horizon"
---

> Site index: https://aadhar.sh/llms.txt
> Section index: https://aadhar.sh/garage/llms.txt
> This is the Markdown twin of a page on aadhar.sh. The HTML at the source
> URL below is the original, and is hand-written and unminified on purpose.

# Horizon

Upcoming web-platform features, test-driven here *before* any of them touch the live homepage. A flag being on in **my** browser means nothing to real visitors, so the rule is simple: nothing graduates from this page to [aadhar.sh](https://aadhar.sh/) until it ships in more than one engine. Each card says where it actually stands, and the chips below light up for *your* browser specifically. Cross-engine status triangulates three sources: Chrome flags, chromestatus, and the green/red WebKit chips that quote Safari's team directly from [webkit.org/standards-positions](https://webkit.org/standards-positions/), so Safari answers "will Safari ever do this" instead of me inferring it.

**Last swept 2026-07-30**, against Chrome 149–153, Safari 27 beta (WWDC26), and Firefox 152–153. A page like this rots in two directions and only one of them is obvious: features arrive, and features I already wrote up quietly change status underneath me. The 07-26 sweep moved four cards (`InstallEvent.addRoutes()`, compression dictionaries, `appearance: base-select`, Temporal) and demoted one of them off "shipped on the site" entirely, which is the more interesting half. Dates here are when I checked, never when I guessed.

The 07-30 pass found a *third* rot direction I hadn't accounted for, and it is the worst of the three: features that finish everywhere without ever showing up as news. Diffing this page against all 377 features chromestatus tags `shipping_year:2026` turned up six that already ship in two or three engines, which is this page's own bar for graduating, sitting here uncovered. Reading a frontier from Chrome's release notes structurally cannot see them. It also caught a wrong claim on the document-patching card, corrected in place. Version numbers in the new batch come from MDN's browser-compat-data v8.0.8 rather than chromestatus, whose Safari and Firefox columns are filled in by the Chrome feature author and had drifted on three of them.

---

## text-box-trim / text-box-edge Chrome · Safari · Firefox

✓ shipped on the site

Trims the half-leading above the cap line and below the baseline, so text sits flush in its box. The highlight shows the line box; on the right it hugs the actual letters.

default leading

Outlook Express

`text-box-edge: cap alphabetic`

Outlook Express

My Documents

On the site: this cleanly fixes the optical-centering I hand-tuned with magic-number padding on the XP title bars, and ends the long Safari `<h2>` baseline saga. Now shipped in all three: Chrome 133, Safari 18.2, Firefox 149.

Your browser doesn't support it yet, so the two samples above look identical.

## contrast-color() Chrome 147 · Safari · Firefox

✓ shipped on the site

Auto-picks a legible (black/white) text color for a given background. Top label in each swatch is naive fixed-white; bottom is `contrast-color()`. watch it flip to black on the light chips.

whiteauto

whiteauto

whiteauto

whiteauto

whiteauto

whiteauto

On the site: serendipity derives each attendee avatar's text colour from its hue with `contrast-color()` (behind an `@supports` guard). Baseline since April 2026: Chrome 147, Safari 26, Firefox 146. The homepage title bars deliberately *don't* use it: that Luna blue sits right on the black/white contrast crossover, so the hand-picked white is the safer call there.

Your browser doesn't support it yet, so the "auto" labels fall back to black.

## interestfor \+ anchor positioning Chrome 142 · Safari opposes · FF no

The declarative dream: `interestfor="id"` shows a popover on hover / focus / long-press, with built-in (configurable) delay and accessibility wiring, and **zero JavaScript**. Anchor positioning places it relative to the link. The demo sets `interest-delay: 0s` so tooltips spawn instantly, matching the site's cursor tooltips (the default is `0.5s`). Hover a car below:

Resto-mods like [Singer](https://www.google.com/search?q=Singer+Porsche+911), the [HWA EVO](https://www.google.com/search?q=HWA+AMG+EVO), or the [Evoluto 355](https://www.google.com/search?q=Evoluto+Automobili+355).

\[ Singer 911 \]

native popover, no JS

\[ HWA EVO \]

anchored to the link

\[ Evoluto 355 \]

interest-delay: 0s

Delay lives in CSS, not baked into the element: `interest-delay-start` / `interest-delay-end` (shorthand `interest-delay`). `0s` spawns instantly like ours, but the trade is that every incidental hover-pass over a grid would fire a tooltip (why the 0.5s default exists). The native-menu compromise: a delay for the first, but instant between adjacent invokers once one is already showing:

```
/* first hover waits; gliding between neighbours is instant */
.photos:has(:interest-source) .photos a { interest-delay-start: 0s; }
```

On the site: this comes closest to natively replacing the ~70-line cursor-tooltip layer: it handles hover/focus detection, the show/hide delay, and accessibility on its own. **But** Safari *opposes* the current design and it's Chrome-only (shipped default-on in Chrome 142, Firefox hasn't), so it is *not* a migration path while the site cares about Safari (WebKit standards-position: [oppose, #464](https://github.com/WebKit/standards-positions/issues/464)). And it anchors to the *element*, not the cursor, so even in a perfect world the cursor-following `--x/--y` loop stays. Strictly a forward-look.

what it would replace (today → declarative)

```
// today: ~70 lines of JS
pointerover  -> findTarget -> buildContent -> showPopover()
pointermove  -> write --x/--y
pointerout   -> hidePopover()

<!-- tomorrow (if it ever lands cross-browser) -->
<a interestfor="tip">Singer</a>
<div id="tip" popover>...</div>
/* CSS: position-area: bottom; interest-delay: 0s; */
```

Your browser doesn't support `interestfor`, the links above just navigate on click and show no popover. It ships default-on in Chrome/Edge 142+, so open this page there to see it (Safari opposes, Firefox hasn't shipped).

## anchor positioning / position-area + position-try Chrome · Safari · Firefox

✓ shipped on the site

Tether one element to another in pure CSS: give the target an `anchor-name`, point a popover at it with `position-anchor`, and place it with `position-area` (a 3×3 grid around the anchor: `top center`, `bottom span-right`…). No `getBoundingClientRect()`, no scroll/resize listeners, no JS coordinate loop. The killer feature is `position-try-fallbacks`: when the chosen side would overflow, the browser *flips* to the opposite side on its own. Click a button below: the left popover sits above (and flips below if it runs out of room near the top of the viewport); the right one asks for the right edge and flips inline when crowded.

position-area: top

Anchored above the button. Scroll me to the viewport edge and `flip-block` drops me below, pure CSS.

position-area: right

Asks for the right edge; `flip-inline` moves me left when there isn't room.

On the site: this is *already live* here in a small dose: the keyboard-focus path of the homepage tooltip tags the focused element with `anchor-name: --xp-tip` and the `.xp-tooltip.anchored` rule uses `position-anchor` to tether it, so Tab-navigating the photo grid gets a properly-placed Fuji-LCD popover with no cursor to follow. It wins everywhere I'd otherwise reach for JS positioning: a future `/coffee` slot-picker dropdown, the artist popovers, any menu, all could anchor + auto-flip in CSS. It does **not** replace the pointer-following `--x/--y` loop (anchors attach to elements, not the cursor), so the two coexist: cursor-tracking for mouse, anchored for keyboard. Now cross-engine: Chrome 125, Safari 26, Firefox 147 (`position-anchor` FF 151), WebKit support [#167](https://github.com/WebKit/standards-positions/issues/167).

Your browser doesn't anchor yet, the popovers above still open (native Popover API), they just fall back to a fixed corner of the demo box instead of tethering + flipping. Chrome 125+, Safari 26+, or Firefox 147+ shows the real behavior.

## scroll-driven animations animation-timeline: scroll() / view() Chrome · Safari · FF flag

Tie a CSS animation's playback to scroll position instead of the clock: no `scroll` listener, no `requestAnimationFrame`, no JS at all. `scroll()` tracks a scroller's offset; `view()` tracks an element crossing the scrollport. Scroll the box below: the XP progress strip fills via a named scroll-timeline, and each row fades up on its own view-timeline as it enters view.

↓ scroll this box ↓

scroll() drives the strip above, tracks this scroller's y-offset.

view() drives each row: one timeline per element, scoped to the scrollport.

animation-range: entry 0% cover 35%, reveal as the row enters.

Runs on the compositor; the main thread stays free while you scroll.

Degrades cleanly: where it's missing, rows just sit visible.

prefers-reduced-motion pins everything to its end state.

~ end ~

On the site: this retires any scroll-position JS I'd otherwise hand-write (a reading-progress strip on `/garage` long-reads, or lazy fade-up reveals for the 3×3 photo grid) in pure CSS that the compositor runs off the main thread (no jank competing with the cursor-tooltip `--x/--y` loop). It's the rare frontier feature that's already *cross-browser* (Chrome 115, Safari 26, Firefox 110+; WebKit standards-position [support, #152](https://github.com/WebKit/standards-positions/issues/152)), so it could graduate to the homepage today, strictly as decoration, gated behind `@supports` and `prefers-reduced-motion`, because the content must read fine with the animation pinned to its end state.

Your browser doesn't support `animation-timeline` yet, the progress strip sits at a fixed third and the rows just stay visible instead of revealing on scroll.

## popover=hint Chrome 133 · FF 149 · Safari no

A third popover *type*, sitting between `auto` and `manual`, purpose-built for tooltips. A `hint` popover is light-dismissed (click outside, `Esc`) **and** won't force-close an open `auto` popover the way another `auto` would, so a hover-tip can float over a menu without nuking it. Open each below and click elsewhere to feel the difference:

auto

Light-dismisses on outside click / `Esc`. Only one `auto` open at a time, a second one closes me.

hint

Also light-dismisses, but does *not* close an open `auto`. Built for transient tooltips.

manual

No light-dismiss at all: only JS `hidePopover()` closes me. (This is what the homepage tooltip uses today.)

On the site: the live cursor-tooltip (`#xp-tooltip` in `index.html`) is declared `popover="manual"` and driven entirely by a JS `pointerover`/`pointermove` loop that writes `--x`/`--y` and calls `showPopover()`/`hidePopover()`. Switching it to `hint` would buy native light-dismiss, but the site only has *one* tooltip and it already manages its own lifecycle, so the win is marginal: I'd still run the same JS to follow the cursor and pick the content. `hint` really pays off in the multi-popover case (a tip that coexists with an open menu) the homepage doesn't have. Filed as "safe to adopt, low value here."

Your browser doesn't support `popover="hint"`, the middle button falls back to `auto` semantics (the attribute parses to the default), so it behaves like the first one. To try it in older Chrome, enable `chrome://flags#enable-experimental-web-platform-features`.

## field-sizing : content Chrome 123 · Safari 26.2 · FF 152

Lets a form control size itself to its *content* instead of a fixed `rows`/`cols` or magic-number height. A `<textarea>` auto-grows line by line as you type and shrinks back when you delete; an `<input>` hugs its value. Type into both fields below: the left one is a stock textarea pinned at `rows="2"`, the right one tracks the text (`min-height`/`max-height` keep it from collapsing or running off the card).

default: fixed `rows="2"`, scrolls

`field-sizing: content`, auto-grows

single-line input that hugs its value:

On the site: this is the native kill-switch for the classic `input`/`scrollHeight` auto-resize handler: the JS pattern that listens on `input`, zeroes the height, reads `scrollHeight`, and writes it back every keystroke. The coffee booker benefits most directly: `cal/`'s "Your info" message box on the booking form can drop its resize script entirely and just say `field-sizing: content; max-height: 9em` on the sunken XP textarea, with the layout reflowing for free. Now shipped in Chrome 123, Safari 26.2, and Firefox 152 (June 2026), so it is now Baseline and can graduate to the live booking form, not just the garage. Pair it with a static `rows` attribute as the fallback height and there's nothing to feature-detect.

Your browser doesn't support `field-sizing` yet, the right-hand textarea behaves exactly like the left (fixed `rows="2"`, scrolls), and the email input keeps its default width. The `rows` attribute is the graceful fallback.

## View Transitions / document.startViewTransition() Chrome · Safari · FF 144

Wrap a DOM mutation in `document.startViewTransition(cb)` and the browser snapshots before + after, then cross-fades (or morphs, for same-named elements) between them: an animated state change with **no manual tweening, no double-buffering, no FLIP math**. Same-document is shipped in Chrome 111 and Safari 18; the cross-document `@view-transition { navigation: auto }` variant (Chrome 126, Safari 18.2) animates whole navigations. Firefox shipped same-document in 144 (Oct 2025) but not the cross-document variant yet. Tap the toggle: the panel below has its own `view-transition-name`, so only it animates:

My Documents folder view, click toggle to swap

Live, self-contained: the swap is a real `startViewTransition()` call, gated so unsupported browsers still toggle instantly (just without the morph).

On the site: nowhere, as of 2026-07-30. The Run palette, the `/writing` note popovers, and the `/lens` view tabs each wrapped their DOM mutation in `startViewTransition()`; all three now apply it directly. The honest reason is that every one of those elements is already composited and on screen the moment it is asked for, so the transition could only add latency to an interaction that had none. It also cost more than the animation: `startViewTransition`*defers* its callback, so every caller had to move focus and measurement inside the callback, and the ones that forgot ran a frame early against a still-hidden element. The API is genuinely good, and the demo below is real; this site just ran out of places where the trade paid.

Your browser doesn't support `document.startViewTransition` (Firefox, today), the toggle still works, it just swaps the panel instantly with no cross-fade. That instant-swap *is* the graceful fallback: the feature is purely a progressive enhancement.

## appearance: base-select / customizable \<select\> Chrome 135 · Safari 27 beta · FF 153 parser

For two decades the `<select>` popup has been a sealed OS widget: you got the trigger, never the list. `appearance:
        base-select` opts the control into a fully styleable model: the popup becomes real DOM you can theme, `::picker(select)` and `::picker-icon` are addressable, and each `<option>` can hold arbitrary markup. The select below is a true native control (keyboard, typeahead, form value all intact) reskinned into an XP combobox with alternating Outlook-Express rows, a blue-gradient highlight, a rotating drop-arrow, and a color swatch inside every option. Open it:

On the site: this natively answers the future `cal/` booking dropdowns (timezone, slot length, meeting type): today those would mean a hand-rolled JS listbox to escape the un-styleable OS popup, or a system widget that shatters the XP illusion. base-select lets one real `<select>` carry the bevel, the alternating rows, and inline swatches/icons while keeping full keyboard + form semantics for free. It went cross-engine in 2026: Chrome shipped it (~m135) and **Safari 27** now ships it too ([WebKit #386](https://github.com/WebKit/standards-positions/issues/386)). Firefox still renders the native widget, so keep it progressive: wrap the enhancement in `@supports (appearance: base-select)`. Gecko is moving though, and the tell is a parser change: Firefox 153 now parses *all* nested elements inside a `<select>` into the DOM rather than discarding everything that is not an `<option>`, `<optgroup>`, or `<hr>`. That is groundwork with no user-visible effect, and it is exactly what shipping this later requires. WebKit's **golden rule**: always give every `<option>` real text content or an accessible text attribute, because a base-select stays a genuine native `<select>` underneath (keyboard, typeahead, form value, screen-reader text all intact) and the options are display-only, never a place to nest buttons or links.

Your browser doesn't support `appearance: base-select` yet, the dropdown above falls back to your OS's native `<select>` widget (which is exactly the intended graceful degradation). To try the XP-themed version, open this page in Chrome 135+ or Safari 27.

## corner-shape \+ superellipse() Chrome 139 · Safari positive · FF no

A second axis for `border-radius`. The radius sets *where* a corner's two endpoints sit; `corner-shape` sets the *curve drawn between them*: `round` (the default), `bevel` (a flat cut), `notch` (a square step in), `scoop` (concave bite), or `squircle` / `superellipse(k)` for the Apple-style continuous curve. Every box below shares the *same*`border-radius: 18px`; only the keyword differs. Resolved via WebKit standards-positions [#229](https://github.com/WebKit/standards-positions/issues/229).

round  
(default)

bevel

notch

scoop

squircle

superellipse(2.4)

My Documents

A window frame with `scoop` top corners: one declaration, no SVG mask, no `clip-path` polygon.

On the site: this natively replaces the `clip-path:
        polygon()` hack on the title-bar icon, and any time I'd reach for an SVG mask to cut a corner. A real squircle on the `.window` and photo-frame corners reads more 2006-Aqua than the flat `border-radius` arc does, and it stays a live border (shadow, outline, focus ring all follow the new shape) instead of a clip that eats the box-shadow. **Chrome 139 only**: Safari and Firefox haven't shipped it, so it can't graduate to the homepage yet; it needs a plain `border-radius` fallback (which every box above already degrades to).

Your browser doesn't support `corner-shape` yet, all six boxes above fall back to identical plain rounded corners, and the framed window keeps ordinary rounded tabs. To try it in Chrome 139+: no flag needed; older Chrome via `chrome://flags#enable-experimental-web-platform-features`.

## calc-size() / interpolate-size Chrome-only

The decades-old missing piece: you *cannot* transition `height: 0 → auto`: the browser can't interpolate to an intrinsic keyword, so it snaps. `calc-size()` makes `auto`/`min-content`/`fit-content` computable, and one declaration (`interpolate-size: allow-keywords`) opts a subtree in, so every keyword transition under it tweens instead of jumping. Click the group box below; in Chrome it eases open, elsewhere it snaps.

Now Playing, details&rsaquo;

This panel's height animates from `0` to its natural content height: no `max-height` guess, no JS `scrollHeight` measurement, no ResizeObserver.

The `<details>` still works as a real disclosure widget for keyboard and AT; the transition is pure progressive enhancement layered on top.

… or fully declarative via `::details-content`

Same animation with zero extra markup, just `::details-content { height: 0 → auto }` plus `interpolate-size`. The XP group box above wraps the body in an explicit `div` only so the bevel clips cleanly.

On the site: this natively fixes every expand/collapse where I currently animate `max-height` to a hand-picked too-big number (which throws off the easing curve: the timing spends itself on empty space) or measure `scrollHeight` in JS. The collapsible disclosure sections (a code viewer, an FAQ, the garage cards here) would drop their measuring code entirely. But it's **Chrome 129 only**: Safari and Firefox have not shipped it and WebKit has taken no position ([#348](https://github.com/WebKit/standards-positions/issues/348)), so the rule stays in the garage. The honest fallback is fine, though: without the keyword the panel just snaps open instantly, which is exactly how `<details>` behaves today, so this can ship as pure enhancement the moment a second engine lands it.

Your browser doesn't support `interpolate-size`, the panels above still open and close correctly, they just snap instead of easing. To try the animation in Chrome 129+, no flag needed.

## scheduler.yield() / main-thread responsiveness Chrome 129 · FF 142 · no Safari

WebKit: unstated A promise you `await` in the middle of a long task: it hands the main thread back to the browser to service pending input/paint, then resumes your loop, and crucially resumes at the *front* of the queue, not the back like `setTimeout(0)`. So you stay responsive without losing your turn to unrelated work. It's shipped in Chrome and Firefox 142 (no flag), so the demo below is live: the concept, then a real measured run, then the code.

### one long synchronous task

the red tap waits for the whole block to finish, janky.

### broken with `await scheduler.yield()`

the same tap lands in a gap and gets serviced, smooth.

live rAF dot, it freezes whenever the main thread is blocked · frames:

Click a button and watch the dot. The single 600 ms task freezes it; the chunked version yields every ~20 ms so it keeps gliding, same total work, responsive throughout.

```
// today on the site: cold-KV tracklist fallback builds ~50 rows
// in one go, blocking input on a slow phone.
for (const t of tracks) renderTrackRow(t);   // one long task

// with scheduler.yield(), guarded so it ships everywhere:
const yieldNow = (window.scheduler && scheduler.yield)
  ? () => scheduler.yield()
  : () => new Promise(r => setTimeout(r, 0));  // fallback

let i = 0;
for (const t of tracks) {
  renderTrackRow(t);
  if (++i % 8 === 0) await yieldNow();   // breathe every 8 rows,
}                                        // resume at front of queue
```

On the site: the offender is the client-side Spotify tracklist fallback (the cold-KV path that renders full-fidelity rows: artist links, cover art, tooltip wiring). Today that's one synchronous burst. `scheduler.yield()` would let it chunk while keeping taps and scroll alive, without the back-of-queue penalty of a `setTimeout(0)` shim. It graduates to the homepage trivially because it's a guarded enhancement (`typeof` check, same-shape fallback), so Safari and Firefox just take the plain loop.

Your browser doesn't expose `scheduler.yield()`, the live demo below still runs and stays responsive, it just takes the `setTimeout(0)` fallback path instead. To get the real primitive: Chrome 129+, shipped, no flag.

**Even further out**: flag-gated in Chrome, not shipped by default in any engine. Bleeding edge. (To exercise the supported ones above, flip the master switch in Canary: `chrome://flags#enable-experimental-web-platform-features`.)

## HTML-in-Canvas / ctx.drawElementImage() Origin trial Ch148-150 · WICG

[WebKit: no position](https://github.com/WebKit/standards-positions/issues) Draws a *live, laid-out* DOM subtree straight into a 2D canvas with `ctx.drawElementImage(el, x, y)` (WebGL gets `texElementImage2D`, WebGPU `copyElementImageToTexture`), after opting the element in with a `layoutsubtree` attribute. The element keeps real text layout, fonts, and accessibility, unlike `foreignObject`+SVG, it isn't tainted, doesn't silently drop styles, and can be composited, transformed, and post-processed pixel-by-pixel. Below: a real XP title bar on the left, rasterized into the canvas on the right and tilted: one source of truth, two surfaces.

live DOM (the source element)

My Documents\_□×

`drawElement` → canvas (skewed)

Same markup, now compositable pixels.

On the site: this is the only sanctioned way to take the hand-built XP chrome (the title bars, the contact-sheet photo frames, the Fuji LCD tooltip) and run it through canvas effects (a tilt, a CRT scanline pass, a drop-shadow bake) *without* re-drawing any of it in canvas primitives or shipping an html2canvas-style screenshotting library. Picture a one-off "rendered on a 2006 CRT" hero, or baking a share-card OG image of the live now-playing list. But it is a single-engine flag with no WebKit position, so it stays a garage toy: the homepage cannot depend on it for anything Safari/Firefox visitors need to see.

the call (what the canvas on the right is doing)

```
const el  = document.getElementById("hic-source");
const ctx = canvas.getContext("2d");

// tilt the whole surface, then rasterize the LIVE element into it
ctx.translate(20, 14);
ctx.transform(1, 0.06, -0.10, 1, 0, 0);   // slight skew
ctx.drawElementImage(el, 0, 0);            // <- the new primitive (el has layoutsubtree)

// from here it's normal canvas: ctx.filter, getImageData, WebGL texElementImage2D…
```

Your browser doesn't support `drawElementImage` yet, the canvas shows a placeholder instead of the live rasterization. It is in origin trial in Chrome 148 through 150; enable `chrome://flags#canvas-draw-element` to see it for real.

## CSS Masonry / Grid Lanes Safari 26.4 · Chrome flag

Lays tiles of *uneven height* into columns, each new tile dropping into the shortest column so the bottom edge stays ragged and the gaps close: the Pinterest / contact-sheet look, but native. After years of a syntax fight (a `grid-template-rows: masonry` shorthand vs. a separate `display: masonry`), it has converged into **Grid Lanes**: masonry expressed *inside* CSS Grid so you keep `grid-template-columns`, gaps, and (eventually) subgrid. **Safari 26.4 shipped it** as `display: grid-lanes` (on by default) with a `flow-tolerance` knob (the old `item-tolerance`, renamed); Chrome keeps it behind the experimental flag. The grid below is *real* grid-lanes where the engine supports it (you, on Safari 26.4+) and falls back to a CSS multi-column mockup elsewhere: the mockup reads down-then-across, true masonry packs into the shortest lane.

Live in Safari 26.4+ (`display: grid-lanes`, on by default). In Chrome it's behind `chrome://flags#enable-experimental-web-platform-features` (the `#css-grid-lanes-layout` entry). Everywhere else: the mockup above.

Grid Lanes syntax (vs. today's fixed 3×3)

```
/* today on aadhar.sh — rigid, every frame the same box */
.photos {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 8px;
}
.photos img { aspect-ratio: 1; object-fit: cover; } /* crops the Fuji frames */

/* now shipping: Grid Lanes (Safari 26.4; Chrome + Firefox behind a flag) */
.photos {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  display: grid-lanes;           /* Safari 26.4 ships this; grid-lanes won the naming, not grid-template-rows:masonry */
  gap: 8px;
  flow-tolerance: 2em;           /* how ragged a lane may get before reflow (was item-tolerance) */
}
.photos img { height: auto; }    /* native aspect ratio preserved, no crop */
```

On the site: the homepage photo grid is a hard `3×3` of square-cropped thumbnails: portrait Fuji frames get center-cropped and tall Leica shots lose their composition. Masonry would let each thumbnail keep its native aspect ratio (the orientation-corrected width/height already in `metadata.json`) and pack with no crop and no row-height gridlock. Until it ships in two engines it stays here: the live grid keeps cropping, because a Canary-flag layout that falls back to a broken stack for every real visitor is exactly what this page exists to *avoid* shipping.

Your browser can't show real masonry yet (only Safari 26.4+ ships it by default in mid-2026). The grid above is a CSS multi-column *approximation*, not the live feature; enable the Canary / Safari TP flags above to drive the genuine layout.

## JPEG XL image/jxl Safari · Chrome 145 flag · Firefox 153 Nightly

The format the photo pipeline actually wants: smaller than AVIF at the *high* quality end (where this site lives), genuinely progressive (a low-res preview paints from the first few KB, then sharpens), and it can losslessly *re-wrap* an existing JPEG ~20% smaller with the original bytes recoverable. No live decode below: Chrome (my daily driver) won't decode JXL without a flag, and there's no `.jxl` asset on the site, so this is an honest mock plus the wiring it'd take. [WebKit: support (shipped)](https://github.com/WebKit/standards-positions/issues/72)

### JPG (jpegli)

baseline, today's universal fallback

everywhere

### AVIF

~25% smaller, but softens fine grain at high q

Cr 85+ · Saf 16+ · FF 93+

### JPEG XL

smaller still at the high-q end + progressive

Safari 16.4+ only

Bars are illustrative (matched perceptual quality, photographic content), not measured on these specific shots.

- **Progressive by default**: the Fuji-grain photos paint a blurry frame from the first KB and resolve as bytes arrive, instead of AVIF's all-or-nothing decode.
- **Lossless JPEG transcode**: `cjxl in.jpg out.jxl` shrinks the existing jpegli output ~20% and is byte-reversible, so no quality decision to re-litigate.
- **High-fidelity sweet spot**: at the q82-ish quality this site targets, JXL keeps grain and tonal gradients that AVIF starts to smear.

how it'd slot into the \<picture\> ladder (a 4th, top-priority source)

```
<!-- add jxl ABOVE avif; browser picks the first type it claims to support.
     Safari takes jxl, Chrome/FF skip to avif, ancient takes the jpg src. -->
<picture>
  <source type="image/jxl"  srcset="/images/<stem>.jxl?v=11">
  <source type="image/avif" srcset="/images/<stem>.avif?v=11">
  <img src="/images/<stem>.jpg?v=11" loading="lazy" decoding="async">
</picture>

# pipeline: one more encode step after the jpegli stage in add-photos.sh
cjxl --lossless_jpeg=1 <stem>.jpg <stem>.jxl   # byte-reversible re-wrap
# OR re-encode from the 1200px source for max ratio:
cjxl -q 90 -e 7 <stem>.png <stem>.jxl
```

On the site: a *third* tier above AVIF in every photo-grid `<picture>`, plus a `cjxl` step in `add-photos.sh` after the jpegli encode and another stem format in `holding/images/` (120 stems × *3* formats). But the `<picture>` type-fallback decode trap from the CLAUDE.md gotcha applies double here: the format split is wildly uneven. Only Safari decodes it by default. Chrome dropped it in 2023 but reintroduced a decoder (the Rust `jxl-rs`) behind `#enable-jxl-image-format` in Chrome 145 (default-on targeted H2 2026), and Firefox 152 shipped the same `jxl-rs` decoder behind a Labs flag. So for now it'd still only serve by default to Safari while tripling the asset count and KB on disk. **Not a graduation candidate** until Chrome and Firefox decode it non-flagged; it stays parked here as the format I'd adopt the day that happens, given the SOOC originals already live in R2 to re-encode from.

Nothing to decode live regardless of your browser, this card is a static mock by design. To actually *view* a `.jxl` today you need Safari 16.4+; in Chrome 145+ enable `chrome://flags#enable-jxl-image-format`, and in Firefox 153 the `image.jxl.enabled` pref is on by default in Nightly.

## HDR adaptive tone-mapping / AGTM · #hdr-agtm Chrome flag · not shipped

A gain-map HDR image carries two things: a normal SDR base picture, plus a per-pixel *gain map* that says how much extra luminance each spot should gain on a display with headroom. **Adaptive Global Tone Mapping** (AGTM, SMPTE ST 2094-50) lets the image author ship a tone-mapping curve so the same file renders correctly across a dim laptop, a bright phone, and a 1600-nit XDR panel: the highlights bloom on capable screens and fold back gracefully on SDR ones, instead of either clipping to flat white or being globally dimmed. This is the next rung above the P3 wide-gamut already used on the photo grid: P3 buys *wider* color, HDR buys *brighter* highlights.

**Can't be shown live here.** It needs a real gain-map asset, an HDR-capable display, and the experimental flag all at once, and a screenshot would just be SDR pixels lying about it. So the cells below are an honest *mockup* of the idea, not real HDR: left, an SDR ramp whose sun clips to paper-white; right, the same scene with the specular headroom the gain map would restore. The bar shows where the SDR ceiling sits and the hatched region is the extra headroom AGTM maps into.

SDR, highlights clip flat

base, clipped sun

HDR + gain map (mock), specular headroom

base × gain map

pipeline sketch (what add-photos.sh would gain)

```
# today: SOOC -> sips resize -> jpegtran rotate -> cjpegli q82 -> avifenc CQ30
#         single SDR-tonemapped AVIF + JPG, P3-tagged.

# with AGTM: keep the SDR base, ALSO author a gain map + 2094-50 curve.
#   X-T5 / Leica raw already holds the highlight data cjpegli throws away.
avifenc --gainmap hdr.avif base.jpg -o photo-hdr.avif   # gain-map AVIF
# OR ultra-HDR JPEG (libultrahdr) for the universal <img> fallback:
ultrahdr_app -m 0 -i base.jpg -g gainmap.jpg -o photo-uhdr.jpg

<picture>
  <source type="image/avif" srcset="/images/<stem>-hdr.avif?v=N">
  <img src="/images/<stem>.jpg?v=N">  <!-- SDR base = the fallback -->
</picture>
/* gate the glow so SDR panels never see a washed-out frame: */
@media (dynamic-range: high) { .photos img { /* let it bloom */ } }
```

On the site: this doesn't replace anything, it's a forward-look for the photo grid. The gain-map base layer *is* the existing SDR JPG/AVIF, so the fallback is free and the pipeline is purely additive: one extra encode step in `add-photos.sh`, no new client JS. It pairs with the `@media (color-gamut: p3)` upgrades already in the stylesheet via a sibling `@media (dynamic-range: high)` gate, so SDR visitors keep the exact frame they have now. Honest blockers: AGTM is a Chrome flag (`#hdr-agtm`), not shipped anywhere by default, and naive HDR photos in a feed are a known eye-searing UX problem, so it stays in the garage until it ships cross-engine *and* the curves can be tuned to glow, not blind.

Your browser / display reports no HDR headroom (`dynamic-range: high` is false), so even a real AGTM asset would render as its plain SDR base, which is exactly the graceful fallback that makes this safe to ship. The two cells above are a mockup either way.

## Declarative routing / route-matching Chrome flag · building blocks cross-browser

The pitch: declare your app's URL space once as a set of `URLPattern` route rules, then let CSS style whichever route is currently active: an "active nav tab" with *zero* JavaScript and no per-link `aria-current` bookkeeping. The routing flag itself is Chrome-only and still unrated, but it's assembled from two shipped, cross-engine primitives: `URLPattern` ([WebKit #61: support](https://github.com/WebKit/standards-positions/issues/61)) and the Navigation API ([WebKit #34: support](https://github.com/WebKit/standards-positions/issues/34)).

code sketch (today's primitives → the declarative dream)

```
// TODAY, cross-browser: URLPattern + Navigation API, ~a dozen lines of JS.
// This is what aadhar.sh would actually use right now.
const routes = [
  { id: "home",   p: new URLPattern({ pathname: "/" }) },
  { id: "garage", p: new URLPattern({ pathname: "/garage/:rest*" }) },
  { id: "photo",  p: new URLPattern({ pathname: "/images/full/:file" }) },
];
navigation.addEventListener("navigate", (e) => {
  const url = new URL(e.destination.url);
  const hit = routes.find(r => r.p.test(url));
  document.documentElement.dataset.route = hit ? hit.id : "404";
});
/* CSS picks up the active route via the data-attribute: */
[data-route="garage"] .nav-garage { font-weight: bold; }

<!-- TOMORROW (Chrome flag #route-matching, not cross-browser): -->
<!-- routes declared in markup; CSS styles the active one directly,  -->
<!-- no navigate listener, no data-attribute plumbing.              -->
<a href="/garage" class="nav-tab">garage</a>
/* :route-active { font-weight: bold; }  (sketch syntax) */
```

On the site: this is overkill *today*: aadhar.sh is deliberately one handwritten file per page, with routing that lives in `route()` at the top of `_worker.js`, not in the client. There's no SPA and no active-nav state to track. But it's the right thing to watch *if* the garage ever grows a shared client-side nav: the cross-browser half (`URLPattern` \+ Navigation API) could already replace any hand-rolled `location.pathname` string-matching with declared patterns, and the CSS half (once it ships in more than one engine) would let the active garage tab style itself with no JS at all. Strictly a forward-look while it's Chrome-flag-only.

Your browser is missing the building blocks (`URLPattern` or the Navigation API), so even the JS-today version above wouldn't run. The mock tab-bar is static either way, no engine ships the declarative CSS side yet. To try the flag in Chrome: `chrome://flags#route-matching`.

## \<install\> element / Web Install API Chrome flag · Safari opposes

A declarative install affordance: drop an `<install>` element (or call `navigator.install()`) and the browser paints a real "install this app" button wired to the same flow as the omnibox install icon, no `beforeinstallprompt` event plumbing, no stashing the deferred prompt, no custom button that has to guess whether the app is already installed. It can also point at a *different* origin's manifest, so one site can offer to install another.

There is no live demo here on purpose: it sits behind `chrome://flags#web-app-installation-api` in Chromium only, and **WebKit opposes the design** ([oppose, #463](https://github.com/WebKit/standards-positions/issues/463)), so it cannot graduate under this page's "two engines" rule. Below is the markup it would take, and a faux-XP render of the button it would mint:

```
<!-- declarative: browser paints + wires the button -->
<install
  manifest="/manifest.webmanifest"
  installtext="Install aadhar.sh"></install>

// or imperative, behind the same flag:
const result = await navigator.install();   // current-origin app
await navigator.install("https://aadhar.sh", manifestUrl); // cross-origin

// what it REPLACES today (the imperative dance):
let deferred;
addEventListener("beforeinstallprompt", e => {
  e.preventDefault(); deferred = e; showMyButton();
});
myButton.onclick = async () => {
  deferred.prompt();
  await deferred.userChoice;   // and you still guess "already installed?"
};
```

On the site: aadhar.sh isn't a PWA: no manifest beyond the favicon, no service-worker install story for the homepage itself (`sw.js` only caches `/images/*` and the garage pages). So there is nothing to wire up *yet*. The honest read is that this is a forward-look for a hypothetical "add aadhar.sh / the coffee booker to your dock" affordance, and even then, because WebKit opposes, it would be a Chrome-only enhancement layered on top of a manual fallback button, exactly the situation the cursor-tooltip and `interestfor` cards describe. Stays in the garage.

Your browser doesn't expose the Web Install API, the mockup above is a dead button. To try it: Chromium with `chrome://flags#web-app-installation-api` enabled.

## CSS Carousel ::scroll-marker · ::scroll-button Chrome 135

A scroll-snap strip that grows its own **prev/next buttons and dot markers in pure CSS**: `scroll-marker-group` on the scroller mints a `::scroll-marker` per item, `:target-current` lights the active dot, and `::scroll-button(left/right)` page it. No JS, no library, no `scroll` listener. Drag, click a dot, or use the buttons:

resto-mod

Porsche 911

Tuthill

Evoluto 355

HWA EVO

On the site: the photo grid could become a swipeable contact sheet with a Luna dot-strip underneath, the markers and arrows are the browser's, not mine. Gated behind `@supports (scroll-marker-group: after)`; where it's missing the same markup is just a plain scroll-snap rail (still swipeable, minus the dots and arrows).

Your browser doesn't mint `::scroll-marker` yet, the strip above still scroll-snaps and swipes, it just has no dots or arrow buttons.

## Invoker Commands command / commandfor Chrome 135 · Safari 26 · FF 144

A button that drives another element declaratively: `commandfor` points at a target, `command` says what to do (`toggle-popover`, `show-modal`, `close`…), the sibling of `interestfor`, but for clicks instead of hover. Zero JavaScript wired below:

**No click handler ran.** This panel toggled purely from `command="toggle-popover" commandfor="ic-pop"`. The same attributes cover `<dialog>` via `show-modal`/`close`, and you can author custom commands (`command="--like"`) handled by a single `commandEvent` listener.

On the site: the caption-bar minimize/close and any future booking dialog in `cal/` become declarative: markup is the behavior, so there's less inline JS to ship and nothing to rehydrate.

Your browser doesn't parse `command`/`commandfor` yet, the button above is inert (no fallback handler is wired, on purpose).

## `@scope` scoped styles + donut Chrome 118 · Safari 17.4 · FF 146

Style a subtree without a naming convention, and stop the styles at an inner boundary: the "donut." `@scope (.card) to (.inner)` applies between the two. Proximity wins over specificity, so a closer scope beats a more-specific selector. Live:

Inside the scope root, above the hole: styled blue + bold.

Inside `.scope-inner`, the donut hole: the scoped rule stops here, so this stays default.

On the site: every page is one file of inline CSS, so a stray `.controls` or `.title-bar` rule leaks into demo windows (it just bit me wiring the garage prototypes). `@scope` fences a component's styles to its own block: no BEM, no prefixes.

Your browser doesn't support `@scope`, the inner line below the hole inherits nothing special; both paragraphs look the same.

## Custom Highlight API CSS.highlights · ::highlight() Chrome · Safari · Firefox

Paint arbitrary text ranges: no wrapper `<span>`s, no DOM mutation. Build `Range`s, hand them to a `Highlight`, register it in `CSS.highlights`, and style via `::highlight(name)`. The two phrases below are lit without touching the markup:

This site is modeled after the recent wave of resto-mod cars, where you take a beloved chassis and formula and modernize it while retaining its soul.

On the site: a code viewer could syntax-highlight without wrapping every token in a tag: cheaper DOM, and search-term highlighting that never disturbs the text it marks.

Your browser lacks the Custom Highlight API, the sentence above renders with no emphasis (the text is identical, just unpainted).

## `hidden=until-found` \+ scroll-to-text Chrome 102 · Safari 26 · FF 148

✓ shipped on the site

Content that is collapsed *but still findable*: `hidden="until-found"` hides a region, yet in-page find (`Ctrl/⌘-F`) and `#:~:text=` deep links will auto-expand it, fire `beforematch`, and scroll it into view. Try it: search this page for **aircooled**:

● Found me. This line was `hidden="until-found"`, collapsed in the layout, but the browser searched inside it anyway and revealed it. The aircooled keyword lived here the whole time.

On the site: long `/garage` write-ups could ship fully collapsed yet stay Ctrl-F-able and deep-linkable, honest with crawlers (the text is really in the DOM) while keeping the page short.

Your browser doesn't support `hidden=until-found`, the line above stays hidden and find-in-page can't reveal it.

## relative color syntax oklch(from …) Chrome 119 · Safari 16.4 · FF 128

✓ shipped on the site

Derive a color *from another color*: pull out its `l c h` channels and recombine them. One base, every tint, shade, and hue-rotation computed from it. All five chips below descend from the same leftmost Luna blue.

base+L−L+130°h+chroma

On the site: the hover/active/border shades of every bevel are currently hand-picked OKLCH values. This computes them from one token: change the base, the whole bevel set follows.

Your browser doesn't support relative color syntax, the derived chips fall back to the base blue.

## @property / registered custom props Chrome · Safari · Firefox

✓ shipped on the site

Registering a custom property with a `syntax` type makes it *animatable*. The gradient angle below is a `<angle>` custom prop being keyframed: impossible with a plain unregistered variable (the browser can't interpolate an untyped string).

--hz-ang animating 0° → 360°

On the site: lets the OKLCH palette tokens (and the `--ab` avatar hue over on serendipity) transition smoothly instead of snapping.

Your browser doesn't support `@property`, the gradient sits static (the angle can't animate).

## @starting-style \+ transition-behavior: allow-discrete Chrome 117 · Safari 18 · FF 129

✓ shipped on the site

Animate an element *as it appears* from `display: none`: no JS, no double-rAF hacks. `@starting-style` gives the entry its "before" values; `allow-discrete` lets `display` itself participate in the transition so the exit animates too. Toggle it:

I fade + slide in from `display:none`, and back out, purely declarative.

On the site: the cursor tooltips and any popover could ease in/out instead of hard-cutting, with zero animation JS.

Your browser doesn't support it, the box snaps in and out with no transition.

## light-dark() Chrome 123 · Safari 17.5 · FF 120

One declaration, both schemes: `color: light-dark(black, white)` resolves by the element's `color-scheme`. The two panels share the *exact same* background + color rules, only their `color-scheme` differs.

color-scheme: light

color-scheme: dark

On the site: a single XP "High Contrast"/dark variant becomes a one-token flip instead of a parallel stylesheet.

Your browser doesn't support `light-dark()`, both panels fall back to unstyled colors.

## declarative shadow DOM \<template shadowrootmode\> Chrome · Safari 16.4 · FF 123

A shadow root written in *markup*: the parser attaches it with no JavaScript. The pill below is a component whose styles are fully encapsulated (a page-level `span` rule can't touch them) and whose label is `<slot>`-projected from the light DOM.

rendered server-side, zero JS

On the site: the XP window chrome is copy-pasted across ~6 files. As a DSD `<xp-window>` it'd be defined once, encapsulated, and still render on first paint with JS off.

Your browser doesn't support declarative shadow DOM, you see the raw light-DOM text ("rendered server-side…") instead of the styled pill.

## \<model\> element Safari 27 · Apple-led

A native, declarative 3D viewer: `<model src="scene.usdz">` with built-in orbit/zoom and AR hand-off, no WebGL/three.js. Shipped in **Safari 27** on iOS, iPadOS, and macOS (a flagged prototype back in Safari 26); no Chromium or Gecko signal. No live model is loaded here, just the placeholder it would occupy:

\<model\>: native 3D / AR viewer (no asset loaded)

On the site: a SOOC lens or a camera body could spin in 3D in the photo tooltip, declaratively, the way `<video>` handles motion.

Your browser doesn't expose `HTMLModelElement`, the element is inert here (placeholder only).

## CloseWatcher API Chrome 120 · Safari 26

One abstraction for "close requests": `Esc` on desktop *and* the Android back gesture, so custom UI (sidebars, lightboxes) dismisses the same way native dialogs do. Open the panel, then press `Esc`:

Press `Esc` (or Android back) to close, one handler covers both.

On the site: the full-res photo lightbox could register a CloseWatcher so Esc and mobile back both dismiss it, with the platform managing the stack.

Your browser lacks `CloseWatcher`, the demo falls back to a manual `Esc` key listener.

## HTML switch control \<input type=checkbox switch\> Safari 17.4 · Apple-led

A native toggle switch: just a `switch` attribute on a checkbox. Same form semantics, switch affordance, no ARIA plumbing. Shipped in Safari (the "HTML switch control" flag in your screenshot); not yet in Chromium/Gecko, where it degrades to a normal checkbox:

On the site: a real switch for any future toggle (sound on/off, reduced motion) instead of a faux-CSS slider.

Your browser ignores the `switch` attribute, you see a standard checkbox above (the graceful fallback).

## if() & sibling-index() / CSS Values 5 Chrome 137+ · FF 153 flag

Two bleeding-edge CSS primitives: `if()` for inline conditionals (`style()`/`media()` queries as values) and `sibling-index()`, which yields an element's position among its siblings, so a staggered animation needs *no* per-item variables. The two are drifting apart in status: Chrome ships the sibling functions default-on and keeps `if()` experimental, and Firefox 153 added `sibling-index()` / `sibling-count()` behind `layout.css.tree-counting-functions.enabled` with no `if()` in sight. Each row below delays by `sibling-index() × 90ms` (reload to replay):

- row one
- row two
- row three
- row four
- row five

On the site: the photo grid or tracklist could cascade in on load with one rule, and `if()` could fold tiny media-query overrides inline.

Your browser doesn't support `sibling-index()`, the delay resolves to 0, so all rows appear at once (no stagger).

## scroll-state container queries @container scroll-state(stuck) Chrome 133 · others no

Style an element by its *scroll condition*, e.g. whether a `position: sticky` header is currently stuck. The header below turns Luna-blue the moment it pins to the top. Scroll the inner box:

sticky header, blue when stuck

scroll down…

…and the header above detects that it's pinned

via `@container scroll-state(stuck: top)`

no scroll-event JavaScript involved

keep going

nearly there

bottom.

On the site: the page title bar could shed its shadow / tighten when it sticks, declaratively, no scroll listener.

Your browser doesn't support scroll-state queries, the sticky header stays grey even when pinned.

## reading-flow / reading-order Chrome 137 · others no

Decouples *focus order* from source order for flex/grid. The three links below are reordered visually with `order` (DOM is 1-2-3, you see 2-3-1). With `reading-flow: flex-visual`, `Tab` follows what you *see* (left to right) not the DOM. Tab through them:

DOM #1DOM #2DOM #3

On the site: lets CSS-driven responsive reordering stay keyboard-accessible without ARIA gymnastics: the long-standing tension between visual and focus order, resolved.

Your browser doesn't support `reading-flow`, Tab follows DOM order (1→2→3) regardless of the visual shuffle.

## Document Picture-in-Picture Chrome 116 · others no

An *always-on-top window you fill with arbitrary HTML*, going beyond a video frame. Click below to pop this box into a floating mini-window (close it to bring it home):

A real DOM node living in a Picture-in-Picture window. Peak resto-mod desktop-OS energy.

On the site: pop the **now-playing** tracklist into a floating window that survives tab-switching: a literal always-on-top Outlook-Express widget.

Your browser lacks `documentPictureInPicture`, the button is disabled.

## Temporal / the date/time rewrite ES2026 · Chrome 144 · FF 139 · no Safari

✓ shipped on the site

The long-awaited replacement for `Date`: immutable objects, first-class time zones and calendars, no more month-zero footguns. It reached **TC39 stage 4** in March 2026, so it is part of the ECMAScript 2026 language rather than a proposal. Shipping is a separate question from standardising, and Safari is the reminder: Blink and Gecko both shipped it in spring 2026, Safari 27 does *not* include it, and it remains flag-gated in Technology Preview. Live output from `Temporal.Now.zonedDateTimeISO()` in your browser:

checking for Temporal…

On the site: photo "uploaded" stamps and serendipity event times become zone-correct and DST-safe without a date library. This is the one card on the page that breaks the two-engine rule on purpose, and the reason it gets away with it is that every use is a progressive enhancement over a working `Date` path: the taskbar clock and the Notepad F5 stamp both try `Temporal` and fall back. Safari visitors get the fallback and notice nothing.

Your browser doesn't expose `Temporal` yet, the box above says so.

---

Newer arrivals: the bleeding edge (shipped or not), plus the networking layer the rest of this page was missing.

## Built-in AI / Prompt + Summarizer API Chrome 148 · on-device

On-device AI as a plain web primitive. `window.LanguageModel` (the Prompt API, stable in Chrome 148) takes text, image, and audio input plus sampling params and runs Gemini Nano locally; `window.Summarizer` (stable Chrome 138) does key-points / tl;dr / teaser / headline. No server, no key, no GPU bill. Chrome-only for now: Mozilla and Apple both objected to shipping it, so there is no Safari or Firefox implementation.

On the site: it could caption the 146-photo grid or summarize a [/lens](https://aadhar.sh/lens) reader page entirely client-side, with no cf-garage Workers-AI round trip. Chrome-only, so it would ride on top of the server path as an enhancement, never replace it.

## Document patching / declarative partial updates Chrome 150–153 proposed · flag

Out-of-order HTML streaming and in-place DOM patching as a browser primitive instead of a framework feature. A `<template for>` element plus `<?marker>` / `<?start>` / `<?end>` processing instructions stream HTML into named targets with no script (Chrome 150, and the processing-instruction parsing underneath it has positive positions from both Mozilla and WebKit). A separate explainer in the same repo revamps imperative insertion: positional methods that take HTML (`before` / `after` / `append` / `prepend` / `replaceWith`, retiring `insertAdjacentHTML`), streaming methods `streamHTML()` / `streamAppendHTML()` that return a `WritableStream`, and a `{ runScripts: true }` option that finally gives `createContextualFragment`'s behaviour a documented name. Chrome 153, behind `#enable-experimental-web-platform-features`.

**Correction (2026-07-30):** this card previously credited `setHTML()` to this proposal, alongside an `appendHTML()` that isn't a method in any of these explainers. `setHTML()` belongs to the Sanitizer API, a different WICG spec that has already shipped (Chrome 146, Firefox 148) and has its own card below. The confusion is understandable and worth keeping on the page: both specs write into an element from a string, they deliberately share an options bag, and the streaming work here extends the sanitizer's vocabulary rather than replacing it. They ship on completely different timelines, though, so treating them as one feature would have you waiting on a flag for something that is already two engines deep.

On the site: the `_worker.js` HTMLRewriter injection of the now-playing tracks and the random photo grid into `index.html` is exactly this server-side partial render, done by hand. This would make it a declared contract instead. It shares a WICG repo with the route-matching work above.

## WebMCP / page tools for agents Origin trial Ch149

A proposed open standard that lets a page expose structured tools (JavaScript functions and HTML forms) to browser-resident agents, so an in-browser agent calls a site's own actions instead of scraping the DOM. The origin trial began in Chrome 149. Early and Chrome-led, no other engine yet.

On the site: a machine-facing sibling to the [AadharshBot](https://aadhar.sh/bot) crawler and the `_index._agents` DNS-AID discovery record, exposing the [/coffee](https://aadhar.sh/coffee) booking or photo search as callable tools rather than pages to parse.

## WebNN / navigator.ml Origin trial Ch147-149

A graph API that runs ML inference on the client's NPU or GPU through the OS ML stack (DirectML, Core ML), the acceleration layer beneath ONNX Runtime Web and TensorFlow.js. The origin trial slipped twice and now runs Chrome 147 through 149 on all Blink platforms; Edge ships alongside Chromium and Firefox has stated intent, so it is cross-engine-bound rather than Chrome-locked. Distinct from WebGPU: WebNN targets the neural accelerator, not the GPU compute path.

## focusgroup attribute Chrome 150 · Safari/FF no

Declarative arrow-key navigation for a set of controls: put `focusgroup="toolbar"` on a container and the browser gives its children a single tab stop, arrow-key movement between them, and last-focused memory, the roving-`tabindex` pattern every toolbar and menu hand-rolls in JS. The value is a behavior token naming the widget pattern (`toolbar`, `tablist`, `radiogroup`, `listbox`, `menu`, `menubar`); a bare `focusgroup` is rejected with a console error and buys you nothing. Shipped default-on in Chrome 150; no Safari or Firefox yet, where it degrades to each control being its own tab stop. Tab into the toolbar below, then use the arrow keys (in Chrome 150):

On the site: aimed straight at the XP shell in `nav.js`. The taskbar app-buttons, the Start menu, and the row of draggable desktop icons are exactly the composite widgets `focusgroup` is for, and their keyboard handling is hand-written today. It would hand the arrow-key + single-tab-stop wiring to the browser. Single-engine, so it stays a garage experiment until a second one ships it.

## background-clip : border-area Chrome 150 · Safari/FF no

Paint a background into the border box *itself*, so a gradient border is one declaration instead of the old `border-image` slice dance or a stacked-background hack: give the element a gradient background, a transparent border, and `background-clip: border-area`, and the gradient fills only the border stroke. Chrome 150, default-on; not in Safari or Firefox yet. The frame below is a transparent border filled by a clipped gradient:

background-clip: border-area

On the site: the whole Luna look is 3D bevels and blue-gradient title bars, currently built from stacked `box-shadow`s and hand-mixed OKLCH border colours. A gradient-framed window or a two-tone bevel collapses to one background plus one clip, no `border-image`. The existing bevels already render fine, so this is a simplification rather than a new capability.

Your browser doesn't support `background-clip: border-area`; the gradient above fills the whole box instead of just the border.

## text-fit CSS property Chrome 150 · Safari/FF no

Scale a text node's font size to exactly fill the width of its box, in pure CSS, with no JS measuring the string and setting a size per element. Chrome 150, default-on; not in Safari or Firefox yet, where the text just keeps its declared size.

On the site: the XP title bars and folder labels truncate long names with an ellipsis today. `text-fit` could instead shrink an over-long window title to fit its bar, the way a real Luna caption never clipped. Minor and single-engine, so it parks here for now.

Your browser doesn't support `text-fit` yet; nothing here changes size.

## CSS random() Safari 26.2 · Chrome flag · FF no

A random value straight in CSS: `random(25%, 100%)` resolves to a number in that range at computed-value time, with an element-scoped keyword so each element can draw its own. Shipped in **Safari 26.2**; behind the experimental flag in Chrome (~148+) and nothing in Firefox, so it reads as a Safari-first CSS Values 5 feature for now.

On the site: pure decoration, filed next to WebGPU under "because we can." A hand-strewn desktop-icon jitter, per-photo grain seeds, or a scatter of Bliss clouds could pick their own offsets with no JS random loop. Nothing here needs it, which is exactly why it belongs on the horizon.

Your browser doesn't support `random()` yet, so a fixed fallback value is used.

## sizes="auto" on lazy images Chrome 126 · FF 150 · Safari 27 beta

A responsive-images `sizes` attribute is normally a promise you make at authoring time: *this image will render about this wide*, written as media queries the browser trusts before layout exists. `sizes="auto"` deletes the promise. Because a `loading="lazy"` image is fetched after layout has already run, the browser knows the tile's real width and picks from `srcset` against the measured box. The attribute only works on lazy images, which is the constraint that makes it sound rather than a shortcut.

On the site: the photo grid picks its tier by *viewport* today, a `<source media="(max-width: 560px)">` that swaps the 600px square for the 400px mobile AVIF. That breakpoint is a hand-guess about how wide a tile ends up in a 3×3 contact sheet, and it is wrong in every window the guess did not anticipate: a resized desktop window, the Run palette's photo preview, a tablet in portrait. Width descriptors plus `sizes="auto"` would replace the guess with the measurement. Two tiers bounds the prize (there are only so many wrong answers available), so this is accuracy rather than bytes. It degrades perfectly: an engine that ignores `sizes` falls back to the `<source>` ladder already there, which is why this is the closest thing on this page to a graduation candidate.

The chip above always reads "no," and that is a limitation of the probe rather than a claim about your browser. `img.sizes` is an unvalidated reflected string, so assigning `"auto"` and reading it back returns `"auto"` everywhere; an honest test has to lay out a lazy image and wait on `currentSrc`, which is more machinery than a chip deserves. Chrome 126+ and Firefox 150+ have it; Safari 27 beta adds it.

## Gap decorations column-rule / row-rule Chrome 149 · Safari TP · FF no

`column-rule` has drawn a line between multicol columns since forever. Gap decorations extend it to grid and flex, and add `row-rule` for the horizontal gaps, so a separator between items stops requiring a border on each item or an empty pseudo-element per seam. The rules paint in the gap that already exists, so nothing about the layout moves. The grid below draws both:

IMG\_0421IMG\_0422IMG\_0423IMG\_0424IMG\_0425IMG\_0426

On the site: the homepage photo grid is a literal contact sheet, and a contact sheet has seams. Those seams are per-tile frames today, which means nine borders drawing what is really four lines, and it means the outer edge of the sheet is drawn by the same rule that draws the inside. `row-rule` and `column-rule` separate the two ideas: the frame belongs to the photo, the seam belongs to the sheet. Chrome-only for now, so the per-tile borders stay.

Your browser doesn't support gap decorations, so the grid above shows no seams.

## border-shape non-rectangular borders Chrome 147 · Safari/FF no

`corner-shape` (above) bends the corners of a rectangle. `border-shape` replaces the rectangle: it sets the geometry of the border box itself, so the border, the border image, the focus ring, and the shadow all follow an arbitrary `shape()`, `polygon()`, or `circle()`. That is the part `clip-path` never did. Clipping cuts the box and takes the border with it, leaving you to fake a stroke; `border-shape` keeps a real border and clips only the inside.

On the site: honestly, close to nothing, and that is worth saying out loud. Luna is rectilinear on purpose. A window that is not a rectangle is not a window, it is a skin, and the whole point of the resto-mod is that the chrome stays period-correct. Where it could matter is the focus ring: the site's bevels are stacked `box-shadow`s, and an outline around a bevelled control currently traces the box rather than the bevel. Filed next to `corner-shape` as the other half of that spec, and parked.

Your browser doesn't support `border-shape` yet.

## :heading and :heading() Safari 27 beta · FF 142 flag · Chrome no

`:heading` matches any of `h1` through `h6`, and `:heading(2, 3)` matches the levels you name. Selectors 5, shipped first in Safari 27 beta, behind `layout.css.heading-selector.enabled` in Firefox, absent in Chrome.

On the site: every garage page opens its stylesheet with some variant of `h1, h2, h3` repeated across a handful of rules, because Luna styles headings as a family and then varies the size. On a page whose CSS ships inline in the HTML, that repetition is real bytes on every request. It is a small win per rule and a boring one, which is exactly the kind that compounds across fifteen garage pages. Waiting on a second engine.

Your browser doesn't support `:heading`; the selector never matches.

## width: stretch sizing keyword Chrome · Safari 27 beta · FF prefixed

`width: 100%` resolves against the containing block and then adds your margins on top, which is why a full-width element with side margins overflows. `stretch` fills the available space and applies the result to the *margin* box, so the margins come out of the width instead of adding to it. It standardises two old prefixes that did the same job: `-webkit-fill-available` and `-moz-available`. Chromium shipped it first, Safari 27 beta unprefixes it, Firefox still answers only to `-moz-available`.

On the site: the `calc(100% - 2 * var(--pad))` pattern shows up wherever a pane has to fill its window and keep its inset, and every one of those is a subtraction the browser could do. Once Firefox unprefixes, this collapses a family of arithmetic into one keyword.

Your browser doesn't support the unprefixed `stretch` keyword.

## ::-webkit-scrollbar the compat surrender Chromium · Safari · FF 153 subset

Firefox 153 began implementing a limited subset of `::-webkit-scrollbar`. Not because it is a good API (it is a vendor prefix from 2009 that never became a standard), but because enough of the web styles scrollbars through it that ignoring it was the bigger compat problem. The subset is deliberately narrow: a rule with a non-zero `width`/`height` disables overlay scrollbars, and `display: none` behaves like `scrollbar-width: none`. The standard `scrollbar-width` and `scrollbar-color` remain the actual answer.

On the site: `nav.js` paints a custom XP scrollbar through the `::-webkit-scrollbar` family, since a Luna scrollbar needs a raised 3D thumb and stepper arrows that `scrollbar-color` cannot express. Firefox visitors get the standards-track properties and a plain scrollbar. This change does *not* fix that, and the card is here mostly as a warning about its own chip: `@supports` now answers yes in Firefox for a selector whose styling still mostly does not land, so feature-detecting it tells you the selector parsed and nothing about whether the thumb rendered.

Your browser doesn't recognise the `::-webkit-scrollbar` selector at all.

## Reference Target cross-root ARIA Chrome 151 · Safari/FF no

The oldest real hole in shadow DOM: an ID reference cannot cross the shadow boundary. A `<label for="x">` outside a component can never reach the `<input id="x">` the component hides, and the same breaks `aria-labelledby`, `aria-controls`, `popovertarget`, and `commandfor`. The usual escape is to give up encapsulation. Reference Target lets the component nominate one inner element as the thing outside references resolve to, declaratively via `shadowrootreferencetarget` on the template or imperatively via `ShadowRoot.referenceTarget`, so the reference lands and the internals stay private.

On the site: this is the missing piece under the declarative-shadow-DOM card above. An `<xp-window>` that encapsulates its own title bar is appealing right up to the moment something outside it needs to label or control that window, and today the answer is to stop encapsulating. It is Chrome-only and the accessibility of the current markup is already fine, so this stays a prerequisite I am watching rather than a change I want.

No `referenceTarget` on `ShadowRoot` here.

## Scoped custom element registries Chrome 146 · Safari 26 · FF no

`customElements.define()` writes into one global map keyed by tag name, so two copies of a component library on one page fight over `<my-button>` and the loser throws. `new
        CustomElementRegistry()` makes a registry you hand to `attachShadow({ registry })`, so definitions apply to that subtree alone and identical tag names coexist. In two engines already, which is further along than most of this page; Firefox has not shipped it. (One sharp edge: a scoped registry rejects the `extends` option, so customized built-ins stay global.)

On the site: nothing today, because the site defines no custom elements at all, and that is the interesting part. It is on this page as a precondition. The reason the XP chrome is server-rendered markup plus one shared `nav.js` instead of a component library is partly that web components have historically been a worse deal than the thing they replace. Scoped registries and Reference Target are the two repairs that would change that arithmetic, and they are both landing at once. Worth knowing before the next rewrite tempts anyone.

No `CustomElementRegistry` constructor here.

## WebAssembly JSPI JS Promise Integration Chrome · FF 153 · Safari 27 beta

Wasm code is synchronous and the web is not, so any Wasm module that wants to `fetch` has had to be rewritten inside out (Emscripten's Asyncify) at real cost in size and speed. JSPI lets a Wasm stack *suspend* on a JavaScript Promise and resume when it settles: `WebAssembly.Suspending` wraps the async import, `WebAssembly.promising` wraps the export, and the C code in between keeps its blocking call. Firefox 153 turned it on by default and Safari 27 beta implements it, so this went cross-engine in about six weeks and is an Interop 2026 focus area.

On the site: no Wasm ships here, so this changes nothing directly. It matters one level down. The photo pipeline's encoders (`zenc` wrapping zenjpeg, `avifenc`) are native binaries that run on my machine at build time; the reason they are not a browser-side tool is the cost of making a synchronous codec behave in an async page. JSPI is what would make a "drop a HIF here and watch it encode" page cheap to build. Filed against the encoding study rather than the homepage.

No `WebAssembly.Suspending` here, so JSPI is unavailable.

## Text module imports with { type: "text" } TC39 stage 3 · Chrome · FF 153 flag

Import attributes gave JSON modules a safe syntax (`with { type: "json" }`); the text proposal adds the other obvious one. `import banner from "./banner.txt" with { type: "text" }` hands you the file as a string, with the type asserted at load time so a server that answers with something else fails the import instead of executing it. That assertion is the entire security argument for import attributes, and it is why this is a language feature rather than a bundler trick. Firefox 153 has it behind `javascript.options.experimental.import_text`.

On the site: `/writing` is plain `.txt` files plus a `posts.json` registry, and the worker reads each one and seeds it into a Notepad `<textarea>`. Today that is a fetch and a string. As a text module it would be an import the bundler can see, which matters because the worker is bundled at deploy: a post would become a build-time dependency instead of a runtime read, and a missing file would fail the deploy rather than the request. Tempting. Also a real coupling change, so it waits until it is not flag-gated.

## Element.moveBefore() state-preserving move Chrome 133 · FF 144 · Safari positive

Reparenting a node with `appendChild` tears its state down: iframes reload, running animations restart, focus and form state reset. `moveBefore()` moves it *without* the teardown. The iframe below counts its own uptime: move it between the trays and watch the counter survive a `moveBefore()` but reset on the `appendChild` fallback.

tray A

tray B

On the site: the desktop shell reparents `.window` nodes when you drag them or pop content into a popover. `moveBefore()` does that without reloading their contents or interrupting a running View Transition.

No `moveBefore()` here, so the button falls back to `appendChild`: the counter resets to 0 each move.

## Cross-document transitions @view-transition Chrome 126 · Safari 18.2 · FF building

The multi-page sibling of View Transitions. One rule (`@view-transition { navigation: auto }` on both pages) animates a *real* navigation between two separate documents, no SPA, no JS. (Can't demo it inside one page; it fires on the navigation itself. [/garage/vt-check](https://aadhar.sh/garage/vt-check) is a bare two-page pair that does, if you want to see whether your browser runs one at all.)

On the site: **tried, then removed**. It shipped here for most of 2026 and every route opted in inline, with a hand-tuned XP minimize/restore instead of a cross-fade. It came out on 2026-07-30 for a reason worth stating plainly, because it is the same reason twice: the Speculation-Rules prerender two cards down already loads the next page on hover-intent, so by click time the document is rendered and activation is free. The transition then spent ~200ms animating over a navigation that had nothing left to hide. Two features that each look like a win can want opposite things, and the prerender won: it makes the page arrive sooner, while the transition could only make it *appear* later. Firefox never implemented the opt-in and always cut instantly. It turned out to be right.

## shape() responsive clip-path Chrome 119 · Safari 18.2 · Firefox 136

A `path()` you can write with percentages and any length unit, so the clip scales with the box instead of being frozen at one pixel size. The pennant below is a single `clip-path: shape(…)`: resize the window and it stays sharp.

shape()

On the site: the hand-written polygon `clip-path`s (the title-bar icon, notched frames, the cone mark) could become resolution-independent shapes. Baseline since Feb 2026.

No `shape()` here, so the pennant falls back to its plain rectangle.

## text-wrap : pretty Chrome 117 · Safari 26 · FF no

The browser looks at the whole paragraph and avoids ugly last lines: orphans, a lonely single word, rivers. Left is default wrapping; right is `text-wrap: pretty`. Same text, same width:

default

The browser breaks lines greedily and can leave one lonely word stranded on the final line.

`text-wrap: pretty`

The browser breaks lines greedily and can leave one lonely word stranded on the final line.

On the site: the `/writing` Notepad text and the photo captions get tidier last lines for free. Pure progressive enhancement, since older engines just wrap as before.

## @function custom CSS functions Chrome 139 · Safari/FF building

Reusable, parameterised CSS logic, like Sass mixins but native and live: `@function --bevel(--l) { result: oklch(from var(--c) calc(l - var(--l)) c h) }`. Chrome-only so far; the others have it in progress.

On the site: the repeated `oklch(from … calc(l − 0.19) …)` bevel math (every raised/sunken edge derives its shade this way) would collapse into one named function. A "watch it" card until a second engine lands.

No `@function` here yet; Chrome leads.

---

Networking: the transport + delivery layer, the part of the platform a static site usually never touches.

## WebTransport HTTP/3 + QUIC Baseline 2026 · Chrome · Firefox · Safari 26.4

WebSocket's successor: bidirectional streams *and* unreliable datagrams over HTTP/3, multiplexed on QUIC so one slow stream doesn't head-of-line-block the rest. Went Baseline in March 2026 once Safari 26.4 shipped it. (No live demo, because it needs an HTTP/3 server endpoint to dial.)

On the site: overkill for a mostly-static page today, but it's the right transport the day anything here goes real-time, whether a live `/serendipity` presence feed or streaming a long crawl in `/around` instead of buffering it.

No `WebTransport` constructor in this browser.

## SW static routing InstallEvent.addRoutes() Chrome · Safari 27 beta · Gecko positive

Declare routing rules at install time so the browser can *skip booting the service worker entirely* for paths that always go the same place (straight to network or straight to cache), shaving the SW startup cost off those requests. Safari 27 beta implements it, which moves this from Chrome-only to two engines.

On the site: **it used to be, and the feature outlived the thing it optimised.**`sw.js` did declare static routes sending `/`, the crawlers, and the JSON APIs straight to network without booting the worker. Then the service worker itself retired in build v136 (July 2026): immutable content-addressed assets, bfcache, and speculation-rules prerender already made repeat visits instant, so the SW's remaining job was insurance priced at a cache-version ritual per deploy plus a second poisonable cache. `sw.js` is now a fifteen-line unregister stub, and the routes went with it. Worth keeping the card, because the lesson is the useful part: static routing made a service worker cheaper to keep, and the better answer turned out to be not having one. A feature that optimises a layer is not an argument for the layer.

No `addRoutes()` on `InstallEvent` here.

## 103 Early Hints server-side Chrome · Firefox · Safari (preconnect)

A response the server sends *before* the real one (status `103`), carrying `Link: rel=preload/preconnect` hints so the browser starts fetching critical assets during server think-time. It plays entirely at the header level, so there's no chip above. Cloudflare can emit it from the edge.

On the site: the homepage's one shared asset is `/nav.js`; a 103 could `preload` it (and preconnect the photo R2 origin) while the worker is still assembling the page. Firefox + Chrome honor preload; Safari does preconnect only.

## Speculation Rules prefetch / prerender Chrome · Safari 26.2 (off) · FF no

✓ shipped on the site

A `<script type="speculationrules">` JSON block tells the browser which links to prefetch or fully *prerender* ahead of the click, so the next page is already painted by the time you navigate: the trick behind McMaster-Carr feeling instant. **Chrome 151** adds a `form_submission` field to prerender rules: an ordinary form submission could never activate a prerender, because it carries extra navigation state the speculation was not prepared for, so a GET search form had to be declared as such up front. GET only. A third action, `prerender_until_script`, is still origin-trial-only at **152** (the trial opened at Chrome 144 in January 2026 and was extended through 154). It prefetches the document and starts rendering, so the preload scanner pulls stylesheets and images, then parks at the first `<script>` and executes nothing until the click lands. That buys most of a prerender's head start while leaving analytics, ads, and anything else that mutates client state unrun on a page nobody has asked for yet. The cost is that such a page can't read `document.prerendering`, never gets a `prerenderingchange` event, and can't be promoted to a full prerender later.

On the site: live already. The homepage and garage pages prerender internal links (eagerness "moderate", minus the live `/around` \+ `/whoareyou` crawlers), which is most of why navigation here feels instant. That one word sets two limits worth naming out loud. Chrome caps "moderate" at 2 prefetches and 2 prerenders and evicts FIFO, so at any moment this site is speculating on the last two links you lingered over and no more. And "hover for 200ms" means nothing on a touchscreen, so phones get viewport heuristics instead: since August 2025 Chrome speculates 500ms after you stop scrolling, for anchors sitting within 30% of the vertical distance from your last tap that are at least half the size of the largest anchor on screen. Same rule block, two quite different machines underneath, and the phone one is the half I can least predict from a desk. Cloudflare sells the managed version as [Speed Brain](https://developers.cloudflare.com/speed/optimization/content/speed-brain/), which injects a hosted rule set from the edge via a `Speculation-Rules` response header; I hand-write the inline block instead, to keep eagerness where I want it and to skip the two live crawlers that an opinionated edge config wouldn't know to leave alone.

No Speculation Rules here; links just load on click.

## Compression dictionaries dcb / dcz Chrome 130 · Firefox 153 · transport-level

Use a file you've already downloaded (or a shipped static dictionary) as the Brotli/Zstandard *dictionary* for later fetches, so an updated asset arrives as a tiny **delta** against the old copy instead of the whole thing. The transport left draft and is now [RFC 9842](https://www.rfc-editor.org/rfc/rfc9842.html): it negotiates entirely through `Accept-Encoding: dcb/dcz` \+ `Use-As-Dictionary` / `Available-Dictionary` headers (Chrome/Edge 130+), so there's no chip above. **Firefox 153** (July 2026) enabled it by rollout, so this is now two engines rather than one and a plan.

On the site: marginal, honestly. The homepage is ~22 KB brotli and `nav.js` is small, so the delta savings stay tiny in absolute terms. It'd earn its keep if those grew. Cloudflare shipped its edge half as [Shared Dictionaries](https://blog.cloudflare.com/shared-dictionaries/), still **passthrough open beta** on all plans (Apr 30 2026): my origin owns the dictionary lifecycle and the edge just forwards the headers and `dcb/dcz` bytes untouched, varying the cache per delta. Cloudflare pitched it as compression "for the agentic web," which is the angle that actually fits here: the machine surfaces ([/llms-full.txt](https://aadhar.sh/llms-full.txt), the JSON endpoints a returning crawler refetches) are where a delta would earn more than a human loading the homepage once.

## stale-while-revalidate async at the edge RFC 5861 · Cloudflare async 2026

A `Cache-Control` directive ([RFC 5861](https://www.rfc-editor.org/info/rfc5861/)): keep serving the *expired* copy for a grace window while a fresh one is fetched in the background, so nobody waits on the revalidation. Cloudflare made its handling **fully asynchronous** in Feb 2026: the first hit after expiry used to block on the origin (a `REVALIDATED`/`EXPIRED` status); now it returns the stale copy instantly with an `UPDATING` status and revalidates behind the scenes. It rides on the [new Pingora-based cache proxy](https://developers.cloudflare.com/changelog/post/2026-05-04-pingora-powers-cache/) (Rust, shipped May 2026), which also cut per-request overhead and tightened RFC compliance. Header-level, so there's no chip above.

On the site: I already hand-roll exactly this pattern in KV. The now-playing tracks carry a `tracks:<id>:fresh` freshness sentinel next to their value (the photo manifest used to be the second example, until it left KV for the worker bundle entirely), and `cal/`'s `fetchBusySWR` keeps a last-good calendar snapshot so a slow ICS feed never gates the booking page. Those tracks are the cleanest candidate to hand back to the platform: set `stale-while-revalidate` on that cached JSON and the edge serves the last-good playlist instantly while it re-scrapes Spotify in the background, retiring the sentinel bookkeeping. The homepage stays `no-store` (it opts out by design), so this lives entirely in the JSON layer underneath it.

---

And two from the far edge: one perfectly on-brand, one just because.

## Local Font Access queryLocalFonts() Chrome desktop · Safari & Firefox oppose

Enumerate the fonts actually installed on the machine (with permission). The thematically perfect feature for a site that ships *zero* font bytes and leans entirely on local Verdana / Tahoma / Trebuchet. Apple and Mozilla oppose it on fingerprinting grounds, so it may stay Chrome-only forever: a fitting horizon entry.

—

On the site: it could verify a visitor actually has the XP stacks installed before relying on them, then gracefully swap when they don't. Mostly it's here because a no-web-fonts site asking the OS what fonts exist is too on-the-nose to skip.

No `queryLocalFonts()` here; the button will say so.

## WebGPU navigator.gpu Chrome · Safari 26 · Firefox 141

Modern GPU compute + render in the browser: the WebGL successor, built on Metal / Vulkan / D3D12. Crossed into all three engines in 2026 (Safari 26, Firefox 141). Wildly overpowered for an XP homage, which is exactly why it belongs on the horizon.

On the site: realistically nothing, since the whole aesthetic is CSS gradients and 2003 restraint. But a GPU-rendered Bliss wallpaper or a procedural dithered backdrop is the kind of thing you'd reach for it. Filed under "because we can."

No `navigator.gpu` in this browser.

## Post-quantum WebCrypto ML-KEM · ML-DSA · X-Wing Origin trial Ch151 · not shipped

The Web Cryptography API is getting the NIST post-quantum primitives natively: **ML-KEM** (key encapsulation, formerly Kyber), **ML-DSA** (signatures, formerly Dilithium), the **X-Wing** hybrid key exchange, and ChaCha20-Poly1305 alongside them. Origin trial in Chrome 151. The two halves carry very different urgency, and conflating them is the usual mistake. Key exchange is urgent because of harvest-now-decrypt-later: traffic recorded today is decryptable the day a cryptographically relevant quantum computer exists, so hybrid key agreement had to arrive early. Signatures are not, because a signature only has to resist forgery during the window it is trusted in, and nobody can retroactively forge one.

On the site: AadharshBot signs its outbound requests with **Ed25519** per RFC 9421, and publishes the public half as a JWKS at [/.well-known/http-message-signatures-directory](https://aadhar.sh/.well-known/http-message-signatures-directory). ML-DSA is the thing that eventually replaces that key. Eventually is doing real work in that sentence: a bot signature covers one request and expires in seconds, which puts it squarely in the "not urgent" column above, and the Web Bot Auth draft pins Ed25519 today, so switching unilaterally would produce a signature no verifier recognises. The half that already affects visitors is the key exchange, and it is not mine to ship: TLS terminates at Cloudflare's edge, which has been negotiating hybrid post-quantum key agreement for a while now. [/whoareyou](https://aadhar.sh/whoareyou) prints the `kex` field from `/cdn-cgi/trace`, so you can read what your own connection actually negotiated rather than take my word for it.

## navigator.cpuPerformance device tier Chrome 152 · Safari/FF no

A read-only integer from 1 (weak) to 4 (fast), with 0 meaning the browser could not classify the device. It exists because the alternatives are worse: sites currently infer device class from `hardwareConcurrency`, from the user-agent string, or from timing a synthetic benchmark during page load, and all three are some mix of inaccurate and user-hostile. Coarse buckets also leak far less fingerprinting surface than a core count. Chrome 152; no signal from the other engines, and a permission-free hardware read is exactly the kind of thing they tend to push back on. Your device reports:

On the site: the site already makes this judgement, just blindly. The tooltip layer toggles `will-change: transform` on and off around the hover lifecycle because leaving a compositor layer allocated measurably hurts Low Power mode and variable-refresh displays, and the `@property` gradient on this very page pauses itself when off-screen because it repaints every frame. Those are both guesses at a device tier, applied to every visitor. A real tier would let the expensive effects stay off on a 1 and stop apologising on a 4. Single-engine, and `prefers-reduced-motion` plus the existing IntersectionObserver already cover the honest majority of the win, so this parks.

Your browser doesn't expose `navigator.cpuPerformance`.

## Long Animation Frames LoAF Chrome 123 · Safari/FF no

A `PerformanceObserver` entry for every rendering update that slips past 50ms. The older Long Tasks API could tell you the main thread was busy and almost nothing about why; LoAF reports the *frame*, so work split across several small tasks that together miss a frame still shows up. Any script that ran for over 5ms inside it comes back with `sourceURL`, `sourceFunctionName`, `sourceCharPosition`, and an `invokerType` naming what called it, alongside `forcedStyleAndLayoutDuration` for layout thrash and `pauseDuration` for the synchronous stalls. Chrome 123 since February 2024, nothing from the other two engines, so it is not Baseline and the field data it gathers is Chromium's view of your users rather than all of them. The sharp edge is in the spec rather than the docs: recording bails out early [if the document is hidden](https://w3c.github.io/long-animation-frames/). A background tab reports nothing, so a zero here means either that nothing was slow or that nobody was watching, and the API will not tell you which. I walked into exactly that measuring this site through an automated browser whose tab reported `hidden`: load, opening the Run palette, and typing into it all came back with zero long frames, and so did a deliberate 180ms blocking frame I added to check the instrument. A clean result and a dead probe look identical.

On the site: the gap is real and it stays open for now. Nothing here collects field data at all, and `nav.js` carries about fifty `addEventListener` calls driving window drag, resize, the taskbar, and a Run palette that filters 158 photos, none of it instrumented. LoAF only earns its keep against real visitors on real hardware, which is precisely the thing a site with no RUM does not have; measuring it once from my own desk would mostly prove that an M-series Mac is fast. There is a second wrinkle if I ever wire it up. Attribution keys on `sourceURL`, and the shell ships as `/a/nav.<hash8>.js` precisely so it can be cached for a year, so the URL changes on every deploy and nothing aggregates across releases without normalising the hash back out first. The cache win and the attribution story pull against each other, which is worth knowing before rather than after.

No `long-animation-frame` entry type here, so this browser has no view of which frames ran long.

## Container Timing containertiming attribute Chrome flag · WICG

Largest Contentful Paint tells you when the single biggest element painted, which is a page-level number that a component cannot ask about. Container Timing lets you mark a subtree with `containertiming` and get a `PerformanceObserver` entry when *that section* finishes its initial paint, the way `elementtiming` works for one element. Behind the experimental flag in Chrome; a WICG proposal rather than a shipped feature.

On the site: the homepage's LCP is a photo tile, so LCP is already roughly "when did the grid start." What it cannot answer is when the grid *finished*, and that is the number that matters here, because the worker server-renders twelve tiles into the HTML and the interesting failure is nine of them arriving fast while three straggle. That distinction is invisible to LCP and would be one `containertiming` attribute on `<section class="photos">`. The same applies to the now-playing list, which is the other server-rendered chunk. Genuinely useful, genuinely single-engine, and measurement rather than user-facing behaviour, so it costs nothing to wait.

No `container` entry type in this browser's `PerformanceObserver`.

## Sweep note: features that already cleared the bar

The cards below came out of diffing this page against all 377 features chromestatus tags `shipping_year:2026`, on 2026-07-30. The uncomfortable half of the result is the first six: they already ship in two or three engines, which is this page's own graduation rule, and they were missing here anyway. A page that sorts the frontier by engine count can still miss things that quietly finished, because nothing about a feature landing everywhere generates the kind of news that gets a feature written up. Versions below are from MDN's browser-compat-data bundle v8.0.8 (2026-07-24), not from chromestatus, because chromestatus's Safari and Firefox columns are filled in by the Chrome feature author and drifted on three of these.

## Sanitizer API Element.setHTML() Chrome 146 · FF 148 · Safari positive

A safe-by-default HTML parser built into the platform. `el.setHTML(str)` parses untrusted markup and drops anything that can execute, so scripts, event-handler attributes, and `javascript:` URLs never reach the DOM. The unsafe twin `setHTMLUnsafe()` has been around since Chrome 124 and does no filtering; the sanitizing one is the new part. Type a hostile string and watch both paths:

`setHTMLUnsafe()`

`setHTML()`

On the site: the honest answer is that this site has almost no user-supplied HTML to sanitize, which is a design choice rather than luck. The one place it would matter is `/lens`, which fetches arbitrary URLs and renders what comes back; that path builds text nodes and escapes on the way out rather than parsing hostile markup, so it sidesteps the question instead of answering it. Where this genuinely changes the calculus is DOMPurify: a ~20KB dependency whose whole job the platform now does, which is the kind of subtraction this site optimises for. Two engines, so by the rule at the top it has graduated.

No `Element.setHTML` here, so the right-hand pane falls back to escaping the string.

## Media element pseudo-classes :playing · :paused · :buffering Safari 15.4 · FF 150 · Chrome 152

`:playing`, `:paused`, `:seeking`, `:buffering`, `:stalled`, `:muted`, and `:volume-locked` match `<audio>` and `<video>` by their actual state, so a custom transport control can style itself from CSS instead of from a pile of `timeupdate` and `waiting` listeners keeping a class in sync. This is one of only two features in the whole 2026 set that names **Interop 2026** as a focus area, and it is the older feature on this page by some margin: Safari has had it since March 2022.

On the site: nothing here plays media, so this is a card about the sweep rather than about a plan. It earns its place because it is the clearest example of the failure mode the note above describes. It shipped in WebKit four years ago, shipped in Gecko this year, is an Interop priority, and still never crossed my desk, because features that arrive quietly in the engine I do not develop against are exactly the ones a Chrome-flag-driven reading list cannot surface.

This browser doesn't parse `:playing`, so the selector never matches.

## Three TC39 methods that finished sumPrecise · getOrInsert · Iterator.concat Chrome · Safari · Firefox

Not upcoming at all. All three shipped in all three engines while this page wasn't looking. `Math.sumPrecise` (Chrome 147, Safari 26.2, Firefox 137) sums an iterable without accumulating float error. `Map.prototype.getOrInsert` and its `getOrInsertComputed` sibling (Chrome 145, Safari 26.2, Firefox 144) collapse the has/get/set dance into one call. `Iterator.concat` (Chrome 146, Safari 26.4, Firefox 147) chains iterators lazily, without materialising arrays.

```
press the button
```

On the site: `getOrInsert` is the one with real call sites. The Spotify scrape builds an artist-id map with the has/get/set pattern in `_worker.js`, and `buildImagesManifest` does the same shape when grouping stems. `Math.sumPrecise` is the sort of thing you reach for once and remember forever: the photo pipeline sums per-tier byte counts, and while naive summation is fine at 474 files, the precise version costs nothing. Worth noting these are three engines deep, so they are past this page's bar and into "just use them."

One or more of the three is missing here; the output says which.

## image-rendering: crisp-edges Safari 7 · FF 65 · Chrome 148

Scale an image without smoothing it. The wrinkle is that Chromium supported the *neighbouring* keyword `pixelated` since Chrome 41 and rejected `crisp-edges` until 148, while WebKit and Gecko took `crisp-edges` years earlier. Spec-wise the two differ (`pixelated` asks for nearest-neighbour specifically, `crisp-edges` asks only to preserve contrast and edges); in every shipping implementation they do the same thing. Same 8×8 source bitmap, scaled 12×:

default (smoothed)

`crisp-edges`

On the site: this is the most on-brand feature in the whole sweep and the page had no card for it. Every icon here is authored as inline SVG precisely to dodge the scaling question, but the XP source material is bitmap art, and the honest 2003 reproduction of a 16×16 toolbar icon at 2× is a hard-edged upscale rather than a redrawn vector. The reason to keep writing `pixelated` rather than switching is Chrome 41 versus Chrome 148: the older keyword has the wider floor, and the two are indistinguishable in practice.

No `crisp-edges` support, so both swatches render smoothed.

## text-decoration-skip-ink: all Safari 15.4 · FF 75 · Chrome 148

The default `auto` breaks an underline around descenders that would collide with it. `all` makes that skipping unconditional, which matters for scripts where the glyphs regularly dip into the underline and the browser's heuristic under-skips. The property itself is old news (Chrome 64); the `all` keyword is what Chrome 148 added, and Safari and Firefox have had it since 15.4 and 75.

`auto`

judgment paging quietly

`all`

judgment paging quietly

These two most likely look identical to you, and that is the honest result rather than a broken demo: on Latin text at this size `auto` already skips every descender that crosses the rule, so `all` has nothing left to do. The keyword earns its keep where the heuristic under-skips, which is scripts with deep or frequent descenders rather than Verdana running English.

On the site: underlines here are Verdana and Tahoma running Latin text, where `auto` already does the right thing, so this is a no-change. It is on the page because it is a clean example of the pattern the sweep kept turning up: a property that shipped everywhere years ago, with one keyword that Chromium only just caught up on, so the feature reads as "new" from a Chrome-shaped vantage point and as ancient from anywhere else.

This browser doesn't accept the `all` keyword, so both lines use `auto`.

## focus({ focusVisible }) Safari 18.4 · FF 104 · Chrome 145

Programmatic focus has always had a guessing problem: the browser decides whether to draw the focus ring based on a heuristic about how focus arrived, and script that moves focus deliberately has no way to say what it wants. `el.focus({ focusVisible: true })` forces the ring on and `false` forces it off, so a script that moves focus for keyboard users can show the indicator without also flashing it at someone who clicked.

On the site: `nav.js` moves focus in two places where this is the exact missing control. Opening the Run palette with ⌘K focuses the input, which is unambiguously a keyboard action and should show a ring; clicking Start opens the same palette from a mouse, where the ring is noise. Today both paths get whatever the heuristic decides. Same story for the Notepad popovers in `notepad.js`. Three engines, so this one is usable now.

This browser ignores the `focusVisible` option, so both buttons behave identically.

## margin-trim Safari 16.4 only · Chrome no · FF no

Drops the margin on a container's first and last children, so a box with uniform padding stops getting extra space at its top and bottom edges from the paragraphs inside it. The usual workaround is a `:first-child` / `:last-child` pair per component, which every stylesheet on the web has written at least once. Safari-only since 16.4, which makes it the inverse of most cards here: WebKit shipped it three years ago and nobody followed.

default

first

last

`margin-trim: block`

first

last

On the site: the `.content` workspace inside every XP window carries exactly the hand-written first-child/last-child pair this replaces. It stays hand-written, because one engine is one engine, and the fallback here is not graceful in the way most of this page's cards are: without support the margins collide and the window padding looks wrong, rather than merely unstyled.

No `margin-trim` here (expected outside Safari), so both boxes look the same.

## Speculation Rules, the measurement half getSpeculations() · on-prefetch-activation Chrome only · several still proposals

The Speculation Rules card above covers firing a prefetch. Four separate 2026 entries cover finding out whether it worked, which is the half that has never existed. `performance.getSpeculations()` exposes preloads, prefetches, and prerenders as measurable entries. The `on-prefetch-activation` response header names a telemetry endpoint the browser pings when a prefetched document is actually used for a navigation, so the signal reaches the *server* rather than a script in a page that may never run. A `form_submission` field lets a prerender be activated by a real form POST or GET. And an external `<script type=speculationrules src>` lets one rule set be shared across documents instead of inlined into each.

On the site: this is the most useful thing in the sweep, because the speculation rules here are hand-tuned and *unmeasured*. The rules in `index.html` were written from reasoning about which links a visitor is likely to take next, and the only evidence that they help is that the pages feel fast when I click them, which is not evidence. `on-prefetch-activation` is the one that fits this architecture best: it is a response header, so `_worker.js` can set it and receive the callback, and the accounting lands next to the existing Analytics Engine counters rather than in a client script the RUM beacon would have to carry. Precision is the number worth knowing, since a prefetch that never activates is bandwidth spent on someone else's behalf.

## @supports at-rule() \+ named-feature() Chrome 148 · FF positive on named-feature · Safari no

`@supports` has always been able to test a property/value pair and a selector, and has never been able to test an *at-rule*. There is no way to ask "does this engine understand `@container`" in CSS. `at-rule(@container)` closes that, and the companion `named-feature()` covers a small set of capabilities that no syntactic probe can reach at all.

Live probe of this browser:

```
checking…
```

On the site: this is the fix for a limitation this page documents against itself. The capability chips below every card are `CSS.supports()` probes, and five of them (`jpeg-xl`, `route-matching`, `sizes-auto`, `import-text`, `pq-webcrypto`) are hardcoded to return `false` under a comment explaining that no synchronous probe exists, on the reasoning that a chip reading "no" is more honest than a probe that pretends to know. `at-rule()` would convert some of that class of question into a real answer. It is Chrome-only today, so the honest-false convention stays exactly as it is, and this card is a note about what would retire it.

No `at-rule()` in this browser's `@supports`, which the probe above reports directly.

## window-drag Chrome preview · FF positive · Safari no

Marks a region of an installed desktop web app as titlebar: dragging there moves the OS window instead of doing anything in the page. `window-drag: move` opts a region in, `window-drag: none` carves an exception back out, which is how you keep the close button clickable inside a draggable strip. Chromium has it in preview channels rather than stable; `-webkit-app-region` has done roughly this for Electron for years, and this is the standards-track version.

On the site: `nav.js` implements window dragging by hand. Every `.window` and `.np-window` is draggable by its title bar via pointer listeners, with a hard top boundary, and the same file carves out the `_ □ ×` controls so a close click doesn't start a drag. That carve-out is precisely what `window-drag: none` is for. The catch is that this property only does anything for an *installed* app moving a real OS window, and the XP windows here are divs moving inside a page, so it would replace none of that JavaScript. It is on the page because the naming collision is a trap worth writing down: the feature that sounds exactly like what this site does is solving a different problem.

## paintTime / presentationTime on paint, LCP + LoAF entries Chrome 145 · FF 140 · Safari no

Paint timing entries have reported one timestamp, and it has been ambiguous which of two very different moments it meant. `paintTime` is when the browser finished the rendering phase and began painting; `presentationTime` is when the pixels actually reached the screen. On a slow compositor or a variable-refresh-rate display those diverge by a frame or more. Exposing both, across paint timing, element timing, LCP, and Long Animation Frames, turns a number that needed a footnote into two numbers that don't.

```
press the button
```

On the site: this lands in the middle of a problem already written up in this repo. The Workers Traces work found that a span cannot measure CPU, because the runtime's clock advances across I/O and never during synchronous execution, so `home.grid.render` honestly reports 0 ms after doing real work. That is the server-side version of exactly this ambiguity, and `presentationTime` is the client-side fix for it: the homepage's LCP is a photo tile, and "when did the tile paint" and "when did the visitor see the tile" have been the same field. Two engines, so the RUM beacon could start reading it.

No `paintTime` on this browser's paint entries; the output shows what is there instead.

## Soft navigations \+ interaction-contentful-paint Origin trial Ch151 · Chrome only

Two new `PerformanceEntry` types. `soft-navigation` marks a JS-driven navigation that changed the URL and re-rendered without a document load, which every Core Web Vital currently cannot see: LCP is measured once, at the real navigation, so every route change after it is invisible. `interaction-contentful-paint` reports the largest paint caused by a specific interaction, which is the LCP idea rebuilt around an interaction instead of a page load.

On the site: mostly a card about why this site doesn't need it, and that is the interesting part. Every route here is a real document served by the worker, and the View Transitions are cross-document, so LCP already fires per navigation and soft navigations do not exist in this architecture. The exception is `/writing`, where the folder notes deliberately open as popovers that composite over the index *without* touching the address bar. That was the honest call, since one URL cannot name three open windows, and it means the cost of opening a note is unmeasured by anything. `interaction-contentful-paint` is the entry that would price it, and it prices interactions rather than URLs, which is the right shape for that decision.

## contentType in Resource Timing \+ Declarative PerformanceObserver Chrome 148 · FF 129 · Safari positive

`PerformanceResourceTiming.contentType` adds the server's content type to each resource entry, so a script can group its own loading by kind without re-deriving it from file extensions. Alongside it, the Declarative Performance Observer proposal moves collection into a response header, so metrics still arrive when the renderer is killed by the OS or the request fails, which is the population that RUM currently drops silently.

```
press the button
```

On the site: `contentType` is the smaller half and still the one with a use here. The serving story on this site is unusually type-dependent, since `/a/*` assets are q11 brotli, the document tiers ship dcz deltas against two different dictionaries, and the photo tiers are AVIF with a JPG fallback chosen by the browser before any script runs. Which encoding a visitor actually received is currently inferred. The declarative half is the more interesting idea and the further out: a response header is a shape this worker is already built around, and its whole pitch is capturing the sessions that die before a beacon fires, which is exactly the sample RUM is missing and cannot know it is missing.

No `contentType` on resource entries here; the grouping falls back to counting entries.

## The long tail: independent engines

"The platform" isn't only Chromium, Gecko, and WebKit. Two teams are building new engines largely from scratch, a useful reminder that the frontier above is the *front*, while most of the web runs well behind it. Both are pre-release and racing toward *baseline* rather than 2026 CSS, so on the features on this page they're mostly "not yet." Status as of mid-2026: check the live links, this moves fast.

### Ladybird pre-alpha

A from-scratch engine (LibWeb) with no Chromium/WebKit/Gecko code, built by a nonprofit. It's now on the WPT dashboard (~2.07M subtests passing) and racing to render the real web.

On these features: it has the **Popover API**, and added **initial CSS anchor positioning** (`position-anchor`) in April 2026. The newer/niche ones (text-box-trim, contrast-color, scroll-driven animations, corner-shape, masonry) aren't there yet. Baseline first, frontier later.

Live: [ladybird.org/news](https://ladybird.org/news/) · [wpt.fyi (ladybird)](https://wpt.fyi/results/?product=ladybird)

### Servo alpha ~Jul 2026

A Rust engine, originally Mozilla's, now under the Linux Foundation and aimed at embedding. WPT pass rate around 95% in its focus areas; a desktop browser is still years out.

It spends its energy on layout fundamentals (flexbox, grid, tables, floats), with recent adds like `cursor` color and `content: image()`. It generally hasn't implemented the frontier CSS here yet (popover, anchor positioning, text-box-trim).

Live: [servo.org/blog](https://servo.org/blog/) · [github.com/servo](https://github.com/servo/servo)

The point: these two are *why* "ship to baseline, prototype the frontier" is the right discipline. To support the independent, indie-web engines, I lean on what's broadly shipped and leave what's newest in one browser parked here. Good deep-dive comparison: [Browser Engines 2026](https://www.youngju.dev/blog/culture/2026-05-14-browser-engines-2026-chromium-gecko-webkit-servo-ladybird-comparison-deep-dive.en).

← back to the [garage](https://aadhar.sh/garage) · [aadhar.sh](https://aadhar.sh/)

© 2026 Aadharsh Pannirselvam · built in the open · triangulated from chromestatus.com + chrome://flags (Canary) + webkit.org/standards-positions + MDN browser-compat-data · last swept 2026-07-30

Source: https://aadhar.sh/garage/horizon
