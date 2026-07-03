<!-- design/GREENFIELD.md — the blank-slate blueprint. Produced 2026-07-02 by a
Fable 5 ultracode pass: 4 independent architectures (css-max, wire-max,
declarative-max, period-purist), 4 judge lenses, one synthesis, then a 14-claim
adversarial verification against live sources; the 5 corrections it caught are
folded in below. This is the greenfield answer to "what would the resto-mod look
like designed today"; the existing site converges on it incrementally.
Owner amendment 2026-07-02: the photo camera-back tooltip KEEPS its
cursor-following behavior on thumbnails (grid + archive); the synthesis's
anchor-at-the-control verdict stands everywhere else. The tooltip DATA pipeline
still moves to SSR bake, so the surviving JS is position-only (~1KB). -->

# aadhar.sh, rebuilt from zero: the 2026 resto-mod blueprint

Synthesized 2026-07-02 from 4 competing designs and 4 judge lenses. The spine is css-max (highest aggregate score across all 4 lenses, and the fewest abstractions between the author and the pixels). Grafted onto it: every judge-endorsed idea that survived the fatal-flaw lists. Conflicts are named and resolved inline. Where a prior existed I re-measured it this session: index.html is 87,398 raw / 25,099 br q11, nav.js is 108,907 raw / 28,155 br q11, exactly as the wire audit claimed.

## Thesis

2026 HTML and CSS contain the XP interaction grammar natively. Windows, menus, tooltips, disclosure, modality: popover, dialog, invoker commands, anchor positioning, `details name=`, and `:has()` are the window manager now. So the shell ships as ~2KB of static markup per page plus one immutable 9KB-brotli stylesheet, and script survives only where the platform still has no primitive: pointer drag, z-order, a ticking clock, palette filtering, and the owner-kept camera-back cursor-follow. That lands at ~3.3KB br of shell JS against the 28.2KB br nav.js costs today, an 88% cut, and every page works with scripting disabled.

Four doctrines govern everything below.

**OEM++ (owner amendment, 2026-07-02): the taste test is "would Redmond have shipped it in Luna if the platform had it," never "did 2006 have it."** This is a resto-mod, and the deviations from strict period behavior on the owner's current site are by design: tasteful upgrades the original manufacturer would have adopted. Period purity is a floor for FALLBACKS, never a ceiling for enhancements. A refusal below is only valid on engineering grounds (engine count, bytes, maintenance, rights), or because it fails the OEM++ taste test (reads as a different era's design language, like soft shadows or springy easing). "XP didn't do it" alone vetoes nothing.

**Fallbacks land ON period behavior, never below it** (period-purist's rule, endorsed by 3 of 4 judges). A missing cross-doc View Transition yields an instant white swap, which is what IE6 did. A missing `base-select` yields a native select, which is what 2006 shipped. An engine gap drops the visitor onto period truth, so the wide frontier surface costs almost nothing to maintain.

**Quote wire numbers at the compression the page can actually get** (the audit key that caught 3 of 4 designs). Static documents precompress offline at brotli q11. The one per-request document, the homepage, gets edge fly-compression at ~gzip quality, a measured ~19% tax, and its budget below says so honestly.

**One maintainer, ten years: every subsystem must earn its state.** The service worker doesn't (deleted). The screenshot-diff CI doesn't (deleted). A deploy-time grep does (kept).

## Page anatomy + byte budgets

Rule: inline what first paint needs, share what 2+ pages use, defer everything else.

**4 shared assets**, versioned `?v=N`, served `max-age=31536000, immutable`, fetched once:

| asset | raw | wire (br q11) | role |
|---|---|---|---|
| luna.css | 36KB | 9KB | the OS: tokens, chrome, components, a11y, print. Ships readable and commented; the stylesheet is itself an artifact |
| shell.js | 12KB | 3.3KB | the irreducible behaviors (full ledger below); deploy-minified with a readable `/shell.src.js` twin |
| icons.svg | 10KB | 3KB | every desktop, taskbar, and menu icon, currentColor-tinted |
| bliss.avif | 24KB (12KB mobile via `image-set()`) | as-is | wallpaper over a solid #3A6EA5 paint-behind, so the desktop is never white |

First-visit shared total ~38KB. Every visit after: 0 bytes, HTTP cache.

**Inline per page:** a ~2KB critical-chrome CSS subset (title bar, bevels, window layout, so a cold first paint never shows unchromed windows), page-specific style capped at 2KB, JSON-LD on the homepage (1.2KB), speculation-rules JSON (0.4KB), and ≤0.8KB of stand-down JS. Every document carries the full desktop as ~2KB of static markup (wallpaper div, icons, taskbar, Start), so curl, readers, and JS-off visitors get the desktop and CLS is 0.

**Page classes:**

| class | HTML raw | HTML wire | compression | cache posture |
|---|---|---|---|---|
| homepage (hand-written, commented) | ~40KB | ~14KB | edge fly, gzip-class (per-request body) | `private, no-cache` (bfcache-safe) |
| essay/garage (~24 pages) | 12-30KB | 5-10KB | br q11 offline | static, immutable, purge-on-deploy |
| photo archive (146 slots + inline EXIF + histograms) | ~150KB | ~24KB | br q11 | static; the one sanctioned outlier |
| writing/Notepad (baked from .txt at deploy) | 8-15KB | 3-6KB | br q11 | static |
| /reading, /around (cron snapshots) | 10-20KB | 4-7KB | br q11 per generation | `s-maxage=1800` + SWR |
| /whoareyou (echoes the live request) | per-request | ~4KB | fly | never speculated, never cached |

**Conflict, resolved (the big one).** wire-max moves the 12-photo shuffle client-side and gets a cacheable homepage at ~1.1KB per return; 2 judges fatal-flagged the mechanism (the preload scanner never sees script-written images, so LCP hangs on an inline script, and JS-off gets a stale grid). The graft dies; the grid stays SSR per request. The surviving half of the idea is the counter move (below): the count leaves the document, every homepage GET becomes pure, and the homepage joins the prerender set for the first time. Per-visit spend drops from the measured ~31KB to ~14KB because the chrome moved into luna.css. That 14KB is the deliberate, priced cost of keeping the soul server-side.

**Ceilings, CI-enforced at deploy:** font bytes 0, third-party bytes 0, cookie bytes 0, render-blocking JS 0, HTML ≤20KB wire (archive excepted at 24), JS executed before first interaction ≤3KB br, requests to first render ≤5 warm / ≤8 cold.

## The window shell: the zero-JS ledger

Windows are normal-flow `<section class="window">` on a CSS-grid desktop; they stack single-column below 720px. Chrome is global classes in light DOM. Declarative shadow DOM was rejected 3 times over: template soup in View Source, find-in-page safety held together only by a "keep content slotted" rule nobody enforces in year 4, and brotli already makes repeated chrome markup near-free.

**Carried by CSS/HTML alone, 15 verbs:**

1. **Chrome.** Bevel quartet, gel caption buttons, title gradient, alternating rows: classes.
2. **Minimize/restore.** A visually-hidden checkbox per window, accessibly labelled "Minimize Photos". The `_` glyph in the title-bar controls is its `<label>`; the taskbar button is a second `<label>` for the same checkbox, pressed/raised via `body:has(#w-photos:checked)`. Full round trip, script off. **Conflict, resolved:** css-max made the whole title bar a `<details>` summary and 2 judges failed it (a single click on a title bar collapsing a window breaks a thousand hours of muscle memory, and every window announces to AT as a disclosure). The checkbox wins: title bars drag and raise, the `_` glyph owns the toggle, and shell.js later upgrades the control to a real toggle button with `aria-pressed` (period-purist's declared retreat) while the checkbox stays as the zero-JS floor.
3. **Maximize.** On the desktop composite, `□` is an `<a>` to that section's own page; maximize IS a navigation, morphed by a cross-doc View Transition. On a section page, `□` is a checkbox toggling fixed inset.
4. **Close.** An `<a>` to the parent route. Closing a window in 2006 meant leaving.
5. **Resize.** CSS `resize: both` on the content area with the dotted XP grip, min/max clamps, disabled below 720px. The current site does this in script.
6. **Start menu.** `popover=auto` opened by `popovertarget`, anchor-positioned above the orb; submenu flyouts on `:hover`/`:focus-within`. Esc and outside-click dismissal are native.
7. **Run.** A `<dialog>` opened by `command=show-modal commandfor`. Native focus trap, Esc, inert backdrop. The declarative ladder underneath: Start > Run is also a plain link to `/run`, a real page with `<input list>` + `<datalist>` of every destination and a GET form a 20-line edge function answers with a 302. The palette works with JS off, invokers missing, or dialog absent. 3 designs converged on this independently; the current Run box is script-only.
8. **Notepad.** Menus are popover + invokers; word-wrap is a checkbox + `:has()`; the textarea autosizes via `field-sizing: content`; ephemerality is native (no save handler exists, reload restores canonical).
9. **Tooltips** (EXIF camera back, tracks, artists). Content is SSR'd into the page, revealed on `:hover`/`:focus-visible` behind `@media (hover: hover)` (which retires the synthetic-touch-hover bug as a media query), anchor-positioned with `position-try` flips, 500ms `transition-delay` (XP's real hover delay), 120ms fade via `@starting-style`. **Conflict, resolved by the owner:** wire-max and period-purist kept the cursor-following camera back; css-max anchors at the control. Track, artist, and generic tips anchor (XP ToolTips popped at the control). The photo camera-back KEEPS cursor-follow on thumbnails, by owner decree: gliding the camera back across a contact sheet is part of this site's identity, worth its ~1KB position loop. The loop keeps the earn-it `will-change` lifecycle and the scroll-settle retarget; its data cost is zero because the content is already in the page.
10. **Taskbar.** Static HTML per page; cross-page buttons are anchors, same-page buttons are the minimize labels; the current page gets `aria-current` pressed styling.
11. **Accordions.** `details name=` for changelog years and writing folders.
12. **IE6 address bar.** A sunken strip of real path-segment anchors on section windows.
13. **XP scrollbars.** `::-webkit-scrollbar` bevels in Chromium and WebKit; `scrollbar-color`/`width` in Firefox as the truthful thin rendering.
14. **Active-window tinting** via `:focus-within` on the title bar.
15. **High contrast.** `forced-colors: active` flattens bevels to ButtonFace/ButtonText, the one dark mode XP genuinely had.

**JS that remains** is itemized in the budget ledger: drag, z-order, the clock, palette filtering, and the AT upgrade. 15 of 21 shell verbs run with zero JS. Controls whose behavior genuinely needs script (drag affordances, the rect-morph niceties) render inert-styled until shell.js lands, batched so nothing pops in piecemeal (declarative-max's honesty gate, applied narrowly).

## Navigation choreography

Strict MPA. Every internal link is an `<a>`. Router bytes: 0.

**Cold first visit** (4G, ~100ms RTT, empty cache):

| t | event |
|---|---|
| 0 | click |
| ~180ms | h3 connect (1-RTT QUIC + TLS) |
| ~220ms | 103 Early Hints arrive: luna.css, icons.svg, shell.js, bliss.avif start fetching |
| ~260ms | TTFB (edge SSR reads pre-warmed KV only; 40ms think budget, never an in-request origin fetch) |
| ~330ms | HTML fully arrived (~14KB); the preload scanner has already seen slot 1's `<img>` because it is real markup, and dispatched it `fetchpriority=high` |
| ~400ms | luna.css (9KB br) arrives; the inline critical-chrome subset painted the frame already, so bevels never pop in late |
| ~450-550ms | FCP: identity-card text, local Tahoma, 0 font wait |
| ~550ms | shell.js (2.5KB br, defer) executes in ~5ms; drag, clock, palette alive |
| ~700-900ms | LCP: grid slot 1 (22KB AVIF, eager) decoded and painted |

Targets: FCP ≤0.6s, LCP ≤1.0s p75 cold 4G, CLS 0, TBT ~0.

**Warm forward hop:**
- Chromium (~65% of traffic): speculation rules prerender at moderate eagerness on hover/pointerdown. Activation ≤100ms perceived, 0 bytes at click. The homepage is in the prerender set for the first time, because its GETs are now pure.
- Safari / Firefox: an edge-cached 5-10KB br document over the hot connection, every subresource in HTTP cache. 100-250ms p75. That gate respects physics; a judge caught period-purist's ≤100ms CI law contradicting its own RTT math, so the honest number ships instead.
- Back/forward: bfcache, ~0ms, 0 bytes, all engines. `no-store` is banned sitewide; dynamic documents ship `private, no-cache`; internal window scrollers re-seed from sessionStorage on `pageshow`.

**View Transition scope, re-adjudicated under OEM++.** css-max and wire-max animate every hop; period-purist restricted VT to window verbs and 3 judges endorsed it. The owner's doctrine dissolves the conflict: in the desktop metaphor every navigation IS a window verb (leaving a page closes its window, arriving opens one), which is exactly what the owner's current site already does by design. So the window rect-morph plays on navigations generally, styled as XP's minimize/restore zoom (linear, ~140-180ms, never a crossfade), with document CONTENT still cutting instantly inside the morphing frame. ≤2 `view-transition-name`s per page, disabled under `prefers-reduced-motion`. Firefox, still building cross-doc VT, gets instant swaps, the period floor.

**Speculation safety is law, and the law is GET purity:** no GET on this site mutates, ever. The counter ticks on an activation-gated path, /around is a static cron snapshot, so the deny-list shrinks to /whoareyou (echoes the live request) and /lens* (fires third-party crawls). Every new route passes a side-effect checklist before entering speculation, and a deploy grep fails on inline fetch calls that lack a `document.prerendering` gate.

## CSS architecture

One shared luna.css, readable and commented, plus the inline critical subset per page. Layer spine: `@layer reset, tokens, chrome, components, page, a11y, print`. Page styles can never outrank window chrome; forced-colors and print win last.

**Tokens: the design-system contract (aligned 2026-07-02 against design/tokens/, the canonical set, byte-identical with the aadhar-sh-design skill package).** The full canonical set moves into the sheet: 115 custom properties across colors.css, bevels.css, typography.css, folded UNMODIFIED under the `tokens` layer; luna.css derives, it never redefines. **Conflict, resolved:** the owner's no-color-tokens rule priced token definitions against uncacheable inline bytes; a cached-forever stylesheet flips the economics, so the tokens go in. **Corrected against canon:** theming is KNOB-based, never `--face`-rooted. The canonical parameterization is `--hue-luna` / `--hue-chrome` / `--chroma-luna` / `--chroma-chrome` plus the semantic hue knobs, with every ramp derived via calc-in-oklch (`--face` is a derived beige, not the root; the tokens file names the knobs "the toneshift later surface"). Olive and Silver ship as knob-override blocks behind a Display Properties popover. Relative color syntax is reserved for STATE derivations (hover/pressed tints, as the live photo-frame hover already does), each with a literal fallback line above it. Radii come from the canonical `--radius-*` tokens (control 0, title 3px, gel 3px, window-top 8px); the deploy grep asserts no literal radius outside them. Fonts: the `--font-*` stacks ship in luna.css; the `src: local()` @font-face blocks in tokens/fonts.css stay reference-only per house rule (never inlined into a served page), 0 font bytes forever. `font-size-adjust: 0.52` for Linux fallbacks is NEW and gets added to typography.css first so canon leads the sheet. `@property` registers the 2-3 animatable properties. The P3 story is already canonical: tokens/colors.css's `@media (color-gamut: p3)` block lifts `--chroma-luna` 0.225 to 0.30 plus the accent bumps; luna.css inherits it rather than reinventing it.

**Components** are semantic classes, structure by convention (`.window > .titlebar + .content`). `@scope` wraps decorative and demo containment only; chrome stays global, so the 2-engine cascade feature can only ever drop decoration.

**Dark mode, conflict resolved.** css-max's "night desk" dims a desktop Luna never dimmed, and a judge flagged it. The verdict: none. `color-scheme: light` is forced (meta + CSS) so Android force-dark can't mangle bevels; `light-dark()` goes unused; `forced-colors: active` is the honest dark path. **Print:** strip wallpaper, taskbar, and chrome; flatten windows into document flow; Notepad prints 12pt Courier black on white; essay links print their hrefs via `::after`.

**Aesthetic enforcement is structural and cheap on purpose.** Deploy greps fail the build on `cubic-bezier`, any easing beyond linear/steps(), `scroll-behavior: smooth`, border-radius above 3px, blur-radius shadows, `@font-face` with `url()`, and curly quotes. **Conflict, resolved:** period-purist's delta-E screenshot goldens are a flaky second product (a judge's fatal flag), so they die; the greps keep the guarantee that matters at zero flake.

## JS budget ledger

Hard caps: 0 render-blocking script anywhere; ≤3KB br executed before first interaction on any page; anything more is earned per page class.

**shell.js, 12KB raw / ~3.3KB br, defer, itemized:**

| behavior | raw | why the platform can't |
|---|---|---|
| window/icon drag + Alt+Space Move mode (arrows move the focused window) | 2.2KB | no pointer-capture primitive; Move mode is period-correct AND the keyboard answer to drag (judge-endorsed twice) |
| z-order raise on pointerdown | 0.3KB | `:focus-within` misses clicks on non-focusable content, a judge-caught mechanism bug |
| icon position persistence (localStorage) | 0.8KB | no declarative storage |
| Run filter + Cmd/Ctrl+K + Highlight API paint | 1.5KB | no declarative keyboard invoker |
| Run hover-preview card (anchor-name swap + img.src per selection) | 1.1KB | rows don't exist until typed + selection is keyboard-driven, so pure :hover can't serve it; positioning/flip/reveal are CSS |
| taskbar clock (Temporal, 0.4KB Date branch) | 0.7KB | ships blank; a wrong clock never renders |
| minimize AT upgrade (checkbox to toggle button, `aria-pressed`) | 0.6KB | screen-reader ergonomics layered over the zero-JS floor |
| minimize/maximize rect-morph (same-doc View Transition) | 0.4KB | animation only; state is CSS |
| menubar roving tabindex (APG) | 0.8KB | `role=menu` is claimed only because the behavior exists |
| tooltip top-layer hoist at scroller edges | 0.5KB | CSS-anchored tips clip at internal scroller edges |
| photo camera-back cursor-follow (thumbnails only) | 1.0KB | owner-kept behavior; position-only (pointermove writes CSS vars), content is SSR'd |
| pageshow resync (scrollers, clock, checkbox normalize) | 0.6KB | bfcache repairs |
| System Properties tray popout (fetches /whoareyou.json on open) | 0.4KB | owner-kept (2026-07-02); lazy fetch, nothing on page load |
| Windows Update tray balloon (fetches /updates.json) | 0.4KB | owner-kept (2026-07-02); the changelog surfaces in the tray, as XP did |
| tray sound pack (Web-Audio synthesis, default-muted, localStorage persistence) | 1.2KB | owner-kept (2026-07-02); 0 asset bytes, no recordings; in-page shell actions only (nav sounds die at unload anyway) |
| shared utils | 0.6KB | |

Per page on top: homepage ≤0.8KB inline (stand-down fetchers that detect "already populated" and quit, plus the prerender-gated count beacon); notepad.js 1.2KB raw on /writing only (Ln/Col via selectionchange, F5 stamp, print); essay demos ≤8KB br each, loaded on viewport entry or an explicit invoker, long loops chunked through `scheduler.yield` with a 3-line setTimeout(0) shim, heavy compute in a Worker. `will-change` applies only inside the drag/hover lifecycle. No framework, no hydration, no polyfills beyond the yield shim and the Temporal Date branch (scheduled for deletion when Safari stable ships).

Against today: nav.js at 108,907 raw / 28,155 br q11 builds the desktop, runs the mousemove tooltip engine, wires menus, and manages window state. The ledger deletes shell DOM construction (markup ships), the tooltip DATA engine (SSR-baked EXIF + histograms; the camera-back keeps a ~1KB position-only follow loop), menu and Esc wiring (popover/dialog/invokers), minimize state (checkbox), and resize (CSS). 28KB br becomes 3.3KB br.

## Image + photo strategy

Tiers stay as measured: 600px AVIF ~22KB and 400px AVIF ~12KB in one `<source srcset ... sizes>`, JPG ~38KB as the universal `<img src>` because type negotiation never catches decode failures (the scar stays honored). Width/height attributes everywhere; CLS 0.

**Addressing, conflict resolved.** Content-hashed immutable filenames (`/i/<stem>.<hash8>.avif`, 1-year immutable) replace `?v=THUMB_VERSION` for images: a global bump today re-downloads ~2.3MB per returning visitor, and the 4h edge-404-poison class dies structurally because a URL is born with its bytes. A judge's hand-authoring objection lands on the shell assets instead, so the 4 hand-referenced files keep `?v=N` (one constant the existing bump script already rewrites); image URLs are pipeline-written, so hashes cost the author nothing. Old `?v=` URLs 301 for a year.

**Homepage grid:** 12 SSR slots. Slot 1 eager + `fetchpriority=high` (the designed LCP), slots 2-3 eager, 4-12 lazy + `decoding=async`. The wallpaper is hinted but must lose the LCP race to slot 1; watched via LCP element attribution in the field.

**Archive:** a uniform square contact sheet, `repeat(auto-fill, minmax(160px, 1fr))` over pre-cropped squares, matching Explorer's Thumbnails view today. Grid Lanes masonry is parked on the 2-engine rule alone (Safari 26.4 stable; Chrome + Firefox at flag) and adopts the day a second engine unflags: per the OEM++ doctrine, the ragged aspect-ratio sheet is what Explorer would have shipped with a better layout engine, and the site's /garage/masonry mule already proves the layout. First 12 eager, 134 lazy, `content-visibility: auto` with exact `contain-intrinsic-size` on below-fold row groups (earned on a long page, skipped on short ones per the measured prior). Full scroll ~2MB, paid strictly as scrolled. Each tile links to `/photos/<stem>`; full-res originals live in immutable HTTP cache and nowhere else.

**EXIF + histogram, conflict resolved (the one graft all 4 judges endorsed), pipeline pinned to the owner's upload-time doctrine (2026-07-02).** "Bake time" means PHOTO-ADD time, never deploy time: the thumbnails stay metadata-stripped, and all derived data is computed once per photo in add-photos.sh / extract-photo-metadata.sh on the owner's machine, where compute is cheap and already lives (build.mjs stays a 4-file minifier; deploys pay nothing). The parked photo-histograms.py comes back for exactly this: it already computes 64-bin RGB + LUMINANCE, per-channel normalized, which is RICHER than the client-side compromise that replaced it (the browser only ever binned luminance). Its bins land in the per-photo meta/<stem>.json alongside the full nullable EXIF field set, with the compact SVG path precomputed at the same step. Honesty holds by pointing the script at the SHIPPED thumbnail bytes (the encoded JPG twin), the same measure-what-you-see property the client compute had. Render side: the EXIF `<dl>` (~300B, lines skipped rather than fabricated) and the luminance `<svg><path>` (~250B) are server-rendered inside each tooltip; the RGB channels ride the JSON for a future richer LCD view at zero re-encode cost. 12 tooltips cost ~2-3KB compressed on the homepage; all 146 ride the static archive. meta/<stem>.json STAYS a served surface (the machine-readable paperwork; agents keep the raw data even though hover no longer fetches it). The client decode + getImageData + main-thread binning pipeline is deleted. Hover latency is 0, and tooltips work offline and JS-off. Nothing is lost anywhere in the chain: the R2 SOOC originals keep their complete EXIF forever, the meta JSON keeps every extracted field plus gains the histogram bins, and the tooltip stays a curated VIEW of that record, never its replacement.

**JXL:** refused at 1 stable engine. Masters live in R2; the tier is one re-encode script the day a second engine unflags.

**The Run palette supersedes the directory listings (owner decision 2026-07-02, delete-with-mitigations).** The two Apache-styled listings (/images/, /images/full/) are deleted; Run + the /photos archive are the browse surfaces. The adversarial audit found four gaps a bare delete would open, each mitigated:
1. No URL showed all 146 originals at once: the /photos archive IS that surface now; /images/ and /images/full/ 301 there (never 404: inbound links and curl users keep a truthful landing).
2. manifest.json + alt.json were referenced by NOTHING (verified: absent from sitemap, llms.txt, robots.txt): both get linked from sitemap.xml and llms.txt, plus a one-line pointer in index.md, so machines and curl users keep a first-class index (strictly richer than the listing was).
3. No-JS discovery: /photos is static markup with real `<a href>` per photo, so dumb crawlers keep an anchor-walkable index.
4. The voice: the mod_autoindex pastiche dies by decree, and the honesty-rule artifact `<address>handwritten worker at aadhar.sh</address>` relocates to the /photos footer + an `"_address"` field in manifest.json. Run's empty state gains a "browse all photos" affordance pointing at /photos.

**The Run hover-preview (the upgrade that earns the deletion).** One reused card node per dialog, anchored to the SELECTED row (mouse hot-track and arrow keys both funnel through one setSel path, so keyboard users get the identical preview and the card can never show anything Enter would not open, which is the honesty property). CSS Anchor Positioning is the mechanism (anchor-name swapped onto the selected row, position-area: inline-end, position-try flips at viewport edges): Baseline across all three engines (Ch125/FF132/Saf18.2+, flips 18.4+), so it clears the 2-engine rule as load-bearing. Nothing fetches until a previewable row is selected; the card loads the 400px AVIF tier (~12KB, shared ?v cache generation), width/height reserved so it never shifts layout, opacity fade only after decode (none under reduced-motion). Scope is gated in markup: only rows carrying data-thumb (photos, plus semantic search hits that resolve to an image) ever show a card; pages/profiles/notes never do. Touch never mounts it (hover:none + pointer:coarse, the site's own gotcha #10). ~1.1KB of JS: one anchor-name write + one img.src write per selection change; positioning, flipping, and reveal are pure CSS.

## Data freshness

4 lanes, each with an honest staleness bound. The origin thinks per generation, never per visitor, except the homepage's grid pick.

| lane | cadence | mechanism | visible honesty |
|---|---|---|---|
| now-playing | hourly | signed AadharshBot cron scrape (RFC 9421, JWKS at .well-known) into KV; homepage SSR injects per request; `/api/now.json` twin at `s-maxage=300` + SWR | "as of HH:MM" in the status bar |
| reading | daily | cron bake to a static page, `s-maxage=3600`, SWR 86400 | crawl timestamp printed |
| around | 30-60min | signed cron crawl writes a snapshot; the page is a static render, prerender-safe, visits trigger nothing | crawl timestamp printed |
| essays / writing / changelog | per deploy | baked; changelog and System Restore read the one deploy-log table, so they can't drift | build number in the footer |

**The counter, conflict resolved.** declarative-max's `<img src="/hit.svg">` wins (endorsed by 3 judges), fused with the activation gating everyone converged on. The edge increments KV and returns ~300B of Tahoma-digit SVG, `no-store` on the image alone (the document stays bfcache-safe). HEAD never ticks. Verified bots (UA + signature) never tick. Requests carrying `Sec-Purpose: prefetch|prerender` get the count without the tick, and a 1-line `prerenderingchange` beacon ticks on activation, so Chromium prerenders count exactly once. JS-off visitors never prerender, so their image fetch ticks normally. bfcache restores tick zero. Counters in 2006 literally were images; the most period-correct rendering is also the one that makes the homepage prerender-safe and HEAD-immune by construction.

**Failure honesty:** an empty KV renders a greyed, period-correct "Now Playing is unavailable" panel with `cursor: progress` during the fallback fetch. No skeletons, no shimmer, no fabricated rows. Invariant on every dynamic surface: SSR primary + JSON twin + a stand-down client that fetches only when its island arrived empty (`data-ssr` stamp).

## Frontier scorecard

| feature | where | status (2026-07) | fallback |
|---|---|---|---|
| cross-doc View Transitions | window rect-morphs on navigations generally (navigation IS a window verb, per the OEM++ re-adjudication); XP zoom styling, never crossfades | Ch126+ / Saf18.2+; FF building | instant swap, the literal IE6 behavior |
| same-doc View Transitions | minimize/restore rect-morph toward the taskbar | Ch + Saf | snap, matching XP with animations off in Performance Options |
| anchor positioning + position-try | tooltips, Start flyouts, menu dropdowns | Ch + Saf + FF shipped | absolute below-right placement; flips lost, clipping accepted |
| popover=auto light dismiss | Start menu, menubar menus, tooltip hoist | Baseline 2025 (iOS light dismiss fixed in Safari 18.x) | none needed; declarative, works JS-off |
| invoker commands (command/commandfor) | Run dialog show-modal, menu popovers | Ch135+ / Saf26.2 / FF144 | popovertarget covers popovers; Start > Run degrades to the /run link |
| `<dialog>` | Run palette: focus trap, Esc, inert backdrop | universal | /run page: input + datalist + GET form, edge 302 |
| `details name=` | changelog years, writing folders | universal (name= Ch120+/Saf17.2+/FF130+) | independent details, all openable |
| `:has()` | minimize state mirror, wrap toggle, validity tinting | universal | load-bearing, allowed at 3 engines |
| `@layer` | cascade spine of luna.css | universal | n/a |
| `@scope` | decorative and demo containment only | Ch118+ / Saf17.4+ | decoration drops; chrome unaffected by design |
| OKLCH + relative color syntax | palette; bevel ramp, gel stops, tints from one `--face` | universal | literal fallback line precedes each derived value |
| `@property` | the 2-3 animated typed tokens | universal | untyped renders the static state |
| `@media (color-gamut: p3)` | gel + selection chroma lift | universal query | sRGB Luna |
| `field-sizing: content` | Notepad textarea, Run input | Ch123+ / Saf / FF152 | rows attribute + internal scroll; Notepad scrolled in 2003 |
| `text-box-trim` | optical centering of captions, buttons, status bar | Ch133+ / Saf18.2+; FF Nightly only, unshipped stable | 1px padding nudge, invisible |
| speculation rules prefetch/prerender | all static pages + the homepage (GETs now pure); deny /whoareyou, /lens* | Chromium stable; Saf26.2 off by default | bfcache + edge cache: 100-250ms warm hops |
| bfcache discipline | sitewide; no-store banned, `private, no-cache` on dynamic docs | universal (`no-store` still blocks bfcache in FF/Safari; Chrome ~150 restores it only conditionally) | it is the fallback |
| 103 Early Hints | luna.css, icons.svg, shell.js, wallpaper | server-side; Chromium + Firefox 123+ honor; Safari honors only preconnect | `<head>` preloads cover Safari |
| Temporal | clock, EXIF wall-clock (PlainDateTime) vs upload instants | Ch144+ / FF139; Saf TP | 0.4KB Date branch, deletion scheduled |
| `scheduler.yield` | demo long-task chunking | Chromium; FF positive | setTimeout(0) chunks |
| `content-visibility: auto` | /photos below-fold row groups, exact intrinsic sizes | universal | skipped on short pages (measured prior) |
| Custom Highlight API | Run palette match painting | cross-engine per audit | unpainted matches; filtering unaffected |
| `::-webkit-scrollbar` + scrollbar-color | XP scrollbars on window scrollers | Ch+Saf full bevels; FF color/width | FF thin tinted bar: a truthful downgrade |
| `forced-colors` | High Contrast, the one real XP dark mode | Chromium + FF on Windows; inert elsewhere | standard Luna |
| Web Bot Auth / RFC 9421 | outbound crawler signing, JWKS at .well-known | server-side IETF | honest UA + /bot page floor |
| CloseWatcher | deliberately idle: dialog and popover own Esc natively | Ch120+ / Saf26 | n/a; Esc belongs to the platform |

## Refusals

- **Service worker.** EXECUTED v136 (2026-07-03). Immutable assets + bfcache + prerender already deliver instant repeats; deleting the CACHE_VERSION ritual and a second poisonable cache is the one optimization that compounds yearly. (Named conflict: 3 designs kept it, the simplicity judge's best idea kills it, and with content-hashed images its remaining job was insurance.)
- **SPA router / framework / hydration.** MPA + bfcache + prerender beats a userland router at 0KB.
- **Declarative shadow DOM for chrome.** Template soup in View Source; find-in-page safety by vigilance alone; brotli already dedupes repeated markup.
- **Grid Lanes masonry, parked NOT refused (OEM++ re-adjudication).** The period argument ("Explorer thumbnails were uniform") is void: uniform grids were a GDI+ layout limitation, and an aspect-ratio-preserving contact sheet is exactly what Explorer would have shipped with a better engine. Grid Lanes passes the taste test; only the 2-engine rule holds it (Safari 26.4 stable, Chrome + Firefox at flag). Adopt the day a second engine unflags; the fallback stays the uniform sheet.
- **JPEG XL tier.** 1 stable engine; a third encode pipeline for ~15% on Safari alone; encoder staged for the flip.
- **Dark mode / `light-dark()`.** Luna is a light OS; forced-colors High Contrast is the honest dark path.
- **corner-shape / superellipse.** The look caps radii at 3px; a superellipse reads 2025 in 1 frame.
- **Cursor-following tooltips, everywhere except photo thumbnails.** XP tips popped at the control, so track/artist/generic tips anchor. The photo camera-back keeps its cursor-follow by owner decree (2026-07-02): a signature behavior, priced at ~1KB of position-only script.
- **Scroll-driven animations, case-by-case (OEM++ re-adjudication).** No blanket period veto; the test is whether a given use reads as Luna (a file-copy progress bar tied to reading progress passes; parallax reveals read 2015 and fail). Admitted per use where 2 engines ship it, on taste review.
- **`appearance: base-select`.** No genuine select exists in the design; adding one to use the feature is resume-driven development.
- **`hidden=until-found`.** Redundant: the collapsed regions are `details`, which find-in-page already auto-expands where supported.
- **Compression dictionaries.** The shell is 2.5KB br; the retention + canary ops cost more than any delta saves.
- **Document Picture-in-Picture.** Chromium-only, and a torn-out window abandons the desktop the site exists to keep.
- **`<model>`, WebNN, built-in AI, WebMCP.** Single-engine or origin trial; the agent surface stays deterministic (llms.txt + signed JSON).
- **`if()`, `@function`, `sibling-index()`, `reading-flow`, `scroll-state()`.** Single-engine CSS whose fallback must ship anyway, so each adds net bytes.
- **`Element.moveBefore`.** No stateful embed ever reparents here.
- **WebTransport.** The fastest data on this site moves hourly; HTTP caching wins.
- **Web fonts of any kind.** Owner law and period truth agree at 0 bytes.
- **Skeletons, spinners, shimmer.** XP showed `cursor: progress` and then finished; placeholder theater is fabricated UI.
- ~~The opt-in XP sound pack~~ **KEPT (owner ruling, 2026-07-02).** The refusal priced "commissioned sound-alikes, 36KB"; the deployed pack is neither: 0-byte Web-Audio synthesis (nav.js), no recordings, no rights exposure, default-muted with the choice persisted. The rationale mismatched the artifact, so the refusal dies; the pack joins the shell.js ledger (~1.2KB raw) and stays opt-in via the tray toggle.
- **Screenshot-diff authenticity CI.** Flaky goldens become a muted gate within a year; the deploy greps keep the guarantee at zero flake.
- **CSS-only 1Hz clock.** A perpetual style invalidation costs more than the 0.3KB timer it replaces.

## Verdicts against the current site

1. **The shell leaves nav.js.** Today a 108.9KB raw script builds the desktop after load; here every document carries ~2KB of static desktop markup and behavior shrinks to a 9KB raw shell. The desktop exists for curl, readers, and JS-off visitors, and CLS is 0.
2. **Inline-everything ends at 30 pages.** The rule was right for 1 page; across ~30 documents, repeated chrome CSS costs ~3KB br on every hop. One immutable 9KB br luna.css plus a 2KB inline critical subset drops warm hops to HTML only. View Source survives: the sheet ships commented, an artifact in its own right.
3. **The full token set goes in.** The no-color-tokens rule priced definitions against uncacheable inline bytes; a cached-forever sheet flips that ledger.
4. **The counter leaves the document.** SHIPPED v133 (2026-07-02), DO-backed variant: hit.svg ticks the existing Counter DO, so no KV seeding and increments stay atomic. hit.svg + activation beacon makes every homepage GET pure, HEAD/bot/prerender-immune by construction, and puts the homepage in the prerender set its own counter used to bar it from. Per-visit HTML spend drops ~31KB to ~14KB.
5. **View Transitions: the current site was right.** The synthesis first ruled ordinary hops back to instant cuts ("XP never animated document loads"); the OEM++ re-adjudication retracts that. Navigation is a window verb in the desktop metaphor, and the current site's window morphs on hops are the design. What survives of the verdict: morphs stay window-shaped (zoom, linear, no crossfades), stay under 2 named elements per page, and honor reduced-motion.
6. **Tooltips anchor at the control** with the 500ms delay and 120ms fade, except the photo camera-back, which keeps cursor-follow (owner's call). Its data pipeline still moves to SSR bake, so the surviving script is a ~1KB position loop with the earn-it will-change lifecycle.
7. **Histograms move to encode time** as ~250B SVGs and EXIF inlines into the page; the hover-time decode + getImageData pipeline and the fetch-on-hover meta files are deleted.
8. **Images go content-addressed.** SHIPPED 2026-07-03 (hash half; SVT re-encode split out, see PORTING duty 4): `?v=THUMB_VERSION` bumps re-downloaded ~2.3MB per returning visitor and existed to dodge 404 poisoning; hashed /i/ filenames kill both, and old URLs 301 for a year. The hand-referenced shell assets keep `?v=N` so hand-authoring never chases hashes.
9. **The service worker and CACHE_VERSION ritual are deleted.** SHIPPED v136 (2026-07-03): unregister stub + all 24 registrations stripped in one deploy; bump-version.sh reads MAX(vnum) from D1. bump-version.sh keeps only its deploy-log insert; /updates and /restore still read the one table.
10. **/around's crawl leaves the request path** for a cron (SHIPPED v134, 2026-07-03; */30 schedule); the page becomes a static snapshot and drops off the speculation deny-list.
11. **`no-store` goes from lesson to law**, and /run gets the zero-JS ladder today's script-only Run box lacks. SHIPPED v135 (2026-07-03): /run + /photos live, listings 301, /updates + /restore on private,no-cache.
12. **forced-colors, print, and reduced-motion coverage exist.** Today they don't, and all three are cheap.
13. **Notepad autosize moves to `field-sizing: content`**, deleting measurement script.

## The 5 biggest risks

1. **Checkbox minimize vs screen readers.** A labelled checkbox is honest but unusual AT semantics; the shell.js toggle-button upgrade is the ergonomic tier, and VoiceOver + NVDA passes run before ship. If real SR users still stumble, minimize becomes JS-only buttons behind the honesty gate; the zero-JS floor is the last thing surrendered.
2. **No service worker means HTTP-cache eviction bites.** iOS in particular can silently re-bill the ~38KB shared bundle on some returns. Accepted against deleting a whole poisonable subsystem; the decision reverses in an afternoon, and field timing data decides whether it ever needs reversing.
3. **Fly-compression variance on the one per-request document.** The ~14KB homepage figure rides the edge compressor's gzip-class ratio; if it regresses, the per-visit spend drifts toward 17KB. Measure in the field; the pressure valve is baking the grid per 300s generation, at the cost of per-visit randomness for no-JS visitors.
4. **Engine drift on the 2-engine calls** (@scope, position-try maturity, Temporal-less Safari stable, Safari's off-by-default prefetch). Contained by decoration-only @scope, tooltips that survive without flips, the Date branch, and warm-hop budgets that assume no speculation. Quarterly matrix retest; promotion to load-bearing only at 2 stable engines, and every demotion is a 1-line revert onto period behavior.
5. **Governance decay at one maintainer.** GET purity, the motion greps, the byte gates, and the speculation checklist are the site's constitution, and they only hold while CI runs them. A flaked gate gets fixed or deleted the same week; a muted gate is how 2006 quietly becomes 2019.