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
# production, the normal path: merge to main; CI promotes the tested commit to
# production; Workers Builds UPLOADS it as a version and moves no traffic. Then
# ramp it (10% -> 50% -> 100%, sampling between steps). Workstation-only.
npm run deploy:promote
npm run deploy:promote -- --status      # what is serving right now
npm run deploy:promote -- --rollback    # 100% back to the previous version

# straight to 100%, no ramp. the fallback for the infra:check deadlock below,
# and for anything where an extra step is the risk rather than the safety net.
npm run deploy

# local dev against PRODUCTION KV/R2/Browser (D1 stays local unless you pass
# --d1; read scripts/gen-remote-config.mjs before you do). Workstation-only.
npm run dev:remote

# the route oracle with those same remote bindings, which un-skips the 5 rows a
# local Worker cannot assert. 3 of them go green on remote KV/R2 alone; the two
# /lens rows also want a SECRET, and secrets are not remotable. CI cannot run this.
npm run routes:check:remote

# add new photos (resize, EXIF-rotate, encode to AVIF+JPG, upload to R2,
# write the photo-index entry, bake histograms, validate artifacts; the
# photo goes live at the next deploy — no cache bust exists or is needed)
npm run photos -- "/path/to/photo.HIF" "/path/to/folder/"

# validate the committed photo artifact graph without uploading anything
npm run photos:check

# diff infra.json (DNS, zone/edge settings, account resources, Workers) against
# reality. read-only; never mutates Cloudflare. add CLOUDFLARE_API_TOKEN for
# the account tier, or --offline for the no-network tier.
npm run infra:check

# the rebuild path, and the ONLY thing here that can mutate Cloudflare. plans
# for free (public DNS, no credential); --confirm writes and needs the separate
# CLOUDFLARE_API_TOKEN_WRITE. refuses to run in CI, by design.
npm run infra:apply

# regenerate JUST the EXIF metadata (after photos are already uploaded)
./holding/scripts/extract-photo-metadata.sh "/Users/aadharsh/Downloads/to post (from ssd)"

# install the histogram decoder dependency
python3 -m pip install -r holding/scripts/requirements.txt

# build the JPEG thumbnail encoder (zenc = zenjpeg hybrid+scan). the pipeline
# scripts auto-build it on first run; this is the explicit form.
cargo build --release --manifest-path holding/scripts/zenc/Cargo.toml

# bust caches via wrangler (RN_KV namespace ID hardcoded in scripts).
# NB: the photo manifest is NOT a cache anymore — the worker bundles
# photo-index.json + hashes.json, so a deploy replaces the pool atomically
# and there are no manifest:* keys. Tracks remain KV (two-key SWR):
NS="3cb8a107c58e47dc9244e75b33401f36"
wrangler kv key delete --namespace-id="$NS" "tracks:4IRq9W1N2tOWHhH0O3vXiF" --remote
wrangler kv key delete --namespace-id="$NS" "tracks:4IRq9W1N2tOWHhH0O3vXiF:fresh" --remote
```

## Collaboration and release discipline

`origin/main` is the production source of truth. Claude, Codex, and local
worktrees may edit freely, but a worktree is not a release surface.

- Start work from a fresh `origin/main`: `git fetch --prune origin`, then make
  a named branch/worktree. Never use a stale local `main` as an agent base.
- **Assume another session is in this tree.** Several agents work here at once,
  so a modified file is not necessarily one you modified, and `HEAD` can move
  under you mid-task. Check `git status` and `git reflog` before you attribute a
  change to yourself, and never revert or commit a hunk you did not write. When
  the work is more than a couple of edits, take a worktree so nobody can move
  your branch out from under you.
- Keep each change on its own branch, commit it, push it, and open a PR. Do
  not deploy from a dirty worktree or push agent work directly to `main`.
- PR CI builds the site, enforces the performance budget, dry-runs the single
  site Worker plus the auxiliary Garage/LWE configs (`cf-garage/`, `lwe-ask/`),
  runs the coffee tests, and sweeps the route oracle against a Worker booted
  in-process (`npm run routes:check`, wrangler's `createTestHarness()`), so a
  broken route fails the PR instead of the deploy.
- Only a successful CI run for `main` associated with a merged PR can promote
  the exact tested commit to the machine-owned `production` branch. Cloudflare
  Workers Builds watches `production` and is the only production publisher for
  the site Worker, which bundles `holding/`, `cal/`, and `serendipity/`. The
  Garage and LWE demos remain auxiliary Worker projects.
- **Repository rulesets enforce the branch half of that, since 2026-08-05.**
  This note used to say GitHub's free private-repo plan could not enforce branch
  protection, which made the promote workflow's own guards the whole backstop.
  The repo is public now, so rulesets cost nothing, and both branches carry one:

  | ruleset | rules | bypass actors |
  |---|---|---|
  | `main` | PR required (0 approvals), required check `validate`, no force-push, no deletion | none |
  | `production` | no force-push, no deletion | none |

  **Zero bypass actors on `main` is the load-bearing part, and an admin exemption
  would quietly undo it.** Claude, Codex, and every local worktree push with the
  OWNER's credentials, so "bypass for repository admins" exempts precisely the
  actors the rule exists to catch. Approvals sit at 0 because GitHub refuses to
  let anyone approve their own PR, so a solo repo requiring 1 could never merge.
  The `validate` check is pinned to `integration_id: 15368` (the GitHub Actions
  app), so only a real workflow run satisfies it and no caller of the
  commit-status API can. `strict_required_status_checks_policy` is FALSE on
  purpose: requiring every PR to be rebased onto the tip first would make each
  Dependabot PR churn on every unrelated merge.

  `production` deliberately carries no pull-request rule. `promote-production.yml`
  moves that branch with a `PATCH .../git/refs/heads/production` carrying
  `force=false`, and a PR rule there would break the release path outright. What
  the two rules it does carry buy is that the release branch can only ever move
  FORWARD, so Workers Builds cannot be handed a rewritten history.

  The promote workflow's two guards (the tested commit must still be current
  `main`, and it must belong to a merged PR into `main`) are belt and braces now
  rather than the only line. Keep them: a ruleset governs refs, while those guards
  govern which commit is allowed to become a release.
- **Reaching `production` no longer moves traffic.** Workers Builds runs
  `wrangler versions upload`, so a promotion builds the commit, uploads the
  assets, checks the secrets, and mints a servable preview URL, while production
  keeps serving the version it was already serving. Traffic moves when a human
  ramps it:

  ```bash
  npm run deploy:promote
  ```

  That walks 10% → 50% → 100%, and between steps it samples `/whoareyou.json`
  (the one route that reports which VERSION answered — both versions read the
  same D1 changelog, so `/updates.json` structurally cannot tell them apart) and
  aborts on a non-200 or on a step that never took. `--to`, `--steps`,
  `--status`, and `--rollback` are the other modes. It is workstation-only for
  the same reason `infra:apply` is: moving traffic needs a token that can write.

  What the ramp buys is the ability to read a change before everyone gets it. The
  script deliberately pauses between steps and tells you to go look at Workers
  Logs; it checks status codes, and it cannot check whether the page is *right*.

  `npm run deploy` still exists and still goes straight to 100%. Keep it: the
  `infra:check` deadlock below is exactly the case where a ramp's extra step is
  a liability rather than a safety net.
- **A fix for a bug that `infra:check`'s edge tier can see will DEADLOCK that
  promotion, and the merge is where it bites.** Those checks read production over
  the wire, which is the whole point of them (see the `app-owns-security-headers`
  note in `infra.json`), but it means CI on `main` keeps failing on the old
  production behaviour after the fix has merged — and promotion is gated on CI, so
  production never gets the fix that would turn the check green. Observed
  2026-07-31 with `markdown-for-agents-off` (#195 merged, run 30666351446 red,
  every `Promote production` run after it skipped). It stays red on every branch
  until someone breaks the cycle from outside, by publishing the merged commit:
  push `main` to `production` so Workers Builds picks it up, or run the local
  `npm run deploy` fallback. Neither is automatic and neither should be — a
  deploy is the owner's call. Just know that merging is not the last step for
  this class of fix, and CI will not tell you so.

  **Branch protection sharpened this on 2026-08-05.** `validate` is a REQUIRED
  check now, so a drift fix that used to merge red cannot merge at all: the one
  check gating it asserts against the very production it exists to repair. The
  escape is to set the `main` ruleset's enforcement to `disabled` for that single
  merge (Settings, then Rules), publish, and flip it back once the check goes
  green on its own. The audit log records both flips. Do NOT reach for a bypass
  actor instead, because a standing exemption is permanent and silent, while a
  disabled ruleset is a deliberate act somebody can see.
- Configure one Workers Build project for the site Worker with `production` as
  its production branch and repository root `.`. Keep the dashboard Build
  command blank; use the repo's Wrangler-owned build during the Deploy command,
  which must be the `versions upload` form recorded in
  [`infra.json`](infra.json) under `release`. **The dashboard Deploy command is
  the one place this whole model can be silently undone: a bare `wrangler
  deploy` there turns every merge back into an instant 100% release and
  `deploy:promote` into dead code that nobody notices, because releases keep
  working.**

  **`infra:check` verifies it now, which it could not before 2026-08-04.** The
  old note in `infra.json` said Cloudflare exposed no public API for Workers
  Builds configuration and the values could only be recorded as intent. That is
  stale: the Builds REST API exists, the permission is **`Workers Builds Configuration`**, and it
  has a **Read** variant, so this costs a sixth read scope on the CI token and
  needs no exception to the no-write-token rule. The dashboard's two command
  fields are two TRIGGERS in the API, separated by their branch filters, and
  both are declared and checked. Without the scope the section degrades to a
  note naming what is missing, exactly like the other five.
- **Preview URLs are on, and the Worker guards them.** `preview_urls: true` in
  `wrangler.jsonc`, with `workers_dev: false` kept — production still has no
  workers.dev address; what previews add is a per-VERSION one. The setting is
  explicit because `preview_urls` DEFAULTS to whatever `workers_dev` is, so
  deleting the line turns previews off again without a word.

  A preview runs **production bindings and secrets**. Cloudflare offers no
  per-version override, so the same RN_KV, the same photo bucket, the same three
  D1s, the same `RESEND_API_KEY`. `holding/_worker.js/lib/preview.js` is what
  makes a preview URL safe to paste into a PR: every response is `noindex`
  (a byte-identical duplicate of the site on another host would otherwise compete
  with the canonical one), and writes are refused by DEFAULT-DENY on unsafe
  methods plus a short list of GET-shaped writes (`/hit`, `/approve`, `/decline`,
  the webmention decisions, `/ledger/prefetch`). Default-deny is the load-bearing
  half: the next POST route anyone adds is guarded on the day it is written.
  Reads all pass, which is the point of the surface. Do not enable previews with
  that guard removed.
- **No deploy path may create Cloudflare resources.** Wrangler's
  `--x-provision` and `--x-auto-create` are hidden flags that both default to
  TRUE, and they provision real KV/R2/D1 for any binding declared without an
  id. `npm run deploy`, `npm run deploy:version`, and **both** Workers Builds
  commands (the Deploy command AND the Non-production branch deploy command)
  pin them off, so resource creation stays with `npm run
  infra:apply` and a missing id fails loudly. **That list read "the Workers
  Builds Deploy command" until 2026-08-04, and the branch build it left out was
  running bare** — every push to every feature branch published with both flags
  at their default TRUE, onto a Worker holding production's bindings. Nothing
  was minted, but nothing stopped it either. Take the general lesson over the
  specific one: this rule enumerated deploy paths in prose and a fourth path
  appeared without joining the list, so `check-infra.mjs` now walks the commands
  from one array and the next trigger Cloudflare adds gets checked by being
  added there. That the flags survive on
  `versions upload` was verified rather than assumed (2026-08-04): they are
  hidden, `--help` lists them for neither subcommand, and the way to tell is the
  exit code — wrangler exits 1 on `--x-bogus-flag` and 0 on `--x-provision=false`.
  Run that control before trusting any flag `--help` omits. `infra:check` now
  fails if EITHER recorded deploy command drops EITHER flag, in the tree tier
  (the declared string, no credential, every PR) and again in the API tier
  (the live dashboard value, when the token carries `Workers Builds
  Configuration:Read`). `npm run deploy` additionally passes `--strict`, which aborts rather
  than prompting when the Worker's last deployment came from the dashboard and
  its remote config has drifted from this repo. Workers Builds deliberately
  does NOT pass `--strict`: it is the authoritative publisher, and a release
  should reclaim a dashboard edit instead of stalling on it.
- **GitHub must never hold a Cloudflare token that can write.** The point is
  that GitHub cannot publish to production; only Workers Builds can, and only
  from `production`. A READ-ONLY token is a different thing and is fine: CI uses
  one for `npm run infra:check`. Scope it to exactly these six reads and
  nothing else: Account Settings:Read, Workers Scripts:Read, Workers KV
  Storage:Read, Workers R2 Storage:Read, D1:Read, **Workers Builds Configuration:Read**. If a
  token in this repo ever needs an `Edit` scope, the answer is no. A token
  missing one of these degrades only the section that needed it, and the check
  names the missing scope.

  `Workers Builds Configuration:Read` was the sixth, added 2026-08-04 so `infra:check` can read
  the live Workers Builds triggers instead of trusting a recorded intent. It is
  the read half of the permission whose Edit half changes the deploy command, so
  granting it buys drift detection on the release path and grants nothing that
  can publish. **Read, never Edit — the rule above is unchanged.**
- The one write path, `npm run infra:apply`, is **workstation-only** and reads a
  different variable (`CLOUDFLARE_API_TOKEN_WRITE`, scoped to DNS on this zone
  alone). It refuses to run in CI and cannot touch the Worker. GitHub stays
  unable to reach production, which is the property the release design rests on.

> `AGENTS.md` is a symlink to this file. One source of truth, so the two cannot
> drift again (they had, badly, by 2026-07-22). Edit this file.

---

## holding/ — homepage architecture

Single-page personal site at `aadhar.sh`. A Cloudflare Worker with static assets, with a
`_worker.js` that does server-side enhancement of an otherwise-static
`index.html`. The worker route table sits in `route()` at the top of
`_worker.js`.

### Key files

| file | role |
|---|---|
| `holding/index.html` | The whole page in one file. Inline CSS + JS. ~58KB uncompressed, ~15.4KB zstd (measured 2026-07-21 via live nav-timing; CF serves zstd, not brotli). Served on the shared `PAGE_CACHE_CONTROL` (`lib/const.js`) like every other document, + ETag, and still never `no-store` (the one directive that would cost the page bfcache). It held `private, no-cache, must-revalidate` through its SSR era and kept it after the SSR left; that cost two things at once, since no shared cache could store it (every front-door hit ran the worker) and Chromium refuses to keep a dictionary offered under `no-cache` (so `/` was the ONE page outside the per-page dcz tier). Changed 2026-07-31. Comments deliberately kept readable for View Source. |
| `holding/writing/` | Written content as plain `.txt` files + `posts.json` registry `[{slug,title,date}]`. The worker renders each as an XP **Notepad** window at `/writing/<slug>` (a server-rendered `<textarea>` seeded with the canonical text — editable by nature, ephemeral by nature: no save → reload restores canonical, "writing in flux"), plus a "My Writing" folder index at `/writing`. Raw `.txt` stays fetchable at `/writing/<slug>.txt`. Author a post = drop a `.txt` + a `posts.json` entry. Render code (`handleWritingIndex`/`handleWritingPost`/`NOTEPAD_CSS`) lives in `_worker.js`. |
| `holding/notepad.js` | Behavior for the `/writing` Notepad view (deferred, SW-cached): per-window `enhance()` wiring File/Edit/Format/View/Help menus, live Ln/Col + word-count status bar, Word-Wrap toggle, the classic **F5 time/date** stamp (Temporal w/ Date fallback), Select All, Print, About. Also opens folder notes as **popovers** that composite over the folder index, deliberately without touching the address bar (notes are `popover="manual"`, so several stay open at once and one URL couldn't honestly name three windows; Esc closes the topmost). The permalink stays real: each row is an `<a href="/writing/<slug>">` the worker serves standalone, and a modified click passes through to it. Chrome itself is SSR'd by `_worker.js`. No-op without a `.np-window`. |
| `holding/tooltip.js` | Rich XP hover island for photos, tracks, artists, and car references. The homepage keeps only a tiny inline loader that idle-prefetches this module and replays a cold first hover; coarse-pointer visitors never load it. |
| `holding/nav.js` | Site-wide XP **desktop shell**. The ONE shared external asset (deferred, SW-cached) — every page includes `<script src="/nav.js" defer>`; it injects its own `<style>` + builds, into `<body>`: the **Bliss desktop** wallpaper, **draggable desktop icons** (Notepad + the 5 profiles; icons drag freely within a visit but positions are DELIBERATELY not persisted, since the stored layout was read back in states that couldn't honour it and came back as a stack), the **taskbar** (Start orb → Run, first-level-subpage app buttons each with a per-section SVG icon, clock via Temporal), and the **Run** command palette (⌘K / Start). Also owns the **OS-window model**: body is a clipping flex desktop, each `.window`/`.np-window` is pinned + its content scrolls internally behind a **custom XP scrollbar**, windows are **draggable** (top is a hard boundary) + **resizable**, and Navigations hard-cut: the cross-document View Transition this file used to describe was removed 2026-07-30 (prerender already made navigation instant, so the animation was pure added latency). Sets each first-level route's **tab favicon** to its section icon. Run destinations: pages + profiles inline; 158 photos lazy-loaded from `/images/manifest.json` with `/images/alt.json` captions. Wired into homepage + all garage pages + worker-gen `/around`,`/whoareyou`,`/bot` + serendipity shell. |
| `holding/quiz.js` | The **understanding-check** widget (deferred, shared, minified at deploy with a `/quiz.src.js` twin). Every garage + LWE content page ends with an active-recall quiz rendered by this one script from an inline `<script type="application/json" id="luq-data">` block: garage pages get an XP GroupBox self-test (`<section id="luq">` mount), LWE pages get the quiz as a continuation of the MSN chat (appended into `.log`, no mount). Misconception-based distractors, deterministic option shuffle, per-page best score in localStorage. The idea is Geoffrey Litt's "Understanding is the new bottleneck" (credited in the widget footer); /lens carries the same pedagogy in copy (predict-then-check mode notes, the Delta counterfactual lab as a Papert micro-world). |
| `holding/terminal.js` | The **Windows PowerShell** console at `/terminal` (deferred, minified at deploy with a `/terminal.src.js` twin). The page SERVER-RENDERS one frame into the console as boot output, so the route reads with JS off and an agent fetching the HTML gets content rather than a mount point; this script turns that scrollback into a shell. Commands are the real thing, not a demo vocabulary: `finger`/`photos`/`lens` hit the same routes curl does, `get` performs the same Accept negotiation an agent performs, `mcp` speaks JSON-RPC to `/mcp`. Arrow keys drive a running program (they are shell history when none is), Ctrl+P/Ctrl+N are history either way. Builds output with `createTextNode` and never `innerHTML`, because the frames carry photo captions and, through `lens`, an arbitrary third party's `<title>`. |
| `holding/_worker.js/terminal.js` + `lib/tui.js` | The three terminal programs and the 80-column frame renderer behind `/terminal/*`. **State is query params, not a session** — `?pane=writing&cursor=3&open=lattice` — so there is no DO round trip on a keypress (counter.js measures one at 185-630ms), sessions FORK, and the state is inspectable rather than an opaque token the caller hands back. Each frame prints the URL that produced it, labelled `state`, and a contract test asserts that URL reproduces the frame. `lib/tui.js` is pure (frames in, string out), which is what lets one renderer answer HTTP, MCP, and `node --test`. Its palette is MID-TONES ONLY: a terminal theme belongs to the visitor, so a near-white or near-black foreground is unreadable for half of them. |
| the `/terminal` window | It is a **console window, not a page**, and the difference is entirely in what was REMOVED. `lunaPage` gained `windowClass`/`contentClass`/`windowAttrs` (all defaulting to empty, so the other nine callers are byte-identical) and the window declares `data-no-histnav`, which `nav.js` honours by skipping the site-wide Back/Forward injection — those are BROWSER controls, and a console carrying them reads as a terminal running inside Internet Explorer. Drag, resize, maximize and close all stay, because those are OS chrome. There is also nothing below the window: the explanatory paragraph that used to sit there was the single strongest tell, since real consoles do not come with a caption. Width is 624px so the console is exactly 80 columns, the size a real one opens at; left at the 760px page default it carried 136px of dead field to the right of every frame. Fonts stay on the design system — `"Lucida Console", var(--font-mono)`, one native Windows font in front of the existing token, no `@font-face`, no bytes. |
| `holding/_worker.js` | The module worker (bundled by wrangler at deploy). Owns routing, photo serving from R2, manifest building, Spotify playlist scraping, AadharshBot crawler, the `/writing` Notepad pages, cache-control overrides. |
| `holding/_headers` | Static-asset cache + security headers (CSP, Permissions-Policy, etc.). Applied to direct static-asset requests; the worker overrides cache-control for select paths. |
| `holding/sw.js` | RETIRED (v136, 2026-07-03): now a ~15-line unregister stub (skipWaiting, delete caches, claim, unregister) that must keep serving 200 for a year+ so installed copies clean themselves up. No CACHE_VERSION anymore; the deploy-log vnum lives in D1 alone (bump-version.sh derives the next from MAX(vnum)). Repeat-visit speed comes from immutable assets + bfcache + speculation prerender. |
| `holding/llms.txt` | The llms.txt format — concise site summary for LLMs. Linked from `<link rel="alternate">`. |
| `holding/index.md` | Markdown source of homepage copy (used by `/llms.txt` and as a fallback). The one COMMITTED Markdown twin: `gen-md-twins.mjs` skips any path that already has one, so this hand-written prose is never regenerated over. |
| `holding/md/` | Hand-authored Markdown twins for the three Worker-rendered prose pages, `/bot`, `/whoareyou` and `/security`, whose text lives in template literals no build step can read. `.assetsignore`d (build input, not a public URL): the generator publishes them at `/bot.md`, `/whoareyou.md` and `/security.md`. `checkTwinFacts()` pins the load-bearing strings against the Worker in BOTH directions, so bumping `BOT_VERSION` fails the deploy until `bot.md` agrees. `security.md`'s pins read `lib/security.js` rather than the page, since a page ABOUT headers must agree with the module that SENDS them; one of them is derived from `ENFORCE_PAGE_HASHES`, so finishing the hashed-CSP rollout fails the deploy until the twin stops calling the policy report-only. |
| `holding/sitemap.xml`, `robots.txt` | Standard SEO files. robots.txt explicitly allows AadharshBot. |
| `holding/.well-known/http-message-signatures-directory` | JWKS for AadharshBot's Ed25519 public key (Web Bot Auth IETF draft). |
| `holding/images/` + `holding/i/` | `images/` holds the photo DATA surfaces: `metadata.json` (the EXIF RECORD, long field names + the Fuji recipe card), `exif.json` (the tooltip's TEXT tier: every photo's short-key EXIF in one 2.6KB-brotli file, warmed once on idle because the homepage draws a fresh random 12 of 158 per request and a per-slot warm-up was cold nearly every visit), `meta/<stem>.json` (per-photo EXIF plus the four 64-bin histogram channels — the BARS tier, fetched only on the hover that needs them, and the self-healing fallback for a stem missing from a cached `exif.json`), `alt.json` (AI captions), `hashes.json` (stem to hash8 map). The pixel tiers (600px AVIF+JPG squares + 400px mobile AVIF) live in `i/` under content-hashed names, 474 files for 158 photos. |
| `holding/og/` | Pre-baked 1200x630 OG/Twitter cards, one per garage + lwe page (`<section>-<name>.png`): the page's live demo floated on the Bliss desktop with an XP dock naming the route, so a shared link unfurls as the interaction, not a bare title. Wired via `og:image`/`twitter:card` in each page's `<head>` (edge-direct static pages can't be worker-injected). Built by `scripts/gen-og-cards.mjs` (playwright-core → Chrome, captures production for live data); meta added by `scripts/inject-og-meta.mjs`. Regen recipe in MAINTENANCE.md. Cached 30d, deploy purges the edge. |
| `holding/scripts/` | Photo-pipeline + asset scripts (see below). Beyond the core pipeline (`add-photos.sh`, `extract-photo-metadata.sh`, `check-photo-pipeline.mjs`, `zenc/` the JPEG encoder crate): `add-car-photo.sh` (one resto-mod reference photo into the dual AVIF+JPG pair the car-link tooltips expect, output `holding/cars/<stem>.{avif,jpg}`, no EXIF/R2); `gen-alt-text.py` (AI alt text for every grid photo, writes `holding/images/alt.json` `{stem: alt}`, resumable; run by `add-photos.sh` phase 4 — posts the committed `i/` thumbnail bytes to Workers AI when `CLOUDFLARE_API_TOKEN` is set so a brand-new photo captions pre-deploy, else falls back to the cf-garage `/garage/cf/caption` endpoint by stem, which only sees deployed photos); `gen-encoding-samples.sh` (regenerates the color sample set for the `/garage/encoding` study through every encoder, prints byte counts + bytes-per-pixel); `reencode-thumbnails.sh` (re-encodes all published grid thumbnails as pre-cropped center squares from the canonical source folder, two square tiers); `photo-histograms.py` (bakes the four 64-bin RGB/luminance channels into each per-photo meta file). |

### The photo pipeline

```
SOOC original (in /Users/aadharsh/Downloads/to post (from ssd)/)
   |
   v
[add-photos.sh] — resize, rotate, encode:
   |   1. sips: resize to 1200px + format-convert (handles HEIF/HIF)
   |   2. jpegtran -rotate N (lossless EXIF orientation, mozjpeg's tool)
   |   3. zenc -q 84 (zenjpeg hybrid trellis + progressive scan search; ~4%
   |      under the retired cjpegli at equal quality, q84 ≈ old cjpegli q82)
   |   4. avifenc -q 63 -d 10 (10-bit AVIF, ~6% smaller at equal quality than
   |      8-bit; sips formatOptions 60 fallback) — primary
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
   |   also writes per-photo /images/meta/<stem>.json files. photo-histograms.py
   |   then bakes four 64-bin RGB/luminance channels into those files from the
   |   shipped hashed JPG tier, so the tooltip has a stable, whole-image
   |   histogram. build-exif-index.mjs finally rolls every per-photo file MINUS
   |   its histogram into the one /images/exif.json the tooltip warms on idle
   |   (derived data: check-photo-pipeline.mjs rebuilds it and fails on drift).
   |   discipline: every field is nullable; the tooltip skips lines
   |   that are null rather than fabricate. never guess metadata.
   |
   v
[gen-alt-text.py] captions any stem missing one -> holding/images/alt.json
   |   with CLOUDFLARE_API_TOKEN set it posts the committed i/ thumbnail
   |   bytes to Workers AI, so a photo added seconds ago captions here
   |   instead of waiting for a deploy. check-photo-pipeline.mjs then
   |   FAILS on any uncaptioned stem, same as a missing pixel tier.
```

Two encoders + one transform tool, all built from source:

- **mozjpeg** (`brew install mozjpeg`, keg-only at `/opt/homebrew/opt/mozjpeg/`)
  — provides `jpegtran` for lossless EXIF-orientation rotation.
- **zenc** (`holding/scripts/zenc/`, a Rust crate wrapping
  `github.com/imazen/zenjpeg`) — the JPEG universal-fallback encoder: hybrid
  trellis + 64-candidate progressive scan search + sharp_yuv chroma, ~4% under the
  retired cjpegli at equal quality. Builds with `cargo`; dependabot tracks the
  zenjpeg pin. Replaced the from-source jpegli build (2026-07). See `holding/scripts/zenc/src/main.rs`.
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

### Markdown twins (`scripts/gen-md-twins.mjs`)

Every page with prose ships a Markdown twin at `<path>.md`, and the two big
sections carry their own `llms.txt`. `/garage/encoding` and
`/garage/encoding.md` are the same content; `/garage/llms.txt` indexes the 17
garage pages so an agent does not have to pull the whole root index to find one.

**Twins are BUILD OUTPUT, never committed.** `build.mjs` step 1c generates them
from the readable source in `holding/` into `.build/holding/`. A twin is a pure
function of the page's bytes, so there is no committed copy that can fall behind
and no step anyone can forget. Same argument the dcz deltas won. It reads the
SOURCE tree deliberately: the staged copy is about to be rewritten (client edge,
hashed asset refs) and `index.html` minified, none of which belongs in a twin.

Two rules the converter (`scripts/lib/html-to-md.mjs`) exists to enforce:

1. **`<script>` bodies never reach the tree.** Every garage/lwe page carries a
   `<script type="application/json" id="luq-data">` holding the understanding
   check's questions, its per-option explanations, AND its `ok` answer flags. A
   converter that walked into script bodies would publish the answer key as
   prose. A contract test asserts this over all 1100+ quiz strings; an earlier
   version of that test read the wrong field names, asserted nothing, and still
   reported a pass, so it now counts what it checked and fails if the count
   collapses.
2. **Interactive controls render nothing.** A `<button>` in a live demo is not
   content, and its label without its behavior is a claim an agent would read as
   fact. The prose around the demo still converts.

The converter reads each page's OWN inline `<style>` to find classes the CSS
takes out of the inline flow (`display:block`, `float`), because otherwise a
figcaption whose separation lives entirely in CSS renders as
`**PNG** lossless178.7 KB1.72 b/px`. No CSS engine, just the rule blocks already
in hand.

Negotiation is a bonus on top, not the mechanism: `Accept: text/markdown` at the
page's own URL works wherever the Worker already sees the request
(`/garage/*`, `/lwe/*`, `/pixel-peeper*`, `/`, `/bot`, `/whoareyou` — the static
ones are worker-first already, for dcz deltas, so this costs no new invocations).
A page that is still edge-direct answers at its `.md` URL only. The negotiated response is
`no-store` because the edge caches per URL, not per Accept; the `.md` URL is the
cacheable representation.

**"wherever the Worker already sees the request" is a condition, not a given: a cache
in front of the Worker revokes it silently.** `/` joined `WORKERS_CACHEABLE_PATHS` in
#189 and production then answered a markdown ask with `text/html` on a `cf-cache-status:
HIT`, because Workers Cache keys the URL and the HTML response's Vary names only
`accept-encoding, available-dictionary`. `shouldUseWorkersCache` (`lib/cache.js`, #195)
bails on `wantsMarkdown` for that reason, and the long argument for bailing over
`Vary: accept` lives with it. What generalizes past markdown: a route that answers more
than one representation at one URL cannot sit behind a URL-keyed cache without a bail,
and if a route ever negotiates on some header other than Accept it needs its own.
Expect this class of bug to read as INTERMITTENT while you are diagnosing it, because a
route breaks only once its entry has filled: on 2026-07-31, `/bot` answered
`text/markdown` on a BYPASS at 21:18 UTC and `text/html` on a HIT twenty-five minutes
later, off the same worker build. Survey a cache-fronted route twice before concluding
it is unaffected. Note
also that `serveStaticPage` bails to the asset layer on `method !== "GET"`, so a HEAD
never negotiates at all — `curl -I` will report HTML on a page whose GET returns
Markdown, which reads exactly like this bug and is not it.

**A route with no page gets neither tier, and `/rn` is the one.** It is a bare 302
to Spotify, so there is no HTML for the converter to read and nothing fixed for a
hand twin to state: the playlist rolls over. Its Markdown is RENDERED live at
`/rn.md`, and at `/rn` under negotiation, from the same payload `/rn/tracks`
serves, which is why it needs no drift check. Reach for this third shape only when
a hand twin would have to describe rather than mirror AND the data already exists
in another representation; otherwise the honest move is to drop `flags.agents`,
because the registry should not advertise a surface an agent cannot read. Note the
`run_worker_first` requirement: a Markdown URL with an extension is a static asset
by default, and `build.mjs` invariant #8 catches a route that forgets it.

Adding a page needs no work here: register it in `site-manifest.json` as usual
and the twin appears. `build.mjs` fails the deploy if fewer than 30 generate,
since losing them would otherwise be silent (pages keep serving HTML).

### AadharshBot — the branded crawler

Lives in `_worker.js` (search for `BOT_NAME`). Signs all outbound requests
per RFC 9421 + Web Bot Auth IETF draft. JWKS at
`/.well-known/http-message-signatures-directory`. Used for:

- The `/around` neighborhood dashboard (crypto VC homepages it crawls)
- The Spotify scraper (`scrapeSpotifyEmbed()`)
- Any other outbound fetch where being identifiable matters

### `/mcp` — dual-era, and why both eras are served

`holding/_worker.js/mcp.js` speaks **2026-07-28** and the three legacy revisions
(`2025-06-18`, `2025-03-26`, `2024-11-05`) on one endpoint. The spec sanctions
this explicitly, and the client's opening move picks the era: a request carrying
per-request `_meta` is served statelessly under the new revision, an `initialize`
request selects legacy semantics.

2026-07-28 is a hard break. It deleted the `initialize` handshake, deleted
protocol-level sessions and `Mcp-Session-Id`, and moved protocol version, client
identity, and capabilities into `_meta` on every request. **Legacy clients have
no fall-forward mechanism** — pointed at a modern-only server they simply fail —
which is the whole reason both eras stay.

The site was well placed for it. `mcp.js` has said "intentionally stateless"
since it was written, and statelessness is exactly what the new revision assumes.
There was nothing to unwind.

What the rewrite added:

- **`server/discover`**, which the spec says servers MUST implement. Identity,
  capabilities, and supported versions in one round trip.
- **Version gating** per request. An unsupported version gets `-32022` carrying
  `{supported, requested}` so the client can retry. That error shape is also how
  a dual-era client RECOGNISES a modern server, so it is load-bearing.
- **`resultType: "complete"`** and `_meta["io.modelcontextprotocol/serverInfo"]`
  on every result, emitted unconditionally. Safe both ways: JSON-RPC clients
  ignore unknown result fields, and the spec tells modern clients to read a
  missing `resultType` as complete anyway. One code path beats two.
- **`ttlMs` + `cacheScope`** on the list and read results (CacheableResult), so a
  client caches instead of polling.

Two deliberate deviations, both written down at the code:

1. **`Mcp-Method` / `Mcp-Name` are validated when present, never required.** The
   spec requires them on Streamable HTTP POSTs; requiring them would reject every
   legacy client at the transport layer, which is the "Legacy client, Modern
   server → Fails" row of the spec's own compatibility matrix. A *mismatch* is
   still `-32020`, because a header disagreeing with the body is the exact case
   the header exists to prevent.
2. **`ping` is kept** though 2026-07-28 removed it. Legacy clients send it and
   it costs nothing.

**BOTH servers on this origin speak it, through one module.** `/serendipity/mcp`
(`serendipity/serendipity.js`) is a separate server with different tools and no
shared data, but the wire rules — versions, `_meta` keys, `resultType`, cache
hints, error codes, the header check, the version gate — live once in
[`lib/mcp-protocol.js`](holding/_worker.js/lib/mcp-protocol.js) and both import
it. Two MCP servers on one origin speaking different dialects is a bug a client
author reports to you rather than one you find yourself.

Sharing is correct here even though `lib/trace.js` and `cal/src/trace.js` are
near-duplicates ON PURPOSE (gotcha 16). The cal duplication exists because cal's
Vitest pool boots from `cal/src/index.js` alone, so a cal → holding import would
make cal untestable without the site tree. Serendipity has no such constraint
and already imports `lib/desktop.js` and `lib/crawl.js`; that direction is
established. **Check which of those two situations you are in before copying
either precedent.**

Two contract tests hold it together: one runs the conformance assertions against
BOTH servers, and one fails if either file re-declares `MCP_SUPPORTED` or
`MCP_PROTOCOL` locally instead of importing them — the drift that would pass on
the day it was written and rot later.

Cards: `.well-known/mcp.json` and `.well-known/mcp/server-card.json` are
Serendipity's; `.well-known/agent-card.json` carries both interfaces. All of
them advertise 2026-07-28 now.

### DNS-AID (agent discovery)

A DNS record, so it lives in Cloudflare DNS rather than in a Worker config.
Its intended value IS declared here, in [`infra.json`](infra.json), and
`npm run infra:check` fails if the live record stops matching.
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
the site doesn't actually serve.

To verify, use `npm run infra:check`, NOT `dig ... SVCB`. macOS ships dig
9.10.6, which doesn't know the `SVCB` mnemonic and silently degrades the
query to an `A` lookup, so it prints nothing and the record reads as
missing when it's fine. If you want the raw answer, ask for the type by
number (`dig _index._agents.aadhar.sh TYPE64 +short`) and expect RFC 3597
generic hex back.

### Cloudflare bindings

- **RN_KV** (KV namespace ID `3cb8a107c58e47dc9244e75b33401f36`) — caches the
  playlist tracks, artist profile pics, the visit-count mirror, and a few
  crawler results. ~10K writes/day budget; we use a handful. (The photo
  manifest left KV 2026-07-28: the worker bundles `photo-index.json` +
  `hashes.json`, so the pool is module memory and a deploy is its bust. The
  `/lens` rate-limit counters left KV 2026-08-04 for the Rate Limiting binding
  below — they were a WRITE per allowed request on the busiest route here, which
  had quietly made "we use a handful" false.)
- **LENS_RL_\*** (Rate Limiting bindings, `ratelimits` in `wrangler.jsonc`) —
  the four per-IP crawl budgets `/lens` and the `/mcp` lens tools share:
  inspect 30/min, shot 8/min, compare 4/min, browser 4/min. Counters are
  per-colo and cost no write. `LENS_BUDGETS` in `lens.js` mirrors the ceilings
  because that is what the 429 message quotes, and a contract test pins the two
  configs and the code together so a message cannot outlive its limit.
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
- **BROWSER (Browser Rendering binding)** — powers `/lens/shot` and
  `/lens/browser` inside **`/lens`** ("The Other Web", which shows any URL the way a
  machine does). `/lens`'s Human view embeds framable sites in a live cross-origin
  `<iframe>` (loaded by the visitor's own browser) and screenshots the rest
  server-side via the binding's `quickAction("screenshot", …)` (real headless
  Chrome; the old REST-API path with `BROWSER_RENDER_TOKEN` is retired). Without
  the binding, `/lens/shot` returns a clean 503 and the Human view falls back to
  the readable-text reader, so the live iframe + all machine lenses keep working
  regardless. (`CF_ACCOUNT_ID` stays a var, but only for `/ledger`'s Analytics
  Engine SQL reads alongside `ANALYTICS_READ_TOKEN`.)
  Screenshots are KV-cached 1h (`lens:shot:<sha256(url)>` in RN_KV) and rate-limited to
  8/min/IP; `/lens/fetch` (the parsing engine) is rate-limited 30/min/IP. Those limits
  are Rate Limiting bindings as of 2026-08-04, not KV counters; the RESPONSE cache is
  still KV, and only the counters moved. Both `/lens/*`
  fetch routes guard against SSRF (http(s) only, no localhost / private / link-local /
  `169.254.169.254` hosts, ports 80/443 only, 8s timeout, 2MB cap) and identify honestly
  as AadharshBot. Framability is read from the target's `X-Frame-Options` /
  `Content-Security-Policy: frame-ancestors` in the `/lens/fetch` pass, so no extra probe.

### Observability: Workers Traces + the span vocabulary

Three layers, deliberately not redundant:

1. **Workers Logs** (`observability.enabled`) — one structured line per
   worker-owned request from `serveWorkerRequest`: path, method, status, ms,
   **version**, country, bot. Cheap, always on, and the right tool for "what
   happened". `v` is the 8-char version prefix and it is the ramp's read-out:
   during a gradual deployment two versions answer the same routes, so filtering
   on it is the difference between "the site has errors" and "the new version
   has errors". `deploy:promote` checks status codes and then tells you to come
   here, because status codes are all it can check.
2. **Analytics Engine** — `BOT_LEDGER` (identified crawler hits, priced by
   `/ledger`) and `PERF_PROBE` (`perf-probe.js`, the :07/:37 homepage-fragment
   latency series). Both are long-retention, low-cardinality COUNTERS.
3. **Workers Traces** (`observability.traces`, added 2026-07-29) — the span
   tree. Auto-instruments every outbound fetch, binding call, and handler
   invocation; `lib/trace.js` hangs named spans off that so the children have a
   parent worth grouping by. This is the layer for "why was it slow" and, more
   often here, "which quiet thing has been failing".

Spans go through `lib/trace.js` (`span(name, fn, attrs)`), never
`tracing.enterSpan` directly. Names are `<surface>.<phase>`, lowercase and
dot-separated; the dispatcher is the one exception, naming its spans
`route <template>` off the ROUTES/PREFIX tables so a tree reads as a route
rather than a slug. Attributes follow the photo pipeline's rule: an undefined
value is SKIPPED, never coerced to 0 or "unknown".

Sampling is **100%**, which is a choice and not a default-by-omission: the rate
is per-Worker rather than per-route, so thinning it would thin exactly the rare
events this was turned on for. The allowance is **200K events/day** (observability
sits on the free tier here regardless of the Workers plan). Budget in SPANS, not
visits: one `/lens/fetch` scan is 33-46 spans, so scan bursts spend it far faster
than page views do.

**A span cannot measure CPU.** Workers spans inherit the frozen-clock semantics of
`Date.now()` — the clock advances across I/O, never during synchronous execution.
Measured in production 2026-07-29 on a 752KB page: `lens.inspect` 685ms decomposed
as `lens.discovery` 656 + `lens.inspect.fetch` 29 + `lens.inspect.parse` **0**,
where that parse had just run HTMLRewriter over 752KB and emitted 81KB of
markdown. So `home.grid.render` and `lens.inspect.parse` read 0 by design; they
are kept for their attributes, which record how much work the phase was handed.
Read `cpuTime` off the tail/log event for actual CPU (193ms on that same request).
This corrects the original premise of this work, which assumed spans would see
what `perf-probe.js` cannot.

**The frozen clock holds in LOCAL dev too, which is worth knowing before you go
looking for CPU there.** Verified 2026-08-04 against `wrangler dev`: exercising
`/photos/grid.html` produced `home.grid.manifest`, `home.grid.alt` and
`home.grid.render` all at **0 ms**, with `home.grid.render` carrying
`pool_size: 158` and `alt_known: 158` — the same shape production reports, on a
local runtime with no Spectre mitigation to blame. The reasonable guess going in
was that local dev would escape the frozen clock and finally measure the
synchronous work; it does not. Local spans are for SHAPE and ATTRIBUTES, exactly
like production ones. `route /photos` read 8 ms in the same run, because that one
spans real I/O.

**Spans are readable in `wrangler dev` as of 2026-08-04, with no config, no
dependency, and no version bump** (Wrangler 4.118.0 already has it). The tracer
reaches local dev for free because of the injection in `lib/trace.js`:
`installTracing(tracing)` runs at module scope in `index.js`, which workerd loads
locally too, so `npm run dev` gets the real tracer and the named spans rather
than the degraded direct calls the contract tests get under plain node.

The recipe is in MAINTENANCE.md under "Read a trace". Short version: the Local
Explorer answers at `/cdn-cgi/explorer/api` (an OpenAPI schema covering KV, D1,
R2, Durable Object and Workflow state as well), and traces are a read-only SQL
query POSTed to `/cdn-cgi/local/explorer/api/local/observability/query`. Our own
`route <template>`, `home.grid.*` and the rest come back nested under the
auto-instrumented `fetch`, `cache_match`, `cache_put` and `GET` spans, with
`attributes` stored as JSONB (read it via `json(attributes)`).

This closes the last gap on the local side of the span story. Until today the
vocabulary above could only be read in production, which meant the cheapest way
to find out whether a new span was named or attributed usefully was to deploy it.

Where the spans are, and what each one is FOR — every one of these is a place
the existing layers structurally could not reach:

| span | the question it answers |
|---|---|
| `route <template>` | which route owns this fetch/KV child; `route.self_fetch` marks a `/lens` self-scan's inner dispatch |
| `home.grid.*`, `rn.tracks.*` | the two hydration fragments. Splits manifest-vs-alt, which `perf-probe.js` fuses into one positional AE double. `home.grid.render` reads 0ms (see the CPU note above) and earns its place on attributes alone |
| `rn.scrape.{playlist,tracks,artists}` | the 3-tier Spotify scrape, cold-miss only. `rn.artists_cached` vs `_scraped` says whether the artist KV cache is actually saving the network |
| `lens.inspect.{fetch,parse}`, `lens.discovery` | `out.elapsedMs` is fixed BEFORE the 28-probe fan-out (botViews is 6 of its own), so a scan's discovery phase was entirely unmeasured. Production, 752KB page: 782ms total, `elapsedMs` reported 29. `lens.inspect.parse` reads 0ms (CPU note above) and is kept for its byte/word attributes |
| `lens.shot`, `lens.browser` | Browser Rendering. Same span name on hit and miss (differing on `lens.cache`) so hit rate is a group-by, not a join; the four distinct 502 shapes are separated by `lens.outcome` |
| `cron.*` | a cron has no response, no status, and no visitor to complain |
| `around.neighbor` | every degradation here is designed to be quiet (a disallowing robots.txt is a legitimate skip). The rollup makes "3 of 20 neighbors dark for a month" one number |
| `census.host` | a time series with silently missing rows is worse than none; the per-host catch is correct AND is how a 16-site roster becomes 3 |
| `webmention.send` | `webmention.capped` flags a run that stopped at MAX_SENDS_PER_RUN, which the summary log cannot express |
| `cal.busy` | `cal.source` (fresh/live/stale/none) + `cal.fail_closed`. The fail-closed 503 is a real person not getting a coffee slot, and it used to reach you only by them mentioning it |

### XP visual vocabulary (CSS)

**Design system:** [`design/DESIGN.md`](design/DESIGN.md) is the Luna brief (canonical
reference + DON'T-modernize guardrails); [`design/tokens/`](design/tokens/) is the
canonical token set (fonts, Luna palette, bevels, radii). Pull from those before
hardcoding any color/font/bevel. Captions = Trebuchet MS, UI/body = Tahoma→Verdana,
mono = Courier New — those three stacks only. The rest of `design/` is HISTORY,
not spec: `GREENFIELD.md`, `PORTING.md`, and `explore-bac-map.md` are July-2026
design passes the site did not converge on, and their byte budgets and file:line
citations are stale. [`design/README.md`](design/README.md) draws that line; read
it before treating anything in there as a target.

**HARD RULES (strong owner preference):** (1) **internal/native fonts ONLY** — never ship `@font-face` with `url()`, web fonts, `@import`, or font preloads; the served pages carry ZERO font bytes (the design system's `@font-face local()` rules are reference-only, never inlined into a served page). (2) **keep perf lean** — fold design tokens in WITHOUT regressing the byte budget: on a brotli'd inline page, tokenizing repeated literals is a wash (brotli already dedupes) while token *definitions* are net-new bytes, so only the FONT tokens (`--font-*`) are inlined site-wide; color/gradient tokens are NOT inlined (they cost bytes for no brotli gain). no external stylesheet, no JS for styling. **The served pages load NO cross-origin assets, and the Cloudflare Web Analytics beacon is why that sentence needs a footnote (owner-approved 2026-07-29).** The homepage, and only the homepage, runs RUM, and BOTH of its legs are first-party: `/ledger/rum.js` proxies the beacon script, `/ledger/rum` forwards the reports, both in `_worker.js/rum.js`. Describe it precisely — the browser speaks only to this origin, while this server still calls Cloudflare on the visitor's behalf. "First-party" is the easiest claim on this site to round up into a privacy win it is not. Why RUM at all: MAINTENANCE.md has named it the outcome source for LCP/INP/CLS since the perf budget was written, and until it reports, the byte ceilings here are guesses standing in for field data; the 2026-04-30 Navigation Type release is what makes the bfcache `no-cache` choice and the hand-tuned speculation rules measurable rather than asserted. Why proxied: `static.cloudflareinsights.com` is on EasyPrivacy, so blocker-running visitors dropped out of the sample entirely, and they skew toward the engines whose bfcache/prerender behaviour is the whole point of the measurement. This is NOT an oversight to clean up. Six surfaces move together or not at all, enforced by a `build.mjs` tripwire (#7b) plus a contract test: the `<script src="/ledger/rum.js">` in `index.html` AND its `send.to` config (without `send.to` the beacon silently falls back to its hardcoded cloudflareinsights.com endpoint, which the CSP now blocks, so every report fails while the script looks fine), the `/ledger/rum*` pair in `_worker.js/index.js`, the same pair in `run_worker_first` in BOTH wrangler configs, CSPs free of `cloudflareinsights.com` in BOTH `_headers` and `_worker.js/lib/security.js`, the disclosure on `/whoareyou` AND its markdown twin `holding/md/whoareyou.md`, and the `/security` CSP summary. **UNVERIFIED, check after the next deploy:** the collector sees the worker's subrequest rather than the visitor's, so geo attribution may collapse; `cf-connecting-ip` is forwarded but whether the collector honours it from a worker is unknown. If the dashboard's country breakdown goes flat, that is this — amend the disclosure, don't quietly keep it. Zone-side automatic injection is NOT an option here: the worker serves these pages as precompressed br/dcz bodies with `encodeBody: "manual"`, and the edge cannot rewrite HTML it did not compress. Site-wide would mean putting it in `nav.js`, which every page loads — an extra request on the shell's critical path, so don't, absent a measurement. (3) **authoring stays buildless; serving is minified, on every page** — the ONLY build is `build.mjs` (deploy-time transform: minifies EVERY served HTML document (structure + inline CSS/JS), the six client scripts, `luna.css` + `lwe-base.css`, and the worker modules' `/*min*/` CSS literals into a staged `.build/` copy, shipping a readable twin beside each one — `/<name>.src.js`, `/luna.src.css`, and a `.src.html` per page, named by a banner comment on line 1; hard-fails the deploy if `luna.css` doesn't parse; and content-hashes `nav.js` + `luna.css` into immutable `/a/<name>.<hash8>.<ext>` URLs, repointing every `src=`/`href=` ref to them so the shell earns a 1-year immutable cache — the unhashed `/nav.js` + `/luna.css` stay as short-cached fallbacks for cal/coffee's absolute refs + any stale HTML). `wrangler.jsonc` self-builds via its `build.command` and points `main`+`assets` at `.build/holding`, so NO deploy path (bare `wrangler deploy`, `npm run deploy`, Workers Builds) can ship the readable originals; local dev uses `wrangler.dev.jsonc` (readable `holding/`, fast reload). Never bundle, and never extend the build past this without the owner's say-so (`luna.css` was owner-approved 2026-07 for an ~8.7KB brotli win on a render-blocking sheet; the `/a/` content-hashing of `nav.js` + `luna.css` was owner-approved 2026-07-21 to clear PSI's "efficient cache lifetimes" audit; whole-site HTML minification was owner-approved 2026-07-31, retiring the older "never minify the garage/lwe HTML" rule — the argument being that a readable twin one banner-click away keeps View Source honest, because the twin is the SAME program, which is exactly the property that separates minifying from compiling).

> **Two traps the whole-site HTML pass hit, both on `/garage/horizon`, both worth knowing before touching served HTML.** (a) **minify-html decodes HTML entities inside quoted attribute values**, and no option turns it off: `value="&lt;script&gt;bad()&lt;/script&gt;"` ships as `value="<script>bad()</script>"`. That is spec-legal (a quoted attribute may hold raw `<`) and DOM-identical — verified in a browser, where the input's `.value` is byte-for-byte the intended payload and nothing renders from it. The consequence is that **any scanner over served HTML must WALK tags rather than search for `<script`**: the naive regex in `contract-tests.mjs` read horizon's XSS demo payload and its `<iframe srcdoc>` as two real inline scripts and failed the deploy demanding CSP hashes for them. This is the third naive scanner that page's demo content has caught. (b) **Lightning CSS 1.33 does not know the CSS Overflow 5 carousel selectors** (`::scroll-marker`, `::scroll-marker-group`, `::scroll-button()`, `:target-current`) that horizon demos on purpose; it warns and then emits them verbatim, so `minifyCss` tolerates exactly that warning family and re-proves the pass-through on every build instead of trusting the one probe that established it.

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
- Each pending booking gets its own **BookingWorkflow** (Cloudflare Workflows)
  expiry timer instead of a weekly cron sweep: it `waitForEvent`s up to
  `PENDING_TTL_DAYS` for the host's approve/decline (which fire a `host-decision`
  event to end it early), and on timeout reclaims the slot if it's still pending.
  The class is defined in `cal/src/workflow.js`, re-exported from the root
  `_worker.js/index.js`, and bound as `BOOKING_WORKFLOW`. Slots are held via
  per-slot `held:<start>:<end>` KV keys (no more race-prone shared index).

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
   Mitigation: keep `/images/<thumb>` worker-first; a re-encode mints a fresh
   content-addressed `/i/` URL by itself, so there is no version to bump.

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
    behavior. If an asset looks stale, hit it with a fresh `?cb=$RANDOM`: if
    that differs from the plain URL's response, you are looking at cache
    state, not missing bytes.

13. **A Worker cannot read the client's `Accept-Encoding`, so it cannot
    negotiate compression.** The runtime rewrites the header to a constant
    before the worker sees it. Measured 2026-07-26 in `wrangler dev`: four
    requests sending `identity`, `br`, `gzip`, and `br;q=0, gzip` ALL arrived
    as `"br, gzip"`. That value describes what the EDGE can accept, never what
    the client asked for, so `if (acceptsBrotli(request))` is dead code that
    always takes the true arm. Serving precompressed bytes therefore relies on
    the edge down-converting for clients that can't take br ("serve Brotli from
    origin"), and `encodeBody: "manual"` is mandatory or the runtime
    re-compresses your already-compressed body.

    **`wrangler dev` does not emulate that edge layer**, so it cannot validate
    the design — it only proves the negotiation is impossible. Locally, three
    of four client cases came back mangled (identity got raw brotli with the
    content-encoding stripped, br got brotli-in-brotli at 13,051 bytes, gzip
    got gzip-of-brotli). Anything touching response encoding on a
    render-blocking path (`/a/*` is nav.js + luna.css) must be verified against
    production behind a canary before it becomes the default, because the
    failure mode is a white screen rather than a slow page. Shell precompression
    was shipped that way, behind a `?br=1` canary, and once production confirmed
    it the canary and its `SHELL_PRECOMPRESS_DEFAULT_ON` flag came out; `/a/*` is
    q11 brotli unconditionally now. Earn the default the same way next time.

    **ROOT CAUSE (2026-07-26), after three wrong suspects.** The double
    compression was OURS, not the platform's. `encodeBody` is **write-only**
    Response init, so rebuilding a response drops it while leaving the
    `content-encoding` header visible, and the runtime then compresses the body a
    second time to match. `withSecurityHeaders` (`lib/security.js`) rebuilds
    EVERY worker response, which made `encodeBody: "manual"` a no-op site-wide.
    It now carries the flag forward whenever a content-encoding is present.

    Isolated with `/encoding-test`: a constant 30-byte brotli payload built in the
    worker, touching no assets. 34 wire bytes in two brotli layers before the fix,
    30 in one layer after. `?br=1` went 13,051 (two layers) to 13,047 (one layer,
    decoding to 46,268 valid JS).

    **Anything that rebuilds a Response must preserve `encodeBody`.** There is no
    getter for it, so the loss is silent and the symptom (a body that decodes once
    into more compressed bytes) looks like a platform bug. Check this FIRST.

    Three suspects were investigated and exonerated. Two of the three are real
    facts worth keeping, they just weren't the cause: (1) a worker cannot read the
    client's Accept-Encoding, so it genuinely cannot negotiate compression;
    (2) the edge does NOT down-convert, so an `identity` client handed br gets raw
    brotli, which is why negotiation can't be faked either; (3) the static-assets
    layer was innocent — `/abr/` had been built only to bypass a suspect that
    turned out not to matter, so it was deleted.

    What this unlocks: q11 precompression (~19% off nav.js + luna.css), and
    `Content-Encoding: dcb` from a worker, since `Available-Dictionary` demonstrably
    reaches it in production (cf-ray a2174bfc). Shell deltas measured 93-97%
    across a real deploy, and a dictionary 11 days stale still gave 87-93%, so
    build-time deltas against a committed dictionary work and need NO wasm. Only
    the SSR'd homepage would need a runtime compressor, because the runtime ships
    no brotli encoder at all (CompressionStream is gzip/deflate only).

14. **The shell ships dcz (zstd) deltas, not dcb (brotli), and the reason is
    latency rather than bytes.** Cloudflare passes both through identically on all
    plans, so it is a free engineering choice. Owner call, 2026-07-27.
    `--patch-from` was measured and buys nothing at this scale.

    **Re-measured 2026-07-28 with real dictionaries, and BOTH original inputs were
    wrong, in opposite directions.** This note used to say brotli won by one byte
    (79 vs 80) and zstd decoded about 2x faster. Neither holds:

    - *Size now favours dcb by more than a byte.* Across all 12 shipping
      dictionary/target pairs: dcz 3,589 bytes total against dcb 3,344, so dcb by
      245 (6.8%), winning 11 of 12. The deltas grew into exactly the regime this
      note predicted the 5-8% brotli edge would appear in. Widest single gaps:
      lens.js 816 vs 756, nav.js 729 vs 685.
    - *Decode favours dcz far harder than 2x.* With an actual dictionary, nav.js
      reconstruction (47,615 bytes either way) is **0.0165ms dcz against 0.1368ms
      brotli, or 8.3x**. Dictionary decode is where zstd pulls away: it seeds the
      window and copies, while brotli still pays a full entropy decode.

    The decisive part is structural: **decode scales with the RECONSTRUCTION, not
    the delta.** A 685-byte dcb delta still rebuilds 47,615 bytes, so shrinking the
    delta never shrinks the decode gap. Break-even at 9 Mbps is ~135 bytes saved
    per asset and dcb saves 44, so dcz wins by about 3x — and the margin WIDENS on
    slow devices, where decode scales with CPU while 44 bytes stays 44 bytes.

    So the conclusion survives, but it was a coin flip on the old numbers and is
    not one on these. Do not re-open it on the size table alone: that table now
    favours dcb, and it is the wrong axis.

    One cost the byte comparison hides: `node:zlib`'s brotli has NO dictionary
    parameter (MODE, QUALITY, LGWIN, LGBLOCK, DISABLE_LITERAL_CONTEXT_MODELING,
    SIZE_HINT, LARGE_WINDOW, NPOSTFIX, NDIRECT is the whole list). Those dcb
    figures came from shelling out to the `brotli` CLI with `-D`. Switching would
    reintroduce a CLI dependency in the build path, which is precisely what moving
    the deltas into the build deleted.

    **zstd above level 19 is dead weight here.** Levels 19, 20, 21, 22, 22+long-
    distance-matching and 22+btultra2 produce BYTE-IDENTICAL output on all 9 shell
    assets and all 12 deltas. What separates 20-22 is window size and long-range
    search, and the largest asset is 47KB raw, so level 19's window already spans
    the whole file and there is no long range to find. build.mjs's pin at 19 is
    optimal; do not spend an afternoon re-checking it.

    dcz's framing is also the tidier of the two: the dictionary hash rides in a
    Zstandard SKIPPABLE frame (magic `0x184D2A5E` LE, then a 4-byte LE length of
    32, then the raw SHA-256), so any conforming decoder skips it and
    `zstd -d -D dict` round-trips the whole file untouched. dcb instead needs
    format-specific handling of its 36-byte prefix.

    Deltas are BUILD OUTPUT, generated by build.mjs with `node:zlib`'s zstd. An
    earlier version of this note said dictionary compression was "unreachable from
    Node" and shipped a workstation script with committed artifacts; that limit is
    BROTLI's, and generalizing it to zstd was wrong. `zstdCompressSync` takes a
    `dictionary` option, it beats shelling out (116 bytes where the zstd CLI gave
    120), and the foreign `zstd -d -D` CLI decodes Node's output byte-exact,
    skippable prefix included — the interop check that matters, since the real
    decoder is a browser. So: no CLI in the deploy path, no committed `.dcz`, no
    step to forget, and no staleness tripwire needed, because a delta is a pure
    function of bytes the build just produced.

    What still has to be committed is `holding/a-dict/`, the SHELL dictionary set,
    because an `/a/` asset is content-addressed: a change mints a new URL, so its
    dictionary must be bytes the BROWSER already holds and no build can derive that
    from source. `npm run shell:roll` adopts the current shell and prunes to 3 per
    asset; it stays a human step because it writes into the source tree, which
    build.mjs must never do. Not urgent either — a dictionary 11 days stale still
    gave 87-93%. `a-dict` is `.assetsignore`d (build input, not a public URL).

    **PAGES use two dictionary tiers.** build.mjs derives ONE raw 64KB family corpus
    from the staged documents, ships it at an immutable `/a/page-family.<hash8>.dict`,
    and every HTML response advertises it via `Link: rel="compression-dictionary"`
    (`lib/security.js`). It also diffs the current page against the committed
    `holding/p-dict` snapshots from the previous release. The worker tries the
    `Available-Dictionary` tag it receives, so a returning visitor gets the old
    per-page ratio (93-97% in the measured set) while a visitor who holds only the
    family corpus gets the broader fallback (~26% off q11: 298,933 B vs 405,909 B
    across 38 pages). Both candidates are emitted only when they beat plain q11.
    `npm run shell:roll` rolls both `a-dict` and `p-dict`; page snapshots are Brotli'd
    in the repo, ignored by the asset upload, and decompressed only at build time.
    RFC 9842 requires RAW bytes here: a `zstd --train` artifact is self-describing,
    the server library reads its tables, Chrome reads the same bytes as content, and
    the navigation dies on `ERR_CONTENT_DECODING_FAILED`.

    **Plain (non-delta) responses stay brotli q11, and that is forced, not chosen.**
    A worker cannot see the client's Accept-Encoding (gotcha 13), so plain zstd is
    unnegotiable server-side; the ONLY safe zstd trigger is `Available-Dictionary`,
    which doubles as proof the client speaks dcz. So "zstd where it wins" IS the
    delta path. Loader classes differ (#119): js/css dcz proven in production, html
    server-side proven (149-byte page delta decodes to the live page), svg OFF by
    design (Chromium's image loader chokes). `npm run dcz:check` asserts both page
    tiers against production, reading the family dictionary out of the live `Link`
    header and the per-page candidate from `holding/p-dict`. Roll SHELL
    dictionaries FROM THE DEPLOYED BUILD (main, post-deploy), never from a feature
    branch: the dictionary must be bytes browsers actually hold, and a branch build
    is not that. (`shell:roll` writes into `holding/a-dict/` the moment it runs —
    if you run it to read the code, `git checkout -- holding/a-dict` after.)

15. **Attaching CDP's `Network` domain suppresses Chrome's Early-Hints preload,
    so a devtools-driven trace reports a FALSE "the browser ignores our 103."**
    Chrome still fires `Network.responseReceivedEarlyHints` carrying the correct
    `link` header, then fetches the hinted assets ~5ms AFTER the 200's headers.
    That reads exactly like the 103 buying nothing, and it cost a whole
    investigation on 2026-07-27 before the control run gave it away: the same
    Playwright harness pointed at `https://www.cloudflare.com/`, a known-good 103
    origin, failed identically. Two unrelated origins failing the same way is the
    tell that the instrument is lying, not the site.

    **Measure it with a plain `page.goto` + `performance.getEntriesByType(
    "resource")`, no CDP session, fresh profile for a cold cache.** Two signals,
    and you need both. `initiatorType === "early-hints"` says the feature is
    active. A fetch duration far too small for the byte count says the preload
    actually completed inside the 103 window: 7632 bytes of `luna.css` in 0.8ms
    is not a network fetch, it is a preload-cache hit. Do NOT judge by
    `startTime`, which is stamped when the DOCUMENT consumes the resource and so
    always looks like it lands just after the 200, whether or not the hint worked.

    The payoff scales with the 103-to-200 window, which is worker think-time, so
    it only shows on a cold isolate or a slow KV read. Measured: a ~280ms window
    preloaded fully (0.8ms recorded fetch); windows under ~100ms did not (26-35ms
    real fetches). That is `shell-assets.js` working as its own comment describes,
    not a defect. Ruled out along the way and worth not re-testing:
    `Network.setCacheDisabled`, `Emulation.setCPUThrottlingRate`, headless vs
    headful, and an explicit `--enable-features=EarlyHintsPreloadForNavigation`.
    Playwright's default `--disable-features` list never mentions Early Hints.

    The same caution applies to paint metrics from an embedded/automated browser
    pane: a tab that is not actually visible defers paint, which made FCP look
    like it trailed DCL by 235ms when a real trace showed FCP landing 291ms
    BEFORE DCL, mid-stream. Confirm any paint claim against a real window.

16. **Only `_worker.js/index.js` may `import ... from "cloudflare:workers"`.**
    Everything else in `holding/_worker.js/` and `cal/src/` is ALSO imported by
    `contract-tests.mjs` under plain node (`node --test`), and node's ESM loader
    rejects the `cloudflare:` scheme at LINK time with
    `ERR_UNSUPPORTED_ESM_URL_SCHEME`. That kills the entire 57-test suite at
    import, before one assertion runs — not a single failing test, a suite that
    never starts. It is why `counter.js` hand-rolls its Durable Object instead of
    importing the base class, and it bit the Workers Traces work on 2026-07-29:
    a static `tracing` import inside `lib/trace.js` took the suite down through
    six transitive importers.

    The fix is INJECTION, not a dynamic import. `lib/trace.js` and
    `cal/src/trace.js` both export `installTracing(candidate)` and hold a
    module-level `null` until `index.js` — the one module only workerd ever loads
    — calls it at module scope, which completes at isolate init before any handler
    runs. Under node nothing installs it and every span degrades to a direct call.
    A top-level `await import("cloudflare:workers")` would also work but is worse:
    it makes the module graph async on a live worker's critical path to buy
    nothing the injection doesn't already give.

    Corollary: the two trace helpers are near-duplicates ON PURPOSE. Dependency
    direction is holding -> cal (`index.js` imports `cal/src/index.js`), and cal's
    Vitest pool boots from `cal/src/index.js` alone, so a cal -> holding import
    would make cal untestable without the site tree. Do not consolidate them.

17. **`script-src` is per-document sha256 hashes, and the committed map is EMPTY
    on purpose.** `lib/csp-hashes.js` ships `PAGE_SCRIPT_HASHES = {}` with a
    `// build:csp-hashes` marker; build step 7c rewrites that line in the staged
    copy from the FINAL bytes (after minification and the `/a/` ref rewrite, before
    step 8 compresses). Same generated-module convention as `shell-assets.js`.

    Empty is correct for `npm run dev`, which serves the readable unminified tree
    whose blocks hash differently. A path with NO entry falls back to
    `'unsafe-inline'`, which is why the build hard-fails below 40 covered documents:
    a collapsed map is otherwise silent, since every page just quietly goes loose.
    An entry with an EMPTY list is the opposite and the best case, a document with
    no inline script earning a bare `script-src 'self'`.

    Hashes rather than a nonce because the staged documents are PRECOMPRESSED
    (gotcha 14): nothing can be injected per request into bytes brotli'd at build
    time, and the runtime has no brotli encoder to redo them. The live
    worker-rendered pages (`/whoareyou`, `/around`, `/coffee`, `/search`, `/ledger`,
    `/rn/admin`, `/serendipity`) are NOT precompressed, so a per-response nonce is
    the right mechanism there and is the open follow-up. They keep the loose policy
    until then, which is no worse than before.

    Three things verified in a real browser rather than assumed, all on 2026-07-30:
    a HASHED `<script type="speculationrules">` is allowed and an unhashed one
    raises a `script-src-elem` violation, so the 25 speculation-rules blocks need
    ordinary hashes and NOT the `'inline-speculation-rules'` keyword; Node's
    `createHash("sha256").update(body, "utf8")` matches the browser's digest
    byte-for-byte on a real staged block containing non-ASCII (26 of the 73 do);
    and a one-space edit to that block is blocked, so the check has teeth.

    Event-handler ATTRIBUTES cannot be hashed. Step 7c hard-fails and names them
    rather than reaching for `'unsafe-hashes'`, which would re-permit attribute
    execution generally and hand most of the win back. Its attribute scanner is
    quote-aware for a reason: `garage/horizon.html` carries
    `value="&lt;img src=x onerror=alert(1)&gt;"` as demo TEXT, and a naive
    `/ on\w+=/` over the raw tag calls that an event handler.

    **The rollout is not finished.** `ENFORCE_PAGE_HASHES` in `lib/security.js` is
    FALSE, so the hashed policy ships as `Content-Security-Policy-Report-Only`
    beside the loose enforcing one. Flip it only after a production deploy has run
    report-only and come back clean, the way `SHELL_PRECOMPRESS_DEFAULT_ON` earned
    its default. You cannot hedge inside one header: a browser that understands
    hashes IGNORES `'unsafe-inline'` in the same directive, so the two policies have
    to be two headers. The failure mode is silent, a blocked inline script leaves
    the page rendering and merely dead.

18. **`scrollbar-color` INHERITS, and it silently disables every
    `::-webkit-scrollbar` rule underneath it.** Chromium treats the standard
    scrollbar properties and the `-webkit-` pseudo-elements as mutually
    exclusive: if an element's used `scrollbar-color` is anything but `auto`,
    all of its `::-webkit-scrollbar-*` rules are discarded. `xpChromeCss` sets
    `html { scrollbar-color: … }` for the whole site, so EVERY element inherits
    a non-auto value it never declared, and any element trying to draw a custom
    scrollbar gets nothing.

    The failure reads as "my CSS did not load" rather than as a conflict,
    because the fallback is the platform default — on macOS an overlay bar of
    **zero width**, so the track is not merely unstyled, it is invisible and
    takes no space. Measured on `/terminal` 2026-08-05: 0px with the inherited
    value, 16px after `scrollbar-color: auto`.

    The fix is to reset to `auto` on the element and put the standard property
    behind `@supports not selector(::-webkit-scrollbar)`, which Firefox (the one
    engine that needs it) matches and Chromium/Safari do not. Check the
    INHERITED value first the next time a custom scrollbar does not appear.

19. **A backtick inside a CSS comment inside a `/*min*/` literal ends the JS
    template literal.** The worker's static CSS lives in backtick literals that
    `build.mjs` step 8 minifies in place, and prose in a CSS comment is still
    JavaScript source. Writing ``overflow-y is `scroll`, not `auto` `` in one
    truncated the literal mid-file and the build failed with a JS parse error
    pointing at a line that looked fine. Nothing is wrong with the CSS; the
    string ended early. The build's post-substitution re-parse is what catches
    it, which is the reason that re-parse exists — keep backticks out of those
    comments.

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
- **`codemode/`** was a spike against Cloudflare's code-mode pattern: generate a
  typed client from the Serendipity MCP's own `tools/list`, then let a model
  write one program instead of chaining tool calls. The codegen worked; the
  production half (running that program in a Worker Loader isolate with the MCP
  bound by RPC) sat in Cloudflare's closed beta, so it never wired into
  anything. Removed 2026-07-23 after a month unreferenced by any page, script,
  or CI job. `git log --diff-filter=D -- codemode/` finds it if the beta opens.
