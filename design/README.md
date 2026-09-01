# `design/` — what is canon and what is history

Three kinds of file live here and they carry very different authority. Read this
before treating anything below as a spec.

## Canon (current, load-bearing)

- **`DESIGN.md`** — the Luna brief. The canonical reference plus the
  DON'T-modernize guardrails. CLAUDE.md points here.
- **`tokens/`** — the canonical token set (colors, bevels, fonts, typography;
  115 custom properties). `src/styles/luna.css` derives from these and never
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
  4-judge pass. Worked through to completion; nothing in it is still pending.
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
after it was written, and the remainder was worked through on 2026-07-26. This
section is the accounting so nobody has to re-derive it.

**GREENFIELD.md is now closed.** Every item it proposed has either shipped, been
overruled on the record, or been declined with a measured reason. Nothing in it
is waiting to be built. If the doc reads like a plan, read "What is actually
left" at the end of this section first.

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
- **The static desktop partial** (lib/desktop.js), with a build.ts tripwire
  keeping it in sync with nav.js. This is what actually won CLS 0 and the
  curl/JS-off desktop, which was the real prize behind the zero-JS ledger.
- **Sound pack, System Properties tray popout, Windows Update balloon**: all
  three owner-kept ledger items are live.

Then, on 2026-07-26, the rest of the open list was worked through:

- **`icons.svg`** (#96). The 12 taskbar + tray icons became one generated
  `<symbol>` sprite, content-hashed into `/a/`. Homepage went 10,348 to 8,288
  brotli, roughly 2,080 off every page, against 2,344 brotli fetched once at a
  year immutable. Built differently from the doc, which had the mechanism wrong
  twice: the icons are hardcoded gradient art rather than `currentColor`-tinted,
  and the sprite could NOT replace nav.js's `SECTION_ICONS`, because that markup
  is also serialized into each route's `data:` favicon where an external `<use>`
  cannot resolve. `gen-desktop-partial.mjs` generates the sprite from those bytes
  instead, so nav.js stays the single source of truth.
- **The taste tripwires** (#95), calibrated rather than literal, plus a
  `/* taste-ok: reason */` marker for deliberate deviations (#100). Its first
  three findings were real and are fixed (#100).
- **The Run hover-preview** (#99), built on a hover engine extracted from
  tooltip.js and serendipity's drifted copy (#98) rather than as a fourth copy.
- **cal and serendipity adopt the desktop partial** (#97), the prerequisite the
  shell diet turned out to be blocked on.

### Overruled, reversed, or declined

- **Tooltips anchor at the control**: tried live 2026-07-03, rolled back within
  hours. All pointer tips cursor-follow; anchoring survives on keyboard focus.
- **View Transitions restricted to window verbs**: retracted under OEM++, then
  moot. Window morphs played on ordinary navigations until 2026-07-30, when the
  whole View Transition layer came out: hover-prerender had already made those
  navigations instant, so the morph only delayed a page that had already arrived.
- **Icon position persistence** (0.8KB in the shell ledger): dropped on purpose.
  Stored layouts got read back in states that couldn't honour them.
- **The `@layer` cascade spine**: declined. luna.css says so at line 14.
- Everything already in the Refusals section stayed refused.

### What is actually left (2026-07-26)

The seven-item open list this audit originally carried is closed. Three shipped,
three were closed with a reason rather than built, and one turned out to be two
separate things. Recorded so nobody re-opens a decision that was already made.

| item | outcome |
|---|---|
| `icons.svg` | **Shipped** (#96) |
| Aesthetic deploy greps | **Shipped** (#95, #100) |
| Run hover-preview | **Shipped** (#98, #99) |
| `shell.js` at 3.3KB br | **Closed.** Prerequisite shipped (#97); the remainder is not worth doing |
| Zero-JS ledger | **Closed.** Its real prizes were won by the SSR partial |
| Verdict 7 (inline EXIF/histograms) | **Declined.** The premise inverted |
| 103 Early Hints | **Closed.** Already live via Cloudflare's harvest |

Three of those deserve their reasoning kept, because each is a decision a future
session would otherwise re-derive from the doc and get wrong.

**The shell diet is closed, and its byte case is dead.** cal and serendipity
adopting the partial (#97) removed the real blocker, so nav.js's construct path
*could* now be deleted. It should not be, for the number: that path is ~2.2KB of
`buildTaskbar` plus ~1.1KB of `buildIcons`, under a kilobyte brotli, from a file
served immutable from `/a/`. Once per visitor per year. The doc's 88% figure was
never reachable, because the two largest things in nav.js are a generated
destinations table and a tray template that `gen-desktop-partial.mjs` evals as
its own input. #97 was still worth doing, for consistency rather than bytes.

**The zero-JS ledger stays skipped.** CLS 0 and a desktop for curl and JS-off
visitors were the prizes, and the SSR partial won both. What remains is that
minimize and Start need script, far smaller than it looked when the same change
was also buying a byte cut that turned out not to exist. The doc's own risk #1
flags the checkbox minimize as unusual AT semantics.

**Verdict 7 is declined on measurement.** Per-photo meta averages 977B; inlining
the reduced form for 12 homepage photos costs ~2 to 2.5KB brotli billed to every
visitor, including mobile, where `tooltip.js` never loads at all because the
pointer is coarse. Baking the data at photo-add time was the good half of that
verdict and shipped in v139; the inlining half would now be a regression.

Genuinely still open, both small, and neither blocking:

- **`details name=` for the changelog years on /updates.** Separable from the
  rest of the zero-JS ledger and still cheap.
- **A nested ListView for the tracklist.** Not from GREENFIELD.md; it came out
  of #101. The homepage tracklist now has a proper sunken well, so a row cut by
  the scroll boundary reads as a viewport edge rather than breakage, but with a
  single scroller a row can still be bisected. The full fix is the list
  scrolling inside its own sunken client area with its own scrollbar, which is
  what Outlook Express's message list did. Deferred as too large for the
  complaint that prompted it.
