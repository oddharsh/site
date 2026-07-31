---
title: "aadhar.sh/garage"
description: "Prototypes, experiments, and work-in-progress for aadhar.sh. Stuff that hasn't made it to the homepage yet, or won't."
path: "/garage"
section: "garage"
kind: "section"
updated: "2026-06-07"
source: "https://aadhar.sh/garage"
---

> Site index: https://aadhar.sh/llms.txt
> Section index: https://aadhar.sh/garage/llms.txt
> This is the Markdown twin of a page on aadhar.sh. The HTML at the source
> URL below is the original, and is hand-written and unminified on purpose.

# Garage

Development mules for [aadhar.sh](https://aadhar.sh/): deliberately rough rigs where I run a tool or an idea under real load before any of it touches the production car. Some graduate to the homepage, some get scrapped (and stay parked here as data points), some still sit on the dyno. Most run live, so poke around. And as of July 2026 every mule ends with an **understanding check**: a few questions before you close the hood, because a demo you poked is easy to mistake for a mechanism you understood. The idea is [Geoffrey Litt’s](https://www.geoffreylitt.com/2026/07/02/understanding-is-the-new-bottleneck).

Carmakers learn the good cars on mules first: McLaren developed the [F1](https://en.wikipedia.org/wiki/McLaren_F1) in two Ultima kit cars nicknamed *Albert* and *Edward*; the mid-engine Corvette hid its chassis under the bones of a Holden HSV ute (and came out better-looking than the real C8). A few more in the hall of fame below. Same spirit here, fewer cones.

![Gordon Murray Automotive T.50 development mule, an Ultima GTR nicknamed George](https://aadhar.sh/cars/t50-mule.jpg?v=1)

GMA developed the T.50, the F1's spiritual heir, in Ultima GTR mules, this one nicknamed *George*. (Murray ran the same play on the F1: *Albert* & *Edward*.) Photo [Calreyn88](https://commons.wikimedia.org/wiki/File:Ultima_GTR_T50_Test_Mule_George.jpg), [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/).

![Saab 99 test mule the Paddan, beside a regular Saab 96](https://aadhar.sh/cars/saab-paddan.jpg?v=1)

Saab's 99 mule, the *Paddan* ("toad"): Saab grafted the new car's body onto a 96 (right) so it could test on public roads without tipping the design. Photo [Jelger Groeneveld](https://commons.wikimedia.org/wiki/File:Saab_Paddan_and_regular_Saab_96.jpg), [CC BY 2.0](https://creativecommons.org/licenses/by/2.0/).

The mule hall of fame: nine that hid in plain sight

1. **HSV 'Corvette'**: the mid-engine C8's chassis wrapped in the bones of a Holden HSV ute. Accidentally better-looking than the real C8.
2. **McLaren F1, 'Albert' & 'Edward'**: two Ultima kit cars. Albert ran a Chevy V8 to mimic the BMW V12's torque, Edward bedded in the real V12. Both crushed afterward. Murray rebooted the trick for the T.50, an Ultima called *George*.
3. **Lotus Esprit '458'**: Lotus reportedly bolted its homegrown V8 into a salvaged Ferrari 458 and prowled Norfolk in it, until the company canned the project.
4. **Ferrari 348 'Enzo'**: a 348 stretched 250mm to swallow the Enzo's 6.5-litre V12. A proper Franken-rarri.
5. **Rolls-Royce Phantom 'high-rider'**: Rolls honed the Cullinan SUV inside a jacked-up, shortened Phantom, a rear wing loading the suspension to dial in spring and damper rates.
6. **MG Maestro Freelander**: Land Rover hid the Freelander under a tall MG Maestro van. One survives at the Dunsfold Collection.
7. **Porsche 918 Spyder**: a naked 918 powertrain mule wearing 991-era 911 panels; Porsche let journalists ride it at Nardo. (918 units, production from 9/18.)
8. **Jaguar XJ220 'van'**: Jaguar plumbed 542bhp into a Ford Transit's load bay. Nobody suspects a white van.
9. **Lamborghini Countach Evoluzione**: a carbon/Kevlar Countach that Lamborghini crashed once the autoclave got too dear. Its young engineer left to start his own marque: Horacio Pagani.

Lore via Top Gear, ["Nine weird secret test mules"](https://www.topgear.com/car-news/top-gears-top-9/nine-weird-secret-test-mules-youve-never-heard) (Ollie Kew). The two photos above are the only ones in the set that exist under a free license; the rest are best enjoyed at the source.

---

- [Pixel Peeper: whose eye do you have?](https://aadhar.sh/pixel-peeper)
  
  A vision test for image compression, in the ismy.blue spirit. Each call shows the same photo squeezed two or three ways; you pick the best on instinct, over and over, and it profiles what your eye is quietly tuned to. Every tile is a real encode (zenc, jpegli, mozjpeg, sips; honest 4:2:2 vs 4:2:0 on the 4:2:2-native Fuji files), scored offline by `ssimulacra2` and `butteraugli`. The twist: the two metrics are rival models of human vision that disagree, so the end reads which one your eye sides with. Closes with an understanding check.
  
  shape: blind A/B/C compression test + metric-alignment read · added 2026-07-21
- [Compression teardown](https://aadhar.sh/garage/compression)
  
  The edge was handing browsers *more* bytes than its own second choice, and compressing at about a third of the effort brotli can reach offline. Fixing it took four rounds, three of them spent blaming the platform for a one-line bug in my own code (`encodeBody` is write-only Response init, so rebuilding a response drops it silently). Ends at ~19% off the shell for every browser and 116 bytes for a returning Chromium visitor, via zstd shared-dictionary deltas. Keeps the wrong turns, since those transfer.
  
  shape: measured teardown + shipped fix · added 2026-07-27
- [5.6 Sol's performance pass](https://aadhar.sh/garage/gpt56)
  
  The performance pass outlined with 5.6 Sol this morning, translated into the work that actually made it onto the lift: first-paint geometry, immutable photo bytes, a shared Luna sheet, explicit Worker boundaries, and deploy-time proof. The local workbench toggles between the three checks; the trace readout is honest about what is local and what still needs field data.
  
  shape: performance field note + local workbench · added 2026-07-10
- [Blueprint: how Fable 5 would rebuild it](https://aadhar.sh/garage/blueprint)
  
  The [teardown](https://aadhar.sh/garage/teardown)'s sequel. Fable 5 read every file in the repo and drew the rebuild drawing: the boutique tricks worth keeping (the two-key SWR quartet, the Temporal wall-clock discipline, the earn-it `will-change`), the Pages-era scar tissue a Workers-native design would remove (denylist routing, SPA-fallback sniffs), and the consolidation sketch, before and after. Ends with the longer list: what a rewrite must never touch.
  
  shape: architecture review + rebuild sketch · added 2026-07-01
- [Bytes on the wire](https://aadhar.sh/garage/wire)
  
  The site's first build step, and the brotli rabbit hole that led there. Where Cloudflare actually compresses (edge quality vs q11, with the four roads to q11 that all closed), deploy-time minification with readable `/<name>.src.js` twins (nav.js went ~33KB to 20.4KB on the wire; sw.js turned out to be 64% comments), whether the CSS deserves the same treatment (measured: brotli voted no), an esbuild vs Oxc head-to-head, and the Cache API layer that finally made `s-maxage` true. With a live edge-cache prober.
  
  shape: measurements + the build's reasoning · added 2026-07-01
- [Post-quantum signatures, priced](https://aadhar.sh/garage/pqc)
  
  This site's TLS key agreement went post-quantum on its own; its signatures did not. What ML-DSA-44 and both SLH-DSA parameter sets actually cost on the one signature a personal site controls, measured on the real signature base: header bytes, signing time, and why hash-based lost twice (22,784 bytes of header one way, 2.5 seconds per signature the other). Ends with the migration shipped, since `Signature-Input` is a dictionary and a second label costs a verifier nothing to ignore.
  
  shape: measurements + a shipped migration · added 2026-07-27
- [Off Pages, onto Workers](https://aadhar.sh/garage/workers)
  
  Why this site left Cloudflare Pages for Workers with static assets: same bytes, but an *atomic* deploy and the whole config (bindings, routing, the Durable Object) as one checked-in `wrangler.jsonc` instead of dashboard clicks. What that opened up (edge-direct avif thumbnails, an in-house counter DO, cron in reach) with a live routing prober that reads production headers in your browser.
  
  shape: platform migration + live prober · added 2026-07-01
- [iroh, and why it stays across the room](https://aadhar.sh/garage/iroh)
  
  iroh hit 1.0 (dial a machine by its public key, not its IP). I went looking for a way to use it here. The page has a native in-browser NodeId generator you can run, no library and no wasm, plus the honest reason a megabyte-class wasm blob, a Rust build step, and a relay do not belong on a lean static site. The garage rule: an experiment that would make every other page heavier does not ship.
  
  shape: evaluation + native demo · added 2026-06-15
- [Teardown: what Fable 5 found](https://aadhar.sh/garage/teardown)
  
  A multi-agent audit, eight finders sweeping in parallel with one adversarial verifier per finding, went over the whole site. Two things were actually broken: a live cache-poisoning hole serving homepage HTML at thumbnail URLs, and a popover fallback that stacked the [/writing](https://aadhar.sh/writing) notes in any browser without the Popover API. The rest made it feel faster. Every finding, with the code before and after, side by side.
  
  shape: audit writeup · added 2026-06-11
- [A masonry contact sheet](https://aadhar.sh/garage/masonry)
  
  The homepage grid crops every photo to a 1:1 square. This page tries `display: grid-lanes` (CSS Grid Lanes, shipped in Safari 27) for a ragged-height contact sheet where portrait and landscape sit at their true heights, no JS. EXIF pins each photo's aspect ratio up front, so nothing reflows; a toggle A/Bs it against the squares, and browsers without Grid Lanes fall back to the squares.
  
  shape: layout prototype · added 2026-06-09
- [Safari 27, through this site's lens](https://aadhar.sh/garage/safari27)
  
  WWDC26's Safari 27 (macOS 27 Golden Gate) shipped ~58 web features. I pulled the "platform caught up" cut: `appearance: base-select` going stable, transform-aware anchor positioning, scroll anchoring, the `:heading` pseudo-class, and mapped each one to what this site already ships, with live per-browser support chips.
  
  shape: platform tracker · added 2026-06-09
- [Three free Cloudflare features, live](https://aadhar.sh/garage/cloudflare)
  
  Durable Objects (an atomic counter), Workers AI (it captions a real grid photo), and Workers Logs (structured observability): one *live* demo each, behind a tiny worker at `/garage/cf/*`. The free Workers plan quietly bundles them; all three work the moment you click. A fourth, Browser Rendering, is wired but parked on the free tier's 10-min/day cap.
  
  shape: platform-feature demos · added 2026-06-06
- [Thumbnail encoding study](https://aadhar.sh/garage/encoding)
  
  One photo run through every thumbnail choice (AVIF / WebP / JPEG, jpegli vs the system encoder, chroma subsampling, quality, resolution), with real byte counts. Why the pipeline builds `cjpegli` from source (~47% smaller JPEGs at the same quality), how zenjpeg's hybrid trellis candidate compares at matched size, why grayscale drops to 4:0:0, and what the grid actually ships.
  
  shape: encoder benchmark + the pipeline's reasoning · added 2026-06-06
- [pretext: text measurement off the DOM](https://aadhar.sh/garage/pretext)
  
  [chenglou/pretext](https://github.com/chenglou/pretext) measures multiline text with the canvas as ground truth instead of the DOM, so asking "how tall at 320px?" never forces a reflow. A from-scratch re-creation of the technique (drag-to-rewrap, plus a 2,000-re-layout race vs `offsetHeight`), where it'd help the site, and why it's "watching" not "shipped."
  
  shape: technique study + benchmark · added 2026-06-01
- [Content-addressed chunking](https://aadhar.sh/garage/chunks)
  
  The quiet engine under the photo grid, made visible: FastCDC content-defined chunking + content-addressing, live in the browser (pure JS + `crypto.subtle`). Snapshot a file, edit a byte, and watch fixed-size chunks re-send the whole thing while content-defined chunks barely flinch, plus a drop-a-file dedup demo. Concepts credit [mkit](https://github.com/officialunofficial/mkit).
  
  shape: interactive systems demo · added 2026-06-01
- [Scroll, the XP way](https://aadhar.sh/garage/scroll)
  
  Scroll-driven animation in a period-correct Luna idiom: the green file-copy progress bar that fills as you scroll, windows that maximize-open as they enter the viewport, and the blue gradient scrollbar. All `animation-timeline`, no scroll listeners, reduced-motion respected.
  
  shape: visual + interaction · added 2026-05-29
- [Horizon: upcoming web platform](https://aadhar.sh/garage/horizon)
  
  Test-driving features before they touch the homepage: `text-box-trim` for optical centering, `contrast-color()` for the OKLCH palette, and `interestfor` \+ anchor positioning as the someday-native tooltip. Live support chips per browser, honest cross-engine status, what each would replace. Nothing ships until it's in more than one engine.
  
  shape: capability dashboard · added 2026-05-29
- [Tooltip experiments](https://aadhar.sh/garage/tooltips)
  
  Cursor-following tooltips for the photo grid and tracklist. The XP-skinned camera readout shipped on photo hover and the album cover-at-cursor on track hover; CSS anchor-positioning shipped too, as the keyboard-focus path. Also here: the Fuji LCD variant it beat, a polaroid flip that didn't survive review, and a Luna balloon still in the wings. Built on `popover`, `@starting-style`, and a small rAF translate3d loop.
  
  shape: visual + interaction · added 2026-05-22

More to come. Mules that graduate get the  tag; the ones that don't stay parked here tagged . Scrapping a rig still leaves a data point; I never delete one. This is a motor pool, so the failures stay parked next to the wins.

← back to [aadhar.sh](https://aadhar.sh/)

© 2026 Aadharsh Pannirselvam · built in the open

Source: https://aadhar.sh/garage
