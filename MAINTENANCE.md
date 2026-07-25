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

## Repository boundary and fresh checkouts

Git is the source of truth for the site code, checked-in configuration, tests,
workflows, and runbooks. A clean clone is intended to be buildable and
pushable; it is not intended to contain every piece of live operational state.

```bash
git clone git@github.com:oddharsh/site.git
cd site
npm ci
npm test --workspace cal
npm run build
npx wrangler deploy --dry-run -c wrangler.jsonc
```

The following are deliberately not committed and should be recreated rather
than copied between checkouts:

- `node_modules/`, `.build/`, `.wrangler/`, `.dev.vars`, and `.DS_Store` are
  local dependencies, build output, credentials, or caches covered by
  `.gitignore`.
- Worker secret values live in Cloudflare, not GitHub: `wrangler.jsonc` names
  them but does not contain them. The contents of KV/R2/D1 are external state
  too, as is Resend's domain verification.
- DNS records, the account resources the bindings point at, the Worker
  inventory, and the Workers Build project settings are still external state,
  but their intended values are now declared in [`infra.json`](infra.json) and
  diffed by `npm run infra:check`. See "Infrastructure declaration" below.
- The curated photo source folder is outside the repository by design; the
  checked-in derivative metadata and image tiers are the repo-facing artifacts.

There are currently no repository symlinks. Do not rely on a case-insensitive
filesystem making two names look like one file. If a symlink becomes a real
repository contract, create it explicitly and confirm Git records mode `120000`:

```bash
git ls-files --stage | awk '$1 == 120000 { print }'
```

Before committing, `git status --short` should show only intentional source
changes, and `git ls-files --others --exclude-standard` should be empty.

## Rotate Cal's calendar or approval secret

Run these from the repository root. They update the live `aadhar-sh` Worker
directly; no GitHub commit or code deploy is required because the values are
Worker secrets. Use `npx wrangler secret list -c wrangler.jsonc` to confirm the
secret is present without printing its value.

### Change the availability calendar (`ICAL_URL`)

Create a new Google Calendar **secret address in iCal format** (or the
equivalent read-only iCloud feed), then replace the secret:

```bash
npx wrangler secret put -c wrangler.jsonc ICAL_URL
```

Paste the new feed URL when prompted. To make the new source take effect
immediately instead of waiting for the current `cal:busy` snapshot to age out,
delete only that derived snapshot and ask the live slots endpoint to refresh:

```bash
BOOKINGS_NS="37acb65118fe485583a90a94cb89365e"
npx wrangler kv key delete --namespace-id="$BOOKINGS_NS" "cal:busy" --remote
curl -fsS https://aadhar.sh/coffee/slots | jq .
```

The feed is cached for up to five minutes at the edge; a changed URL normally
gets a new cache key. The booking path fails closed if the new feed cannot be
read, so verify that `/coffee/slots` returns JSON before relying on it.

### Change the unlisted Google Calendar redirect

This is separate from `ICAL_URL`. `WORK_CALENDAR_URL` is the destination that
the exact secret path on `cal.aadhar.sh` redirects to, and the Worker accepts
only an `https://calendar.app.google/...` destination. Set the destination
first, then the new random-looking path segment:

```bash
npx wrangler secret put -c wrangler.jsonc WORK_CALENDAR_URL
npx wrangler secret put -c wrangler.jsonc WORK_CALENDAR_SLUG
```

Verify the new path without following the redirect and confirm that the old
path no longer matches:

```bash
curl -fsSI "https://cal.aadhar.sh/<new-slug>"
curl -sSI "https://cal.aadhar.sh/<old-slug>" | head
```

The response should be `302` with the expected Google Calendar `Location` for
the new path, and the old path should be `404`. Do not put either value in
GitHub or in a public page.

### Rotate the Cal approval/decline signing secret (`SIGNING_SECRET`)

Generate a new value and replace the Worker secret:

```bash
openssl rand -hex 32 | npx wrangler secret put -c wrangler.jsonc SIGNING_SECRET
```

This immediately invalidates every outstanding approve and decline link. It
does not delete bookings, so any pending requests whose links were invalidated
must be handled manually or allowed to expire after `PENDING_TTL_DAYS`.

For a routine rotation, send one throwaway booking after the change and verify
that the new approval link works. For an emergency rotation, prioritize the
rotation and treat all previously emailed links as compromised.

## CI/CD release path

`.github/workflows/ci.yml` is the pull-request gate. It installs locked
dependencies, builds the site, enforces the performance budget, dry-runs
the single site Worker plus the `cf-garage/` and `lwe-ask/` auxiliary Wrangler
configs, and runs `cal/npm test`. Cal and Serendipity are bundled into the site
Worker; their source modules and Cal behavioral suite remain inside the
pull-request gate.

Dependabot (`.github/dependabot.yml`) keeps the Wrangler pin current: the npm
ecosystem entry at the repository root bumps the single exact root pin (and the
shared lockfile) via PR, alongside the cargo, pip, and github-actions
ecosystems. The exact lockfile pin keeps a release reproducible; the Dependabot
PR keeps it current. Wrangler's npm dependency metadata instrumentation is
explicitly enabled in every Worker config.

`.github/workflows/promote-production.yml` runs after a successful `CI` run for
`main` associated with a merged PR (or an explicit manual dispatch). It refuses
unmerged commits, then advances the machine-owned `production` branch to the
exact tested SHA. Cloudflare Workers Builds watches that branch and is the only
production publisher. Configure one Workers Build project for the site Worker
with `production` as the production branch and monorepo root `.`, leave its
dashboard Build command blank, and use `npx wrangler deploy` as the Deploy
command. GitHub never holds a Cloudflare token that can write, so it cannot
publish to production even if the workflow guard is defeated.

### Infrastructure declaration

`wrangler.jsonc` declares the compute layer and CI dry-runs it, so a bad route
or a missing binding already fails a PR. [`infra.json`](infra.json) covers the
layer above that: DNS records, the account resources the bindings point at, the
Worker inventory, and the Workers Build settings. `npm run infra:check` diffs
the declaration against reality. It is read-only by design and has no apply
path; editing `infra.json` changes what the check demands of production, never
production itself.

Three tiers, by what they cost to run:

| tier | needs | covers |
|---|---|---|
| tree | nothing | binding names agree with `wrangler.jsonc`; every `consumer` file exists; the release block agrees with the Worker config |
| dns | network | every declared record, via DoH against two independent resolvers, plus the nameservers and the DNSSEC `DS` |
| account | a read-only token | the KV/R2/D1 IDs actually resolve; declared Workers are deployed and retired ones are gone |

Same hard-versus-advisory split as the performance budget. A hard failure means
"we checked and it is wrong." An advisory means "we could not check" (resolver
unreachable, no token) and never fails the run, so a network blip cannot redden
a PR that only touched CSS. Use `--strict` to promote advisories to failures
when you want a real audit, and `--offline` for the no-network tier alone.

Resource IDs live in `wrangler.jsonc` and nowhere else. `infra.json` names what
must exist and why, and the checker joins the two by binding name, so the two
files cannot drift into describing different worlds.

**The token.** CI reads `secrets.CLOUDFLARE_API_TOKEN` and the optional
`vars.CLOUDFLARE_ACCOUNT_ID`; with neither set the account tier just skips.
Scope the token to reads only — Account Settings:Read, Workers Scripts:Read,
Workers KV Storage:Read, D1:Read, and Zone:Read on `aadhar.sh`. Nothing in this
repo may hold an `Edit` scope, because Workers Builds being the only publisher
is the release backstop.

```bash
gh secret set CLOUDFLARE_API_TOKEN --repo oddharsh/site
```

**Known blind spot.** Cloudflare publishes no REST endpoint for Workers Builds
project configuration, so the `release` block in `infra.json` is recorded but
unverifiable, and the checker says so on every run. It matters more than most of
what is checked: a non-empty dashboard Build command builds twice, and a command
that runs anything other than `build.mjs` is how production once served an
unminified 78KB `nav.js`. Review it by eye when you touch build settings.

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
npm run og-cards   # bake the page's OG/Twitter card once it's live (see below)
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
- Thumbnails are content-addressed at `/i/<stem>.<hash8>.<ext>` (hashes.json via `hash-thumbnails.sh`); `THUMB_VERSION` is gone entirely (retired with the last legacy fallback — `lib/const.js` keeps only `CANONICAL_HOST` + `ARCHIVE_VERSION`).
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

The shared toolbox: `lib/const.js` (CANONICAL_HOST, ARCHIVE_VERSION), `lib/http.js`
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
| `BROWSER` | Browser Rendering | binding behind `/lens/shot` + `/lens/browser` (Browser Run); absent → clean 503 |
| `CF_ACCOUNT_ID` | var | account id for the Analytics Engine SQL API (`/ledger` reads) |
| `BOT_LEDGER` | Analytics Engine | dataset `aadhar_bot_ledger` — AI-crawler hit counts for `/ledger` (absent → counting silently off) |
| `ANALYTICS_READ_TOKEN` | secret | API token (Account Analytics : Read) so `/ledger` can query the dataset back; absent → invoice renders with a "meter not readable" note |
| `X402_PAY_TO` | var or secret | receiving EVM address for the `/llms-full.txt` x402 paywall; absent → file serves free with `x-payment-note` |
| `X402_NETWORK`, `X402_FACILITATOR` | var | optional x402 overrides: network (`base` default, `base-sepolia` for tests) + verify/settle facilitator URL (default `https://x402.org/facilitator`, which is testnet-only — mainnet needs e.g. Coinbase CDP's) |
| `RN_BUST_SECRET` | secret | guards `/rn/admin` + `/rn/set` |
| `ICAL_URL` | secret | Cal's read-only Google/iCloud availability feed; changing it changes which busy events block slots |
| `RESEND_API_KEY` | secret | Resend API credential used for booking and invite email |
| `SIGNING_SECRET` | secret | Cal HMAC key for approve/decline links; rotating it invalidates outstanding links |
| `WORK_CALENDAR_SLUG` | secret | exact unlisted path segment on `cal.aadhar.sh` for the external calendar redirect |
| `WORK_CALENDAR_URL` | secret | validated `https://calendar.app.google/...` destination for that redirect |
| `SYNC_SECRET`, `EXA_API_KEY`, `PARALLEL_API_KEY`, `COVER_SECRET` | secret | Serendipity sync, enrichment, and image-proxy credentials |

### Files whose only consumer lives outside this repo

Two files have zero inbound references in the tree, so a reference sweep reads
them as detritus. Both have real consumers. Leave them, and re-run the checks
below whenever they look unreferenced again:

- **`holding/bimi.svg`** is the BIMI logo (SVG Tiny-PS, square and full-bleed
  because inboxes circle-crop it). Its consumer is a Cloudflare DNS record, so
  deleting the file breaks mail rather than the site.

  **This one now goes red.** The BIMI record in [`infra.json`](infra.json)
  carries a `consumer` field naming this path, and `npm run infra:check` fails
  if the file disappears. That is the whole reason the `consumer` field exists;
  a DNS record pointing into the tree makes a file load-bearing even though
  nothing here links it. Point any future record at its file the same way.

  ```bash
  dig +short default._bimi.aadhar.sh TXT   # "v=BIMI1; l=https://aadhar.sh/bimi.svg"
  ```

- **`design/styles.css`** is the design system's entry point, four `@import`s
  over `design/tokens/`. Nothing the site serves links it (the site inlines only
  the font tokens, per the byte-budget rule in CLAUDE.md). Its consumer is the
  `aadhar-sh-design` skill package, which lists it in `globalCssPaths` and tells
  prototypes to link it. Check with:

  ```bash
  grep -l styles.css ~/.claude/skills/aadhar-sh-design/SKILL.md
  ```

### Verify the whole route surface

`node verify-routes.mjs [baseUrl]` curls every route and asserts status +
content-type (+ markers). All-green ("0 hard failure(s)") is the gate before and
after any deploy. The skeuomorphic `_worker.js/` module tree was extracted with
this as the regression tripwire; keep it green on every future change.

---

## Remote image pipeline

> Three files cover photos and they do not overlap: this section is the
> **runbook** (which button, in what order), [PHOTO-PIPELINE.md](PHOTO-PIPELINE.md)
> is the **input contract** (accepted source formats, the five workflow routines,
> what lands in git versus what stays in R2), and CLAUDE.md explains the
> **encoder choices** behind both. Start here; reach for the contract when a
> source file is unusual or a routine misbehaves.

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

The GitHub-hosted macOS runner installs the Homebrew tools, builds the `zenc`
encoder with cargo, runs the selected routine, and discards the source files when
the job ends. The runner is the only execution host; nothing on the author's
machine is part of the contract.

Dependabot covers the encoder now: its cargo ecosystem tracks the zenjpeg pin in
`holding/scripts/zenc`, opening a version-bump PR on the weekly cadence alongside
the Actions, npm, and Pillow layers. This retired the old `Refresh image toolchain`
workflow that hand-tracked the from-source jpegli commit. Only Homebrew formulas
(mozjpeg, libavif) fall outside Dependabot and update on their own cadence.

## Local fallback setup

```bash
brew install exiftool jq mozjpeg libavif              # mozjpeg = jpegtran; libavif = avifenc (optional, sips falls back)
python3 -m pip install -r holding/scripts/requirements.txt  # Pillow for histogram baking
# the JPEG encoder (zenc) builds itself on first pipeline run; needs rust (rustup.rs)
cargo build --release --manifest-path holding/scripts/zenc/Cargo.toml
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
./holding/scripts/hash-thumbnails.sh               # re-hash the tiers into /i/ + rewrite hashes.json
# bust manifest:images + manifest:images:fresh in KV, then deploy (new bytes = new URLs, nothing else to bump)
```
`SQ_SM` (mobile tier) must match `THUMB_SMALL_PX` in `_worker.js` (the `-<N>.avif` suffix). add-photos.sh mirrors this script's two encode paths; keep them in sync.

### Add a car reference photo (homepage tooltip)
```bash
./holding/scripts/add-car-photo.sh <stem> <input-image>   # stem: singer | tuthill | hwa-evo | f355
```
Outputs `holding/cars/<stem>.{avif,jpg}` (no EXIF, no R2). Bump the `?v=` on that car image in `index.html` if you replace one in place, then deploy.

### Generate AI alt text for the grid
`add-photos.sh` already does this in phase 4, so a normal add needs nothing here.
Run it by hand to backfill or to retry after a rate limit:
```bash
npm run captions                            # writes holding/images/alt.json {stem: alt}
```
Resumable: only fills uncaptioned stems, so a 429 (Workers-AI neuron budget) just means run again later.

**Set a token once and captions work pre-deploy.** With `CLOUDFLARE_API_TOKEN` in
the environment, the script reads the committed `holding/i/<stem>.<hash8>.jpg` and
posts those bytes straight to Workers AI, so a photo added seconds ago gets
captioned in the same run. Without one it falls back to handing a stem to
`/garage/cf/caption`, which fetches the thumbnail from production and therefore
only sees photos that are already live.
```bash
export CLOUDFLARE_API_TOKEN=...             # Account · Workers AI · Read
```
`check-photo-pipeline.mjs` fails on any stem with no caption, the same way it does
for a missing pixel tier or histogram, so an unlabelled image can't reach a deploy.

### Regenerate the /garage/encoding study samples
```bash
./holding/scripts/gen-encoding-samples.sh [STEM] [SRC_DIR]
```
Prints byte counts + bytes-per-pixel so the figcaptions on `/garage/encoding` can be updated to match. The grayscale (`g-*`) set is generated separately and is not touched.

---

## Regenerate the OG / Twitter cards

Every garage + lwe page unfurls as a 1200x630 card showing its live demo floated
on the Bliss desktop (`holding/og/<section>-<name>.png`), wired via
`og:image`/`twitter:card` in each page's `<head>`. Regenerate when a demo's look
changes or a new page lands:

```bash
npm run og-cards                    # captures LIVE aadhar.sh (data-driven demos render populated)
node holding/scripts/inject-og-meta.mjs   # add the meta to any page missing it (idempotent)
# then deploy — a deploy purges the edge so the refreshed card lands.
```

- `gen-og-cards.mjs` drives the installed Chrome via `playwright-core` (a
  scripts-only devDep). Hero selector per page lives in the `HERO{}` map at the
  top; a page with no entry (or an essayistic one) falls back to the top of its
  XP window, which still reads well. `garage-vt-b`/`garage-vt-check` are excluded
  (diagnostic harnesses, not shareable).
- Captures **production** by default so the photo grid, live counters, and the
  routing prober come back full, not empty. Point `OG_BASE=http://localhost:8787`
  at a local server to preview a not-yet-deployed page (it self-boots one).
- A card that comes out weak (its hero grabbed prose): add/adjust the page's
  `HERO{}` selector, optionally a `preset` click to populate the demo, re-run.
- The LWE + Garage generators emit the same `og:image` block, so a future
  pipeline-authored page gets a card automatically (its PNG still needs one
  `npm run og-cards` run before the URL resolves).

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

### Bump THUMB_VERSION (retired — nothing to bump)
Fully retired (hash cutover 2026-07-03): thumbnails are content-addressed at `/i/<stem>.<hash8>.<ext>`, so a re-encode mints new URLs by itself — run `./holding/scripts/hash-thumbnails.sh` after re-encoding, bust `manifest:images` + `manifest:images:fresh`, deploy. The constant no longer exists in `lib/const.js`; legacy `/images/<stem>.<ext>[?v=N]` URLs just 301 into `/i/` regardless of their `?v`. The worker route still clamps unknown-thumb 404s to `max-age=0` so misses do not inherit immutable caching.

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
| `check-photo-pipeline.mjs` | CI-safe invariant check: every metadata stem has all three hashed tiers, per-photo metadata, and four 64-bin histogram channels, with no orphaned pixel files. Also walks the authored HTML/JS for hardcoded `/i/<stem>.<hash>` URLs (the `/garage/tooltips` demo slots have three) and fails if a re-encode has pruned the bytes one of them names. |
| `extract-photo-metadata.sh` | Read EXIF from the SOOC folder, emit `images/metadata.json` + per-photo `images/meta/<stem>.json`. Pulls the Fuji recipe fields too. Requires exiftool + jq. **Two schemas, on purpose:** `metadata.json` is the RECORD (long, self-documenting field names, plus the derived `recipe` card) and the per-photo files are the tooltip's RENDER CACHE (short keys, tooltip-only fields, nulls dropped, ~28% smaller compressed because one is fetched per hover). Bump `META_V` in `tooltip.js` when the per-photo shape changes. |
| `build-recipes.py` | Derive the self-documenting Fuji film-recipe card (`recipe`) for each photo in `images/metadata.json`, in the idiom fujixweekly.com publishes recipes in (`Dynamic Range: DR400`, `White Balance: Kelvin (5900K), -1 Red & +4 Blue`, `Clarity: -2`). Called by `extract-photo-metadata.sh`. Values are transformed from the NUMERIC EXIF tags (`FujiFilm:Sharpness`, `Clarity`, `DevelopmentDynamicRange`), never guessed back from friendly words; a non-Fuji frame gets no recipe block. Query it with `/photos/query.json?recipe=DR400`. |
| `reencode-thumbnails.sh` | Re-encode every published grid thumb from the source folder at a new resolution (pre-cropped squares, two tiers). Follow with `hash-thumbnails.sh` + a manifest bust. |
| `add-car-photo.sh` | One resto-mod reference photo -> `cars/<stem>.{avif,jpg}` for the homepage car tooltips. No EXIF, no R2. |
| `zenc/` | The JPEG thumbnail encoder: a Rust crate wrapping zenjpeg (hybrid trellis + progressive scan search). `cargo build --release` (auto-built on first pipeline run). `zenc <in> <out> -q 84`. dependabot tracks the zenjpeg pin; replaced the from-source jpegli build in 2026-07. |
| `download-remote-photos.sh` | Download selected R2 object keys into disposable runner storage for the GitHub Actions photo workflow; accepts `all` for the public manifest. |
| `gen-alt-text.py` | AI alt text for grid photos -> `images/alt.json`. Run by `add-photos.sh` phase 4. Posts the committed `i/` thumbnail to Workers AI when `CLOUDFLARE_API_TOKEN` is set (captions pre-deploy), else asks `/garage/cf/caption` by stem (deployed photos only). Resumable. |
| `gen-encoding-samples.sh` | Regenerate the color sample set for `/garage/encoding` through every encoder; defaults to the committed `garage/enc/c-png.png` fixture and prints byte counts. |
| `photo-histograms.py` | Bakes four 64-bin RGB/luminance histogram channels into each per-photo `images/meta/<stem>.json` from the shipped hashed JPG tier. Requires the pinned Pillow dependency in `holding/scripts/requirements.txt` and is called by both metadata extraction and `add-photos.sh`. |
| `gen-og-cards.mjs` | Render the 1200x630 OG/Twitter card per garage + lwe page (live demo on the Bliss desktop) into `holding/og/`. `npm run og-cards`. Drives the installed Chrome via `playwright-core`; captures production so data-driven demos render full. Hero selectors + presets in the `HERO{}` map. See "Regenerate the OG / Twitter cards". |
| `inject-og-meta.mjs` | Idempotently add `og:image`/`twitter:card` meta to any garage + lwe page missing it, pointing at `/og/<section>-<name>.png`. `--check` reports gaps without writing. |
| `hash-thumbnails.sh` | sha256 each pixel tier into `holding/i/<stem>.<hash8>.<ext>`, write `images/hashes.json`, and prune tiers no longer named by it. Run by `add-photos.sh`; a re-encode mints new URLs, so there is no version to bump. |
| `gen-encoding-grids.sh` | Regenerate the ZOOMED 96px comparison crops (`garage/enc/z-*`) that `/lwe/encoding` fetches. Run by the `regenerate-encoding-study` routine of the photo workflow. |
| `gen-desktop-partial.mjs` | Bake the XP desktop shell into `_worker.js/lib/desktop.js` and patch it into the 28 static pages, generated from nav.js's own `PROFILES`/`SUBPAGES`/`SECTION_ICONS`/tray template so the two cannot drift. Re-run after editing any of those. A run on an unchanged tree is a byte-exact no-op. |
| `bump-version.sh` | Insert one `checkpoints` row into the `aadhar-restore` D1 database, deriving the next vnum from `MAX(vnum)`. Both `/restore` and `/updates` read that table, so this is the only place a deploy gets logged. `./holding/scripts/bump-version.sh <slug> "<title>"`. |

---

## Gotchas that have bitten me

- **Thumbnail 404s must be uncacheable.** Workers static assets no longer return homepage HTML for missing files, but a real miss under `/images/*` can still inherit the immutable cache rule unless the worker clamps it. Keep the thumbnail route worker-first; a re-encode mints a fresh `/i/` URL by itself, so there is no version to bump.
- **zsh eats `${var}:something`.** Brace-quote KV key names with colons (`"tracks:${OLD}:fresh"`), and use `${=flag}` if you need word-splitting in ad-hoc snippets (the scripts use `#!/usr/bin/env bash` so they are safe internally).
- **`jpegtran` / mozjpeg strip EXIF.** Rotate losslessly with `jpegtran -copy none -rotate N` *before* recompressing, and send its binary stdout to a file (`2>/dev/null > out.jpg`), not through a pipe that could mix in stderr.
- **Production deploy = merge to `main`, CI promotion to `production`, then Workers Builds**; the single site Worker deploys the root `wrangler.jsonc`, bundling `holding/`, `cal/src/`, and `serendipity/` from that exact release branch. The deploy config points `main` + `assets` at `.build/holding` and runs `build.mjs` first through its `build.command`, so the production path self-builds and ships the minified client scripts + `luna.css`. Local dev is the exception: `wrangler dev -c wrangler.dev.jsonc` (`npm run dev`, wired into `.claude/launch.json`) serves the readable tree directly. Before merging, CI runs `npm run perf-budget`; after configuring Workers Builds, verify its release status and run `node verify-routes.mjs https://aadhar.sh` plus the `/coffee` and `/serendipity` route smoke checks.
- **`_playlistId` is module-cached per isolate.** After changing `playlist-id`, redeploy to flush it (see the playlist section).
- **The worker is bundled, not hand-concatenated.** `_worker.js/` imports sibling modules; wrangler bundles them at deploy via built-in esbuild.
- **Authoring is buildless; SERVING is minified.** `build.mjs` (repo root; minifier devDependencies: `@minify-html/node`, `lightningcss`, `oxc-minify`) copies `holding/` to `.build/` and minifies: `index.html` (structure via minify-html, inline CSS/JS through the same Lightning CSS + Oxc settings, with marker tripwires and a readable `/index.src.html` twin), the six client scripts (`nav.js`, `notepad.js`, `lens.js`, `lens-browser.js`, `quiz.js`, `tooltip.js`), `luna.css` (owner-approved 2026-07), and the worker modules' `/*min*/` CSS literals — each with a readable `/<name>.src.*` twin (the banner in each minified file points there). It hard-fails the deploy if `luna.css` doesn't parse as valid CSS (the v143 corruption slipped through for three releases), and content-hashes `nav.js` + `luna.css` into immutable `/a/` URLs. Garage/lwe HTML, images, and `_headers` ship byte-identical to git (View Source is part of the design). Do NOT extend the build into bundling or version auto-bumps; the scripts remain independently readable islands.
