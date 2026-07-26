# `design/` — what is canon and what is history

Three kinds of file live here and they carry very different authority. Read this
before treating anything below as a spec.

## Canon (current, load-bearing)

- **`DESIGN.md`** — the Luna brief. The canonical reference plus the
  DON'T-modernize guardrails. CLAUDE.md points here.
- **`tokens/`** — the canonical token set (colors, bevels, fonts, typography;
  115 custom properties). `holding/luna.css` derives from these and never
  redefines them. Change a token here first, then flow it into luna.css.
- **`styles.css`** — the entry point that `@import`s the four token files.
  Nothing the site serves links it; the `aadhar-sh-design` skill package does.
  See "Files whose only consumer lives outside this repo" in MAINTENANCE.md.

## History (a record of decisions, NOT a spec to implement)

These were produced by design passes in early July 2026 and are kept because the
reasoning in them is worth having. **The site did not converge on them, and the
numbers in them are stale.** Do not read a byte budget or an architecture out of
these files and treat it as a target.

- **`GREENFIELD.md`** (2026-07-02) — the blank-slate blueprint from a 4-design,
  4-judge pass. Most of its verdict list shipped; its shell rewrite did not.
  Full item-by-item accounting below, measured 2026-07-26.
- **`PORTING.md`** (2026-07-02) — the companion manifest of which tricks and
  which copy survive that rewrite. Its file:line citations point at a tree that
  has since moved.
- **`explore-bac-map.md`** (2026-07-05) — the four-quadrant map for the B/A/C
  cleanup-and-guard program. Its "known knowns" section is still a decent
  orientation to the request path and caching model; its build plan is spent.

If one of these ever becomes the plan again, move it back up to Canon and
re-measure everything it asserts first.

## GREENFIELD.md, audited against the tree (2026-07-26)

The doc reads as one undelivered blueprint, which undersells it: roughly two
thirds of it either shipped or was deliberately overruled in the three weeks
after it was written. What's left is the shell rewrite, and the case for that
has weakened. This section is the accounting so nobody has to re-derive it.

**Measured today, against the doc's own 2026-07-02 figures:**

| file | doc said | today | note |
|---|---|---|---|
| nav.js | 108,907 raw / 28,155 br | 83,095 raw / 23,111 br | a 24% raw cut, not the projected 88% |
| luna.css | budgeted 36KB raw / 9KB br | 65,856 raw / 16,956 br | the sheet shipped at nearly 2x its budget |
| index.html | budgeted ~40KB raw / ~14KB wire | 80,990 raw / 20,372 br q11 | and the homepage gets fly-gzip, not br q11 |
| SSR desktop partial | "~2KB of static markup" | 20,842 raw / 3,159 br per document | of which 16,229 raw / 2,204 br is the 12 icon SVGs |

Treat every remaining number in GREENFIELD.md as wrong by a similar margin.

### Shipped

- **luna.css as one immutable shared sheet**, tokens folded in (owner-approved
  2026-07-21). The doc's central bet, and the part that paid.
- **The counter left the document** (v133, revised v138): `/hit` plus the
  Counter DO, so homepage GETs are pure and the page can be prerendered.
- **Service worker and the CACHE_VERSION ritual deleted** (v136).
- **Content-addressed `/i/` thumbnails** (2026-07-03), old URLs 301 for a year.
- **`/around`'s crawl moved to cron** (v134); the `*/30` trigger is in
  wrangler.jsonc.
- **`/run` and `/photos` shipped, listings 301** (v135). Run is a real
  `<dialog>` with `showModal` plus the zero-JS `/run` page and its GET form,
  which is the declarative ladder the doc specified.
- **forced-colors and print coverage** in luna.css (v142).
- **Notepad autosize via `field-sizing: content`**; the measurement script died.
- **Window resize via CSS `resize: both`**, replacing the scripted path.
- **Histograms and EXIF bake at photo-add time** (v139), all four channels.
- **The static desktop partial** (lib/desktop.js), with a build.mjs tripwire
  keeping it in sync with nav.js. This is what actually won CLS 0 and the
  curl/JS-off desktop, which was the real prize behind the zero-JS ledger.
- **Sound pack, System Properties tray popout, Windows Update balloon**: all
  three owner-kept ledger items are live.

### Overruled, reversed, or declined

- **Tooltips anchor at the control**: tried live 2026-07-03, rolled back within
  hours. All pointer tips cursor-follow; anchoring survives on keyboard focus.
- **View Transitions restricted to window verbs**: retracted under OEM++.
  Window morphs play on ordinary navigations, which is what the site did anyway.
- **Icon position persistence** (0.8KB in the shell ledger): dropped on purpose.
  Stored layouts got read back in states that couldn't honour them.
- **The `@layer` cascade spine**: declined. luna.css says so at line 14.
- Everything already in the Refusals section stayed refused.

### Still open, and whether it's still worth it

1. **`shell.js` at 3.3KB br: the number is dead, one piece of the work isn't.**
   The doc assumed nav.js's construct path was a legacy fallback to delete. It
   isn't: `/coffee` (cal/src/templates.js) and `/serendipity` load nav.js
   without the partial and build the taskbar there every visit, and
   gen-desktop-partial.mjs evals the tray template out of that same function, so
   nav.js is the generator's source of truth. Deleting it today breaks two
   routes. The real prerequisite is wiring cal and serendipity to
   lib/desktop.js, which is worth doing on its own. After that the remaining
   prize is small: nav.js ships from `/a/nav.<hash>.js` at 1-year immutable, so
   its bytes are a first-visit cost, and the 15KB destinations table is
   generated data that a diet wouldn't touch.
2. **`icons.svg`: the one open item with a measured payoff.** The 12 icon SVGs
   cost 2,204 br in *every document, every visit*, because HTML ships
   `private, no-cache`. That's ~11% of the homepage's wire and a larger share of
   a small garage page. A same-origin sprite at 1-year immutable collects that
   once. Two caveats the doc got wrong: the icons are hardcoded gradient art,
   not `currentColor`-tinted, so its stated mechanism doesn't apply; and an
   external `<use>` turns above-fold art into a second request. They're
   `aria-hidden` decoration, so a late paint is cheap, but prototype and measure
   LCP, not just bytes.
3. **The zero-JS ledger (checkbox minimize, `popover` Start menu): mostly not
   worth it now.** Its actual prizes, CLS 0 and a desktop for curl and JS-off
   visitors, were won by the SSR partial instead. What's left is that minimize
   and Start don't work with scripting off, which is a much smaller thing than
   it looked when the same change was also buying an 88% byte cut. The doc's own
   risk #1 flags the checkbox as unusual AT semantics. Skip it. `details name=`
   for the changelog years on /updates is separable and still cheap.
4. **The Run hover-preview: worth building, and it's the most fun thing left.**
   ~1.1KB, self-contained, and anchor positioning is Baseline across all three
   engines now. It's a feature rather than a byte play, and its honesty property
   (the card can only ever show what Enter would open) still holds.
5. **Verdict 7, SSR'ing EXIF and histograms into the tooltip markup: decline
   it.** The premise flipped. Per-photo meta averages 977B; inlining the reduced
   form for 12 homepage photos costs ~2 to 2.5KB br paid by every visitor,
   including mobile, which can never hover (tooltip.js doesn't even load on a
   coarse pointer). The current hover fetch is one request over an already-open
   h3 connection. Baking the data was the good half of the verdict and it
   shipped; the inlining half is now a regression.
6. **The aesthetic deploy greps** (cubic-bezier, radius above 3px, blur shadows,
   curly quotes): worth it, and cheap. build.mjs already has the eight-tripwire
   scaffold to hang them on, and the doc's governance risk (#5) is the one risk
   on its list that ages badly by doing nothing.
7. **103 Early Hints: close it, effectively done.** The worker emits the
   `rel=preload` links that Cloudflare's Early Hints harvests into a 103. The
   doc wanted the outcome, not a hand-rolled 103, and the outcome is live.
