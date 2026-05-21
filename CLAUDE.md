# aadhar.sh — personal site

A resto-mod 2003-aesthetic personal site for Aadharsh Pannirselvam, deployed
to Cloudflare Pages + Workers. Two cohabiting projects in this directory:

- **`holding/`** — the live `aadhar.sh` homepage (Cloudflare Pages + `_worker.js`)
- **`cal/`** — a custom coffee/bagel booking system at `aadhar.sh/coffee` (Cloudflare Worker, not yet deployed)

The look is deliberately Windows XP / Outlook Express era: blue title bars,
Verdana/Tahoma fonts, raised 3D bevel buttons, sunken inputs, OKLCH-encoded
colors that read modern in source but render period-correct.

---

## Quick reference

```bash
# deploy the homepage
wrangler pages deploy holding --project-name aadhar-sh --branch holding --commit-dirty=true

# add new photos (resize, EXIF-rotate, encode to JPG+WebP, upload to R2,
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
| `holding/index.html` | The whole page in one file. Inline CSS + JS. ~65KB uncompressed, ~19KB brotli. Comments deliberately kept for the `/source` view. |
| `holding/_worker.js` | Pages-Worker hybrid. Owns routing, photo serving from R2, manifest building, Spotify playlist scraping, AadharshBot crawler, /source viewer, /coffee redirect, cache-control overrides. |
| `holding/_headers` | Static-asset cache + security headers (CSP, Permissions-Policy, etc.). Applied to direct static-asset requests; the worker overrides cache-control for select paths. |
| `holding/sw.js` | Service worker. `CACHE_VERSION = "aadhar-v5-webp-jpg"`. Cache-first for `/images/*` (content-addressed via `?v=N`), SWR for static text files, network-only for everything else. Bumping `CACHE_VERSION` sweeps old caches. |
| `holding/llms.txt` | The llms.txt format — concise site summary for LLMs. Linked from `<link rel="alternate">`. |
| `holding/index.md` | Markdown source of homepage copy (used by `/llms.txt` and as a fallback). |
| `holding/sitemap.xml`, `robots.txt` | Standard SEO files. robots.txt explicitly allows AadharshBot. |
| `holding/.well-known/http-message-signatures-directory` | JWKS for AadharshBot's Ed25519 public key (Web Bot Auth IETF draft). |
| `holding/images/` | 120 thumbnails (1200px JPG + WebP pairs) + `metadata.json` (EXIF index). 120 stems × 2 formats = 240 files. |
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
   |   4. cwebp -q 80 -sharp_yuv (from the corrected JPG)
   |
   v
holding/images/<stem>.{jpg,webp}  +  R2 aadhar-photos/<filename>
   |
   v
[extract-photo-metadata.sh] generates holding/images/metadata.json
   |   keyed by stem (not filename), orientation-corrected width/height,
   |   pulls Fuji-specific recipe fields (FilmMode, ColorChrome, Grain,
   |   tone curves) when present.
```

Two encoders + one transform tool, all built from source:

- **mozjpeg** (`brew install mozjpeg`, keg-only at `/opt/homebrew/opt/mozjpeg/`)
  — provides `jpegtran` for lossless EXIF-orientation rotation.
- **cwebp** (`brew install webp`) — WebP primary thumbnail.
- **jpegli** (built from `github.com/google/jpegli`, installed at
  `~/.local/bin/cjpegli`) — primary JPEG fallback encoder.
  See `holding/scripts/build-jpegli.sh` to rebuild.
- **exiftool, jq** (`brew install exiftool jq`) — metadata extraction.

### `<picture>` + cache-busting strategy

Photo thumbnails are dual-encoded WebP + JPG, served via `<picture>`:

```html
<a href="/images/full/<filename>" data-full="..." data-size="..." data-uploaded="...">
  <picture>
    <source type="image/webp" srcset="/images/<stem>.webp?v=8">
    <img src="/images/<stem>.jpg?v=8" loading="lazy" decoding="async">
  </picture>
</a>
```

**The `?v=N` query is critical.** Cloudflare's edge will cache a 404
response for 4 hours if any URL gets hit during a deploy race window.
The `THUMB_VERSION` constant (top of `_worker.js`, currently `8`) is
appended as `?v=N` to every thumbnail URL in the pre-rendered HTML.
**Bump it whenever you suspect cache poisoning** — bumping = fresh URLs =
fresh edge cache lookup = bypass any poisoned 404.

The worker route at `/images/<stem>.<ext>` also rewrites cache-control
on 404 responses to `max-age=0, must-revalidate` so future 404s can't
poison the edge for 4 hours.

### Worker enhancement (`serveHomepageWithPrerenderedTracks`)

When `/` is requested, the worker pulls two cached chunks of data from KV
and uses `HTMLRewriter` to inject them into the static HTML:

1. **`/rn/tracks` (Spotify playlist tracks)** — populated by a separate
   handler that scrapes `open.spotify.com/embed/playlist/<id>`, then
   `embed/track/<id>` (for album cover + artist IDs), then
   `embed/artist/<id>` (for artist profile pics, KV-cached 30d).
   Identifies as `AadharshBot/1.0 (+https://aadhar.sh/bot)` UA.
2. **Photo grid** — random 9 from manifest, emitted as
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

### Cloudflare bindings

- **RN_KV** (KV namespace ID `3cb8a107c58e47dc9244e75b33401f36`) — caches the
  playlist tracks, photo manifest, artist profile pics, and a few crawler
  results. ~10K writes/day budget; we use a handful.
- **PHOTOS_R2** — R2 bucket `aadhar-photos`, holds the SOOC originals
  (~3 GB / 120 photos at FUJIFILM X-T5 + Leica resolution).
- **ASSETS** — auto-bound by Pages, serves static files from the project.

### XP visual vocabulary (CSS)

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

**Status: source-complete, not deployed.** Needs secrets set before
`wrangler deploy` will work end-to-end (see `cal/README.md`).

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

1. **Cloudflare edge caches 404s for 4 hours.** If ANY thumb URL gets a
   transient 404 during a deploy race, the edge serves that 404 for 4 hours
   thereafter. Mitigations: `THUMB_VERSION` bump + worker route that rewrites
   cache-control on non-200 responses.

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
   Only "format not supported by this browser." We saw this with AVIF;
   stuck with WebP because its decoder-failure rate is much lower.

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

12. **Cloudflare Pages dedup is content-addressed.** Re-deploying the same
    bytes shows `Uploaded 0 files (252 already uploaded)` even if the live
    URL serves a stale 404 — the bytes are in storage, the edge cache is
    the problem. Diagnose by hitting the URL with a fresh `?cb=$RANDOM`:
    if THAT returns 200 but `?v=N` returns 404, it's poisoned cache.

---

## Source folder for new photos

The local mirror of the R2 originals lives at
`/Users/aadharsh/Downloads/to post (from ssd)/` — that's what
`extract-photo-metadata.sh` reads from, and what `add-photos.sh` accepts as
input. **Privacy rule: nothing else from elsewhere on disk.** The user has
curated this folder; treat it as the canonical photo source.

---

## What's NOT here

- The original `/Users/aadharsh/noodling/.claude/worktrees/silly-goldberg-6b0687/`
  worktree still exists (branched off `oddharsh/serendipity` on GitHub). It
  has the same code in it but is no longer the source of truth. Future work
  should happen in this directory.
- No GitHub remote yet — user wants this to be a private repo eventually.
  Run `gh repo create aadhar-sh --private --source=. --remote=origin --push`
  when ready.
- `node_modules/`, `.wrangler/` build cache, and `.DS_Store` files were
  intentionally not copied. They'll regenerate as needed.
