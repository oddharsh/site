# aadhar.sh — personal site

A resto-mod 2003-aesthetic personal site for Aadharsh Pannirselvam, deployed
to Cloudflare Pages + Workers. Two cohabiting projects in this directory:

- **`holding/`** — the live `aadhar.sh` homepage (Cloudflare Worker with static assets + `_worker.js`; migrated off Pages 2026-06-30)
- **`cal/`** — a custom coffee/bagel booking system LIVE at `aadhar.sh/coffee` (its own Cloudflare Worker; deploy separately with `cd cal && npm run deploy`)

The look is deliberately Windows XP / Outlook Express era: blue title bars,
Verdana/Tahoma fonts, raised 3D bevel buttons, sunken inputs, OKLCH-encoded
colors that read modern in source but render period-correct.

---

## Quick reference

```bash
# deploy the homepage
wrangler pages deploy holding --project-name aadhar-sh --branch holding --commit-dirty=true

# add new photos (resize, EXIF-rotate, encode to AVIF+JPG, upload to R2,
# regenerate metadata.json, bust manifest cache)
./holding/scripts/add-photos.sh "/path/to/photo.HIF" /path/to/folder/

# regenerate JUST the EXIF metadata (after photos are already uploaded)
./holding/scripts/extract-photo-metadata.sh "/Users/aadharsh/Downloads/to post (from ssd)"

# rebuild jpegli (Google's JPEG encoder, ~25% smaller than mozjpeg)
./holding/scripts/build-jpegli.sh

# bust caches via wrangler (RN_KV namespace ID hardcoded in scripts)
NS="3cb8a107c58e47dc9244e75b33401f36"
wrangler kv key delete --namespace-id="$NS" "manifest:images" --remote
wrangler kv key delete --namespace-id="$NS" "tracks:4IRq9W1N2tOWHhH0O3vXiF" --remote
```

---

## holding/ — homepage architecture

Single-page personal site at `aadhar.sh`. Hosted on Cloudflare Pages, with a
`_worker.js` that does server-side enhancement of an otherwise-static
`index.html`. The worker route table sits in `route()` at the top of
`_worker.js`.

### Key files

| file | role |
|---|---|
| `holding/index.html` | The whole page in one file. Inline CSS + JS. ~78KB uncompressed, ~22KB brotli. Comments deliberately kept readable for View Source. |
| `holding/writing/` | Written content as plain `.txt` files + `posts.json` registry `[{slug,title,date}]`. The worker renders each as an XP **Notepad** window at `/writing/<slug>` (a server-rendered `<textarea>` seeded with the canonical text — editable by nature, ephemeral by nature: no save → reload restores canonical, "writing in flux"), plus a "My Writing" folder index at `/writing`. Raw `.txt` stays fetchable at `/writing/<slug>.txt`. Author a post = drop a `.txt` + a `posts.json` entry. Render code (`handleWritingIndex`/`handleWritingPost`/`NOTEPAD_CSS`) lives in `_worker.js`. |
| `holding/notepad.js` | Behavior for the `/writing` Notepad view (deferred, SW-cached): per-window `enhance()` wiring File/Edit/Format/View/Help menus, live Ln/Col + word-count status bar, Word-Wrap toggle, the classic **F5 time/date** stamp (Temporal w/ Date fallback), Select All, Print, About. Also opens folder notes as **popovers** that composite over the folder index (+ `pushState` to `/writing/<slug>`, Back closes). Chrome itself is SSR'd by `_worker.js`. No-op without a `.np-window`. |
| `holding/nav.js` | Site-wide XP **desktop shell**. The ONE shared external asset (deferred, SW-cached) — every page includes `<script src="/nav.js" defer>`; it injects its own `<style>` + builds, into `<body>`: the **Bliss desktop** wallpaper, **draggable desktop icons** (Notepad + the 5 profiles, positions persisted in localStorage), the **taskbar** (Start orb → Run, first-level-subpage app buttons each with a per-section SVG icon, clock via Temporal), and the **Run** command palette (⌘K / Start). Also owns the **OS-window model**: body is a clipping flex desktop, each `.window`/`.np-window` is pinned + its content scrolls internally behind a **custom XP scrollbar**, windows are **draggable** (top is a hard boundary) + **resizable**, and View Transitions animate only the window. Sets each first-level route's **tab favicon** to its section icon. Run destinations: pages + profiles inline; 146 photos lazy-loaded from `/images/manifest.json` with `/images/alt.json` captions. Wired into homepage + all garage pages + worker-gen `/around`,`/whoareyou`,`/bot` + serendipity shell. |
| `holding/_worker.js` | Pages-Worker hybrid. Owns routing, photo serving from R2, manifest building, Spotify playlist scraping, AadharshBot crawler, the `/writing` Notepad pages, cache-control overrides. |
| `holding/_headers` | Static-asset cache + security headers (CSP, Permissions-Policy, etc.). Applied to direct static-asset requests; the worker overrides cache-control for select paths. |
| `holding/sw.js` | Service worker. `CACHE_VERSION = "aadhar-v66-luna-perf"` (bump on every nav.js/notepad.js change). Cache-first for `/images/*` thumbnails only (content-addressed via `?v=N`; full-res `/images/full/*` deliberately excluded — browser HTTP cache holds those immutable), SWR for static text files + nav.js/notepad.js, network-only for everything else. Bumping `CACHE_VERSION` sweeps old caches. |
| `holding/llms.txt` | The llms.txt format — concise site summary for LLMs. Linked from `<link rel="alternate">`. |
| `holding/index.md` | Markdown source of homepage copy (used by `/llms.txt` and as a fallback). |
| `holding/sitemap.xml`, `robots.txt` | Standard SEO files. robots.txt explicitly allows AadharshBot. |
| `holding/.well-known/http-message-signatures-directory` | JWKS for AadharshBot's Ed25519 public key (Web Bot Auth IETF draft). |
| `holding/images/` | 146 thumbnails (1200px AVIF + JPG pairs + 400px mobile AVIF tier) + `metadata.json` (EXIF index) + `meta/<stem>.json` per-photo EXIF for the hover tooltip. |
| `holding/scripts/` | Photo-pipeline scripts (see below). |

### The photo pipeline

```
SOOC original (in /Users/aadharsh/Downloads/to post (from ssd)/)
   |
   v
[add-photos.sh] — resize, rotate, encode:
   |   1. sips: resize to 1200px + format-convert (handles HEIF/HIF)
   |   2. jpegtran -rotate N (lossless EXIF orientation, mozjpeg's tool)
   |   3. cjpegli -q 82 -p 2 (Google's encoder, ~25% smaller than mozjpeg)
   |   4. avifenc CQ 30 (or sips formatOptions 60 fallback) — primary
   |
   v
holding/images/<stem>.{avif,jpg}  +  R2 aadhar-photos/<filename>
   |
   v
[extract-photo-metadata.sh] generates holding/images/metadata.json
   |   keyed by stem (not filename), orientation-corrected width/height.
   |   pulls Fuji recipe (FilmMode, DynamicRange, ColorChrome FX +Blue,
   |   Grain roughness + size, tone curves, saturation) plus standard
   |   exposure / focus / metering / WB shift / Kelvin temperature.
   |   also writes per-photo /images/meta/<stem>.json files (what the
   |   tooltip actually fetches on hover). histograms are NO LONGER
   |   stored — the Fuji LCD tooltip computes the 64-bin luminance
   |   histogram client-side from the on-screen thumbnail
   |   (photo-histograms.py is kept on disk but unused).
   |   discipline: every field is nullable; the tooltip skips lines
   |   that are null rather than fabricate. never guess metadata.
```

Two encoders + one transform tool, all built from source:

- **mozjpeg** (`brew install mozjpeg`, keg-only at `/opt/homebrew/opt/mozjpeg/`)
  — provides `jpegtran` for lossless EXIF-orientation rotation.
- **jpegli** (built from `github.com/google/jpegli`, installed at
  `~/.local/bin/cjpegli`) — JPEG universal-fallback encoder.
  See `holding/scripts/build-jpegli.sh` to rebuild.
- **libavif** (`brew install libavif`, optional) — `avifenc` for the
  primary AVIF thumbnail. Falls back to `sips -s format avif` (macOS
  native, no extra dep) when avifenc isn't installed.
- **exiftool, jq** (`brew install exiftool jq`) — metadata extraction.
- **Pillow** — no longer needed: histograms are computed client-side
  from the thumbnail; `photo-histograms.py` is kept on disk but unused.

### `<picture>` + cache-busting strategy

Photo thumbnails are dual-encoded AVIF + JPG, served via `<picture>`:

```html
<a href="/images/full/<filename>" data-full="..." data-size="..." data-uploaded="...">
  <picture>
    <source type="image/avif" srcset="/images/<stem>.avif?v=10">
    <img src="/images/<stem>.jpg?v=10" loading="lazy" decoding="async">
  </picture>
</a>
```

**The `?v=N` query is cache insurance.** The `THUMB_VERSION` constant
(`holding/_worker.js/lib/const.js`, currently `19`) is appended as `?v=N`
to every thumbnail URL in the pre-rendered HTML. Bump it when thumbnails
are re-encoded or when you need a fresh edge cache key for a stale-looking
thumbnail.

Workers static assets return honest 404s now; the old Pages SPA-fallback
masquerade is gone. The worker route at `/images/<stem>.<ext>` still clamps
true 404 responses to `max-age=0, must-revalidate` so a missing thumbnail
doesn't inherit the immutable `/images/*` cache rule.

### Worker enhancement (`serveHomepageWithPrerenderedTracks`)

When `/` is requested, the worker pulls two cached chunks of data from KV
and uses `HTMLRewriter` to inject them into the static HTML:

1. **`/rn/tracks` (Spotify playlist tracks)** — populated by a separate
   handler that scrapes `open.spotify.com/embed/playlist/<id>`, then
   `embed/track/<id>` (for album cover + artist IDs), then
   `embed/artist/<id>` (for artist profile pics, KV-cached 30d).
   Identifies as `AadharshBot/1.0 (+https://aadhar.sh/bot)` UA.
2. **Photo grid** — random 12 from manifest, emitted as
   `<a><picture><source><img></picture></a>` slots inside `<section class="photos">`.

If either chunk fails (KV empty, R2 missing, etc.), the rewriter silently
skips and the inline JS in `index.html` takes over with a client-side
fetch.

### AadharshBot — the branded crawler

Lives in `_worker.js` (search for `BOT_NAME`). Signs all outbound requests
per RFC 9421 + Web Bot Auth IETF draft. JWKS at
`/.well-known/http-message-signatures-directory`. Used for:

- The `/around` neighborhood dashboard (crypto VC homepages it crawls)
- The Spotify scraper (`scrapeSpotifyEmbed()`)
- Any other outbound fetch where being identifiable matters

### DNS-AID (agent discovery)

DNS record, not in this repo — lives in Cloudflare DNS for the zone.
`_index._agents.aadhar.sh` is a ServiceMode SVCB record
(`1 aadhar.sh. alpn="h2,h3" port=443 mandatory=alpn,port`, TTL 3600) per
draft-mozleywilliams-dnsop-dnsaid + RFC 9460. It points agents at this
host; `llms.txt` plus the JSON endpoints are the discovery surface. The
zone is already DNSSEC-signed (ECDSAP256SHA256, DS published at the
registrar), so the SVCB answer is authenticated automatically.

Deliberately only `_index` is published, not `_a2a`: the site has no
Agent2Agent server, so an `_a2a` record would be a dangling pointer that
passes a scanner but breaks any agent that connects. Same honesty rule
as the `/whoareyou` "no third party" claim — don't advertise capability
the site doesn't actually serve. To verify:
`dig _index._agents.aadhar.sh SVCB +dnssec +short`.

### Cloudflare bindings

- **RN_KV** (KV namespace ID `3cb8a107c58e47dc9244e75b33401f36`) — caches the
  playlist tracks, photo manifest, artist profile pics, and a few crawler
  results. ~10K writes/day budget; we use a handful.
- **PHOTOS_R2** — R2 bucket `aadhar-photos`, holds the SOOC originals
  (~3 GB / 146 photos at FUJIFILM X-T5 + Leica resolution).
- **ASSETS** — auto-bound by Pages, serves static files from the project.

### XP visual vocabulary (CSS)

**Design system:** [`design/DESIGN.md`](design/DESIGN.md) is the Luna brief (canonical
reference + DON'T-modernize guardrails); [`design/tokens/`](design/tokens/) is the
canonical token set (fonts, Luna palette, bevels, radii). Pull from those before
hardcoding any color/font/bevel. Captions = Trebuchet MS, UI/body = Tahoma→Verdana,
mono = Courier New — those three stacks only.

**HARD RULES (strong owner preference):** (1) **internal/native fonts ONLY** — never ship `@font-face` with `url()`, web fonts, `@import`, or font preloads; the served pages carry ZERO font bytes (the design system's `@font-face local()` rules are reference-only, never inlined into a served page). (2) **keep perf lean** — fold design tokens in WITHOUT regressing the byte budget: on a brotli'd inline page, tokenizing repeated literals is a wash (brotli already dedupes) while token *definitions* are net-new bytes, so only the FONT tokens (`--font-*`) are inlined site-wide; color/gradient tokens are NOT inlined (they cost bytes for no brotli gain). no external stylesheet, no build, no JS for styling.

Reusable classes that show up across the site (homepage + future `/coffee`):

- `.title-bar` — blue gradient strip with icon + title + boxed `_ □ ×` controls
- `.controls span/a` — the small minimize/maximize/close glyphs (boxed,
  hover-tinted red on the close one)
- `.window` — outer card with the title-bar + content
- `.content` — workspace area inside the window
- `.now-playing` — list of currently-playing tracks (Outlook-Express styling)
- `.np-list li` — alternating-row tracklist
- `.np-artist-link` — clickable artist names (span, not anchor; click handler
  intercepts because nested `<a>` is invalid HTML)
- `.photos` — 3×3 grid of contact-sheet-framed photos
- `.xp-tooltip` — generic hover popover (used by photos, tracks, artists)
- `@media (color-gamut: p3)` — wide-gamut color upgrades for OKLCH chroma

Font stack universally: `Verdana, Tahoma, Geneva, sans-serif` for body,
`"Trebuchet MS", Verdana, sans-serif` for headings. Both font families
are installed on macOS, so the fallback path doesn't hit Helvetica/Arial.

---

## cal/ — coffee booking worker

Custom-built scheduler at `aadhar.sh/coffee`. Replaces Cal.com. Inspired by
[jry.io/bagel](https://jry.io/bagel). Crediting Jacob Young in the footer.

**Status: LIVE at aadhar.sh/coffee** (zone route → `cal-aadhar-sh` worker).
Deploys separately: `cd cal && npm run deploy` (secrets already set). The cal npm
scripts pass `-c wrangler.toml`: a bare `wrangler deploy` from cal/ wrongly
inherits the repo-root `build.command` (`node build.mjs`) and fails.
Availability is served from an SWR calendar snapshot (KV `cal:busy`, 2s upstream
deadline, stale fallback), the GET page edge-caches 30s, and a booking fails
closed if the calendar can't be vouched for (never books over an unseen event).

### Architecture

- Public ICS feed (Google/iCloud) is the read-only source of busy intervals
- `generateSlots()` computes bookable slots from working hours config
- `POST /book` creates a pending booking in KV, emails the host with
  HMAC-signed approve/decline links (Resend free tier)
- Host clicks approve → confirmed → `.ics` invite to requester
- Host clicks decline → polite auto-reply
- Cron triggers a weekly sweep of un-acted pending bookings

### Files

```
cal/
├── wrangler.toml       — routes: aadhar.sh/coffee/*, cal.aadhar.sh/* (fallback)
├── package.json
└── src/
    ├── index.js        — router, request dispatch, KV state
    ├── availability.js — ICS parsing, slot generation, working-hours logic
    ├── booking.js      — pending/confirmed booking CRUD + index
    ├── email.js        — Resend integration, .ics generation
    ├── sign.js         — HMAC-SHA256 for approve/decline URL auth
    ├── templates.js    — XP-themed HTML for all pages (booking, success, confirmed, declined, error)
    └── uuid.js         — RFC4122 v4 helper
```

### Required secrets (before deploy)

```bash
cd cal && npm install
npx wrangler kv namespace create CAL_BOOKINGS         # paste id into wrangler.toml
npx wrangler secret put ICAL_URL                       # Google Calendar → "secret ICS"
npx wrangler secret put RESEND_API_KEY                 # resend.com, DKIM-verify aadhar.sh
openssl rand -hex 32 | npx wrangler secret put SIGNING_SECRET
npx wrangler deploy
```

### Visual notes (XP reskin lives in `cal/src/templates.js`)

- Window chrome matches the homepage (`title-bar`, boxed `_ □ ×` controls)
- GroupBox panels for "Available slots" + "Your info" (sunken bevel)
- Slot picker: raised XP buttons that depress + tint blue when selected
- Form inputs: sunken 3D (dark TL, light BR — opposite of buttons)
- Banner variants: info / success / warn / error (Outlook-Express style)
- Status bar at the bottom with `← aadhar.sh · jacob credit · cloudflare workers · tz`

---

## Conventions + gotchas this session learned the hard way

1. **Thumbnail 404s must be uncacheable.** Workers static assets no longer
   return homepage HTML for missing files, but a real miss under `/images/*`
   can still inherit the immutable cache rule unless the worker clamps it.
   Mitigations: keep `/images/<thumb>` worker-first and bump `THUMB_VERSION`
   when you need a fresh cache key.

2. **zsh doesn't word-split unquoted parameters** — bash does. The
   `add-photos.sh` script uses `#!/usr/bin/env bash` so this isn't a problem
   inside the script, but **ad-hoc shell snippets** run in interactive zsh
   need `${=flag}` to force splitting. Caught this when `jpegtran -copy none $flag`
   passed `"-rotate 270"` as a single argv element.

3. **mozjpeg's `djpeg|cjpeg` strips EXIF.** Including orientation. Apply
   rotation losslessly with `jpegtran -copy none -rotate N` BEFORE the
   recompression pipe — otherwise portrait shots come out landscape.

4. **`jpegtran` writes binary to stdout.** Don't `2>&1` to a file or stderr
   warnings will corrupt the JPEG bytes. Use `2>/dev/null > out.jpg` (stderr
   to null) instead.

5. **exiftool's `-n` is global**, not per-tag. To force numeric output for
   just one tag, use the `#` suffix: `'-Orientation#'`. Otherwise every
   field (shutter, aperture, ISO) collapses to a decimal.

6. **EXIF "Orientation" values 5–8 mean swap width/height for display.**
   Camera writes sensor-native landscape pixels + a rotation hint. Source
   dimensions for portrait shots need to be transposed before going into
   `metadata.json` so the tooltip matches what users see.

7. **`<picture>`'s type-based fallback doesn't catch DECODE failures.**
   Only "format not supported by this browser." This bit us with AVIF
   early on (we briefly went WebP-as-primary because of it). Currently
   AVIF-as-primary with JPG as the universal `<img src>` fallback —
   the WebP middle tier was dropped because every modern browser
   (Safari 16+, Chrome 85+, Firefox 93+) advertises image/avif
   natively. If broken-image reports recur, the fix is to demote
   AVIF — adding more `<source>` tiers does not help, because the
   browser commits to its chosen format before the decoder runs.

8. **`<a>` nested inside `<a>` is invalid HTML** — the parser hoists them
   out. For the per-artist clickable spans inside the row-anchor, use
   `<span class="np-artist-link" role="link" tabindex="0" data-href="...">`
   + a delegated click handler.

9. **Pages's `wrangler pages deploy holding`** must run from the project
   root (`~/noodling/site/`), not from inside `holding/images/` etc.,
   otherwise wrangler tries to scan `images/holding/` and ENOENTs.

10. **Hover-only features need `(hover: none)` gating.** Touch devices fire
    synthetic `mouseover`/`mouseout` on long-press, which was causing
    spurious tooltips during mobile scroll. The tooltip IIFE now early-exits
    if `matchMedia("(hover: none)")` matches.

11. **`will-change: transform` is an "earn it" hint, not a permanent set.**
    Leaving it on a `display: none` element keeps a compositor layer
    allocated even when invisible — measurable hit on Low Power mode /
    variable-refresh-rate displays (ProMotion 24Hz). Toggle it on/off in JS
    around the hover lifecycle.

12. **Cloudflare asset uploads are content-addressed.** Re-deploying the
    same bytes may upload 0 files even when you are trying to change cache
    behavior. If a thumb looks stale, hit it with a fresh `?cb=$RANDOM`: if
    that differs from `?v=N`, you are looking at cache state, not missing
    bytes.

---

## Source folder for new photos

The local mirror of the R2 originals lives at
`/Users/aadharsh/Downloads/to post (from ssd)/` — that's what
`extract-photo-metadata.sh` reads from, and what `add-photos.sh` accepts as
input. **Privacy rule: nothing else from elsewhere on disk.** The user has
curated this folder; treat it as the canonical photo source.

---

## What's NOT here

- The original `/Users/aadharsh/noodling/.Codex/worktrees/silly-goldberg-6b0687/`
  worktree still exists (branched off `oddharsh/serendipity` on GitHub). It
  has the same code in it but is no longer the source of truth. Future work
  should happen in this directory.
- No GitHub remote yet — user wants this to be a private repo eventually.
  Run `gh repo create aadhar-sh --private --source=. --remote=origin --push`
  when ready.
- `node_modules/`, `.wrangler/` build cache, and `.DS_Store` files were
  intentionally not copied. They'll regenerate as needed.
