# aadhar.sh — personal site

A resto-mod 2003-aesthetic personal site for Aadharsh Pannirselvam, deployed
as a Cloudflare Worker with static assets. Cohabiting source modules in this
directory, deployed by one site Worker:

- **`holding/`** — the live `aadhar.sh` site (Workers static assets + the `_worker.js/` dispatcher)
- **`cal/`** — a custom coffee/bagel booking module at `aadhar.sh/coffee`, delegated by the root Worker
- **`serendipity/`** — the event dashboard module at `aadhar.sh/serendipity`, delegated by the root Worker

The look is deliberately Windows XP / Outlook Express era: blue title bars,
Verdana/Tahoma fonts, raised 3D bevel buttons, sunken inputs, OKLCH-encoded
colors that read modern in source but render period-correct.

---

## Quick reference

> Full task-by-task ops runbook (add photos, swap the now-playing playlist,
> bust caches, version bumps, what every script does): [MAINTENANCE.md](MAINTENANCE.md).

```bash
# production: merge to main; CI promotes the tested commit to production and
# Workers Builds deploys it. Local fallback only:
npm run deploy

# add new photos (resize, EXIF-rotate, encode to AVIF+JPG, upload to R2,
# bake histograms, validate artifacts, and bust the manifest cache)
npm run photos -- "/path/to/photo.HIF" "/path/to/folder/"

# validate the committed photo artifact graph without uploading anything
npm run photos:check

# regenerate JUST the EXIF metadata (after photos are already uploaded)
./holding/scripts/extract-photo-metadata.sh "/Users/aadharsh/Downloads/to post (from ssd)"

# install the histogram decoder dependency
python3 -m pip install -r holding/scripts/requirements.txt

# rebuild jpegli (Google's JPEG encoder, ~25% smaller than mozjpeg)
./holding/scripts/build-jpegli.sh

# bust caches via wrangler (RN_KV namespace ID hardcoded in scripts).
# manifest busts need BOTH keys (value + freshness sentinel)
NS="3cb8a107c58e47dc9244e75b33401f36"
wrangler kv key delete --namespace-id="$NS" "manifest:images" --remote
wrangler kv key delete --namespace-id="$NS" "manifest:images:fresh" --remote
wrangler kv key delete --namespace-id="$NS" "tracks:4IRq9W1N2tOWHhH0O3vXiF" --remote
```

---

## holding/ — homepage architecture

Single-page personal site at `aadhar.sh`. A Cloudflare Worker with static assets, with a
`_worker.js` that does server-side enhancement of an otherwise-static
`index.html`. The worker route table sits in `route()` at the top of
`_worker.js`.

### Key files

| file | role |
|---|---|
| `holding/index.html` | The whole page in one file. Inline CSS + JS. ~83KB uncompressed, ~24KB brotli (measured 2026-06; served `no-store`, so every visit pays it). Comments deliberately kept readable for View Source. |
| `holding/writing/` | Written content as plain `.txt` files + `posts.json` registry `[{slug,title,date}]`. The worker renders each as an XP **Notepad** window at `/writing/<slug>` (a server-rendered `<textarea>` seeded with the canonical text — editable by nature, ephemeral by nature: no save → reload restores canonical, "writing in flux"), plus a "My Writing" folder index at `/writing`. Raw `.txt` stays fetchable at `/writing/<slug>.txt`. Author a post = drop a `.txt` + a `posts.json` entry. Render code (`handleWritingIndex`/`handleWritingPost`/`NOTEPAD_CSS`) lives in `_worker.js`. |
| `holding/notepad.js` | Behavior for the `/writing` Notepad view (deferred, SW-cached): per-window `enhance()` wiring File/Edit/Format/View/Help menus, live Ln/Col + word-count status bar, Word-Wrap toggle, the classic **F5 time/date** stamp (Temporal w/ Date fallback), Select All, Print, About. Also opens folder notes as **popovers** that composite over the folder index, deliberately without touching the address bar (notes are `popover="manual"`, so several stay open at once and one URL couldn't honestly name three windows; Esc closes the topmost). The permalink stays real: each row is an `<a href="/writing/<slug>">` the worker serves standalone, and a modified click passes through to it. Chrome itself is SSR'd by `_worker.js`. No-op without a `.np-window`. |
| `holding/tooltip.js` | Rich XP hover island for photos, tracks, artists, and car references. The homepage keeps only a tiny inline loader that idle-prefetches this module and replays a cold first hover; coarse-pointer visitors never load it. |
| `holding/nav.js` | Site-wide XP **desktop shell**. The ONE shared external asset (deferred, SW-cached) — every page includes `<script src="/nav.js" defer>`; it injects its own `<style>` + builds, into `<body>`: the **Bliss desktop** wallpaper, **draggable desktop icons** (Notepad + the 5 profiles, positions persisted in localStorage), the **taskbar** (Start orb → Run, first-level-subpage app buttons each with a per-section SVG icon, clock via Temporal), and the **Run** command palette (⌘K / Start). Also owns the **OS-window model**: body is a clipping flex desktop, each `.window`/`.np-window` is pinned + its content scrolls internally behind a **custom XP scrollbar**, windows are **draggable** (top is a hard boundary) + **resizable**, and View Transitions animate only the window. Sets each first-level route's **tab favicon** to its section icon. Run destinations: pages + profiles inline; 158 photos lazy-loaded from `/images/manifest.json` with `/images/alt.json` captions. Wired into homepage + all garage pages + worker-gen `/around`,`/whoareyou`,`/bot` + serendipity shell. |
| `holding/quiz.js` | The **understanding-check** widget (deferred, shared, minified at deploy with a `/quiz.src.js` twin). Every garage + LWE content page ends with an active-recall quiz rendered by this one script from an inline `<script type="application/json" id="luq-data">` block: garage pages get an XP GroupBox self-test (`<section id="luq">` mount), LWE pages get the quiz as a continuation of the MSN chat (appended into `.log`, no mount). Misconception-based distractors, deterministic option shuffle, per-page best score in localStorage. The idea is Geoffrey Litt's "Understanding is the new bottleneck" (credited in the widget footer); /lens carries the same pedagogy in copy (predict-then-check mode notes, the Delta counterfactual lab as a Papert micro-world). |
| `holding/_worker.js` | The module worker (bundled by wrangler at deploy). Owns routing, photo serving from R2, manifest building, Spotify playlist scraping, AadharshBot crawler, the `/writing` Notepad pages, cache-control overrides. |
| `holding/_headers` | Static-asset cache + security headers (CSP, Permissions-Policy, etc.). Applied to direct static-asset requests; the worker overrides cache-control for select paths. |
| `holding/sw.js` | RETIRED (v136, 2026-07-03): now a ~15-line unregister stub (skipWaiting, delete caches, claim, unregister) that must keep serving 200 for a year+ so installed copies clean themselves up. No CACHE_VERSION anymore; the deploy-log vnum lives in D1 alone (bump-version.sh derives the next from MAX(vnum)). Repeat-visit speed comes from immutable assets + bfcache + speculation prerender. |
| `holding/llms.txt` | The llms.txt format — concise site summary for LLMs. Linked from `<link rel="alternate">`. |
| `holding/index.md` | Markdown source of homepage copy (used by `/llms.txt` and as a fallback). |
| `holding/sitemap.xml`, `robots.txt` | Standard SEO files. robots.txt explicitly allows AadharshBot. |
| `holding/.well-known/http-message-signatures-directory` | JWKS for AadharshBot's Ed25519 public key (Web Bot Auth IETF draft). |
| `holding/images/` + `holding/i/` | `images/` holds the photo DATA surfaces: `metadata.json` (EXIF index), `meta/<stem>.json` (per-photo EXIF plus four 64-bin histogram channels the tooltip fetches), `alt.json` (AI captions), `hashes.json` (stem to hash8 map). The pixel tiers (600px AVIF+JPG squares + 400px mobile AVIF) live in `i/` under content-hashed names, 474 files for 158 photos. |
| `holding/scripts/` | Photo-pipeline + asset scripts (see below). Beyond the core pipeline (`add-photos.sh`, `extract-photo-metadata.sh`, `check-photo-pipeline.mjs`, `build-jpegli.sh`): `add-car-photo.sh` (one resto-mod reference photo into the dual AVIF+JPG pair the car-link tooltips expect, output `holding/cars/<stem>.{avif,jpg}`, no EXIF/R2); `gen-alt-text.py` (AI alt text for every grid photo via the cf-garage Workers-AI caption endpoint, writes `holding/images/alt.json` `{stem: alt}`, resumable); `gen-encoding-samples.sh` (regenerates the color sample set for the `/garage/encoding` study through every encoder, prints byte counts + bytes-per-pixel); `reencode-thumbnails.sh` (re-encodes all published grid thumbnails as pre-cropped center squares from the canonical source folder, two square tiers); `photo-histograms.py` (bakes the four 64-bin RGB/luminance channels into each per-photo meta file). |

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
   |   tooltip actually fetches on hover). photo-histograms.py then bakes
   |   four 64-bin RGB/luminance channels into those files from the shipped
   |   hashed JPG tier, so the tooltip has a stable, whole-image histogram.
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
- **Pillow** (`python3 -m pip install -r holding/scripts/requirements.txt`) — required by
  `photo-histograms.py` to bake the four 64-bin RGB/luminance channels from
  the shipped hashed JPG tier.

### `<picture>` + content-addressed thumbnails

Photo thumbnails are dual-encoded AVIF + JPG, served via `<picture>` from
content-hashed URLs (cutover 2026-07-03):

```html
<a href="/images/full/<filename>" data-full="..." data-size="..." data-uploaded="...">
  <picture>
    <source type="image/avif" media="(max-width: 560px)" srcset="/i/<stem>-400.<hash8>.avif">
    <source type="image/avif" srcset="/i/<stem>.<hash8>.avif">
    <img src="/i/<stem>.<hash8>.jpg" loading="lazy" decoding="async">
  </picture>
</a>
```

**A URL names exact bytes.** `scripts/hash-thumbnails.sh` (run by
add-photos.sh) sha256-hashes each tier into `holding/i/` and writes
`holding/images/hashes.json`, which `buildImagesManifest` bakes into the
manifest's absolute `thumb_avif`/`thumb_jpg`/`thumb_small` URLs. `/i/*` is
edge-direct + immutable-1y; a re-encode mints a new URL, so there is no
global version bump and no way for a cached 404 to shadow real bytes.
`THUMB_VERSION` is gone (retired once hashes.json went 100% complete). There
is no legacy-fallback URL shape: a stem missing from hashes.json means a
half-run pipeline, so `buildImagesManifest` skips it and logs the gap rather
than baking a broken `/i/undefined` tile.

Legacy `/images/<stem>.<ext>[?v=N]` URLs 301 into `/i/` at the worker (kept
for a year+ for old links); unknown names still get the 404 cache-clamp so
a miss can't inherit an immutable rule. Workers static assets return honest
404s; the old Pages SPA-fallback masquerade is gone.

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
  (~3 GB / 158 photos at FUJIFILM X-T5 + Leica resolution).
- **ASSETS** — the Workers static-assets binding (wrangler.jsonc `assets`), serves files from holding/.
- **RESTORE_DB** — D1 database `aadhar-restore` (id `88c8daf1-3a36-4f8e-a2ad-dba8a74e1b9f`),
  the **single source of truth for the deploy log**. One row per logged deploy
  (bump-version.sh insert; the retired SW's `CACHE_VERSION` used to carry the
  number), seeded from git history. BOTH `/restore` (the restore-point
  scrubber + "You are here" banner) AND `/updates` (Windows Update changelog + running
  build) read this one `checkpoints` table, so they cannot drift apart. Schema:
  `checkpoints(vnum INTEGER PK, ts INTEGER, ymd TEXT, version TEXT, slug TEXT, title TEXT)`
  — `slug` is the version suffix / changelog tag, `title` is the human description.
  **Configured in `wrangler.jsonc`** (d1_databases), like every other binding
  since the Workers migration.
  **Log a deploy** (so both pages stay current):
  `./holding/scripts/bump-version.sh <slug> "<title>"`, then deploy. It derives
  the next vnum from `SELECT MAX(vnum)` and inserts the checkpoint (no file edit;
  the SW that used to carry the version string retired in v136).
- **CF_ACCOUNT_ID + BROWSER_RENDER_TOKEN** — CF_ACCOUNT_ID is a var in
  `wrangler.jsonc`; BROWSER_RENDER_TOKEN is a Worker secret (`wrangler secret put`) that power `/lens/shot`, the
  Browser Rendering screenshot fallback inside **`/lens`** ("The Other Web", which shows
  any URL the way a machine does). `/lens`'s Human view embeds framable sites in a live
  cross-origin `<iframe>` (loaded by the visitor's own browser) and screenshots the rest
  server-side via Cloudflare Browser Rendering's REST API (`POST /accounts/<id>/browser-rendering/screenshot`,
  returns raw PNG bytes). `CF_ACCOUNT_ID` is the plain account id; `BROWSER_RENDER_TOKEN`
  is a secret API token scoped to **Account · Browser Rendering · Edit**. Without both,
  `/lens/shot` returns a clean 503 and the Human view falls back to the readable-text
  reader, so the live iframe + all four machine lenses keep working regardless.
  Screenshots are KV-cached 1h (`lens:shot:<sha256(url)>` in RN_KV) and rate-limited to
  8/min/IP; `/lens/fetch` (the parsing engine) is rate-limited 30/min/IP. Both `/lens/*`
  fetch routes guard against SSRF (http(s) only, no localhost / private / link-local /
  `169.254.169.254` hosts, ports 80/443 only, 8s timeout, 2MB cap) and identify honestly
  as AadharshBot. Framability is read from the target's `X-Frame-Options` /
  `Content-Security-Policy: frame-ancestors` in the `/lens/fetch` pass, so no extra probe.

### XP visual vocabulary (CSS)

**Design system:** [`design/DESIGN.md`](design/DESIGN.md) is the Luna brief (canonical
reference + DON'T-modernize guardrails); [`design/tokens/`](design/tokens/) is the
canonical token set (fonts, Luna palette, bevels, radii). Pull from those before
hardcoding any color/font/bevel. Captions = Trebuchet MS, UI/body = Tahoma→Verdana,
mono = Courier New — those three stacks only.

**HARD RULES (strong owner preference):** (1) **internal/native fonts ONLY** — never ship `@font-face` with `url()`, web fonts, `@import`, or font preloads; the served pages carry ZERO font bytes (the design system's `@font-face local()` rules are reference-only, never inlined into a served page). (2) **keep perf lean** — fold design tokens in WITHOUT regressing the byte budget: on a brotli'd inline page, tokenizing repeated literals is a wash (brotli already dedupes) while token *definitions* are net-new bytes, so only the FONT tokens (`--font-*`) are inlined site-wide; color/gradient tokens are NOT inlined (they cost bytes for no brotli gain). no external stylesheet, no JS for styling. (3) **authoring stays buildless; serving is minified** — the ONLY build is `build.mjs` (deploy-time transform: minifies the six client scripts + `luna.css` into a staged `.build/` copy, ships readable `/<name>.src.js` / `/luna.src.css` twins alongside; also hard-fails the deploy if `luna.css` doesn't parse). `wrangler.jsonc` self-builds via its `build.command` and points `main`+`assets` at `.build/holding`, so NO deploy path (bare `wrangler deploy`, `npm run deploy`, Workers Builds) can ship the readable originals; local dev uses `wrangler.dev.jsonc` (readable `holding/`, fast reload). Never minify `index.html` or the garage/lwe HTML (View Source is part of the design), never bundle, never extend the build to more CSS or HTML without the owner's say-so (`luna.css` was owner-approved 2026-07 for an ~8.7KB brotli win on a render-blocking sheet).

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

## cal/ — coffee booking module

Custom-built scheduler at `aadhar.sh/coffee`. Replaces Cal.com. Inspired by
[jry.io/bagel](https://jry.io/bagel). Crediting Jacob Young in the footer.

**Status: LIVE at aadhar.sh/coffee**, delegated by the root `aadhar-sh` Worker.
The source remains in `cal/src/` so its booking, calendar, and email policies
stay readable and testable; `build.mjs` stages it beside the holding Worker
entrypoint. Production secrets (`ICAL_URL`, `RESEND_API_KEY`, and
`SIGNING_SECRET`) belong to the root Worker. `cal/wrangler.test.toml` is only a
Vitest runtime fixture, never a deployment config.

### Architecture

- Public ICS feed (Google/iCloud) is the read-only source of busy intervals,
  read via `fetchBusySWR`: a last-good snapshot in KV (`cal:busy`, 5-min
  freshness, 2s upstream deadline, stale fallback) so a slow/down feed never
  gates the page. The GET page edge-caches 30s (invalidated on booking action);
  `/slots` stays live.
- `generateSlots()` computes bookable slots from working hours config
- `POST /book` creates a pending booking in KV, emails the host with
  HMAC-signed approve/decline links (Resend free tier). It **fails closed**: if
  the calendar snapshot is unavailable or older than 15 min, it 503s rather than
  book over a real event it can't see (the old code returned `[]` on ICS failure,
  making every slot look free — a double-booking risk).
- Host clicks approve → confirmed → `.ics` invite to requester
- Host clicks decline → polite auto-reply
- Cron triggers a weekly sweep of un-acted pending bookings

### Files

```
cal/
├── wrangler.test.toml  — test-only KV/vars config for Vitest (not deployed)
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
npm install
npx wrangler secret put -c wrangler.jsonc ICAL_URL        # Google Calendar → "secret ICS"
npx wrangler secret put -c wrangler.jsonc RESEND_API_KEY  # resend.com, DKIM-verify aadhar.sh
openssl rand -hex 32 | npx wrangler secret put -c wrangler.jsonc SIGNING_SECRET

# Production still ships through merge -> CI -> production -> Workers Builds.
# Local fallback, from the repository root only:
npm run deploy
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

9. **HISTORICAL (Pages era): `wrangler pages deploy holding`** is retired.
   Production is merge → CI promotion to `production` → Workers Builds; the
   local fallback is `npm run deploy` from the repository root.

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

- The original `/Users/aadharsh/noodling/.claude/worktrees/silly-goldberg-6b0687/`
  worktree still exists (branched off `oddharsh/serendipity` on GitHub). It
  has the same code in it but is no longer the source of truth. Future work
  should happen in this directory.
- The GitHub remote exists: `origin` points at `git@github.com:oddharsh/site.git`.
- `node_modules/`, `.wrangler/` build cache, and `.DS_Store` files were
  intentionally not copied. They'll regenerate as needed.
