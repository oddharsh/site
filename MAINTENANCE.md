# Maintenance runbook

For future me. Every recurring chore on aadhar.sh, organized by "I want to ___",
with the exact command and the gotcha that bit me last time. Deep design notes
and the full conventions list live in [CLAUDE.md](CLAUDE.md); this is the ops sheet.

One site Worker, with three source islands:
- **holding/** (aadhar.sh): the **Cloudflare Worker with static assets** (migrated off Pages 2026-06-30). Config is `wrangler.jsonc` at the repo root: it points `main` + `assets.directory` at `.build/holding` and runs `build.mjs` via its `build.command`, so `assets.run_worker_first` (an allowlist mirroring the `ROUTES`/`PREFIX` tables in `index.js`; static is the default) applies to the built tree; `workers_dev:false` (custom domain only). **Production deploy: merge to `main`; GitHub CI promotes the exact tested commit to the machine-owned `production` branch, then Cloudflare Workers Builds deploys it.** The config self-builds, so the Workers Build Deploy command ships the minified tree; local dev uses `wrangler.dev.jsonc` (readable `holding/`, fast reload). A local `wrangler deploy` is fallback-only. Verify after every deploy with `node verify-routes.mjs https://aadhar.sh` (now also asserts `/nav.js` minified + `.src` twins resolve). All site bindings live in `wrangler.jsonc`; secrets via `wrangler secret put`.
- **cal/** (coffee booking module): **LIVE** at `aadhar.sh/coffee`, dispatched by the same `aadhar-sh` Worker. Availability still serves from an SWR calendar snapshot (KV `cal:busy`, 2s upstream deadline, stale fallback); the GET page edge-caches 30s; booking fails closed if the calendar can't be vouched for. See [cal/README.md](cal/README.md). `cal/wrangler.test.toml` is test-only; it is not a deployment target.
- **serendipity/** (event dashboard module): **LIVE** at `aadhar.sh/serendipity`, dispatched by the same `aadhar-sh` Worker. Its D1, secrets, route-specific CSP, and dashboard cache policy remain isolated in the module and shared root bindings.

**Deploy sanity:** after Workers Builds deploys the promoted commit, verify the live route oracle. `_headers` and `.assetsignore` (which excludes `_worker.js` from being served) both work natively on Workers static assets. `_worker.js/` is the bundled Worker entry, not a served asset. The old Pages "static-only, no Function" outage class no longer applies (a Worker deploy is atomic).

**Consolidation cutover:** before the first production deploy, set the former
Cal secrets (`ICAL_URL`, `RESEND_API_KEY`, `SIGNING_SECRET`) and Serendipity
secrets (`SYNC_SECRET`, `EXA_API_KEY`, `PARALLEL_API_KEY`, `COVER_SECRET`) on
the root `aadhar-sh` Worker. After the new route smoke tests pass, remove the
old `cal-aadhar-sh` and `serendipity` route/custom-domain ownership so only
the root Worker receives `/coffee*`, `/serendipity*`, and `cal.aadhar.sh/*`.

The legacy `cal.aadhar.sh/` host redirects to the canonical `/coffee` page.
The exact work-calendar slug and its Google Calendar destination are Worker
secrets (`WORK_CALENDAR_SLUG`, `WORK_CALENDAR_URL`); both can be rotated
without changing the route or source code.

## CI/CD release path

`.github/workflows/ci.yml` is the pull-request gate. It installs locked
dependencies, builds the site, enforces the performance budget, dry-runs
the single site Worker plus the `cf-garage/` and `lwe-ask/` auxiliary Wrangler
configs, and runs `cal/npm test`. Cal and Serendipity are bundled into the site
Worker; their source modules and Cal behavioral suite remain inside the
pull-request gate.

`.github/workflows/update-wrangler.yml` runs weekly (and on manual dispatch),
resolves the newest published Wrangler, applies the same exact version to the
root site Worker and auxiliary Worker projects through the shared lockfile, then
opens or refreshes a draft PR.
The exact lockfile pin keeps a release reproducible; the scheduled PR keeps it
current. Wrangler's npm dependency metadata instrumentation is explicitly
enabled in every Worker config.

`.github/workflows/promote-production.yml` runs after a successful `CI` run for
`main` associated with a merged PR (or an explicit manual dispatch). It refuses
unmerged commits, then advances the machine-owned `production` branch to the
exact tested SHA. Cloudflare Workers Builds watches that branch and is the only
production publisher. Configure one Workers Build project for the site Worker
with `production` as the production branch and monorepo root `.`, leave its
dashboard Build command blank, and use `npx wrangler deploy` as the Deploy
command. GitHub does not need Cloudflare production secrets for this path.

### Performance budget semantics

`npm run perf-budget` is intentionally split into hard build invariants and
advisory wire-size observations. Hard failures cover CSS validity, deploy-time
minification markers, readable source twins, and missing expected assets. The
client asset envelopes are measured in gzip and Brotli, not raw authoring bytes;
they are role-aware and deliberately have room for ordinary feature work. The
Worker gzip number is a growth alert, not a user-experience ceiling: Worker code
is server-side, so it must earn a hard limit through measured TTFB or CPU impact.

Cloudflare Web Analytics/RUM is the outcome source for LCP, INP, CLS, FCP, and
page-load behavior. Until it has a useful baseline, do not turn an advisory
asset warning into a CI failure. Use a controlled mobile/4G browser run for
repeatable pre-merge checks; once field data is sufficient, replace guessed
byte ceilings with route/cohort SLOs and keep bytes as regression signals.

The Workers Build project should expose its build/deploy status on the release
commit. After enabling it, verify the live homepage route surface plus
`/coffee`, `/coffee/slots`, and `/serendipity`. This repository's current free
private-repo plan does not support branch/environment protection rules, so the
promotion workflow guard is the release backstop; upgrade or make the repo
public later if hard GitHub-side branch protection is desired.

Before merging the first revision that uses this path, change each Workers
Build project's production branch from `main` to `production`. Otherwise the
merge push can still trigger the old direct production build.

## Understanding-first review

Every pull request uses the author claim card in
`.github/pull_request_template.md` and receives an idempotent reviewer prompt
from `.github/workflows/understanding-review.yml`. The canonical practice is
documented in [UNDERSTANDING-REVIEW.md](UNDERSTANDING-REVIEW.md): reconstruct
the model, name a falsifier, inspect evidence, and leave residual uncertainty
visible. The prompt is advisory; it is not a prose-quality or AI-scoring gate.

## Author a new LWE or Garage explainer

The page generators carry the current editorial contract forward. LWE authors
write `lwe-pipeline/specs/<id>.json`; Garage authors write
`garage-pipeline/specs/<id>.json` and register the page in
`garage-pipeline/pages.json`. Both specs require a reader/problem/thesis/
evidence/uncertainty card and a three-to-seven-question understanding check.

```bash
node lwe-pipeline/generate.mjs page <id>
node lwe-pipeline/generate.mjs wire
node garage-pipeline/generate.mjs page <id>
node garage-pipeline/generate.mjs wire
npm run pages:check
```

The shared contract lives in
[`content-pipeline/page-contract.mjs`](content-pipeline/page-contract.mjs).
It emits the shared quiz payload and runtime, checks the LRS/style guardrails,
and keeps the understanding check diagnostic rather than a gate. Read the
[LWE authoring guide](lwe-pipeline/README.md) and
[Garage authoring guide](garage-pipeline/README.md) before starting a page.

Key facts (don't hardcode these elsewhere, they drift):
- RN_KV namespace id: `3cb8a107c58e47dc9244e75b33401f36`
- R2 bucket: `aadhar-photos` (SOOC originals + full-res JPGs)
- Thumbnails are content-addressed at `/i/<stem>.<hash8>.<ext>` (hashes.json via `hash-thumbnails.sh`); `THUMB_VERSION` in `lib/const.js` survives only for the legacy-fallback URL shape.
- The service worker RETIRED in v136 (2026-07-03): `holding/sw.js` is an unregister stub that must keep serving 200 for a year+. There is no `CACHE_VERSION`; the deploy-log number lives in D1 (`bump-version.sh` derives the next from `MAX(vnum)`).
- Canonical photo source: the aadhar-photos R2 bucket. Raw source files are
  never committed to GitHub; the Actions workflow downloads only the requested
  object keys into disposable runner storage.

---

## Route map (where each URL's code lives)

`holding/_worker.js/` is a **directory** bundled by Cloudflare at deploy. The
dispatcher lives in `index.js`; each route's handler lives in a per-section
module (search the module name to find it). `lib/` holds shared helpers.
Static sections (`/garage/*`, `/lwe/*`, `/cars/*`, shell JS, most discovery
files) are served straight from disk. Worker-owned routes are enumerated in
`index.js`; keep that table and `assets.run_worker_first` in sync.

| URL | Handler / mechanism | module / source |
|---|---|---|
| `/` | homepage prerender (HTMLRewriter over `index.html`) + markdown negotiation | `home.js` |
| `/index.html` | 301 -> `/` | `index.js` |
| `/favicon.ico` | inline traffic-cone SVG | `index.js` |
| `/auth.md`, `/.well-known/api-catalog`, `/.well-known/agent-card.json`, `/.well-known/oauth-*` | `serveFreshAsset` (static cards) | `lib/assets.js` |
| `/agent/auth`, `/agent/auth/claim`, `/oauth2/token`, `/oauth2/revoke` | `handleAgentAuth*` | `agent.js` |
| `/whoareyou`, `/whoareyou.json` | `handleWhoareyou` / `handleWhoareyouJson` | `whoareyou.js` |
| `/security` | `handleSecurityCenter` | `security.js` |
| `/reading` | `handleReading` (Curius) | `reading.js` |
| `/updates`, `/updates.json`, `/restore` | `handleWindowsUpdate` / `handleUpdatesJson` / `handleSystemRestore` (D1) | `updates.js` |
| `/lens`, `/lens/`, `/lens/fetch`, `/lens/shot` | `handleLens` / `handleLensFetch` / `handleLensShot` | `lens.js` |
| `/coffee`, `/coffee/*` | Cal booking module delegation | `../cal/src/index.js` |
| `/serendipity`, `/serendipity/*` | Serendipity module delegation + local CSP | `../serendipity/serendipity.js` |
| `/lens.js` | static client renderer | `holding/lens.js` (served asset) |
| `/llms-full.txt` | `handleLlmsFull` (x402 bot paywall; free until `X402_PAY_TO` is set) | `x402.js` |
| `/ledger`, `/ledger.json` | `handleLedger` / `handleLedgerJson` (AI-crawler invoice from Analytics Engine; counting via `countCrawlerHit` in `index.js`) | `ledger.js` |
| `/writing`, `/writing/`, `/writing/<slug>` | `handleWritingIndex` / `handleWritingPost` (Notepad) | `writing.js` |
| `/writing/<slug>.txt`, `/writing/posts.json` | ASSETS passthrough (dotted paths fall through) | n/a |
| `/rn`, `/rn/tracks`, `/rn/admin`, `/rn/set` | `handleRn` / `handleRnTracks` / `handleRnAdmin` / `handleRnSet` | `rn.js` |
| `/bot` | `handleBotPage` | `bot.js` |
| `/around`, `/around/json` | `handleAround` / `handleAroundJson` (AadharshBot crawl) | `around.js` |
| `/images`, `/images/full` | 301 -> trailing slash | `index.js` |
| `/images/*` selected routes (listings, manifest, metadata, R2 originals, thumb 404 clamp) | `handleImages*` / `servePhotoFromR2` + asset 404 clamp in `index.js` | `photos.js` (+ `index.js`) |

The shared toolbox: `lib/const.js` (THUMB_VERSION, CANONICAL_HOST), `lib/http.js`
(esc, json/error responses, markdown negotiation), `lib/security.js` (security +
discovery headers), `lib/chrome.js` (the XP window CSS + `lunaPage` shell),
`lib/cache.js` (`swrKV` + `cachedRender`), `lib/botauth.js` (AadharshBot signed
fetch), `lib/assets.js` (`serveFreshAsset` + asset 404 clamp).

### Bindings the worker reads (`env.*`)

KV/R2/D1/DO are resource bindings; the rest are secrets. Bindings live in
wrangler.jsonc; secrets on the Worker via `wrangler secret put`. Every use is
guarded, so a missing binding degrades, it doesn't crash.

| `env.*` | Kind | What |
|---|---|---|
| `ASSETS` | (auto) | Workers static assets binding (wrangler.jsonc `assets`) |
| `RN_KV` | KV | tracks, manifest, artist pics, crawler caches (`3cb8a107c58e47dc9244e75b33401f36`) |
| `PHOTOS_R2` | R2 | bucket `aadhar-photos`, SOOC originals |
| `RESTORE_DB` | D1 | `/restore` + `/updates` changelog store |
| `SERENDIPITY_DB` | D1 | Serendipity event dashboard |
| `BOOKINGS` | KV | Cal pending/confirmed bookings + calendar snapshot |
| `COUNTER` | Durable Object | cross-script binding to cf-garage's Counter (homepage visits) |
| `RN_SIGNING_KEY_JWK` | secret | AadharshBot Ed25519 signing key (RFC 9421) |
| `BROWSER_RENDER_TOKEN`, `CF_ACCOUNT_ID` | secret | Browser Rendering for `/lens/shot` |
| `BOT_LEDGER` | Analytics Engine | dataset `aadhar_bot_ledger` — AI-crawler hit counts for `/ledger` (absent → counting silently off) |
| `ANALYTICS_READ_TOKEN` | secret | API token (Account Analytics : Read) so `/ledger` can query the dataset back; absent → invoice renders with a "meter not readable" note |
| `X402_PAY_TO` | var or secret | receiving EVM address for the `/llms-full.txt` x402 paywall; absent → file serves free with `x-payment-note` |
| `X402_NETWORK`, `X402_FACILITATOR` | var | optional x402 overrides: network (`base` default, `base-sepolia` for tests) + verify/settle facilitator URL (default `https://x402.org/facilitator`, which is testnet-only — mainnet needs e.g. Coinbase CDP's) |
| `RN_BUST_SECRET` | secret | guards `/rn/admin` + `/rn/set` |

### Verify the whole route surface

`node verify-routes.mjs [baseUrl]` curls every route and asserts status +
content-type (+ markers). All-green ("0 hard failure(s)") is the gate before and
after any deploy. The skeuomorphic `_worker.js/` module tree was extracted with
this as the regression tripwire; keep it green on every future change.

---

## Remote image pipeline

The normal photo path is entirely remote:

1. Upload the source object to the aadhar-photos R2 bucket.
2. Run [Remote photo pipeline](https://github.com/oddharsh/site/actions/workflows/photo-pipeline.yml).
3. Enter the exact R2 object key(s), or all for a complete thumbnail re-encode.
4. Review and merge the generated artifact PR through the normal CI and
   production-promotion path.
5. After Workers Builds has deployed the merge, run
   [Bust remote photo manifest](https://github.com/oddharsh/site/actions/workflows/bust-photo-manifest.yml).

The photo-processing workflow needs no Cloudflare secret: it reads source
objects through the public /images/full/<key> route and skips R2/KV writes.
The cache-bust workflow needs repository secrets
PHOTOS_CLOUDFLARE_API_TOKEN (Workers KV edit only) and
CLOUDFLARE_ACCOUNT_ID.

The GitHub-hosted macOS runner installs the Homebrew tools, builds the pinned
jpegli revision, runs the selected routine, and discards the source files when
the job ends. The runner is the only execution host; nothing on the author's
machine is part of the contract.

The `Refresh image toolchain` workflow runs weekly and can be dispatched manually. It checks the upstream jpegli HEAD, opens a PR with the new pinned revision plus regenerated encoding-study evidence, and records Homebrew formula versions in the Actions summary. Dependabot covers the Actions, npm, and Pillow layers; Homebrew formulas and the jpegli source commit remain under this workflow's review.

## Local fallback setup

```bash
brew install exiftool jq mozjpeg libavif cmake ninja   # mozjpeg = jpegtran; libavif = avifenc (optional, sips falls back)
python3 -m pip install -r holding/scripts/requirements.txt  # Pillow for histogram baking
./holding/scripts/build-jpegli.sh                      # builds cjpegli -> ~/.local/bin (Google's JPEG encoder)
wrangler login                                         # Cloudflare auth (deploys + KV + R2 all use it)
```
This is an emergency fallback only. sips is macOS-native (no install), and the
normal path is the remote workflow above.

---

## Add photos (local fallback only)

```bash
# The normal remote path is the Remote photo pipeline workflow above.
# This local command remains for recovery when Actions or R2 ingress is unavailable.
./holding/scripts/add-photos.sh "/path/to/photo.HIF" [more files...]
# then it prints the deploy line; run it:
npm run deploy   # local fallback only; normal production is merge + CI promotion
```
- Accepts JPG/PNG/HEIF/HIF. JPGs are uploaded as supplied; HEIF/HIF sources
  remain archive objects and also produce a full-resolution maximum-quality
  q100 JPG export as the `/images/full/<stem>.jpg` click target.
- Emits the 600px JPG fallback, 600px AVIF, and 400px mobile AVIF tiers;
  regenerates EXIF metadata; bakes the four 64-bin RGB/luminance histograms;
  and runs `npm run photos:check` before busting the manifest cache.
- The remote render-only path defers the `manifest:images` bust until the
  separate post-deploy workflow; the local fallback performs its normal KV
  writes.
- A thumbnail can't go stale anymore: its URL is its bytes (`/i/<stem>.<hash8>`). If one looks wrong, re-run `hash-thumbnails.sh` and bust the manifest (value + `:fresh`); a changed file gets a new URL automatically.

### Regenerate just the EXIF metadata (photos already uploaded)
```bash
./holding/scripts/extract-photo-metadata.sh "/path/to/sooc-originals"
```
The normal remote equivalent is the `refresh-metadata` routine in the Remote
photo pipeline workflow. Local `--merge` mode updates only a selected batch;
the full directory mode rebuilds the metadata index. Every field is nullable;
the tooltip skips nulls rather than guess.

### Re-encode ALL thumbnails (e.g. a new resolution/quality)
```bash
./holding/scripts/reencode-thumbnails.sh           # re-encodes every grid thumb as pre-cropped center squares
# bump THUMB_VERSION in holding/_worker.js/lib/const.js, then deploy
```
`SQ_SM` (mobile tier) must match `THUMB_SMALL_PX` in `_worker.js` (the `-<N>.avif` suffix). add-photos.sh mirrors this script's two encode paths; keep them in sync.

### Add a car reference photo (homepage tooltip)
```bash
./holding/scripts/add-car-photo.sh <stem> <input-image>   # stem: singer | tuthill | hwa-evo | f355
```
Outputs `holding/cars/<stem>.{avif,jpg}` (no EXIF, no R2). Bump the `?v=` on that car image in `index.html` if you replace one in place, then deploy.

### Generate AI alt text for the grid
```bash
python3 holding/scripts/gen-alt-text.py     # writes holding/images/alt.json {stem: alt}
```
Resumable: only fills uncaptioned stems, so a 429 (Workers-AI neuron budget) just means run again later. Deploy after.

### Regenerate the /garage/encoding study samples
```bash
./holding/scripts/gen-encoding-samples.sh [STEM] [SRC_DIR]
```
Prints byte counts + bytes-per-pixel so the figcaptions on `/garage/encoding` can be updated to match. The grayscale (`g-*`) set is generated separately and is not touched.

---

## Change the now-playing playlist

The homepage scrapes a Spotify playlist; `playlist-id` in KV points at it. To swap it
(this is the sequence that actually works, the `/rn/set` endpoint needs `RN_BUST_SECRET`):

```bash
NS="3cb8a107c58e47dc9244e75b33401f36"
OLD=$(wrangler kv key get --namespace-id="$NS" playlist-id --remote)   # save the current id
wrangler kv key put --namespace-id="$NS" playlist-id "<NEW_22_CHAR_ID>" --remote
# clear the old playlist's two-key SWR cache (value + freshness sentinel):
wrangler kv key delete --namespace-id="$NS" "tracks:${OLD}" --remote
wrangler kv key delete --namespace-id="$NS" "tracks:${OLD}:fresh" --remote
curl -s "https://aadhar.sh/rn/tracks" >/dev/null                       # warms tracks:<new> by scraping
wrangler deploy   # from the repo root; deploys the aadhar-sh Worker (holding/ as static assets)
```
- The id is the 22 chars after `/playlist/` in the share URL (drop `?si=...`).
- **Why the redeploy:** the worker caches `playlist-id` in a module variable (`_playlistId`) per warm isolate. A redeploy recycles isolates so the homepage *prerenders* the new list immediately instead of waiting for them to age out.
- **zsh gotcha:** write `"tracks:${OLD}:fresh"` with braces. Bare `tracks:$OLD:fresh` triggers a zsh history modifier (`:r` etc.) and silently mangles the key.
- One-shot alternative once you have the secret: `curl "https://aadhar.sh/rn/set?secret=$RN_BUST_SECRET&url=<playlist-url>"`.

---

## Bust a cache

```bash
NS="3cb8a107c58e47dc9244e75b33401f36"
# photo manifest (forces re-derive from R2; the value is two-key SWR, deleting the value is enough):
wrangler kv key delete --namespace-id="$NS" "manifest:images" --remote
# directory-listing indexes:
wrangler kv key delete --namespace-id="$NS" "idx:images" --remote
wrangler kv key delete --namespace-id="$NS" "idx:imagesfull" --remote
# a specific playlist's tracks (delete both keys):
wrangler kv key delete --namespace-id="$NS" "tracks:<id>" --remote
wrangler kv key delete --namespace-id="$NS" "tracks:<id>:fresh" --remote
```

### Bump THUMB_VERSION
Mostly retired (hash cutover 2026-07-03): thumbnails are content-addressed at `/i/<stem>.<hash8>.<ext>`, so a re-encode mints new URLs by itself — run `./holding/scripts/hash-thumbnails.sh` after re-encoding, bust `manifest:images` + `manifest:images:fresh`, deploy. `THUMB_VERSION` survives only in the legacy-fallback URL shape (stems missing from hashes.json) and in the `/images/<thumb>` 301 layer's inputs; it should never need bumping. The worker route still clamps unknown-thumb 404s to `max-age=0` so misses do not inherit immutable caching.

### Log a deploy (bump-version.sh)
`./holding/scripts/bump-version.sh <slug> "<title>"`, then deploy. Inserts the next checkpoint into D1 (vnum from `SELECT MAX(vnum)`), which is what `/updates` and `/restore` render. Nothing edits sw.js anymore: the service worker retired in v136, `nav.js`/`notepad.js` updates land via their short `_headers` max-age plus the per-deploy edge purge, and the stub at `/sw.js` cleans up old installs.

---

## Verify things

```bash
dig _index._agents.aadhar.sh SVCB +dnssec +short          # DNS-AID agent-discovery record
curl -s https://aadhar.sh/.well-known/http-message-signatures-directory | jq .   # AadharshBot JWKS (Web Bot Auth)
curl -sD- -o /dev/null "https://aadhar.sh/images/<stem>.avif?v=<N>"  # a thumb: expect 200 image/avif, 1yr immutable
curl -s "https://aadhar.sh/images/manifest.json" | jq length          # photo count
```

---

## The scripts (`holding/scripts/`)

| script | what it does |
|---|---|
| `add-photos.sh` | Full pipeline for new photos: resize, EXIF-rotate, encode AVIF+JPG center-square thumbs, upload the full-resolution browser copy to R2, regenerate metadata, bake histograms, validate the artifact graph, and bust the manifest KV keys. |
| `check-photo-pipeline.mjs` | CI-safe invariant check: every metadata stem has all three hashed tiers, per-photo metadata, and four 64-bin histogram channels, with no orphaned pixel files. |
| `extract-photo-metadata.sh` | Read EXIF from the SOOC folder, emit `images/metadata.json` + per-photo `images/meta/<stem>.json`. Pulls the Fuji recipe fields too. Requires exiftool + jq. |
| `reencode-thumbnails.sh` | Re-encode every published grid thumb from the source folder at a new resolution (pre-cropped squares, two tiers). Pair with a THUMB_VERSION bump. |
| `add-car-photo.sh` | One resto-mod reference photo -> `cars/<stem>.{avif,jpg}` for the homepage car tooltips. No EXIF, no R2. |
| `build-jpegli.sh` | Build Google's `cjpegli`/`djpegli` from the pinned upstream revision to `~/.local/bin`; update `JPEGLI_COMMIT` deliberately. Requires cmake + ninja + clang. |
| `download-remote-photos.sh` | Download selected R2 object keys into disposable runner storage for the GitHub Actions photo workflow; accepts `all` for the public manifest. |
| `gen-alt-text.py` | AI alt text for grid photos via the Workers-AI caption endpoint -> `images/alt.json`. Resumable. |
| `gen-encoding-samples.sh` | Regenerate the color sample set for `/garage/encoding` through every encoder; defaults to the committed `garage/enc/c-png.png` fixture and prints byte counts. |
| `photo-histograms.py` | Bakes four 64-bin RGB/luminance histogram channels into each per-photo `images/meta/<stem>.json` from the shipped hashed JPG tier. Requires the pinned Pillow dependency in `holding/scripts/requirements.txt` and is called by both metadata extraction and `add-photos.sh`. |

---

## Gotchas that have bitten me

- **Thumbnail 404s must be uncacheable.** Workers static assets no longer return homepage HTML for missing files, but a real miss under `/images/*` can still inherit the immutable cache rule unless the worker clamps it. Keep the thumbnail route worker-first and bump `THUMB_VERSION` when you need a fresh cache key.
- **zsh eats `${var}:something`.** Brace-quote KV key names with colons (`"tracks:${OLD}:fresh"`), and use `${=flag}` if you need word-splitting in ad-hoc snippets (the scripts use `#!/usr/bin/env bash` so they are safe internally).
- **`jpegtran` / mozjpeg strip EXIF.** Rotate losslessly with `jpegtran -copy none -rotate N` *before* recompressing, and send its binary stdout to a file (`2>/dev/null > out.jpg`), not through a pipe that could mix in stderr.
- **Production deploy = merge to `main`, CI promotion to `production`, then Workers Builds**; the single site Worker deploys the root `wrangler.jsonc`, bundling `holding/`, `cal/src/`, and `serendipity/` from that exact release branch. The deploy config points `main` + `assets` at `.build/holding` and runs `build.mjs` first through its `build.command`, so the production path self-builds and ships the minified client scripts + `luna.css`. Local dev is the exception: `wrangler dev -c wrangler.dev.jsonc` (`npm run dev`, wired into `.claude/launch.json`) serves the readable tree directly. Before merging, CI runs `npm run perf-budget`; after configuring Workers Builds, verify its release status and run `node verify-routes.mjs https://aadhar.sh` plus the `/coffee` and `/serendipity` route smoke checks.
- **`_playlistId` is module-cached per isolate.** After changing `playlist-id`, redeploy to flush it (see the playlist section).
- **The worker is bundled, not hand-concatenated.** `_worker.js/` imports sibling modules; wrangler bundles them at deploy via built-in esbuild.
- **Authoring is buildless; SERVING is minified.** `build.mjs` (repo root, one devDependency: esbuild) copies `holding/` to `.build/` and minifies the client scripts (`nav.js`, `notepad.js`, `lens.js`, `lens-browser.js`, `quiz.js`, `tooltip.js`) plus `luna.css` (owner-approved 2026-07), deploying each readable original alongside as `/<name>.src.js` / `/luna.src.css` (the banner in each minified file points there). It also hard-fails the deploy if `luna.css` doesn't parse as valid CSS (the v143 corruption slipped through for three releases because esbuild only warns). Everything else — `index.html`, all garage/lwe HTML, images, `_headers`, worker modules — ships byte-identical to git. Do NOT extend the build into bundling, HTML minification, version auto-bumps, or CSS beyond `luna.css`; the scripts remain independently readable islands.
