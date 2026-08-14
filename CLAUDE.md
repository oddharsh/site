# aadhar.sh — personal site

A resto-mod 2003-aesthetic personal site for Aadharsh Pannirselvam, deployed
as a Cloudflare Worker with static assets. Cohabiting source modules in this
directory, deployed by one site Worker:

- **`www/`** — the live `aadhar.sh` site (Workers static assets + the `_worker.js/` dispatcher)
- **`cal/`** — a custom coffee/bagel booking module at `aadhar.sh/coffee`, delegated by the root Worker
- **`serendipity/`** — the event dashboard module at `aadhar.sh/serendipity`, delegated by the root Worker

The look is deliberately Windows XP / Outlook Express era: blue title bars,
Verdana/Tahoma fonts, raised 3D bevel buttons, sunken inputs, OKLCH-encoded
colors that read modern in source but render period-correct.

---

## Repository layout

Read this before going looking for a file. Every top-level entry, and what
decides which one a given file belongs in:

| entry | holds |
|---|---|
| **`www/`** | **everything the site serves.** Pages, the `_worker.js/` dispatcher, client scripts, CSS, photos, dictionaries. If a browser can fetch it, it is in here. |
| `cal/`, `serendipity/` | the two application modules the site Worker bundles and serves at `/coffee` and `/serendipity`. They sit outside `www/` because they are programs with their own tests, not documents. |
| `cf-garage/`, `lwe-ask/`, `lens-reader/` | the three SEPARATELY deployed auxiliary Workers, each with its own `wrangler.toml` and its own deploy. Nothing here reaches production through the site Worker. |
| **`scripts/`** | **every developer tool.** The build (`build.mjs`), the test suite (`contract-tests.mjs`), the route oracle, the perf budget, and the `check-*` / `gen-*` family. Nothing in here ships. |
| `www/scripts/` | the photo and asset pipeline specifically, kept beside the pixels it operates on. The split from `scripts/` is by SUBJECT: this one touches `www/images` and `www/i`, nothing else does. |
| **`config/`** | `infra.json` (declared Cloudflare + GitHub state), `site-manifest.json` (the surface registry), `tsconfig.json`. |
| `pipelines/` | the page GENERATORS, one directory per section: `content/` (the shared page contract), `garage/`, `lwe/`. These author into `www/`; they are not part of the build. |
| **`docs/`** | the long-form runbooks: `MAINTENANCE.md`, `PHOTO-PIPELINE.md`, `DEPENDENCIES.md`, `UNDERSTANDING-REVIEW.md`. |
| `design/` | the Luna design system. `tokens/` and `DESIGN.md` are canonical; the rest is history, and `design/README.md` draws that line. |
| `migrations/`, `talks/` | D1 SQL for the site Worker, and talk material. |

Four things stay at the repository root because their tooling demands it, and
moving any of them costs more than it buys:

- `wrangler.jsonc` + `wrangler.dev.jsonc`. Workers Builds runs from the repo
  root and wrangler resolves `main` and `assets.directory` relative to the
  config file, so relocating these means editing the Cloudflare dashboard
  FIRST (the deploy command is mirrored in `config/infra.json` and `infra:check`
  fails on drift it would otherwise invent itself).
- `package.json`, `pnpm-workspace.yaml`, `pnpm-lock.yaml`, `.node-version`.
- `CLAUDE.md` and its `AGENTS.md` symlink, plus `README.md`.
- `.github/`, `.gitignore`.

Two naming notes worth having. `www/` was called `www/` until 2026-08-11,
so any branch or note older than that says `holding` for the same directory.
And the ONE path that reads as a duplicate, `scripts/` against `www/scripts/`,
is the subject split in the table above rather than an accident.

---

## Quick reference

> Full task-by-task ops runbook (add photos, swap the now-playing playlist,
> bust caches, version bumps, what every script does): [MAINTENANCE.md](docs/MAINTENANCE.md).

```bash
# production, the normal path, and it needs NOTHING from you at a terminal:
# merge to main; CI promotes the tested commit to production; Workers Builds
# UPLOADS it as a version and moves no traffic; ramp.yml then takes it to 10% on
# its own and WAITS for you to approve the `full` job in the Actions tab, which
# is what carries it 50% -> 100%. Approve it there, or run the commands below.
#
# By hand (still supported, and the only way to roll back):
pnpm run deploy:promote --dry-run     # which version WOULD ramp. run this first
pnpm run deploy:promote
pnpm run deploy:promote --status      # what is serving right now
pnpm run deploy:promote --rollback    # 100% back to the previous version

# straight to 100%, no ramp. the fallback for the infra:check deadlock below,
# and for anything where an extra step is the risk rather than the safety net.
pnpm run deploy:direct

# local dev against PRODUCTION KV/R2/Browser (D1 stays local unless you pass
# --d1; read scripts/gen-remote-config.mjs before you do). Workstation-only.
pnpm run dev:remote

# the route oracle with those same remote bindings, which un-skips the 5 rows a
# local Worker cannot assert. 3 of them go green on remote KV/R2 alone; the two
# /lens rows also want a SECRET, and secrets are not remotable. CI cannot run this.
pnpm run routes:check:remote

# add new photos (resize, EXIF-rotate, encode to AVIF+JPG, upload to R2,
# write the photo-index entry, bake histograms, validate artifacts; the
# photo goes live at the next deploy — no cache bust exists or is needed)
pnpm run photos "/path/to/photo.HIF" "/path/to/folder/"

# validate the committed photo artifact graph without uploading anything
pnpm run photos:check

# lint, syntax plus TYPE-AWARE, in one 0.6s pass. the type half runs on tsgolint,
# which tracks the exact TypeScript 7.0.2 pinned here; that pairing matters
# because TS 7.0 ships no stable programmatic API, so typescript-eslint cannot
# run on it at all. config + every suppression's reason: .oxlintrc.json.
# NB: read gotcha 34 before running `oxlint --fix`, and 35 before "fixing" a
# finding inside a content-hashed client asset.
pnpm run lint

# the wire-size DIFF. perf-budget checks numbers against constants that rot;
# this compares two builds and has no constants. CI runs it against the merge
# base on every PR touching served code and comments the delta, gating nothing.
# each record self-builds through the wrangler dry-run (~12s).
pnpm run perf:snapshot record base.json --label main
pnpm run perf:snapshot record head.json --label mine
pnpm run perf:snapshot compare base.json head.json

# the TREND, which is what the diff structurally cannot see. one compact JSONL
# row per snapshot; .github/workflows/perf-history.yml appends these nightly to
# the machine-owned `perf-history` branch and /garage/dyno charts them.
pnpm run perf:snapshot row base.json

# diff infra.json (DNS, zone/edge settings, account resources, Workers) against
# reality. read-only; never mutates Cloudflare. add CLOUDFLARE_API_TOKEN for
# the account tier, or --offline for the no-network tier.
pnpm run infra:check

# the rebuild path, and the ONLY thing here that can mutate Cloudflare. plans
# for free (public DNS, no credential); --confirm writes and needs the separate
# CLOUDFLARE_API_TOKEN_WRITE. refuses to run in CI, by design.
pnpm run infra:apply

# roll the shared-compression dictionaries onto what production is SERVING.
# .github/workflows/dictionary-roll.yml does this nightly and opens a PR; this is
# the manual form. Sourced from the wire, so it is correct from any checkout.
pnpm run dict:roll

# is the dictionary tier actually operational, per surface class, in production?
# advisory: it reads production, so never make it a required check.
pnpm run dcz:check

# regenerate JUST the EXIF metadata (after photos are already uploaded)
./www/scripts/extract-photo-metadata.sh "/Users/aadharsh/Downloads/to post (from ssd)"

# install the histogram decoder dependency
python3 -m pip install -r www/scripts/requirements.txt

# build the JPEG thumbnail encoder (zenc = zenjpeg hybrid+scan). the pipeline
# scripts auto-build it on first run; this is the explicit form.
cargo build --release --manifest-path www/scripts/zenc/Cargo.toml

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
- PR CI lints (`pnpm run lint`, oxlint including its type-aware rules), builds
  the site, enforces the performance budget, dry-runs the single
  site Worker plus the auxiliary Garage/LWE configs (`cf-garage/`, `lwe-ask/`),
  runs the coffee tests, and sweeps the route oracle against a Worker booted
  in-process (`pnpm run routes:check`, wrangler's `createTestHarness()`), so a
  broken route fails the PR instead of the deploy. All of that lives in the ONE
  `validate` job, because `validate` is the one required check on `main` and a
  gate that is not required is not a gate.
- **`.github/workflows/perf-diff.yml` is deliberately OUTSIDE that job**, and the
  separation is the whole design rather than tidiness. It builds the merge base
  and HEAD, diffs the wire sizes, and comments the delta on the PR; it fails on
  nothing and is not a required check. Everything in `perf-budget.mjs` compares a
  number against a constant somebody typed, and the baseline history in that file
  is the record of what constants cost (86 → 129.23 → 204.24 KiB gzip, with the
  129.23 era spent permanently in breach while CI printed "hard checks green"
  over it every run, and the 204.24 set on 2026-08-04 already firing four days
  later). A diff has no constant to rot and nothing to re-baseline. Keep the two
  apart on purpose: a number that BLOCKS a merge trains people to widen the
  threshold, and a number that merely reports trains nobody to do anything except
  read it. Modelled on `astral-sh/ruff`'s memory and ecosystem jobs, which do
  exactly this and gate on nothing.
- **`perf-history` is a third machine-owned branch, alongside `production`.**
  `.github/workflows/perf-history.yml` appends one JSONL row a night and `/perf`
  charts it; nothing else writes there and nobody should hand-edit it. It exists
  because the per-PR diff catches the STEP a change makes and structurally cannot
  see DRIFT, which is the failure this repo actually had. A branch is the target
  because `main`'s ruleset has zero bypass actors so no workflow may push to it,
  and the only Cloudflare token that can write D1 is environment-gated behind a
  reviewer for the ramp; a branch outside both rulesets is the one place a
  nightly job can write without weakening either. The job's `contents: write` is
  a GITHUB token, so the no-Cloudflare-write-token-in-CI rule is untouched.
  Shape from `commonwarexyz/monorepo`'s `benchmark.yml`, which runs the same
  split: a per-change check plus a nightly series kept outside the code branch.
- Only a successful CI run for `main` associated with a merged PR can promote
  the exact tested commit to the machine-owned `production` branch. Cloudflare
  Workers Builds watches `production` and is the only production publisher for
  the site Worker, which bundles `www/`, `cal/`, and `serendipity/`. The
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

  **Both rulesets are DECLARED in [`infra.json`](config/infra.json) under `repository`,
  and `pnpm run infra:check` fails on drift**, for the same reason the Workers
  Builds block is declared there: dashboard state that no config in this repo can
  derive, load-bearing for what reaches production, and silent when it changes.
  The table above is now the readable copy of a machine-checked declaration
  rather than a claim nobody re-reads.

  The RULESET half costs no credential. The repo is public, so GitHub's rulesets
  endpoint is public with it, and that part runs on every PR like the DNS tier
  instead of degrading to a note like the Cloudflare account tier. CI passes the
  auto-provisioned `GITHUB_TOKEN` for rate-limit headroom alone there (60/hr per
  IP unauthenticated, which shared Actions runners exhaust), and a read that
  fails is an advisory, so GitHub being down cannot redden an unrelated PR.

  **`repository.code_scanning` is the exception, and it is WORKSTATION-ONLY.**
  CodeQL default setup declares the language list #241 curated, plus `state`,
  `query_suite` and `threat_model`. Its endpoint answers 401 unauthenticated even
  on a public repo, and the permission it wants is the repository
  **Administration** read, which is **not one of the keys a workflow may grant its
  `GITHUB_TOKEN`** (`actions`, `artifact-metadata`, `attestations`, `checks`,
  `code-quality`, `contents`, `deployments`, `discussions`, `id-token`, `issues`,
  `models`, `packages`, `pages`, `pull-requests`, `repository-projects`,
  `security-events`, `statuses`). No `permissions:` block turns it on.

  `security-events: read` was added to `ci.yml` for it and MEASURED to do nothing
  (still 403, 2026-08-07), so it came back out with a note where it sat. The only
  credential that can read it is a classic PAT with `repo`, which is exactly the
  broad standing credential this repo keeps out of CI, so the answer is no. The
  assertion runs on a workstation and CI reports one advisory naming the limit.

  Two general lessons, and the second is the expensive one. "GitHub read,
  therefore free" does not generalize, so check the auth requirement per endpoint
  rather than inheriting the rulesets precedent. And a `permissions:` key that
  merely SOUNDS right is worth measuring before trusting: `security-events`
  covers code scanning ALERTS, while the default-setup CONFIGURATION sits under
  Administration, and nothing about the name says so.

  Two assertions are worth knowing before you edit that block. `visibility` is
  checked FIRST and fails on its own, because rulesets on a private repo need a
  paid plan, so flipping the repo back to private would silently restore exactly
  the world this note used to describe. And `bypass_actors` is asserted EMPTY
  rather than against a declared list, on purpose: a list invites someone to add
  an entry to `infra.json` to turn a red check green, which is the precise change
  the check exists to catch.
- **Reaching `production` no longer moves traffic.** Workers Builds runs
  `wrangler versions upload`, so a promotion builds the commit, uploads the
  assets, checks the secrets, and mints a servable preview URL, while production
  keeps serving the version it was already serving. Traffic moves when a human
  ramps it:

  ```bash
  pnpm run deploy:promote
  ```

  That walks 10% → 50% → 100%, and between steps it samples `/whoareyou.json`
  (the one route that reports which VERSION answered — both versions read the
  same D1 changelog, so `/updates.json` structurally cannot tell them apart) and
  aborts on a non-200 or on a step that never took. `--to`, `--steps`,
  `--status`, and `--rollback` are the other modes. The old flat
  `if (process.env.CI) die()` is gone: `scripts/lib/release-guard.mjs` asks
  whether the process can authenticate instead, because a blanket CI ban refused
  the gated pipeline it was meant to protect while doing nothing about a ramp
  that starts unauthenticated and dies after traffic already moved.

  **The ramp runs in Actions now, and it splits at the human.**
  `.github/workflows/ramp.yml` (built 2026-08-12) fires off a successful
  `Promote production`, waits for Workers Builds to finish uploading, and then:

  | job | traffic | environment | gate |
  |---|--:|---|---|
  | `canary` | 10% | `production-canary` | none, runs on its own |
  | `full` | 50% then 100% | `production-full` | REQUIRED REVIEWER |
  | `verify` | none | (no environment, no credential) | runs `dcz:check` |

  So a merge reaches a tenth of traffic by itself and stops. Approving the `full`
  job is the same decision you were making at a terminal, minus the terminal, and
  the pause is still the point. A workstation ramp keeps working exactly as
  before; `release-guard.mjs` asks whether the process can authenticate rather
  than whether it is CI, which is what made both paths possible.

  **Expect more `Ramp production` runs in the Actions tab than releases, and most
  of them doing nothing.** It fires on `Promote production` COMPLETING, and a
  skipped promote completes, so every skipped promote spawns a ramp whose `canary`
  declines to run. On the first real release there were three. They are no-ops, and
  since 2026-08-12 they take a per-run concurrency group so they start, skip and
  end rather than queueing behind a ramp parked on the reviewer gate, because
  concurrency is evaluated BEFORE jobs and previously they could not even reach
  their own guard.

  **Real ramps do NOT queue, and believing they did cost every release between
  2026-08-12 and 2026-08-14.** This note used to end "real ramps still share one
  group and serialize." A concurrency group holds at most ONE pending run, and
  each new arrival CANCELS the previously pending one. `cancel-in-progress`
  governs IN-PROGRESS runs alone and does nothing about that, so a ramp parked on
  the reviewer gate deleted its successors one at a time rather than delaying
  them, silently, while production stayed on the stale 10/90 split that same
  parked run had left. Run 31644451923 sat `waiting` two days and three real ramps
  died behind it, each with ZERO jobs, the last cancelled one second after the
  next entered the group. `cancel-in-progress: true` since 2026-08-14, so the
  newest promoted commit wins and an unapproved canary expires instead of blocking
  what follows. The long argument, including the one thing still unmeasured, is at
  the concurrency block in `ramp.yml`.

  **`ci.yml` carries a TRIPWIRE for a parked ramp, and it lives there rather than
  in `ramp.yml` on purpose.** A jam inside a concurrency group cannot be reported
  from inside that group, which is why two days of stalled releases produced no
  signal at all. It warns past 6 hours, names the run, and is ADVISORY: failing
  would gate every merge on a state no PR caused and would deadlock the one PR
  able to fix a stuck ramp, the same trap `infra:check`'s edge tier documents. It
  swallows its own API errors for the same reason, since a tripwire that reddens
  CI on a GitHub hiccup gets muted, and a muted tripwire is worse than none. An
  unparseable timestamp falls STALE rather than fresh, because the alternative
  reads as a healthy repo forever. It found a real parked ramp on its first run.

  **The newest `Ramp production` run is usually the no-op rather than the
  release.** A no-op finishes in seconds while a real ramp waits on Workers
  Builds, so sorting by recency hands you the wrong run: on 2026-08-14 the two
  fired six seconds apart and the no-op completed first, which reads as a release
  that did nothing. Select by `headSha` matching the promoted commit, never by
  `--limit 1`.

  **A ramp waiting on approval is not stuck.** `waiting` is the environment gate
  doing its job, and the way to tell it apart from a jam is to ask what it is
  waiting for:

  ```bash
  gh api repos/oddharsh/site/actions/runs/<id>/pending_deployments \
    --jq '.[] | {environment: .environment.name, current_user_can_approve}'
  ```

  An approvable row means click it. Note also that `gh run view --log` refuses a
  run that has not finished, so the canary's own output is unreadable until the
  `full` job resolves; `pnpm run deploy:promote -- --status` answers what is
  serving regardless and does not depend on the run at all.

  Three things about it that are load-bearing rather than incidental:

  - **It checks out `production`, never `main`.** The ramp writes the D1 changelog
    by diffing the checked-out `checkpoints.json` against D1, so the tree has to
    be the one that was built and uploaded. This is gotcha 24 solved rather than
    relocated: CI cannot ramp from a stale tree, and it cannot ramp from one
    running AHEAD of what is serving either.
  - **`full` refuses a version the canary never saw.** Approval is asynchronous
    and Workers Builds uploads a version for every push, so re-resolving the
    newest production build after an approval could put traffic on something
    nothing canaried, silently, and every downstream check would pass because a
    version that built returns 200s. It compares against the 8-char prefix the
    canary actually put at 10% and fails if it moved.
  - **The wrangler it runs is the pinned one, which was not true when this was
    written.** `deploy-promote.mjs` shelled out to `npx wrangler`, and npx
    resolves whatever it can find: measured 2026-08-12 in a tree with no
    `node_modules`, `npx wrangler --version` answered **4.105.0** from its own
    cache while this repo pins 4.120.0. So the wrangler that moved production
    traffic depended on how the script happened to be invoked. It calls `pnpm
    exec wrangler` now (see gotcha 29), which resolves the pin itself. Ramp steps
    still go through `pnpm run` to match the documented interface, but that is
    consistency now rather than the guardrail it briefly was.

  `--to`, `--steps`, `--status`, `--rollback` and `--dry-run` all still work by
  hand, and a rollback is still a workstation command on purpose.

  What the ramp buys is the ability to read a change before everyone gets it. The
  script deliberately pauses between steps and tells you to go look at Workers
  Logs; it checks status codes, and it cannot check whether the page is *right*.

  **A SPLIT DEPLOYMENT SPLITS ASSET REQUESTS TOO, which is what version affinity
  is for.** Every document here references content-hashed shell assets
  (`/a/luna.<hash8>.css`, `/a/nav.<hash8>.js`), `build.mjs` keeps exactly one hash
  per asset, and during a ramp each request picks a version independently. So a
  document from one version asks for an asset the other version has never built
  and gets a 404: `/a/*` is `run_worker_first` and is NOT in
  `WORKERS_CACHEABLE_PATHS`, so nothing bridges the two. At the 10% canary that is
  roughly 90% of the new-HTML cohort plus 10% of the old-HTML cohort, per changed
  asset, on any release touching `nav.js` or `luna.css`. `ramp.yml`'s canary job
  runs unattended, so it fires on its own. Cloudflare's docs name this exact
  case. What keeps it from being permanent is the 404 cache-clamp, which was
  written for `/images/*` (gotcha 1) and has been quietly holding this line too.

  The fix is one Transform Rule deriving `Cloudflare-Workers-Version-Key` from
  `ip.src`. It is DECLARED in [`infra.json`](config/infra.json) under
  `zone.version_affinity` and NOT YET CREATED, because it needs a zone write and
  the only write token here is DNS-scoped and workstation-only. The recipe is in
  [MAINTENANCE.md](docs/MAINTENANCE.md), and `infra:check` fails on the missing
  rule until somebody creates it. Two things about it are load-bearing.
  Its expression must EXEMPT a request that already carries that header, because
  `deploy-promote.mjs` sends one key per request so it can still watch a split take
  from a single IP; clobber those and every intermediate step reads as a dead ramp,
  which fails closed and wastes an afternoon. And the check for it is
  ZONE-scoped, so CI's six account reads cannot reach it and that section always
  degrades to a note there. It is workstation-only, the same standing as
  `repository.code_scanning`.

  **The ramp itself now asks the new version directly**, with
  `Cloudflare-Workers-Version-Overrides: aadhar-sh="<version>"`, 12 requests all
  handled by the target. That is the health check. The 40-request unpinned sweep
  stays, because pinning bypasses the split by construction and so cannot tell you
  whether traffic moved. Worth knowing why this changed: errors used to be found
  only in whatever share of the 40 sampled requests landed on the new code, about
  four at a 10% step, so a fault in the version being ramped had four requests
  looking for it. Cloudflare honours the override only for a version already in the
  deployment, so the probe runs after each step and never before.

  `pnpm run deploy:direct` still exists and still goes straight to 100%. Keep it: the
  `infra:check` deadlock below is exactly the case where a ramp's extra step is
  a liability rather than a safety net.
- **A SECRET is a version too, so `wrangler secret put` no longer works here.**
  Hit 2026-08-06 adding `BROWSER_RUN_TOKEN`:

  ```
  ✘ Secret edit failed. You attempted to modify a secret, but the latest
    version of your Worker isn't currently deployed.
  ```

  That is this release model working, not a fault. `wrangler secret put` writes
  a secret AND deploys immediately; because the newest version here is normally
  an UPLOADED, unramped one, doing that would ship whatever is sitting in the
  queue as a side effect of setting a secret. Wrangler refuses rather than let a
  credential change become a release.

  Use the versions form, which mints a new version and moves no traffic:

  ```bash
  pnpm exec wrangler versions secret put -c wrangler.jsonc <NAME>
  ```

  Then ramp it like any other version (`pnpm run deploy:promote`). Every secret
  command in this file, MAINTENANCE.md and `cal/README.md` was the old form and
  is now the new one; they had been unrunnable since gradual deployments landed
  and nobody noticed, because secrets are set about once a year.

  **Order matters when the secret is FOR new code.** Merge first so Workers
  Builds uploads a version containing the feature, then set the secret on top of
  it, then ramp. Setting it first attaches a credential to a version whose code
  predates the thing that reads it, which is harmless and pointless.
- **A DURABLE OBJECT LIFECYCLE CHANGE is the one thing this release path cannot
  publish, and `--dry-run` cannot see it.** Adding, renaming, transferring, or
  deleting a DO class needs a `[[migrations]]` entry, and `wrangler versions
  upload` refuses to apply one: a migration mutates account-level namespace state,
  which is exactly what an upload-without-traffic is defined not to do. So the
  normal path (merge, then Workers Builds, then ramp) publishes everything
  EXCEPT this.

  What makes it worth a note is that nothing warns you. `wrangler deploy
  --dry-run` never contacts the API, so CI's three dry-run steps pass on a config
  whose migration has never been applied. The failure shows up at the one moment
  you least want it, on the real publish.

  Two consequences, both load-bearing:

  1. **Prefer a NEW INSTANCE of an existing class over a new class.** Instances
     are isolated by name and cost no migration, so a `coffee-slot:<start>:<end>`
     and `homepage-visits` can share a class while sharing nothing else. Reach
     for a second class only when the two really need different code, and assert
     the declared class list in a contract test when you do, so adding one is a
     deliberate act rather than a surprise at deploy time.
  2. **When a class genuinely must appear or disappear, publish it with `pnpm run
     deploy:direct` once** (straight to 100%, migration applied), then go back to the
     ramp for everything after. Deleting also needs its own entry, and the
     migration list is CUMULATIVE: keep the old tags and append.

     ```toml
     [[migrations]]
     tag = "v1"
     new_sqlite_classes = ["Counter"]

     [[migrations]]
     tag = "v2"
     deleted_classes = ["Counter"]
     ```

     Deleting a class DESTROYS its stored data, and there is no undo.

  Verified rather than remembered, 2026-08-07: Cloudflare's current docs describe
  a newer `exports`-based form and call `deleted_classes` legacy, so the syntax
  above was checked against the pinned toolchain instead of the docs. Wrangler
  4.118.0 does validate these keys: it warns `Unexpected fields found in
  migrations field: "bogus_key_xyz"` on an invented one and accepts
  `deleted_classes` silently. Run that control before trusting either form,
  because the docs describe the newest wrangler and this repo pins an exact
  older one.
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
  `pnpm run deploy:direct` fallback. Neither is automatic and neither should be — a
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

  Since the rulesets are declared in `infra.json`, a disabled one now fails
  `infra:check` by name, and that resolves itself rather than deadlocking twice:
  while enforcement is off, `validate` is not a required check either, so a red
  run cannot block the merge it was disabled for. What the failure buys is the
  tripwire for the actual risk here, which is nobody flipping it back. Expect one
  red `validate` for the duration and treat a red one AFTER the re-enable as the
  real signal.
- Configure one Workers Build project for the site Worker with `production` as
  its production branch and repository root `.`. Keep the dashboard Build
  command blank; use the repo's Wrangler-owned build during the Deploy command,
  which must be the `versions upload` form recorded in
  [`infra.json`](config/infra.json) under `release`. **The dashboard Deploy command is
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
  D1s, the same `RESEND_API_KEY`. `www/_worker.js/lib/preview.js` is what
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
  id. `pnpm run deploy:direct`, `pnpm run deploy:version`, and **both** Workers Builds
  commands (the Deploy command AND the Non-production branch deploy command)
  pin them off, so resource creation stays with `pnpm run
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
  Configuration:Read`). `pnpm run deploy:direct` additionally passes `--strict`, which aborts rather
  than prompting when the Worker's last deployment came from the dashboard and
  its remote config has drifted from this repo. Workers Builds deliberately
  does NOT pass `--strict`: it is the authoritative publisher, and a release
  should reclaim a dashboard edit instead of stalling on it.
- **GitHub's DEFAULT token is read-only, and one narrowly scoped write token is
  allowed, in an environment, behind a reviewer.** This rule used to read "GitHub
  must never hold a Cloudflare token that can write, full stop"; the owner
  retired that on 2026-08-06 and the reasoning is worth keeping, because the risk
  it was aimed at is real and unchanged: **this repository is PUBLIC.** Actions
  secrets are not exposed by a public repo, but a workflow that runs untrusted
  input can exfiltrate whatever it can read, so WHERE the secret lives is the
  whole control.

  **BUILT 2026-08-12, and this is now a description.** `CLOUDFLARE_API_TOKEN_RAMP`
  is an ENVIRONMENT secret on `production-canary` and `production-full`, never a
  repo secret, so a job that does not name those environments cannot see it and
  fork PRs cannot reach it. `production-full` carries required reviewers, so
  majority traffic cannot move without a human. `.github/workflows/ramp.yml` is
  the only consumer.

  **The scope list, derived from what the ramp actually executes.** This note said
  `Workers Scripts:Edit` + `D1:Edit` "and nothing else" from 2026-08-06 while no
  such token existed, so the list was never checked against a running ramp:

  | permission | why |
  |---|---|
  | Account · Workers Scripts · **Edit** | `versions list`, `deployments status`, `versions deploy` |
  | Account · D1 · **Edit** | `SELECT` the shipped vnums, `INSERT` the changelog row |
  | Account · Account Settings · **Read** | wrangler resolves the account |

  **Three Account permissions, and NO User-scoped ones. Measured 2026-08-12** with
  a real token: `CI=1 … deploy:promote -- --dry-run` resolved a target, printed the
  current split, and skipped two non-production versions by alias, all without
  `User Details:Read` or `Memberships:Read`. An earlier version of this table listed
  those two, inferred from the token Workers Builds generates for itself; they are
  not needed and are also unavailable on an account-owned token, so listing them
  sent somebody looking for a category that was never there.

  What the dry run does NOT prove is the two **Edit** halves: it only reads, so a
  token holding `Workers Scripts:Read` would satisfy it too. `versions deploy` and
  the D1 `INSERT` are first exercised on a real ramp, and the D1 one fails quietly
  (see below).

  Restrict Account Resources to this one account. **Workers Routes, KV and R2 are
  NOT needed**, which is where this is narrower than the token Workers Builds
  generates for itself: a ramp shifts traffic between versions that already exist
  and never uploads one, so it needs neither the storage scopes nor routes.

  Why `CLOUDFLARE_ACCOUNT_ID` is what replaces the identity scopes: it is passed
  explicitly so wrangler never has to enumerate accounts, which is the call those
  User permissions would have been for. **User-scoped permissions exist only on
  USER-owned tokens** anyway (scope `com.cloudflare.api.user`, under My Profile,
  API Tokens); an account-owned token created from Manage Account does not offer the
  category at all, which reads like a missing option and is a token-type difference.

  The control, which moves nothing:

  ```bash
  CI=1 CLOUDFLARE_API_TOKEN=<token> CLOUDFLARE_ACCOUNT_ID=<id> pnpm run deploy:promote -- --dry-run
  ```

  `CI=1` is load-bearing: `release-guard.mjs` ignores the token entirely when `CI`
  is unset and falls back to the interactive wrangler login, so without it the
  control passes while testing the wrong credential.

  **An under-scoped D1 fails SILENTLY and late, and that is by design.** The
  changelog `INSERT` runs only after the last step hits 100%, and it is wrapped in
  a catch that prints `warn: could not log vN` rather than unwinding a good
  release. So a missing `D1:Edit` costs a changelog gap on a ramp that otherwise
  reports success. The backstop is `checkpoints:check`, now a CI gate, which goes
  red on the next PR naming the missing row.

  **Both environments also restrict deployments to `main`, and that rule is doing
  real work rather than tidiness.** `workflow_dispatch` can target any branch that
  carries the workflow file, so without a branch policy anyone able to push a
  branch could ship a modified `ramp.yml` and read the token out of it. The
  environment is the boundary the secret lives behind; a branch policy is what
  stops the boundary being reachable from an arbitrary branch.

  This state is NOT declared in `infra.json` yet, which makes it the one piece of
  release-critical dashboard state on the honour system: delete the required
  reviewer and the gate is gone silently, which is precisely the failure the
  ruleset declarations exist to catch. Declaring `environments` and asserting them
  in `check-infra.mjs` is the obvious follow-up and is deliberately not bundled
  into the change that created them.

  **The default is still read-only, and adding a second write token is still a
  no.** CI's own token stays exactly as it was. Scope it to exactly these six
  reads and nothing else: Account Settings:Read, Workers Scripts:Read, Workers KV
  Storage:Read, Workers R2 Storage:Read, D1:Read, **Workers Builds Configuration:Read**. If a
  token in this repo ever needs an `Edit` scope, the answer is no. A token
  missing one of these degrades only the section that needed it, and the check
  names the missing scope.

  `Workers Builds Configuration:Read` was the sixth, added 2026-08-04 so `infra:check` can read
  the live Workers Builds triggers instead of trusting a recorded intent. It is
  the read half of the permission whose Edit half changes the deploy command, so
  granting it buys drift detection on the release path and grants nothing that
  can publish. **This one is Read, never Edit** — the ramp token above is a
  separate, narrower credential and does not widen this one.
- The one write path, `pnpm run infra:apply`, is **workstation-only** and reads a
  different variable (`CLOUDFLARE_API_TOKEN_WRITE`, scoped to DNS on this zone
  alone). It refuses to run in CI and cannot touch the Worker, and that refusal
  is NOT covered by the 2026-08-06 change: it can create and destroy zone-level
  DNS, which no pipeline here needs to do.

> `AGENTS.md` is a symlink to this file. One source of truth, so the two cannot
> drift again (they had, badly, by 2026-07-22). Edit this file.

---

## www/ — homepage architecture

Single-page personal site at `aadhar.sh`. A Cloudflare Worker with static assets, with a
`_worker.js` that does server-side enhancement of an otherwise-static
`index.html`. The worker route table sits in `route()` at the top of
`_worker.js`.

### Key files

| file | role |
|---|---|
| `www/index.html` | The whole page in one file. Inline CSS + JS. ~58KB uncompressed, ~15.4KB zstd (measured 2026-07-21 via live nav-timing; CF serves zstd, not brotli). Served on the shared `PAGE_CACHE_CONTROL` (`lib/const.js`) like every other document, + ETag, and still never `no-store` (the one directive that would cost the page bfcache). It held `private, no-cache, must-revalidate` through its SSR era and kept it after the SSR left; that cost two things at once, since no shared cache could store it (every front-door hit ran the worker) and Chromium refuses to keep a dictionary offered under `no-cache` (so `/` was the ONE page outside the per-page dcz tier). Changed 2026-07-31. Comments deliberately kept readable for View Source. |
| `www/writing/` | Written content as plain `.txt` files + `posts.json` registry `[{slug,title,date}]`. The worker renders each as an XP **Notepad** window at `/writing/<slug>` (a server-rendered `<textarea>` seeded with the canonical text — editable by nature, ephemeral by nature: no save → reload restores canonical, "writing in flux"), plus a "My Writing" folder index at `/writing`. Raw `.txt` stays fetchable at `/writing/<slug>.txt`. Author a post = drop a `.txt` + a `posts.json` entry. Render code (`handleWritingIndex`/`handleWritingPost`/`NOTEPAD_CSS`) lives in `_worker.js`. |
| `www/notepad.js` | Behavior for the `/writing` Notepad view (deferred, SW-cached): per-window `enhance()` wiring File/Edit/Format/View/Help menus, live Ln/Col + word-count status bar, Word-Wrap toggle, the classic **F5 time/date** stamp (Temporal w/ Date fallback), Select All, Print, About. Also opens folder notes as **popovers** that composite over the folder index, deliberately without touching the address bar (notes are `popover="manual"`, so several stay open at once and one URL couldn't honestly name three windows; Esc closes the topmost). The permalink stays real: each row is an `<a href="/writing/<slug>">` the worker serves standalone, and a modified click passes through to it. Chrome itself is SSR'd by `_worker.js`. No-op without a `.np-window`. |
| `www/tooltip.js` | Rich XP hover island for photos, tracks, artists, and car references. The homepage keeps only a tiny inline loader that idle-prefetches this module and replays a cold first hover; coarse-pointer visitors never load it. |
| `www/infotip.js` | The same trick for every OTHER hover on the site. The rule is short: **any `[title]` is an infotip, wherever it lives** — taskbar app buttons, tray icons, the clock, desktop icons, title-bar controls, form fields, and titled links and controls in page bodies. All of them already bought the OS tooltip, so this is what that tooltip was hiding: a pin's page count (from nav.js's own destination table), the tray's live colo/build (the same JSON its click-balloon fetches), the clock's full date, a citation link's destination host. It re-draws `title` rather than replacing it: emptied on hover, restored on leave, so AT still reads it at focus and a page with no JS keeps the native tooltip. `[data-tip]` is the opt-in for a control that never had one. **Four richer surfaces are skipped by name** (`.lx-term`, `.photos a`, `.np-list li`, `.np-artist-link`, `.car-link`, `.ev[data-cover]`) because each already draws its own card from the same engine; `.lx-term` is the sharp one, since those ship a `title` as their no-JS fallback and `lens.js` strips it once its own surface is live. **`nav.js` owns the matcher and passes the FUNCTION in**, not a selector each side keeps a copy of. Loads on the first hover that has a tip, never on a coarse pointer. Windows' two delays live in `hoist.js` now (`openMs` 400 cold-dwell, `autopopMs` 6s), both defaulting OFF so the content hover CARDS keep the instant show they were tuned for. |
| `www/nav.js` | Site-wide XP **desktop shell**. The ONE shared external asset (deferred, SW-cached) — every page includes `<script src="/nav.js" defer>`; it injects its own `<style>` + builds, into `<body>`: the **Bliss desktop** wallpaper, **draggable desktop icons** (Notepad + the 5 profiles; icons drag freely within a visit but positions are DELIBERATELY not persisted, since the stored layout was read back in states that couldn't honour it and came back as a stack), the **taskbar** (Start orb → Run, first-level-subpage app buttons each with a per-section SVG icon, clock via Temporal), and the **Run** command palette (⌘K / Start). Also owns the **OS-window model**: body is a clipping flex desktop, each `.window`/`.np-window` is pinned + its content scrolls internally behind a **custom XP scrollbar**, windows are **draggable** (top is a hard boundary) + **resizable**, and Navigations hard-cut: the cross-document View Transition this file used to describe was removed 2026-07-30 (prerender already made navigation instant, so the animation was pure added latency). Sets each first-level route's **tab favicon** to its section icon. Run destinations: pages + profiles inline; 158 photos lazy-loaded from `/images/manifest.json` with `/images/alt.json` captions. Wired into homepage + all garage pages + worker-gen `/around`,`/whoareyou`,`/bot` + serendipity shell. |
| `www/quiz.js` | The **understanding-check** widget (deferred, shared, minified at deploy with a `/quiz.src.js` twin). Every garage + LWE content page ends with an active-recall quiz rendered by this one script from an inline `<script type="application/json" id="luq-data">` block: garage pages get an XP GroupBox self-test (`<section id="luq">` mount), LWE pages get the quiz as a continuation of the MSN chat (appended into `.log`, no mount). Misconception-based distractors, deterministic option shuffle, per-page best score in localStorage. The idea is Geoffrey Litt's "Understanding is the new bottleneck" (credited in the widget footer); /lens carries the same pedagogy in copy (predict-then-check mode notes, the Delta counterfactual lab as a Papert micro-world). |
| `www/terminal.js` | The **Windows PowerShell** console at `/terminal`, and an actual **MCP client**: typing `dict <url>` sends the same `POST /mcp` `tools/call` an agent sends, and echoes the request before making it. Deliberately no private endpoints — if the console had its own, watching it would say nothing about what an agent gets and the two could drift unnoticed. The page server-renders one frame as boot output, so the route reads with JS off. Builds output with `createTextNode`, never `innerHTML`, because frames carry photo captions and third-party page titles. |
| `www/_worker.js/terminal.js` + `lib/tui.js` | The tools and the 80-column frame renderer. Tools are TOP-LEVEL utilities (`/finger`, `/radar`, `/dict`, `/cache`), because this site puts utilities at the root and only content nests; `/terminal` is the console that DRIVES them, not their parent. The frame is a REPRESENTATION alongside `.md`: one URL answers HTML to a browser, the frame to everything else, and `<tool>.txt` explicitly. **The MCP tool name IS the route name** — what you type in the console, what you curl, and what an agent calls are one word, and a contract test asserts every tool with a route is reachable over MCP. State is query params (small and addressable), so frames fork, bookmark and replay. `lib/tui.js` is pure, which is what lets one renderer answer HTTP, MCP and `node --test`; its palette is MID-TONES ONLY because a terminal theme belongs to the visitor. |
| the `/terminal` window | It is a **console window, not a page**, and the difference is entirely in what was REMOVED. `lunaPage` gained `windowClass`/`contentClass`/`windowAttrs` (all defaulting to empty, so the other nine callers are byte-identical) and the window declares `data-no-histnav`, which `nav.js` honours by skipping the site-wide Back/Forward injection — those are BROWSER controls, and a console carrying them reads as a terminal running inside Internet Explorer. Drag, resize, maximize and close all stay, because those are OS chrome. There is also nothing below the window: the explanatory paragraph that used to sit there was the single strongest tell, since real consoles do not come with a caption. Width is 624px so the console is exactly 80 columns, the size a real one opens at; left at the 760px page default it carried 136px of dead field to the right of every frame. Fonts stay on the design system — `"Lucida Console", var(--font-mono)`, one native Windows font in front of the existing token, no `@font-face`, no bytes. |
| `www/_worker.js` | The module worker (bundled by wrangler at deploy). Owns routing, photo serving from R2, manifest building, Spotify playlist scraping, AadharshBot crawler, the `/writing` Notepad pages, cache-control overrides. |
| `www/_headers` | Static-asset cache + security headers (CSP, Permissions-Policy, etc.). Applied to direct static-asset requests; the worker overrides cache-control for select paths. |
| `www/sw.js` | RETIRED (v136, 2026-07-03): now a ~15-line unregister stub (skipWaiting, delete caches, claim, unregister) that must keep serving 200 for a year+ so installed copies clean themselves up. No CACHE_VERSION anymore; the deploy-log vnum lives in D1 alone (bump-version.sh derives the next from MAX(vnum)). Repeat-visit speed comes from immutable assets + bfcache + speculation prerender. |
| `www/llms.txt` | The llms.txt format — concise site summary for LLMs. Linked from `<link rel="alternate">`. |
| `www/index.md` | Markdown source of homepage copy (used by `/llms.txt` and as a fallback). The one COMMITTED Markdown twin: `gen-md-twins.mjs` skips any path that already has one, so this hand-written prose is never regenerated over. |
| `www/md/` | Hand-authored Markdown twins for the three Worker-rendered prose pages, `/bot`, `/whoareyou` and `/security`, whose text lives in template literals no build step can read. `.assetsignore`d (build input, not a public URL): the generator publishes them at `/bot.md`, `/whoareyou.md` and `/security.md`. `checkTwinFacts()` pins the load-bearing strings against the Worker in BOTH directions, so bumping `BOT_VERSION` fails the deploy until `bot.md` agrees. `security.md`'s pins read `lib/security.js` rather than the page, since a page ABOUT headers must agree with the module that SENDS them; one of them is derived from `ENFORCE_PAGE_HASHES`, so finishing the hashed-CSP rollout fails the deploy until the twin stops calling the policy report-only. |
| `www/sitemap.xml`, `robots.txt` | Standard SEO files. robots.txt explicitly allows AadharshBot. |
| `www/.well-known/http-message-signatures-directory` | JWKS for AadharshBot's Ed25519 public key (Web Bot Auth IETF draft). |
| `www/images/` + `www/i/` | `images/` holds the photo DATA surfaces: `metadata.json` (the EXIF RECORD, long field names + the Fuji recipe card), `exif.json` (the tooltip's TEXT tier: every photo's short-key EXIF in one 2.6KB-brotli file, warmed once on idle because the homepage draws a fresh random 12 of 158 per request and a per-slot warm-up was cold nearly every visit), `meta/<stem>.json` (per-photo EXIF plus the four 64-bin histogram channels — the BARS tier, fetched only on the hover that needs them, and the self-healing fallback for a stem missing from a cached `exif.json`), `alt.json` (AI captions), `hashes.json` (stem to hash8 map). The pixel tiers (600px AVIF+JPG squares + 400px mobile AVIF) live in `i/` under content-hashed names, 474 files for 158 photos. |
| `www/og/` | Pre-baked 1200x630 OG/Twitter cards, one per garage + lwe page (`<section>-<name>.png`): the page's live demo floated on the Bliss desktop with an XP dock naming the route, so a shared link unfurls as the interaction, not a bare title. Wired via `og:image`/`twitter:card` in each page's `<head>` (edge-direct static pages can't be worker-injected). Built by `scripts/gen-og-cards.mjs` (playwright-core → Chrome, captures production for live data); meta added by `scripts/inject-og-meta.mjs`. Regen recipe in MAINTENANCE.md. Cached 30d, deploy purges the edge. |
| `www/scripts/` | Photo-pipeline + asset scripts (see below). Beyond the core pipeline (`add-photos.sh`, `extract-photo-metadata.sh`, `check-photo-pipeline.mjs`, `zenc/` the JPEG encoder crate): `add-car-photo.sh` (one resto-mod reference photo into the dual AVIF+JPG pair the car-link tooltips expect, output `www/cars/<stem>.{avif,jpg}`, no EXIF/R2); `gen-alt-text.py` (AI alt text for every grid photo, writes `www/images/alt.json` `{stem: alt}`, resumable; run by `add-photos.sh` phase 4 — posts the committed `i/` thumbnail bytes to Workers AI when `CLOUDFLARE_API_TOKEN` is set so a brand-new photo captions pre-deploy, else falls back to the cf-garage `/garage/cf/caption` endpoint by stem, which only sees deployed photos); `gen-encoding-samples.sh` (regenerates the color sample set for the `/garage/encoding` study through every encoder, prints byte counts + bytes-per-pixel); `reencode-thumbnails.sh` (re-encodes all published grid thumbnails as pre-cropped center squares from the canonical source folder, two square tiers); `gen-pixel-peeper.py` (the one remaining Pillow consumer, a one-off generator for the /pixel-peeper comparison frames; NOT part of add-photos.sh). The four 64-bin RGB/luminance channels are baked by `zenc histogram`, inside the encoder crate, since 2026-08-14. |

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
www/images/<stem>.{avif,jpg}  +  R2 aadhar-photos/<filename>
   |
   v
[extract-photo-metadata.sh] generates www/images/metadata.json
   |   keyed by stem (not filename), orientation-corrected width/height.
   |   pulls Fuji recipe (FilmMode, DynamicRange, ColorChrome FX +Blue,
   |   Grain roughness + size, tone curves, saturation) plus standard
   |   exposure / focus / metering / WB shift / Kelvin temperature.
   |   also writes per-photo /images/meta/<stem>.json files. `zenc histogram`
   |   then bakes four 64-bin RGB/luminance channels into those files from the
   |   shipped hashed JPG tier, so the tooltip has a stable, whole-image
   |   histogram. build-exif-index.mjs finally rolls every per-photo file MINUS
   |   its histogram into the one /images/exif.json the tooltip warms on idle
   |   (derived data: check-photo-pipeline.mjs rebuilds it and fails on drift).
   |   discipline: every field is nullable; the tooltip skips lines
   |   that are null rather than fabricate. never guess metadata.
   |
   v
[gen-alt-text.py] captions any stem missing one -> www/images/alt.json
   |   with CLOUDFLARE_API_TOKEN set it posts the committed i/ thumbnail
   |   bytes to Workers AI, so a photo added seconds ago captions here
   |   instead of waiting for a deploy. check-photo-pipeline.mjs then
   |   FAILS on any uncaptioned stem, same as a missing pixel tier.
```

Two encoders + one transform tool, all built from source:

- **mozjpeg** (`brew install mozjpeg`, keg-only at `/opt/homebrew/opt/mozjpeg/`)
  — provides `jpegtran` for lossless EXIF-orientation rotation.
- **zenc** (`www/scripts/zenc/`, a Rust crate wrapping
  `github.com/imazen/zenjpeg`) — the JPEG universal-fallback encoder: hybrid
  trellis + 64-candidate progressive scan search + sharp_yuv chroma, ~4% under the
  retired cjpegli at equal quality. Builds with `cargo`; dependabot tracks the
  zenjpeg pin. Replaced the from-source jpegli build (2026-07). See `www/scripts/zenc/src/main.rs`.
- **libavif** (`brew install libavif`, optional) — `avifenc` for the
  primary AVIF thumbnail. Falls back to `sips -s format avif` (macOS
  native, no extra dep) when avifenc isn't installed.
- **exiftool, jq** (`brew install exiftool jq`) — metadata extraction.
- **Pillow** (`python3 -m pip install -r www/scripts/requirements.txt`) — required by
  `gen-pixel-peeper.py` alone, which is a one-off generator rather than part of
  this pipeline. The 64-bin RGB/luminance bake moved into `zenc histogram` on
  2026-08-14, so nothing in add-photos.sh or extract-photo-metadata.sh needs it.

The four below serve the STUDY pages rather than the photo pipeline, and every
one of them was undocumented until `tools:check` went looking (2026-08-14):

- **webp** (`brew install webp`) — `cwebp` draws the WebP point on both
  `/garage/encoding` grids.
- **ffmpeg** (`brew install ffmpeg`) — one PNG-to-PPM conversion in
  `gen-encoding-grids.sh`, because `cjpeg` will not read PNG and sips' BMP
  output confuses it.
- **ssimulacra2** and **butteraugli_main** — the two perceptual metrics
  `export-for-instagram.sh` searches quality against. These are libjxl TOOLS,
  built with `-DJPEGXL_ENABLE_TOOLS=ON`, and **`brew install jpeg-xl` does not
  ship them**, which is why the script falls back to `/opt/zerobrew/prefix/bin`.
  The error message in that script names the formula rather than the tools and
  is misleading; the binaries are what to go find.

> **The whole list is DECLARED in [`config/tools.json`](config/tools.json) and
> `pnpm run tools:check` fails on drift.** It sits outside `infra.json` on
> purpose: that file declares Cloudflare and GitHub state and diffs it against
> those APIs, while nothing here is remote and nothing here has an API.
>
> The check is tiered the same way `infra:check` is. Its DECLARATION tier reads
> source text, needs no binary, and runs on every PR: every `for cmd in …` guard,
> every literal `command -v`, and every `brew install` hint in the shell scripts
> must have an entry, and both this file and MAINTENANCE.md must name it. Its
> PRESENCE tier probes the machine and is ADVISORY in CI, because a hosted runner
> has none of these and is not meant to.
>
> The guard scanner is the load-bearing part, and it is why four prerequisites
> could stay undocumented. Most of these preconditions are written `for cmd in
> sips exiftool`, so the binary name exists only as a loop word and a grep for the
> name finds nothing. That is gotcha 29's blind spot in different clothes: a
> command assembled from list elements is invisible to a search for the assembled
> form. Each scanner also carries a FLOOR and fails if its match count collapses,
> since a scanner that matches nothing otherwise reports a pass.

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
add-photos.sh) sha256-hashes each tier into `www/i/` and writes
`www/images/hashes.json`, which `buildImagesManifest` bakes into the
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

### Moving a page: what checks it, and what does not

Renaming or moving a page used to leave every page LINKING to it pointing at a
404, and nothing in the repo noticed. `routes:check` sweeps the routes it is
TOLD about, which is the forward direction. Build invariant #1 asserts the
Worker's routes reach `run_worker_first`. Neither one reads an href.

**`scripts/lib/link-integrity.mjs`, run as a build invariant, closes that.** Every
same-origin `href`/`src` in the minified documents has to resolve to a real staged
file, a `<path>.html`, a Worker `ROUTES` key, a registered surface, or a dynamic
namespace. 2645 refs across 48 documents in ~45ms, so it is COMPLETE rather than
scoped to the diff: a diff-scoped version would be more code and would miss the
case where the moved page is not in the diff and its dependents are.

Two things about it are worth knowing before editing it.

**`run_worker_first` cannot be the resolver on its own.** It answers "does the
Worker SEE this request", not "does this path SERVE a page", and it carries
`/garage/*` and `/lwe/*` — the namespaces holding most of the site's pages. A
glob-only resolver called `/garage/renamed-page` fine, measured on a deliberately
broken ref. So a namespace that already holds registered surfaces is GOVERNED by
the registry: a path in it must be registered or be a real file, and the glob buys
it nothing. The governed set is derived from `site-manifest.json`, so adding a
section governs it with no edit here.

**The scanner is quote-aware because minify-html unquotes attributes.** The served
bytes carry `href=/coffee` far more often than `href="/coffee"`, and the first
draft, written against the quoted form, reported 33 refs where there were 2645 and
passed with a straight face. That is the third naive scanner this repo's minified
output has caught.

What this does NOT cover, deliberately:

- **Prose mentions of a path** in docs or page copy. CLAUDE.md discusses routes
  that were deliberately deleted (`/lens/rendered`), so asserting every `/path`
  string in prose resolves would false-fire on its own history.
- **The Run palette and nav fences**, which are generated from the registry and
  asserted by invariant #8 instead.
- **Off-origin links.** A dead third-party URL is a different job and needs the
  network.

### Markdown twins (`scripts/gen-md-twins.mjs`)

Every page with prose ships a Markdown twin at `<path>.md`, and the two big
sections carry their own `llms.txt`. `/garage/encoding` and
`/garage/encoding.md` are the same content; `/garage/llms.txt` indexes the 17
garage pages so an agent does not have to pull the whole root index to find one.

**Twins are BUILD OUTPUT, never committed.** `build.mjs` step 1c generates them
from the readable source in `www/` into `.build/www/`. A twin is a pure
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

`www/_worker.js/mcp.js` speaks **2026-07-28** and the three legacy revisions
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

Three deliberate deviations, all written down at the code:

1. **`Mcp-Method` / `Mcp-Name` are validated when present, never required.** The
   spec requires them on Streamable HTTP POSTs; requiring them would reject every
   legacy client at the transport layer, which is the "Legacy client, Modern
   server → Fails" row of the spec's own compatibility matrix. A *mismatch* is
   still `-32020`, because a header disagreeing with the body is the exact case
   the header exists to prevent.

   **That is a SERVER rule and it does not travel to the CLIENT half.** Being
   permissive about what you accept and being correct about what you send are
   different jobs, and the strict half of the ecosystem does require the header:
   measured 2026-08-14, `mcp.context7.com` and `docs.mcp.cloudflare.com` both
   answer 400 `-32020` without it and 200 with it. So `foreignMcpTools()` in
   [`lib/doors.js`](www/_worker.js/lib/doors.js), the one MCP client this site
   has, SENDS `Mcp-Method` and derives it from the same constant as the body so
   the two cannot disagree. It also offers BOTH framings on `Accept`, because a
   Streamable HTTP server may answer JSON or an SSE stream at its own discretion
   and `mcp.deepwiki.com` refuses a JSON-only `Accept` outright (406, "Client
   must accept both"). Both omissions had the same silent cost, which is the
   reason they are written down here: /lens reported three well-known live MCP
   servers as unreadable doors, on the one surface whose whole premise is never
   reporting a failed check as a negative result.

   **`MCP-Protocol-Version` is the sharper case, because there is NO fixed
   request that satisfies the ecosystem, and a survey of 38 live servers is what
   showed it.** `mcp.svelte.dev` refuses without that header (`-32020`, "Header
   mismatch: MCP-Protocol-Version is required"). `mcp.deepwiki.com` and
   `mcp.exa.ai` serve happily WITHOUT it and refuse the byte-identical request
   WITH it, because they validate the header against their own supported list
   and neither speaks `2026-07-28`. All measured 2026-08-14. So sending it
   always and sending it never each break a real population, and the client
   sends it only as a reply to a refusal that names it: one retry, on nobody who
   already works, carrying the revision the body declares. Generalise it past
   this header. **A header that is REQUIRED by one half of an ecosystem and
   VALIDATED by the other cannot be a constant**, and the way you find out is
   the second population, which a survey finds and a fix for one broken server
   never does.

   The same survey settled how a 401 reads. Sixteen of the 38 are auth-gated and
   they refuse in two dialects: an EMPTY body (Cloudflare's six) and an OAuth
   challenge body (Notion, Sentry, Linear, PayPal, Neon, Webflow, Canva,
   Grafana, Wix). Those used to render as "not JSON" and as the literal string
   "undefined: undefined", while `lens.js` was already calling the same status an
   OAuth-protected server at the knock, so two halves of one page disagreed about
   one origin. A locked door is reported as UNREADABLE with the scheme named,
   because the door is there and we did not get to look.

   Two servers name a revision our own `MCP_SUPPORTED` does not carry,
   `2025-11-25`. That is a question about this site's SERVER rather than its
   client and is deliberately still open.
2. **`ping` is kept** though 2026-07-28 removed it. Legacy clients send it and
   it costs nothing.
3. **`protocolVersion` is not enforced as a REQUIRED `_meta` field, though
   `clientCapabilities` is.** The spec marks both required on every modern
   request and pins the refusal to `-32602` + HTTP 400.
   `missingRequiredMeta()` enforces the second and structurally cannot enforce
   the first: an absent `_meta` is how a legacy client presents itself, so a
   dual-era server cannot both read absence as an era signal and call absence
   malformed. It picks the era signal. What is left is a clean rule worth
   stating, since it governs anything the revision adds next: **`protocolVersion`
   is the self-declaration of modernity, and everything else the modern revision
   requires is enforced against callers who made it.**

   **Enforcing it broke two of our own clients, which is the transferable
   lesson.** `wire.js` (the `/terminal` page, which renders a real `/mcp`
   exchange) and `foreignMcpTools()` in `lib/doors.js` (the `/lens` door probe,
   whose self-scan loops back into our own `/mcp`) both sent `protocolVersion`
   alone. Neither would have errored visibly: `/terminal` degrades to "the tool
   list could not be read just now" and the door probe reports the origin's MCP
   server as unreadable. A server-side strictness change is a client-side
   change too, and the clients here are the ones least likely to complain.
   `-32021` (MissingRequiredClientCapability) is still unimplemented, and stays
   that way until a tool actually requires a client capability.

**BOTH servers on this origin speak it, through one module.** `/serendipity/mcp`
(`serendipity/serendipity.js`) is a separate server with different tools and no
shared data, but the wire rules — versions, `_meta` keys, `resultType`, cache
hints, error codes, the header check, the version gate — live once in
[`lib/mcp-protocol.js`](www/_worker.js/lib/mcp-protocol.js) and both import
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

**`/mcp` is also the browser's tool catalog now, which is why `find_events` lives
there.** Cloudflare's WebMCP bridge (gotcha 20) reads ONE endpoint per origin,
`data-mcp-url`, defaulting to `/mcp`, and registers whatever `tools/list` returns
into `document.modelContext`. Two servers on one origin is right for an agent that
reads the agent card and picks a door, and invisible to an agent that only ever
knocks on one. So `lib/tools.js` hoists exactly one Serendipity tool through
`serendipityFindEvents()` in `serendipity/serendipity.js`, which dispatches into the
same `mcpCallTool` that `/serendipity/mcp` uses — one implementation, one schema per
door, no drift. It is deliberately ONE tool and not a proxy: `get_event` and
`search_people` are drill-downs that only make sense inside the pool, and hoisting
all four would put four near-duplicate names in front of a model that already has
eight. Note the import runs holding → serendipity, the reverse of the established
direction, which is fine (no cycle, and both files are node-safe, which is the
constraint that actually bites — gotcha 16).

This replaced a hand-rolled `navigator.modelContext` block in `index.html` that
registered `whats_playing` and `find_events`. It was wrong three ways by then:
homepage only, on the API Chrome 146 renamed to `document.modelContext`, and
`whats_playing` was a second name for `now_playing`. Adding a tool to `DATA_TOOLS`
now lights up four doors at once (JSON-RPC, `/terminal/ask`, the terminal programs,
and every page's browser-local catalog), so weigh new entries accordingly.

**Cards are GENERATED, and one of their paths changed meaning on 2026-08-07.**
`pnpm run gen:mcp-cards` projects both servers' live registries into three files,
and a contract test deep-equals each card against that server's own `tools/list`,
so a card cannot quietly acquire a tool the Worker does not serve. They are
committed rather than built into `.build/` because they are read by scripts and
tests outside the deploy path; the test is what stands in for the "pure function
of the bytes" argument the Markdown twins won.

| path | server |
|---|---|
| `.well-known/mcp/server-card.json` | the SITE server (`/mcp`) |
| `.well-known/mcp/serendipity.json` | Serendipity (`/serendipity/mcp`) |
| `.well-known/mcp.json` | Serendipity, compatibility alias |

`server-card.json` served SERENDIPITY until #243. Both the api-catalog and
`lens.js` probe that path on any origin, so on our own origin it was answering
with the wrong server; a root server-card should describe the server at the root.
`.well-known/mcp.json` stays as the alias for clients holding the old anchor.

**The rename is not fully purgeable, and that is the part to remember.** `_headers`
gives the cards `max-age=2592000`, so a client that fetched the old bytes reads a
Serendipity card at the SITE card's URL for up to 30 days. A deploy purges the
edge and cannot purge a client. It is survivable only because these are
pre-connection metadata: `server/discover` and `tools/list` stay the protocol
source of truth, so a stale card costs a wasted probe rather than a wrong call.
Weigh that before repointing any long-cached well-known path again.

`.well-known/agent-card.json` carries both interfaces and now names each one's
card. All of them advertise 2026-07-28.

**Tool annotations are a CLAIM, and the default is read-only.** `lib/mcp-tools.js`
decorates every tool with a title, an object output schema, and
`readOnlyHint/destructiveHint/idempotentHint/openWorldHint`. Its defaults describe
what most tools here actually are (read a public thing, change nothing), and a
tool that is not that overrides them ON ITS OWN DEFINITION, next to the code that
makes it untrue: `representation_capture` and `representation_compare` each INSERT
a vault row, so both declare `readOnlyHint: false, idempotentHint: false` beside
that INSERT. The decorator takes the definition's annotations over its defaults,
which also makes it idempotent, and it has to be: `DATA_TOOLS` is decorated once
in `lib/tools.js` and then composed into two servers that decorate again.

The contract test used to assert one annotation shape across every tool. That
passed right up until a writing tool existed and would have kept passing while
advertising a D1 write as an idempotent read, so it now names the exceptions
explicitly. A blanket assertion over a set that only ever grew is worth
distrusting on sight.

### DNS-AID (agent discovery)

A DNS record, so it lives in Cloudflare DNS rather than in a Worker config.
Its intended value IS declared here, in [`infra.json`](config/infra.json), and
`pnpm run infra:check` fails if the live record stops matching.
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

To verify, use `pnpm run infra:check`, NOT `dig ... SVCB`. macOS ships dig
9.10.6, which doesn't know the `SVCB` mnemonic and silently degrades the
query to an `A` lookup, so it prints nothing and the record reads as
missing when it's fine. If you want the raw answer, ask for the type by
number (`dig _index._agents.aadhar.sh TYPE64 +short`) and expect RFC 3597
generic hex back.

### Cloudflare bindings

- **RN_KV** (KV namespace ID `3cb8a107c58e47dc9244e75b33401f36`) — caches the
  playlist tracks, artist profile pics, the visit-count mirror, and a few
  crawler results. The ceiling is **1,000 writes/day to distinct keys on Workers
  Free and unlimited on Paid**, plus 1 write/sec to the SAME key on either. This
  said "~10K writes/day budget; we use a handful" until 2026-08-14, which was 10x
  optimistic on Free and meaningless on Paid, so check which plan the account is
  on before reasoning against either number. (The photo
  manifest left KV 2026-07-28: the worker bundles `photo-index.json` +
  `hashes.json`, so the pool is module memory and a deploy is its bust. The
  `/lens` rate-limit counters left KV 2026-08-04 for the Rate Limiting binding
  below — they were a WRITE per allowed request on the busiest route here, which
  had quietly made "we use a handful" false.)
- **LENS_RL_\*** (Rate Limiting bindings, `ratelimits` in `wrangler.jsonc`) —
  the six per-IP crawl budgets `/lens` and the `/mcp` lens tools share:
  inspect 30/min, shot 3/min, compare 4/min, browser 3/min, wire 2/min, tools
  10/min. A seventh, `LENS_RL_BROWSER_ALL` at 4/min, is keyed on a CONSTANT
  rather than on the caller, so every browser-consuming route bills against one
  bucket. Counters are per-colo and cost no write. `LENS_BUDGETS` in `lens.js`
  mirrors the ceilings because that is what the 429 message quotes, and a
  contract test pins the two configs and the code together so a message cannot
  outlive its limit. **This prose is a THIRD copy that the test does not cover**,
  which is how it undercounted the budgets and overstated two of the ceilings
  until 2026-08-14 while config and code agreed with each other throughout. The
  wrong values are deliberately not restated here: a stale number written as
  `N/min` inside its own correction is still a greppable stale number.
- **PHOTOS_R2** — R2 bucket `aadhar-photos`, holds the SOOC originals
  (~3 GB / 158 photos at FUJIFILM X-T50 + Leica resolution).
- **ASSETS** — the Workers static-assets binding (wrangler.jsonc `assets`), serves files from www/.
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
  `./www/scripts/bump-version.sh <slug> "<title>"`, then deploy. It derives
  the next vnum from `SELECT MAX(vnum)` and inserts the checkpoint (no file edit;
  the SW that used to carry the version string retired in v136).
- **BROWSER (Browser Run binding)** — powers `/lens/shot` and
  `/lens/browser` inside **`/lens`** ("The Other Web", which shows any URL the way a
  machine does). `/lens`'s Human view embeds framable sites in a live cross-origin
  `<iframe>` (loaded by the visitor's own browser) and screenshots the rest
  server-side via the binding's `quickAction("screenshot", …)` (real headless
  Chrome). Without
  the binding, `/lens/shot` returns a clean 503 and the Human view falls back to
  the readable-text reader, so the live iframe + all machine lenses keep working
  regardless. (`CF_ACCOUNT_ID` is read by `/ledger`'s Analytics Engine SQL
  alongside `ANALYTICS_READ_TOKEN`, and by the Kitesurf REST path below.)

  **Kitesurf rides the EXISTING `/lens/browser`, and there is no second route.**
  A `/lens/rendered` was built here on 2026-08-06 and deleted the same day: it
  duplicated the Browser view, which already renders after JavaScript, already
  asks for content + screenshot + markdown + accessibility tree in ONE Quick
  Action, and whose `deltaStrip` already computed the HTTP-versus-rendered word
  gap. Read `lens-browser.js` before adding a rendering surface.

  What survives in `lens-render.js` is the engine seam. **Kitesurf cannot be
  reached from the binding**: probed 2026-08-06, passing `browser` to
  `quickAction` returns `{"code":"unrecognized_keys","keys":["browser"]}`, and an
  invented engine name returns the byte-identical error — the payload schema is
  CLOSED, so it refuses the option rather than failing on an unknown value. REST
  is the only door and it wants a `Browser Rendering - Edit` token in
  `BROWSER_RUN_TOKEN`. That is an EDIT scope living as a Worker secret; it is not
  in GitHub, so the no-write-token-in-CI rule is intact, but do not confuse it
  for a read scope. `browser=kitesurf` is in Cloudflare's launch post and NOT in
  the Quick Actions reference, so the code TRIES it and, on a 400, retries
  without it and remembers for the isolate. Only the PARAMETER is conditional —
  REST itself keeps serving, because gating the whole REST path on a dead beta
  flag silently demoted every later render back to the binding.

  **The selector only works on `/browser-run/<action>`, and this posted to
  `/browser-rendering/<action>` until 2026-08-08.** Both spellings ROUTE, which
  is the whole problem: probed unauthenticated against the real account id, each
  answers error 10000 `Authentication error` rather than 7003 `Could not route
  to`, so the wrong path costs no error, no retry and no log line. It costs the
  opt-in. Cloudflare's Kitesurf page documents the selector on `browser-run`
  alone while the older Quick Actions reference pages still show
  `browser-rendering`, so reading either one in isolation gets you a path that
  looks right. `restUrl()` is exported from `lens-render.js` and asserted in a
  contract test for exactly this reason: a one-word difference with no symptom
  survives review.

  **A 200 was being read as proof Kitesurf served, and it is not.** The
  documented envelope is `{success, result, meta:{status,title}}` with no engine
  field, so an endpoint that ignores an unrecognised query parameter and one that
  honours it return the same response. The old code set `engine: "kitesurf"` on
  any 200 carrying the selector, which meant `/lens` could report a Chromium
  render as Kitesurf on the page whose entire premise is showing what a machine
  actually saw. The label is `kitesurf-requested` now, and the 400-retry is
  unchanged.

  **A NON-200 carries no engine information whatsoever, and on the free plan that
  is the COMMON case rather than the edge.** `kitesurfParamLive` only flips true
  on `response.ok`, so a call the API refuses falls through to `chromium-rest`
  regardless of whether the selector was honoured, and the span records that
  label beside the failure. Since the daily browser-minute ceiling is what
  usually does the refusing, a log window can fill with `chromium-rest` while
  containing zero evidence about Kitesurf either way. Measured 2026-08-08:
  filtering Workers Logs on `exists(lens.render_engine)` returned five
  `lens.browser` spans over 24h, every one of them `chromium-rest` with
  `lens.outcome: browser_budget_spent`, reaching back to a 2026-08-07 scan of
  theverge.com on an earlier version. Read `lens.render_engine` only alongside
  `lens.outcome`, and treat a window with no successful render as NO DATA rather
  than as a verdict for Chromium.

  **Promoting it takes one control: does the endpoint REJECT an invented engine
  name?** `pnpm run kitesurf:check` runs that control and prints a verdict — same
  shape as the `--x-bogus-flag` control on wrangler and
  `definitely-not-a-real-gateway-xyz` on AI Gateway, and worth running before
  trusting any beta selector the docs describe but do not specify the failure
  mode for. It is a SCRIPT and not a runtime probe because an ignored parameter
  means the control RENDERS rather than erroring, and this account has 10 free
  browser-minutes a day, so a once-per-isolate control would spend the budget
  measuring itself. Its free tier costs nothing (invalid payload, so nothing can
  render) and is decisive only when the error names the engine parameter;
  `--render` buys the certain answer for two renders of a 40-byte inline
  document. If the verdict is `enforced`, promote the label and record the date
  and the outputs at the control.

  Worth the effort because Kitesurf is FREE during its beta. The daily
  browser-minute ceiling is what makes `/lens/browser` fragile (and what blacks
  out the feature while you debug it), so a selector that silently does nothing
  is not a cosmetic mislabel.

  **`/lens/browser?do=<recipe>` runs a FIXED script in the page before reading
  it**, which is how the Browser view answers "what does a machine see once the
  consent wall is gone". Two recipes ship, `expand` and `consent`, both
  synchronous, in [`lens-recipes.js`](www/_worker.js/lens-recipes.js).
  `?recipes=1` publishes the whole allowlist verbatim, and a contract test pins
  the published script to the executed one.

  The constraint that decided the shape: **a live CDP session was the obvious
  build and is the wrong one.** Browser Sessions count against the free plan's 3
  concurrent browsers and 1-new-instance-per-20-seconds, which Quick Actions do
  not, so a public unauthenticated session would black out `/lens/shot` and
  `/lens/browser`, which share the same account-wide 10 min/day.
  `@cloudflare/puppeteer` is ~1 MB of ESM against a 204 KiB gzip bundle. And
  holding a session needs a new DO class plus a `[[migrations]]` entry, which
  `wrangler versions upload` structurally cannot publish (the DO note above).
  Any one of those kills it alone. So this rides `addScriptTag` on the EXISTING
  Quick Action: one query parameter, no new route, no new binding, no
  dependency, one render per click, billed against the same two buckets.

  **The allowlist is the security boundary and nothing may route around it.**
  `addScriptTag` runs arbitrary JS in a third party's page, so a `js=` parameter
  would make `/lens` an open remote-code-execution proxy running attacker code
  from Cloudflare IPs under this account's browser identity, and a `selector=`
  parameter is the same hole one step removed. A contract test asserts no caller
  byte reaches the payload outside `url`.

  **Nothing clicks.** `consent` REMOVES an overlay from our own copy of the DOM
  rather than pressing the button: removal sets no cookie and records no consent
  choice, while clicking "Accept all" from a Cloudflare IP would be this site
  manufacturing a consent record on somebody else's page. Both recipes are pure
  DOM, so they issue zero additional requests to the origin, and that is why
  there is **no robots.txt gate** — the crawl footprint is identical to the plain
  render that already happens. A future recipe that causes fetches (a scroll that
  loads images, a click that pages in content) re-opens both arguments and
  inherits neither.

  **The receipt's nonce buys less than it looks like, and that is fine.** The
  page reports what it did through the only channel available, `result.content`,
  in a `<script type="application/lens-receipt">` that never executes and that
  `documentShape()`'s existing `<script>` strip already excludes from the word
  count, so it cannot inflate the delta by construction. The per-run nonce stops
  a page that plants a receipt blindly. It does NOT stop a targeted page: a
  MutationObserver's mutation record survives our node's removal, so the nonce is
  recoverable, and no in-page value can beat that. Survivable because **the
  receipt is not the load-bearing number** — the word delta is computed
  server-side from the HTML the page returned, and a page cannot inflate that
  without actually serving the words. Scoping the nonce as an IIFE argument
  instead of a top-level `var` was still a real fix (measured in Chromium
  2026-08-08: `typeof window.__LENS_N` came back `"string"`, free for any timer
  on the page to read).

  Ordering that is easy to get wrong: strip the receipt, THEN `documentShape()`,
  THEN the 120KB cap. Count first and `shape` counts our own script; cap first
  and the receipt falls off a large page, so the run reports as never having
  happened.

  `scripts/lens-inject-probe.mjs` is this feature's control, in the same idiom as
  `kitesurf:check`: does the engine execute an injection, is the capture after
  it, and does `waitForTimeout` land after injection. That last one is the gate
  on any future ASYNC recipe; both shipping recipes are synchronous, so v1 sends
  `addScriptTag` and nothing else.

  **The two GATING questions are answered, measured 2026-08-08 against the real
  binding through `pnpm run dev:remote`.** `env.BROWSER.quickAction` accepts
  `addScriptTag`, and the capture happens after the injected script's
  synchronous mutations. Both were live risks rather than paranoia: the
  binding's payload schema is CLOSED, and the Kitesurf probe had already caught
  it refusing a key the REST docs describe, so "documented" does not imply
  "accepted here". Against `https://aadhar.sh/garage/horizon` the run reported
  `acted: 7, scanned: 8` and returned HTML carrying 8 of 8 `<details>` open,
  with neither the receipt nor the injected script surviving into `content`.
  The engine was `chromium-binding`, since a local dev session holds no
  `BROWSER_RUN_TOKEN`.

  **`waitForTimeout` is the one thing still unmeasured, and it gates only an
  ASYNC recipe.** Nothing shipping sends it. Probe cases 3 and 4 are that
  question and they need the REST token, so they stay a workstation run.

  The snapshot now reports `engine` and a server-computed `shape` (words,
  headings, links, images, JSON-LD). `shape` is counted from the FULL rendered
  body BEFORE the 120KB content cap, which retires the old truncation bail: a
  capped snapshot used to refuse a word comparison entirely (stripe read
  "1874 -> 139 words" off a slice) and can now answer honestly.

  Screenshots are KV-cached 6h (`lens:shot:<sha256(url)>` in RN_KV) and rate-limited to
  3/min/IP; `/lens/fetch` (the parsing engine) is rate-limited 30/min/IP. Those limits
  are Rate Limiting bindings as of 2026-08-04, not KV counters; the RESPONSE cache is
  still KV, and only the counters moved. Both `/lens/*`
  fetch routes guard against SSRF (http(s) only, no localhost / private / link-local /
  `169.254.169.254` hosts, ports 80/443 only, 8s timeout, 2MB cap) and identify honestly
  as AadharshBot. Framability is read from the target's `X-Frame-Options` /
  `Content-Security-Policy: frame-ancestors` in the `/lens/fetch` pass, so no extra probe.

### `lens-reader/` — the Reader lens, and the first auxiliary Worker the site calls

The seventh machine tab on `/lens` ("Reader's guess") runs a THIRD-PARTY reader-mode
extractor over the same URL and reports what it threw away. Engine is
[Defuddle](https://github.com/kepano/defuddle) (MIT, kepano; the one behind Obsidian
Web Clipper), pinned at `0.19.2`.

**The gap is the artifact, not the extraction.** Anyone who wants to read a page can
open it. What no other surface here shows is that an extractor is GUESSING which part
of a document is the article, and how badly that goes on a page that is not one.
Measured 2026-08-09: stripe.com loses 55% of its words and its hero headline;
Wikipedia loses 22%, which is an extractor doing its job; `/garage/horizon` loses 2%
but hands over **13 of 25 control labels** as prose, because Defuddle keeps `<button>`
text on purpose (`dist/markdown.js`, `addRule('button', replacement: content =>
content)`). That last number is the same failure `scripts/lib/html-to-md.mjs` rule 2
exists to refuse, which is why the twins still use the hand-rolled converter — the
sweep behind that decision is in the PR.

So the payload never claims to be what the machine got. It names the extractor and
version, reports `source` / `kept` / `dropped`, and both word counts come from ONE
function on ONE fetch, because comparing against a number `lens.js` computed would be
comparing two definitions of "word" and calling the difference an extraction loss.

**It is a separate Worker for two independent reasons, either sufficient alone.**
Defuddle needs a DOM `Document` and Workers have HTMLRewriter, so supplying one costs
linkedom: ~190 KB gzip across the three deps against a site bundle already over its
204.24 KiB budget. And `run_worker_first` caps at 100 rules with this repo at exactly
100 (gotcha 26), so a `/lens/read` path on the site Worker would refuse to boot, while
a zone route needs no entry at all. Same shape as `cf-garage` owning `/garage/cf/*`.

What it DOES share with the site tree is exactly one thing: the SSRF guard.
`validateLensTarget` moved from `lens.js` into `lib/crawl.js`, beside the
`privateHostBlocked` floor it wraps, and both Workers import it. A second Worker aiming
a visitor-supplied URL at the public internet is the same surface `/lens/fetch` has, and
two copies of an allowlist pass review on the day they are written. A contract test
asserts both files import it and neither redefines it.

**Turndown ships two builds and wrangler picks the one that cannot work.** The node
build falls back to `@mixmark-io/domino` and takes an HTML string happily; the browser
build reaches for `document.implementation.createHTMLDocument`. Wrangler resolves the
BROWSER condition, so `turndown(htmlString)` throws `document is not defined` in a
Worker while passing under `node --test`. Measured both ways 2026-08-10. The fix is to
pass a NODE (turndown's `RootNode` does `input.cloneNode(true)` for a non-string), which
skips its parser entirely — no global shim, and three successive shims are what it costs
to learn that the shim route is a dead end.

The contract test for it is STRUCTURAL and says so at the assertion, because the
behavioural version is impossible: `node --test` resolves the node build, so it
exercises the one path that cannot fail. The first version of that test reintroduced the
bug deliberately and still went green — the same "a check that can only agree with
itself is decoration" lesson as gotcha 24.

**The root suite may not import ANYTHING from `lens-reader/src/`, and this is gotcha 16
wearing different clothes.** `contract-tests.mjs` runs under plain node with the ROOT
workspace's dependencies; `reader.js` imports defuddle, linkedom and turndown, which
live only in that sub-project. Importing it fails with `ERR_MODULE_NOT_FOUND` in CI
while passing on any workstation that has run `pnpm install` in `lens-reader/` — which
is exactly how it was caught, on PR #299's first run, after a local suite that had been
green all afternoon. The split is by CAPABILITY: everything provable from source text
stays in the root suite, and everything that has to actually RUN lives in
`lens-reader/test/`, which the CI step that installs those dependencies executes.

Generalise it past this Worker: **a green local suite proves nothing about CI when the
two have different dependency sets.** The cheap control is to hide the sub-project's
`node_modules` and re-run, which is the CI condition rather than an approximation of it.

Two smaller rules learned here. **A Worker entrypoint may export ONLY the default
handler and DO/Workflow classes**; a named value export fails at startup with
`Incorrect type for map entry '<name>': the provided value is not of type 'function or
ExportedHandler'`, which is why the testable half lives in `src/reader.js` and
`src/index.js` is the handler alone. And the lens is **opt-in rather than auto-firing**
the way Browser Run is: Browser Run auto-fires because an empty third pane makes Compare
read as broken, while this is a tab, and every run is a second full fetch of the target
from our IP (10/min/visitor, `READER_RL`).

Deploy it like the other auxiliaries, from its own directory. It is declared in
`infra.json` under `workers.expected`, so `infra:check` fails if it goes missing. If it
is down, `/lens` is unaffected and the Reader tab reports the extractor as unreachable.

### `/lens/wire` — the request waterfall, and the CDP door behind the binding

The eighth machine tab ("What it costs") records every request a page makes and
reports how much of the weight belongs to somebody who wrote none of the words.
Measured 2026-08-11: theverge.com is **307 requests, 6.98 MB, 94 hosts, 60% of
transfer bytes third-party**, with 5 MB of the 7 being JavaScript. aadhar.sh is
24 requests, 239 KB, one host, 0%.

**`env.BROWSER` is a Fetcher with the full Chrome DevTools Protocol behind it,
and this was not known here until it was probed.** Every browser surface on this
site went through `quickAction`, whose payload schema is CLOSED (the Kitesurf
probe proved it refuses unknown keys), so the request waterfall was assumed
unreachable. It is four HTTP calls on the binding:

```
POST   https://localhost/v1/devtools/browser              -> { sessionId, webSocketDebuggerUrl }
GET    https://localhost/v1/devtools/browser/<id>/json/protocol   (54 domains)
       browser.fetch(<id>, { headers: { Upgrade: "websocket" } }) -> response.webSocket
DELETE https://localhost/v1/devtools/browser/<id>
```

Verified against the production binding: Chrome/128.0.6613.137, and `Network`,
`Performance`, `Tracing`, `Profiler`, `Security` and `Audits` all present. The
recipe was read out of **`agents@0.20.1`** (`dist/connector-*.js`), which is the
package Cloudflare's browser-agent example wraps.

**We deliberately did NOT take that package.** Its `createBrowserTools` hands an
LLM a `browser_execute` that writes its own CDP JavaScript and runs it in a
Worker Loader sandbox, which is exactly the model-authored-code door
`lens-recipes.js` exists to refuse, and it costs a `worker_loaders` binding plus
a per-load fee on a public endpoint. The transport here is ~60 lines and the
script is ours. A contract test asserts exactly one `params.get()` in the module,
because a second one is how a `js=` or `selector=` parameter would arrive.

**Three things about the cost, and the middle one is the surprise.** A CDP
session is a real browser INSTANCE on the same 10-minutes-a-day account-wide
allowance `/lens/shot` and `/lens/browser` share. The free plan mints **one new
instance every 20 seconds**, which was hit live: a second session opened 20s
after the first answered `429 Rate limit exceeded` on the create, so a refused
session is the COMMON outcome rather than an edge case and is reported as our own
budget rather than as the target failing. And the session is cheaper than
feared — 3.7s for a session plus one command, 8.1s including a navigation, well
under the ~19s a Quick Action render costs.

Rationed three ways: `LENS_RL_WIRE` at 2/min/IP, the shared `LENS_RL_BROWSER_ALL`
ceiling, and a 6h KV cache which is the real control. The session is deleted in a
`finally`, which is not tidiness — a leaked session holds one of three concurrent
browsers and blacks out every browser lens on the site.

**Two accounting bugs worth knowing, both found by running it rather than by
reading it.** `Network.loadingFailed` does NOT mean failure: our own `/hit?tick=1`
beacon answers 204 and then reports `net::ERR_ABORTED`, because a fire-and-forget
fetch nobody awaits is cancelled at teardown, so the discriminator is whether a
response ever arrived and the third state is `aborted`. And the KV-hit path spread
`cached: true` over the summary's `cached` COUNT of the target's cache-served
requests, which rendered as "true served from cache"; the response-level flag is
`fromCache` now. Both have tests naming the measurement.

`run_worker_first` had to be FOLDED to fit this route. The eight exact `/lens`
rows became `/lens` + `/lens/*`, taking the config from exactly 100 of 100 to 94
— gotcha 26's own recommended remedy, and the reason `/lens/wire` needed no rule
of its own. Safe because nothing static lives under `/lens/`: the three client
scripts are top-level, and `/lens/read` belongs to the `lens-reader` Worker via a
zone route matched before this config is read.

**`/lens`'s bare shell is a generated page that lives only in `.build/`, so it
404s under `pnpm run dev`.** That is by design and costs an hour if you meet it
cold: `?url=` takes the live Worker path and works, while the empty shell is a
built static page the readable tree has no file for. A stale `caches.default`
entry in `.wrangler/state` can make it appear to work and then stop, which is
what makes it read like a regression you just caused.

### `/lens/tools` — the ninth tab, and why it reads without ever calling

"What it accepts" walks through the door `discovery` only knocks on. It reads a
foreign origin's `tools/list` WITH the argument schemas and draws a form per
tool, which is a block explorer's contract page pointed at MCP: Etherscan turns
an ABI into a form, and `inputSchema` is the same artefact under another name.

**The analogy stops at simulation, and that limit is the whole design.** A chain
is a public state machine anyone can fork, so `eth_call` at a block height is
reproducible by anyone. An MCP server is a private database behind an RPC. There
is no fork, no state override, no revert, and the protocol has **no dry-run
primitive**: no `dryRun` flag, no simulate method, nothing in `_meta`. So "what
would `send_invoice` do" is unanswerable without the server volunteering an
answer, and none of them do. What IS answerable is the exact frame a call would
carry, so the pane renders that plus a copyable curl and stops.

Execution moving to the visitor's own machine is the SAFETY property rather than
a consolation prize. A public button that fired strangers' tools would do it
from this account's IP and under AadharshBot's signature, which is the argument
`lens-recipes.js` already makes for refusing a `js=` parameter. A contract test
asserts the pane makes exactly one request, to our own route, and that
`_worker.js/lens-tools.js` never names `tools/call` and never calls `fetch`.

Three rules decide the planner in `www/lens-tools.js`, and the first is the one
that keeps it honest:

1. **Never lie about the schema.** `oneOf`, `anyOf`, `$ref`, type unions, tuple
   items, free-form objects and anything past 3 levels of nesting degrade to a
   raw JSON box that states WHY. Rendering `anyOf` as its first arm is worse
   than a textarea, because the reader believes it. Not hypothetical:
   `mcp.deepwiki.com`'s `ask_question.repoName` is an `anyOf`.
2. **Types survive the DOM.** Enum options carry the JSON encoding of their real
   value, so `image_transform`'s `rotate` comes back as the number 90 rather
   than `"90"`. An unchecked optional boolean is ABSENT, not `false`, and a
   blank optional is omitted rather than sent as `""`.
3. **Bounded and untrusting.** Depth, property and option caps, and the controls
   are built with `createElement` and `textContent`, because every string in
   them came from a stranger's server. Same rule `www/terminal.js` follows for
   third-party page titles.

`foreignMcpTools` grew an `opts.schemas` flag, OFF by default: the three
existing callers render a catalogue as prose and a schema is dead weight in a
terminal frame. An over-cap schema is dropped WHOLE and flagged, never
truncated, because half a schema silently describes the wrong contract and
"too large to carry" and "takes no arguments" are opposite claims.

Opt-in like Reader and Wire, for the same reason: every run is a real POST to
somebody else's server. Cached 1h in KV to keep a public button from re-asking a
stranger the same question on every click, and rate-limited by `LENS_RL_TOOLS`.

**Local dev can only scan THIS origin.** An external probe fails at signing
before it leaves, since the AadharshBot key is a secret and secrets are not
remotable, so `?url=https://aadhar.sh` is the one target that works under
`pnpm run dev` (self-dispatch needs no wire signature). Everything else needs a
deployed version.

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
locally too, so `pnpm run dev` gets the real tracer and the named spans rather
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
| `lens.shot`, `lens.browser` | Browser Run. Same span name on hit and miss (differing on `lens.cache`) so hit rate is a group-by, not a join; the four distinct 502 shapes are separated by `lens.outcome` |
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

**HARD RULES (strong owner preference):**

1. **Internal/native fonts ONLY.** Never ship `@font-face` with `url()`, web
   fonts, `@import`, or font preloads. Served pages carry zero font bytes; the
   design system's `@font-face local()` rules are reference-only and are never
   inlined into a served page.
2. **Keep perf lean.** Fold design tokens in without regressing the byte budget.
   On a brotli-compressed inline page, tokenizing repeated literals is a wash
   while token definitions are net-new bytes, so only the font tokens
   (`--font-*`) are inlined site-wide. Color and gradient tokens are not inlined;
   there is no external stylesheet and no JavaScript for styling.

   **Served pages load no cross-origin assets.** The one same-origin script whose
   code is not in this repository is Cloudflare's WebMCP bridge. The edge injects
   `<script type="module" src="/.webmcp/bridge.js">` into every document, 47.6 KB
   of Cloudflare code under `cache-control: public, max-age=0, must-revalidate`,
   first in `<head>`. The CSP's `script-src 'self'` admits it in the enforcing and
   hashed report-only policies, which is why hashing inline scripts guarantees
   less than it sounds like. For ordinary visitors `initBridge()` returns unless
   the browser implements `document.modelContext`, so nearly everyone downloads
   it, gets one warning, and stops. `/whoareyou` and `/security` disclose it, and
   `gen-md-twins.mjs` pins the path so turning the edge feature off cannot leave
   those pages describing a tag that is gone.

   Browser RUM is deliberately absent: no page loads Cloudflare Web Analytics,
   there is no `/ledger/rum*` route or proxy module, and build tripwire #7b plus
   the contract test keep those runtime surfaces absent together. Controlled
   browser runs are the current client-side performance evidence; do not claim a
   field baseline that the site does not collect.
3. **Authoring stays buildless; serving is minified, on every page.** The only
   build is `build.mjs`: a deploy-time transform that minifies every served HTML
   document (structure plus inline CSS/JS), the six client scripts, `luna.css`,
   `lwe-base.css`, and the Worker modules' `/*min*/` CSS literals into a staged
   `.build/` copy. It ships a readable twin beside each transformed asset:
   `/<name>.src.js`, `/luna.src.css`, and a `.src.html` per page named by a banner
   comment on line 1. It hard-fails if `luna.css` does not parse and content-hashes
   `nav.js` plus `luna.css` into immutable `/a/<name>.<hash8>.<ext>` URLs, while
   keeping the unhashed paths as short-cached fallbacks for Cal's absolute refs
   and stale HTML.

   `wrangler.jsonc` self-builds and points both `main` and `assets` at
   `.build/www`, so no deploy path can ship the readable originals. Local
   development uses `wrangler.dev.jsonc` against readable `www/`. Never bundle
   or extend the build without the owner's say-so. `luna.css` was owner-approved
   for its measured render-blocking win; the `/a/` content hashing was approved to
   clear the cache-lifetime audit; and whole-site HTML minification was approved
   because the same-program readable twin keeps View Source honest.

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
pnpm install
pnpm exec wrangler versions secret put -c wrangler.jsonc ICAL_URL        # Google Calendar → "secret ICS"
pnpm exec wrangler versions secret put -c wrangler.jsonc RESEND_API_KEY  # resend.com, DKIM-verify aadhar.sh
openssl rand -hex 32 | pnpm exec wrangler versions secret put -c wrangler.jsonc SIGNING_SECRET

# Production still ships through merge -> CI -> production -> Workers Builds.
# Local fallback, from the repository root only:
pnpm run deploy:direct
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
   local fallback is `pnpm run deploy:direct` from the repository root.

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

    One cost the byte comparison used to hide is RETIRED, and it is worth reading
    as a correction rather than a fact. This note said `node:zlib`'s brotli has NO
    dictionary parameter, listed the nine params as the whole list, and concluded
    that switching would reintroduce a `brotli` CLI dependency in the build path,
    which is precisely what moving the deltas into the build deleted. Node 26 takes
    a `dictionary` option (nodejs/node#61763, merged 2026-02-13), and
    `.node-version` is 26, so CI has it too. Measured 2026-08-10 on node v26.7.0,
    q11 over a 21KB target: 70 bytes with no dictionary against 18 with one. The
    dcb figures above still came from the CLI with `-D`, because that was the only
    door on the day they were taken.

    The CLI-dependency argument is therefore gone while the CONCLUSION is
    untouched, since dcz won on DECODE and neither engine's encoder was ever the
    question. Re-open it only with a fresh decode measurement, never on the size
    table (see above) and no longer on this paragraph.

    **Probe an engine's dictionary support, never infer it.** Three runtimes
    disagree on this one option. Node 26 honours it. workerd accepts it for zstd
    and silently ignores it, measured 2026-08-05, which is why `/terminal` ships no
    delta calculator and says so on the page. Bun does the same thing through
    1.3.14, its current stable, with the fix landing 2026-07-18 in oven-sh/bun#34427
    and verified here on `1.4.0-canary.1`. **The failure is silent in every case,
    because a frame compressed WITHOUT the dictionary still decodes fine WITH it**,
    so nothing throws and the only signal is a byte count that never shrank. The
    control is four lines: compress one target with no dictionary, the right one,
    and a wrong one. An engine that honours the option prints a smaller number for
    the right dictionary alone, and an engine that ignores it prints the same
    number three times.

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
    Node" and shipped a workstation script with committed artifacts; that limit was
    BROTLI's, generalizing it to zstd was wrong, and node 26 has since retired the
    brotli half of it too (see above). `zstdCompressSync` takes a
    `dictionary` option, it beats shelling out (116 bytes where the zstd CLI gave
    120), and the foreign `zstd -d -D` CLI decodes Node's output byte-exact,
    skippable prefix included — the interop check that matters, since the real
    decoder is a browser. So: no CLI in the deploy path, no committed `.dcz`, no
    step to forget, and no staleness tripwire needed, because a delta is a pure
    function of bytes the build just produced.

    What still has to be committed is `www/a-dict/`, the SHELL dictionary set,
    because an `/a/` asset is content-addressed: a change mints a new URL, so its
    dictionary must be bytes the BROWSER already holds and no build can derive that
    from source. `pnpm run shell:roll` adopts the current shell and prunes to 3 per
    asset; it writes into the source tree, which build.mjs must never do, so it can
    only ever land as a separate commit.

    **"Not urgent" was wrong, and the cost of believing it was 161 commits.**
    This said a dictionary 11 days stale still gave 87-93%, which is true of a
    dictionary that is STALE and false of one that is ABSENT. Those are different
    failures: the page tier degrades to the family corpus (~26%), while the shell
    tier has no fallback and degrades to plain brotli. Measured 2026-08-12, the
    last real roll was #178 on 2026-07-30 and every dictionary-carrying shell asset
    production served (nav, luna, hoist, tooltip, lens) was missing from `a-dict`.
    A returning visitor was taking 13.7 KB on the render-blocking path where the
    deltas are 1.3 KB. `dcz:check` printed PASS the whole time (see below).

    `.github/workflows/dictionary-roll.yml` runs the roll nightly against
    production and opens a PR when anything moved. It cannot merge that PR:
    `main` takes zero bypass actors, which is the property the release model rests
    on, so the last step stays a human one deliberately. `a-dict` is
    `.assetsignore`d (build input, not a public URL).

    **PAGES use two dictionary tiers.** build.mjs derives ONE raw 64KB family corpus
    from the staged documents, ships it at an immutable `/a/page-family.<hash8>.dict`,
    and every HTML response advertises it via `Link: rel="compression-dictionary"`
    (`lib/security.js`). It also diffs the current page against the committed
    `www/p-dict` snapshots from the previous release. The worker tries the
    `Available-Dictionary` tag it receives. The family offer deliberately uses a
    longer site-wide URLPattern than an exact page path, so RFC 9842 makes it the
    preferred dictionary whenever both are cached; this prevents an uncaptured old
    page snapshot from shadowing a usable family delta and forcing Brotli. The exact
    page remains the high-ratio fallback (93-97% in the measured set) before the
    idle-loaded family dictionary arrives. The family corpus includes representative
    tails from its four outlier layouts and now beats q11 on all 46 deterministic
    pages (428,238 B vs 494,073 B across the set). Both candidates are emitted only
    when they beat plain q11.
    `pnpm run shell:roll` rolls both `a-dict` and `p-dict`; page snapshots are Brotli'd
    in the repo, ignored by the asset upload, and decompressed only at build time.
    **BOTH halves can read the wire now, and `--live` is how the scheduled roll
    works.** `p-dict` has always fetched the LIVE pages, because an edge feature can
    rewrite a document after this Worker and a snapshot derived from source then
    matches nothing (gotcha 20, the WebMCP instance and the measurement). `a-dict`
    adopted from `.build/www/a`, which was never WRONG the same way (nothing
    rewrites js/css at the edge) but forced the roll to run from the deployed
    commit. `pnpm run dict:roll` passes `--live` so the shell half reads production
    too. That buys two things: a roll can run from anywhere, including a scheduled
    job on an unramped `main`, and it captures what browsers are holding rather than
    what this checkout happens to build. Adopting from a build can only ever capture
    THIS commit's shell, so a release that went by without a roll is unrecoverable,
    and on an unramped tree it adopts bytes nobody holds while evicting one still in
    use (KEEP is 3). It refuses outright if production reads empty, because an empty
    read hands the prune an empty `current` set, which is exactly when it is free to
    evict what is live. `pnpm run pages:roll` still rolls the page half alone.
    RFC 9842 requires RAW bytes here: a `zstd --train` artifact is self-describing,
    the server library reads its tables, Chrome reads the same bytes as content, and
    the navigation dies on `ERR_CONTENT_DECODING_FAILED`.

    **Plain (non-delta) responses stay brotli q11, and that is forced, not chosen.**
    A worker cannot see the client's Accept-Encoding (gotcha 13), so plain zstd is
    unnegotiable server-side; the ONLY safe zstd trigger is `Available-Dictionary`,
    which doubles as proof the client speaks dcz. So "zstd where it wins" IS the
    delta path. Loader classes differ (#119): js/css dcz proven in production, html
    server-side proven (149-byte page delta decodes to the live page), svg OFF by
    design (Chromium's image loader chokes). `pnpm run dcz:check` asserts both page
    tiers against production, reading the family dictionary out of the live `Link`
    header and the per-page candidate from `www/p-dict`. With `pnpm run dict:roll`
    the source is production for both halves, so the old "roll only from the deployed
    build, never from a feature branch" rule is satisfied by construction rather than
    by remembering it. Plain `shell:roll` still reads `.build/` and still carries that
    requirement. (Either writes into `www/a-dict/` the moment it runs, so if you run one
    to read the code, `git checkout -- www/a-dict` after.)

    **`dcz:check`'s shell probe could only ever agree with itself, and the coverage
    assertion beside it is the fix.** The probe picks an a-dict candidate that is NOT
    the live hash, offers it, and asserts `dcz` comes back. build.mjs builds a delta
    for every a-dict entry, so that is true by construction; it reads the live hash
    only to EXCLUDE it. What a returning visitor actually asks is whether the bytes
    THEY hold are covered, which is the same shape as the page tier's "committed
    snapshots are WIRE bytes" assertion. `live shell is covered by a-dict` now asks
    it. Bases with no a-dict history are skipped, since a newly shipped asset cannot
    have a dictionary until it has been served once. Keep it ADVISORY: like
    `infra:check`'s edge tier it reads production, so making it required would
    deadlock the release that would clear it.

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
    Everything else in `www/_worker.js/` and `cal/src/` is ALSO imported by
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

    Empty is correct for `pnpm run dev`, which serves the readable unminified tree
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
    behind a query only Firefox (the one engine that needs it) matches. Check
    the INHERITED value first the next time a custom scrollbar does not appear.

    **Writing this note down did not fix the other three instances, and that is
    the part worth generalizing.** It was filed 2026-08-05 off the `/terminal`
    repair and reads as though the site were now correct. It was not: `luna.css`
    had `scrollbar-color` and `::-webkit-scrollbar-*` on the same selectors
    (`.window>.content`, `.window>.body`, `.np-text`), so EVERY window on the
    site drew a zero-width overlay bar, and `garage/scroll.html` did too, on the
    one page whose entire purpose is demonstrating the Luna scrollbar while its
    copy claims "WebKit/Blink get the full gradient thumb + buttons." Both went
    unnoticed for two days because the symptom is an absence. Measured 2026-08-07
    in Chromium 148, changing only that property: homepage window 0px to 16px,
    demo box 0px to 17px. When a gotcha lands here, grep the tree for the other
    instances in the same commit; `grep -rl '::-webkit-scrollbar' www/` was
    the whole search.

    **`@supports not selector(::-webkit-scrollbar)` no longer isolates Firefox,
    so the original recipe above is retired.** FF153 answers YES to that probe
    while implementing a narrow subset (a non-zero `width`/`height` disables
    overlay bars, `display:none` acts like `scrollbar-width:none`, and nothing
    else lands), which `/garage/horizon` already documents as its own chip lying.
    A bare `not` arm therefore hands modern Firefox `auto` and drops the tint.
    All three sites now use:

    ```css
    @supports (not selector(::-webkit-scrollbar)) or selector(:-moz-focusring)
    ```

    so the colours survive unless Firefox both answers the probe AND drops the
    pseudo. Chromium evaluates the whole query false, verified in-engine.

    **Do NOT reach for `(-moz-appearance:none)` as the Firefox arm.** It is the
    obvious candidate, it is correct in the source, and Lightning CSS un-prefixes
    it to `(appearance:none)`, which Chromium supports. The query flips true at
    BUILD time, the reset is undone, and the bug returns while the source still
    reads right. Of six candidates tested through the minifier, `-moz-appearance`
    and `-moz-box-align` were rewritten; `:-moz-focusring`, `:-moz-any-link`,
    `-moz-osx-font-smoothing` and `-moz-float-edge` survived. The general rule is
    that a vendor-prefixed feature query has to be diffed in the MINIFIED output,
    never trusted from source, because this minifier's job is to normalize
    exactly the prefix the query depends on.

19. **A backtick inside a CSS comment inside a `/*min*/` literal ends the JS
    template literal.** The worker's static CSS lives in backtick literals that
    `build.mjs` step 8 minifies in place, and prose in a CSS comment is still
    JavaScript source. Writing ``overflow-y is `scroll`, not `auto` `` in one
    truncated the literal mid-file and the build failed with a JS parse error
    pointing at a line that looked fine. Nothing is wrong with the CSS; the
    string ended early. The build's post-substitution re-parse is what catches
    it, which is the reason that re-parse exists — keep backticks out of those
    comments.

20. **An edge feature that rewrites HTML *after* the Worker invalidates anything
    derived from the Worker's own output — silently, and dictionaries first.**
    WebMCP was enabled on 2026-08-06 (Agent Readiness → Labs), and Cloudflare
    implements it by injecting one loader tag with HTMLRewriter at the edge:

    ```html
    <script type="module" src="/.webmcp/bridge.js" data-packs="c2pa,mcp-server-client"></script>
    ```

    It lands FIRST in `<head>`, on every document here, worker-rendered and static
    alike, and it survives `encodeBody: "manual"` precompression — so the CLAUDE.md
    claim that "the edge cannot rewrite HTML it did not compress" is true of the
    zone-side Web Analytics injector and NOT true in general. Verify per feature.

    What broke: `www/p-dict` snapshots were adopted from `.build/www/*.html`,
    and a shared dictionary is matched by the SHA-256 a BROWSER computes over the
    body it stored. The staged file has no injected tag, so every snapshot hashed to
    bytes nobody held and the 93-97% per-page tier fell back to the family
    dictionary. Nothing errored. Proven on `/garage/pretext`: offering the committed
    tag answered `dcz`, offering the tag of the live body answered `br`.

    `shell:roll`'s page half reads PRODUCTION now, and `pnpm run pages:roll` rolls
    that half alone (the shell half still reads the local built tree, so it is still
    deployed-commit-only — that is why they split). `dcz:check` grew a
    **committed snapshots are WIRE bytes** assertion: a script the live document
    loads must appear in at least one snapshot. The old per-page probe could not see
    this, because it offers the committed tag and so passes on a snapshot no browser
    could ever offer.

    Generalise past WebMCP: Rocket Loader, Email Obfuscation, zone-side beacons, an
    A/B mutation — any of them breaks a dictionary derived from source, and the
    symptom is a silent tier downgrade rather than an error. **Derive from the wire,
    or verify the wire equals the build.**

    **The repair exposed a second bug in the same operation: `git checkout` destroys
    mtime ordering, and both prune loops were sorting on mtime.** Checkout stamps
    every file it writes with the checkout time, so in a fresh worktree every
    pre-existing candidate is exactly as old as every other and "delete the oldest"
    becomes "delete whatever readdir listed first". The first repair roll, run from
    a clean worktree, kept a snapshot from an old release and deleted
    `garage__pretext.73cac3ee` — the bytes production had served that same morning,
    and therefore the only candidate a visitor from that morning could offer. The
    hygiene rule (work from a fresh worktree) and the prune were in direct conflict,
    and the roll is exactly where they meet.

    Ordering is COMMIT time now, from one `git log --name-only` walk per directory,
    shared by both halves (`gitTimes()` / `oldestFirst()` in the roll script).
    Snapshots the run confirmed as currently served are un-prunable outright. The
    check that this is right is a set intersection, not a vibe: the snapshots a roll
    deletes must not intersect the snapshots representing bytes browsers hold.

22. **A ramp step names the WHOLE traffic split, and at most 2 versions.** Both
    halves of that bit `deploy:promote` on 2026-08-06. `wrangler versions deploy`
    takes no delta, so `<target>@10` alone is rejected for totalling 10% and each
    step has to name the incumbent holding the remainder. Then, because production
    was already serving TWO versions (a secret update mints a version, and
    `e0f1ab05` had been left at 10%), naming every incumbent produced a 3-way split
    and wrangler refused the step outright: *"Too many versions selected. You can
    deploy at most 2 version(s) at a time."*

    So a ramp that starts from a multi-version split necessarily DROPS the smaller
    incumbents, and the script cannot avoid that — it can only choose which one
    survives.

    **This paragraph described a `trafficSplit()` that does not exist, and the
    correction is the more useful note.** That function was written in the working
    tree on 2026-08-06 to distribute the remainder proportionally across every
    incumbent; the 2-version cap is exactly what makes that idea unimplementable,
    and the whole thing was discarded without ever being committed. What ships is
    simpler and predates it: `const previous = active.find((v) => …)`, so the
    remainder goes to **the first non-target version the API happens to list**, and
    the split is only ever 2 wide, which is why the "too many versions" error cannot
    recur here.

    The wart worth knowing: with two incumbents, `find` is arbitrary rather than
    largest. Hand the remainder to a version only 10% of traffic was getting and a
    ramp step silently moves 90% of users somewhere new, inside a procedure whose
    only purpose is changing one thing carefully. Rare (it needs a multi-version
    split, which usually means a previous ramp stopped half-way), unlikely to be
    noticed when it happens, and a one-line fix — sort by `pct` and take the largest
    — if someone decides it is worth touching the release path for.

    **Run `pnpm run deploy:promote --dry-run` before any ramp.** It resolves and
    prints the target and moves nothing, and it exists (#259) because the target is
    no longer simply "the newest version": Workers Builds uploads one for EVERY
    branch push, so a bare ramp used to be a live way to walk another agent's branch
    to 100%. `newestVersion()` filters on `workers/alias` now and fails closed rather
    than guess. That is a different axis from the split above — #259 chose the
    TARGET, this note is about which incumbent holds the REMAINDER, and #259 touched
    neither `previous` nor `specs` — but both are ways a ramp can move traffic
    somewhere you did not intend, and the dry run is what shows you either one
    before it happens.

21. **The bridge's `c2pa` pack cannot see this site's photos, and no pipeline
    change fixes it.** TURNED OFF in the dashboard 2026-08-06, so the injected tag
    reads `data-packs="mcp-server-client"` and the note below is the record of why
    rather than a proposal. Read it before anyone scopes Content Credentials again.
    `collectImageSources()` reads
    `img.currentSrc || img.src`, and `currentSrc` on a `<picture>` is whatever the
    browser CHOSE — AVIF here. `detectImageFormat()` then sniffs exactly two magic
    numbers, JPEG's SOI and the PNG signature, and returns `unknown` for everything
    else. So the pack fetches the AVIF and reports "Unsupported image format" no
    matter what the JPG tier carries. Signing buys nothing until that parser learns
    BMFF, which is the reason the pack is off: it was 2 tools that walk every
    `<img>` on the page and fetch each one to learn nothing.

    The byte numbers, from `c2patool` 0.27.6 against a real shipped thumbnail
    (`L1000069_3`, 21,505 B JPG / 11,204 B AVIF), since they are the reason this
    stays parked: **+13.8 KB per image, near-constant**, and NOT the certificate
    (the whole PEM chain is 1,836 B). JPG 21,505 → 35,283. AVIF 11,204 → 25,092.
    Default settings are far worse, because c2pa-rs embeds a claim thumbnail unless
    `[builder.thumbnail] enabled = false`: 21,505 → **101,603**. A sidecar `.c2pa`
    leaves the pixels byte-identical at the same 13,766 B, which is the only shape
    worth revisiting. Across 474 committed `/i/` files that is ~6.5 MB of immutable
    assets for a signature nothing on the page can currently read.

23. **An AI Gateway id is a hard dependency, so the three Workers AI callers here
    name one through config rather than a literal.** Cloudflare merged Workers AI
    and AI Gateway into one control plane on 2026-08-07: `env.AI.run` takes a third
    argument and the REST endpoint takes a `cf-aig-gateway-id` header, which buys
    payload logs, per-model token counts and cost attribution with no dashboard
    setup. No breaking changes, and `lwe-ask` had already been routing through its
    own `lwe` gateway since it was written, so the only callers this changed were
    `/garage/cf/caption` and the two photo scripts.

    Verified rather than assumed, because the docs do not say whether a `default`
    gateway exists: against `wrangler dev` with the real account, `default` returned
    a caption in 5.4s and `definitely-not-a-real-gateway-xyz` returned
    **`2001: Please configure AI Gateway in the Cloudflare dashboard`**. Run that
    control before trusting any gateway id. What it proves is the part that matters
    operationally: **a wrong or deleted gateway FAILS the inference call**, it does
    not quietly fall back to un-gatewayed inference. Since no deploy path here may
    create Cloudflare resources, a literal in the source would make a live demo
    endpoint depend on a resource this repo cannot restore, so the id is
    `cf-garage`'s `AI_GATEWAY` var and the scripts' `CLOUDFLARE_AI_GATEWAY`, both
    defaulting to `default` and both disabled by an empty string.

    **Caching is deliberately off on all three**, which is the non-obvious half.
    `cacheTtl` / `cf-aig-cache-ttl` is a separate opt-in and it is wrong here for two
    different reasons: `/garage/cf/caption` sends a byte-identical request on every
    click, so one cached answer becomes every visitor's answer on a page whose lede
    promises nothing is faked; and the photo scripts are resumable, where re-running
    a stem is exactly how a bad caption gets replaced, which a cache keyed on the
    identical request would make impossible. Reach for gateway caching only where a
    repeated identical request SHOULD return a repeated identical answer, the way
    `lwe-ask` does with its 24h TTL and explicit per-request `cacheKey`.

    Two announced pieces are not shipped and nothing here should be built on them
    yet: **model-first routing** (ask for a model abstractly, let the gateway pick a
    provider and fail over) and **smart routing**. The first is worth watching,
    since `lwe-ask/wrangler.toml` already carries a scar from `llama-3.1-8b` being
    deprecated out from under `GEN_MODEL` on 2026-05-30.

24. **The ramp writes the changelog from YOUR WORKING TREE, so pull `main` before
    you ramp.** `deploy:promote` decides what to log by reading the local
    `www/_worker.js/checkpoints.json` and diffing it against D1
    (`scripts/deploy-promote.mjs`, the `steps[last] === 100` block). Ramp from a
    tree that has not pulled the merge and the file it reads still ends at the
    previous release, so the diff is empty and the row is never written.

    Hit 2026-08-08 on v175. The entry was staged in a worktree, merged, and ramped
    from a main tree sitting one commit behind, which printed:

    ```
    done. 50377ca5 is at 100%.
    deploy log: nothing staged — this version carries no new changelog entry.
    ```

    That sentence is TRUE about what the script could see and false about what
    shipped, which is the whole problem. **Three things then conspire to hide it.**
    `/updates` and `/restore` render the projection baked in at BUILD time, so the
    deployed page cheerfully showed v175 while D1 had no record it ever shipped.
    `checkpoints:check` cannot catch it either, because it compares the local
    projection against D1 and a stale tree makes both agree; it reported
    `projection agrees with D1` throughout. And the one honest signal is a single
    line of ramp output that reads like routine confirmation.

    The repair costs nothing once you see it: pull, confirm the target with
    `--dry-run`, then re-run against a version ALREADY at 100%.

    ```bash
    git pull --ff-only
    pnpm run deploy:promote --dry-run    # target must be the version now serving
    pnpm run deploy:promote --to 100     # moves no traffic; runs the logging block
    ```

    Two lessons worth keeping past this bug. **A check that compares two values
    derived from the same stale source proves nothing**, which is the same shape as
    the contract test in the Markdown-twin note that read the wrong field names and
    still reported a pass; when a check can only ever agree with itself, it is
    decoration. And **the hygiene rule collides with the release step**: this repo
    tells you to work from a fresh worktree, and that discipline is exactly what
    puts the staged entry somewhere the ramp cannot see it. Same collision as the
    `git checkout` mtime problem in gotcha 20, and the same resolution: the
    conflict lives at the one operation that touches both, so handle it there.

25. **A secret change between one production upload and the next is INVISIBLE to
    the ramp, and ramping across that window silently reverts it.** Two rules
    this file already states separately produce it, and each is right on its own.

    A secret is a version (see the `versions secret put` note above), so
    `wrangler versions secret put|delete` mints one. That version is created by
    `create_version_api` and therefore carries **no `workers/alias`**. And since
    #259, `newestVersion()` in `scripts/deploy-promote.mjs` filters candidates to
    the production alias, because ramping the newest version outright was a live
    way to walk another agent's branch build to 100%.

    Together: **a secret change made after the production build can never be the
    ramp target.** The dry run does say so, in a line that reads like routine
    noise rather than a warning:

    ```
    skipping 1 newer non-production version(s): (no alias)
    target version:   d285199d
    ```

    Measured 2026-08-08 while deleting the dead `BROWSER_RENDER_TOKEN`. The
    deletion landed 52 seconds after Workers Builds uploaded `d285199d`, so that
    build still carried the secret (13 names) while the deletion version
    `9e53d836` did not (12). Ramping the target the script picked would have put
    the secret back, and nothing would have said a word.

    **What saves it is that a version inherits the CURRENT secret set**, and that
    is the half worth remembering, because it turns an alarming problem into a
    small one. `0013118a`, built four minutes after the deletion, already lacked
    the secret; so did `404dac60`, the next production build, which is the one
    that got ramped. **The exposure is only the window between the production
    upload and the secret change** — one more merge, or any push to `production`,
    closes it without help.

    The rule is short: **after changing a secret, do not ramp a production
    version that predates the change.** Check with
    `pnpm exec wrangler versions view <id>`, which prints `Secrets:` by name. If the
    only production build is older than your change, wait for the next one;
    re-applying the change on top after ramping is the fallback rather than the
    default, since a secret PUT needs the value again and those live on a
    workstation.

    Do NOT reach for "let the ramp target unaliased versions too". That is
    precisely the guard #259 added and its reason has not gone away. If this is
    ever worth automating, the shape is narrower: allow an unaliased version only
    when it sits directly above the newest production build AND its
    `workers/message` names a secret change.

    Two near-misses here are worth copying past the secret itself. `--dry-run`
    is what surfaced the skipped version at all, the second time it has earned
    its place (gotcha 22 is the first). And the ramp was nearly run from the main
    tree, which at that moment sat on **another session's branch** with an
    uncommitted file. Gotcha 24 says to pull `main` before ramping; the sharper
    form is **check you are ON it**, because a tree parked on somebody else's
    branch satisfies a `git pull` and still reads the wrong `checkpoints.json`.
    Ramp from a fresh worktree at `origin/main`.

26. **`run_worker_first` caps at 100 RULES and this repo sits at exactly 100.**
    There is no headroom. Adding two paths for `/garage/dyno` on 2026-08-08 took
    it to 102 and wrangler refused to start the Worker at all:

    ```
    Error: Too many `run_worker_first` rules were provided;
    102 rules provided exceeds max of 100.
    ```

    **Neither `pnpm run build` nor `wrangler deploy --dry-run` catches this**,
    which is the part worth knowing before you spend an afternoon on it. Both
    passed on the config that could not boot; `parseStaticRouting` runs at
    session creation, so the failure needs a real Worker. `pnpm run routes:check`
    is what found it, because `createTestHarness()` starts one. That is a second
    reason the route oracle exists beyond the routes it sweeps: it is the only
    pre-merge step that instantiates the asset-routing config.

    Two things follow. **Check whether a wildcard already covers your path before
    adding a rule** — `/garage/*`, `/lwe/*`, `/pixel-peeper/*`, `/access/*`,
    `/coffee/*`, `/serendipity/*`, `/writing/*` and several `/images/*.<ext>`
    entries are already there, and the two `/garage/dyno` rules turned out to be
    redundant, which is how that change shipped at 100 rather than 102. And
    **deduping will not buy you room**: the list holds 107 raw entries of which 7
    are exact duplicates (`/garage/*`, `/garage`, `/lens`, `/lens/`, `/photos`,
    `/photos/`, `/rn.md` each appear twice), and wrangler counts the 100 UNIQUE
    ones. Real headroom means folding individual paths onto wildcards, which
    changes what the Worker sees and is not a cosmetic edit.

27. **A `github-advanced-security` failure is usually GitHub's own Copilot
    Autofix falling over, not your diff.** Seen six times across three days: on
    2026-08-08 on #289 and #295, on 2026-08-10 on #305, #307 and #313, and on
    2026-08-11 on #319. Every one of them ran while the separate `CodeQL` check
    reported *"No new alerts in code changed by this pull request."*

    **Read the ROOT CAUSE paragraph at the end of this gotcha first.** Everything
    between here and there is the fingerprint, which is what we had before the
    job log gave up the actual error; it is still useful and it is no longer the
    sharpest tool available.

    The signature is specific enough to recognise on sight: the check has an
    EMPTY output title, and its single annotation points at `.github:<line>` —
    a path that is a directory in this repo and therefore cannot have a line.
    The job log names the real actor (`COPILOT_AGENT_INPUTS`,
    `COPILOT_JOB_NONCE`, `Preparing Copilot...`, and a `COPILOT_AGENT_MODEL`).

    Read the sibling `CodeQL` check before touching any code. If that one passed,
    there is nothing in the change to fix. It is also NOT a required check, so it
    never blocks a merge — both of those PRs merged and shipped with it red.

    **"Usually" is carrying real weight, and #299 produced BOTH variants an hour
    apart.** The first failure there was a GENUINE finding: a real inline review
    comment on a real source line (`lens-reader/src/index.js:79`, information
    exposure through a stack trace), which was correct and got fixed. The second
    was the Copilot artifact above. Same check name, same red X, opposite
    meanings — so "it's just Copilot" is a conclusion to reach, never an
    assumption to start from.

    The tell takes one API call and separates them cleanly:

    ```bash
    gh api repos/oddharsh/site/commits/<sha>/check-runs \
      --jq '.check_runs[] | {name, conclusion, title: .output.title}'
    ```

    A real finding carries a non-null `output.title` naming the rule AND an
    inline comment on a source file. The artifact has `title: null`, an empty
    summary, and its lone annotation at `.github:<line>`. Check the annotation
    path: a finding points at code you wrote, the artifact points at a directory.

    **A prose-only PR is the strongest control there is, and 2026-08-10 handed us
    one.** #305 changed documentation, four code COMMENTS and one quiz string;
    #307 changed a build script. Both failed this check identically, with
    `title: null` and one annotation at `.github:211` and `.github:213`
    respectively, while CodeQL passed on both. A diff carrying no executable
    change cannot carry a security finding, so a check that reddens on it is
    reporting on itself. When the API tell above leaves you unsure which variant
    you have, ask whether the PR contains code at all. And confirm the stakes from
    the ruleset rather than from the check list, since `validate` is the only
    required context: this has now been red on six PRs while gating none of them.

    **#313 added two things, and the second one changes how you look.** Its lone
    annotation was at `.github:213` — the SAME line as #307, on an unrelated
    CSS-only diff. A line number that repeats across two PRs sharing no content
    is a fingerprint of the harness rather than a location in anything, so read
    it as one more signature and never go looking for what lives there.

    The sharper one: **`gh pr checks` did not list the failing check at all.**
    On #313 it printed seven rows, every one `pass` or `skipping`, with no
    `github-advanced-security` among them, while `/commits/<sha>/check-runs`
    reported that same check as `failure` on the same head commit. Reproduced
    twice, minutes apart, so it is not a timing gap. The consequence is that the
    convenient command reports the PR as GREEN while the notification says a
    check failed, which reads exactly like a stale alert and is not one. Use the
    `check-runs` call above as the source of truth for whether this check is red;
    `gh pr checks` is fine for everything else.

    **THE ROOT CAUSE, read out of the job log on #319 (2026-08-11), and it
    retires the fingerprint as the primary test.** Every paragraph above infers
    the artifact from circumstantial marks: a null title, an annotation at a
    directory, a line number that repeats. The log says it outright:

    ```
    Error creating PR review request: SessionModelError: Execution failed:
    CAPIError: 400 The requested model is not supported.
    ```

    Copilot's review agent asked GitHub's own model API for a model that API
    refused, threw inside `runAgenticLoop`, and exited 1. It never read the diff.
    So the check is reporting an outage in Copilot's model routing, and no change
    to your branch can turn it green.

    **The log NAMES the model, which is the sharpest form of this fingerprint
    and was missing from every entry above.** Read on #368 (2026-08-14), one
    line before the error:

    ```
    Creating copilot-sdk session with model: claude-opus-4.6 and clientName: github/code-scanning
    ```

    That narrows the outage from "Copilot's model routing" to one model on one
    client, which is worth knowing for two reasons. It says the refusal is a
    routing or entitlement gap for a specific model rather than the review agent
    being broken, so the fix is upstream configuration and not a Copilot release.
    And the line is emitted whether or not the request then fails, so it is the
    thing to read on the day this goes green: it tells you WHICH model GitHub
    moved to, which is the only evidence that the outage ended rather than
    paused. Grep for it alongside `CAPIError`, since a run that prints the
    session line and no error is the recovery signal.

    **It is not a flake: the same error landed on three commits across two PRs
    in twenty-one minutes.** #319 twice (its feature head, then a merge commit
    that only pulled `main` in), and then THIS PR, whose entire diff is the
    paragraph you are reading. Three different Request IDs, one identical error,
    including on a change that adds no executable line to the repository. An
    outage in a service this check depends on reproduces on whatever you push
    next, which is worth knowing before you start bisecting a diff for the cause
    of it.

    That gives a test which does not depend on recognising a signature:

    ```bash
    URL=$(gh api repos/oddharsh/site/check-runs/<check-run-id> --jq .details_url)
    RUN=$(echo "$URL" | sed -E 's#.*/actions/runs/([0-9]+)/.*#\1#')
    gh run view $RUN --log-failed | grep -i "CAPIError\|Copilot Error\|session with model"
    ```

    **Pull the run id with that sed rather than off the end of the URL.**
    `details_url` ends `/actions/runs/<run-id>/job/<job-id>`, so the trailing
    number is the JOB, and `gh run view <job-id>` exits 0 and prints NOTHING.
    An empty grep is supposed to mean "a real finding, no crash", so handing it
    the wrong id inverts the verdict without erroring. Cost one step on #370,
    which is the PR that added this line.

    A crashed agent prints the error. A real finding prints an inline review
    comment on a source line and leaves this grep empty. Prefer it to the
    `.github:<line>` tell, which was only ever suggestive: this one names the
    failure rather than pattern-matching around it.

    Two smaller things #319 settled. The workflow is
    `dynamic/agents/github-advanced-security`, titled "Code scanning AI findings
    on PR #N", and it lives nowhere in `.github/workflows/`, which is why no file
    in this repo configures it and why grepping the tree for it finds nothing.
    And a **re-notification can arrive for a run that already failed hours
    earlier**: #319 alerted twice on check-run `93749646946`, same `completed_at`
    both times, with no new commit in between. Compare `id` and `completed_at`
    before investigating, because a repeat alert about an old run is
    indistinguishable from a fresh failure in the notification itself.

    **It fires on EVERY PUSH now, and the outage has not moved in a day.** Three
    more on 2026-08-12 (#351, check-runs `94224768202`, `94225922560`, plus one on
    #340), all the same `CAPIError: 400`, taking it to nine recorded. One of them
    landed on a commit whose entire diff moved `${{ }}` expressions out of `run:`
    blocks and into `env:`, which strictly REDUCES attack surface — so a red mark
    here carries no information about the diff even in the direction it claims to.
    Those three cost three separate investigations in one session, which is the
    real bill: the check is not required, it gates nothing, and it reliably pulls
    somebody into a log.

    So the loop to run is short. Confirm the run id is new (a repeat alert looks
    identical), grep the log for `CAPIError`, and stop. Do NOT re-read the diff
    looking for what upset it, and do not push anything to appease it.

    **Ten recorded, and the outage is three days old as of 2026-08-14** (#368,
    check-run `94825132999`, annotation at `.github:214`, `claude-opus-4.6`).
    The `.github:<line>` number has now been 211, 213 and 214 across four
    unrelated diffs, which settles that it tracks the harness rather than
    anything in the repository.

    **Turning off Copilot Autofix does NOT stop it, measured 2026-08-12.** This
    paragraph said the fix was in GitHub's settings and named autofix; the owner
    turned it off and the very next push failed identically. The run proves the
    toggle landed and changed nothing that matters: the log carries
    `COPILOT_AGENT_ONLINE_EVALUATION_DISABLED: true` and `[skills]
    session=github/code-scanning enabled=false source=disabled`, then crashes on
    the same `CAPIError: 400` anyway. The job also ran 29s instead of ~80s, so
    something genuinely changed; the check still fails.

    Which setting (if any) actually silences `dynamic/agents/github-advanced-security`
    is UNKNOWN, and guessing has now cost one wrong answer. It configures nothing
    in this repo (gotcha 27's own note: it lives in no workflow file here), so
    treat it as an upstream red mark that gates nothing until GitHub fixes their
    model routing. `CodeQL` and `Analyze (actions)` are the checks doing the real
    scanning and both stay green throughout.

    **What it will not catch, learned the same day.** `Analyze (actions)` passed on
    a workflow that interpolated `${{ inputs.base }}` straight into a `run:` block,
    because the CodeQL Actions analyzer treats `workflow_dispatch` inputs as
    trusted. That is defensible (dispatch needs write access) and it means the
    injection class in workflow code is on you to read for. Grep new workflows for
    `\$\{\{` inside `run:` and route values through `env:` instead.

28. **Bun runs this build byte-identically and about twice as fast, and it is
    still not adopted.** `pnpm run bun:check` is the control, in the same idiom as
    `kitesurf:check`: it probes the zstd dictionary option, diffs a full node
    build against a full bun build file by file, and runs the contract suite
    under `bun test`. Measured 2026-08-10, node v26.7.0 against bun
    `1.4.0-canary.1+827475e21`:

    | question | result |
    |---|---|
    | zstd honours `dictionary` | yes, 73 none / 24 good / 73 wrong |
    | build output byte-identical | yes, 1975 files, 0 differing |
    | wall clock | 14.4s node against 7.1s bun |
    | contract suite under `bun test` | 206 pass, 0 fail |

    **BYTE-IDENTICAL is the bar, and it is much higher than "the build
    succeeds".** `/a/` and `/i/` are content-addressed, so a single differing
    byte mints a new URL, orphans every committed `a-dict` snapshot naming the
    old hash, and moves the CSP hashes the documents are served under. A build
    that is 2x faster and one byte different is not a faster build.

    Three things keep it unadopted, and only the first is about bun. The newest
    STABLE bun is **1.3.14** (2026-05-13), which predates the dictionary fix
    (oven-sh/bun#34427, merged 2026-07-18) and silently ignores
    `zstdCompressSync`'s `dictionary`; pinning the build path to a canary trades a
    correctness bug for an unreleased revision. wrangler, miniflare and workerd
    are the deploy path AND the route oracle, and they are node-pinned. And the
    win is seconds on a step CI already spends far longer on in dry-runs.

    **The failure here would be LOUD, which is worth knowing before this reads
    scarier than it is.** build.mjs already feature-detects the same collapse and
    throws (search `expected a collapse`), so bun 1.3.14 kills the build rather
    than shipping no-op deltas. That guard exists because the no-op shipped for a
    full deploy once. The ENGINE is silent; this build is not.

    **Bun's spec-strict `Response` found a real defect in our suite**, which is
    the byproduct worth keeping even if bun is never adopted. `withSecurityHeaders`
    rebuilds every response as `new Response(response.body, …)`, which per Fetch
    LOCKS the body it was handed, and one contract test pushed the same four case
    objects through it twice. Bun threw `Body object should not be disturbed or
    locked`; node's undici allows it. The assertions were about headers, so the
    leniency was never load-bearing, and the test now builds its cases fresh per
    pass. **A suite that passes on one runtime and not another is reporting a
    fact about the runtime**, so run the other one occasionally even when you have
    no intention of switching.

29. **This repo runs pnpm, and the migration turned up four things that bite.**
    Switched 2026-08-10 after measuring npm, pnpm, bun and all three yarn 4
    linkers against this tree. Every one built identically and passed the full
    suite, so the choice came down to cost rather than capability: a second
    repo's dependencies cost pnpm **4 MB** of real disk against npm's **459 MB**
    (APFS clones the store, so `du` reports 340 MB and is wrong), and warm
    installs run 1.50s against 3.71s. Yarn was ruled out on a hard failure rather
    than a preference — the 4.9.1 that Workers Builds ships cannot install this
    repo at all, because its builtin TypeScript compat patch expects
    `lib/_tsc.js` and TypeScript 7 has no such file (controls both ways: TS 5.9.3
    installs on 4.9.1, TS 7.0.2 installs on 4.18.0). For bun, see gotcha 28.

    **`pnpm <script>` runs the script, and that made `deploy` a loaded gun.**
    The root release script is **`deploy:direct`** now, and the rename is the
    whole point rather than tidiness. Under npm, reaching a 100% production
    deploy required the word `run`. Under pnpm, `pnpm deploy` is a plausible
    shorthand, and it does NOT hit pnpm's builtin `deploy` the way `pnpm deploy
    --help` in an empty directory implies: a script of the same name wins, so it
    starts `wrangler deploy` against production. Verified the hard way while
    testing that assumption. `lens-reader` keeps a plain `deploy` on purpose,
    since it publishes a demo Worker rather than aadhar.sh.

    **A package published in the last 24 hours is REFUSED**, by
    `minimumReleaseAge: 1440` in `pnpm-workspace.yaml`. It is pnpm 11's default
    and is written down explicitly so it stays a decision. The bill arrives in CI
    rather than locally, because `--frozen-lockfile` re-checks the policy against
    the COMMITTED lockfile: a dependabot PR opened minutes after a release fails
    to INSTALL until the package turns a day old or lands in
    `minimumReleaseAgeExclude`. `pnpm install` regenerates that list. It also
    fires on any job that installs an OLDER commit — `perf-diff.yml` builds the
    merge base using the workflow from your branch, so a base predating the
    exclude list gets the policy without it. Self-resolving once this is on main,
    and the general shape is that a new policy against an old tree fails on the
    gap between them.

    **It also fires on any job that installs an OLDER commit**, which is a case
    worth knowing before you go debugging one. `perf-diff.yml` checks out the
    merge base and builds it, using the WORKFLOW from your branch against the
    TREE from the base, so a commit predating `minimumReleaseAgeExclude` gets
    the policy with no exclude list and fails. That was self-resolving for the
    pnpm migration itself (once this landed on main, every merge base carried
    the list), and it generalises: a workflow that builds an old tree with a new
    policy will fail on the gap between them, and the fix belongs in the job
    rather than in the policy. `perf-diff` gates nothing, so it was left to
    resolve itself; `validate` would not have that luxury.

    **`allowBuilds` is pnpm 11 only, and the build image runs pnpm 10.11.1.**
    pnpm 10 spells the same idea `onlyBuiltDependencies` and ignores this key
    silently, so `esbuild` and `workerd` postinstalls do not run there. Harmless
    today, because every native dependency here ships its platform binary through
    `optionalDependencies` and passes its probe with the postinstall blocked
    (measured; npm 11.19 blocks them too and always did). It stops being harmless
    the day something genuinely needs its build step.

    **`npx` is `pnpm exec` now, and the reason is the registry.** `npx` FETCHES
    what it cannot resolve locally — pointed at a nonexistent binary it reached
    `registry.npmjs.org` even under `--no-install`, while `pnpm exec` failed
    locally with no network call. On a repo that pins Wrangler exactly and runs
    `check-wrangler` on every PR to enforce one version, a command that will
    silently download some other one is a hole in that guarantee. **`pnpm dlx` is
    npx's true twin and is the WRONG tool here**: all 30 call sites were `npx
    wrangler`, wrangler is a pinned devDependency, and `dlx` would fetch from the
    registry and ignore the pin. Use `dlx` only for something genuinely not in
    `package.json`.

    **"all 30 call sites" was wrong, and EIGHT survived in `scripts/` until
    2026-08-12.** `check-checkpoints.mjs`, `deploy-promote.mjs`, `lens-webmcp.mjs`
    (x2), `perf-budget.mjs` (x2), `perf-snapshot.mjs` and `release-status.mjs` each
    spawned `execFile("npx", ["wrangler", …])`, which the original sweep missed
    because it read as a STRING ARGUMENT rather than a shell command, so no grep
    for `npx wrangler` as a phrase would find it. That is the same blind spot the
    `holding/` rename hit from the other direction: a path or command assembled
    from array elements is invisible to a search for the assembled form.

    The worst of the eight was `deploy-promote.mjs`, so **the wrangler that moved
    production traffic depended on how the ramp was invoked**: under `pnpm run` it
    got the pin, and from a tree with no `node_modules` it got whatever npx had
    cached (measured: 4.105.0 against a pinned 4.120.0). All eight are `pnpm exec`
    now and were each exercised afterwards, since a spawn failure here surfaces as
    a missing binary at the worst moment rather than at review.

    The general rule the sweep needed: grep for `"npx"` as a quoted token, not for
    `npx <binary>` as a phrase.

    **The sweep finished on 2026-08-14, and the last holdouts were the two
    Workers Builds dashboard commands.** This paragraph used to say all three
    `npx` strings would deliberately survive, on the reasoning that `npx
    wrangler` was measured resolving pnpm's `node_modules/.bin` so the swap
    bought nothing. That reasoning was incomplete: npx FETCHES what it cannot
    resolve locally, so a build image whose install left no linked wrangler
    would publish production with a registry download and say nothing, which is
    precisely what this gotcha's own sweep measured in `deploy-promote.mjs`
    (4.105.0 against a pinned 4.120.0). `pnpm exec` turns that silent
    wrong-version publish into a loud failure. Both commands are `pnpm exec
    wrangler versions upload` now.

    **The ORDER survives the migration and is the part to keep.** Those two
    strings in `infra.json`, plus the mirrored copies in `wrangler.jsonc` and
    `check-infra.mjs`, RECORD what is typed into the Cloudflare dashboard rather
    than commands this repo runs. `check-infra.mjs` compares them against the
    live values with an exact string match, and `validate` is a required check,
    so editing this file first fails on drift it invented itself and blocks its
    own merge. **Dashboard FIRST, strings second, every time.**

    **What a workstation cannot check here is whether the Workers Builds deploy
    shell can run the command at all**, since `pnpm exec` dry-running clean
    locally says nothing about that image. A branch build is the proof, which is
    why the Non-production branch deploy command is the right place to stage any
    future change to these two: it is the only trigger whose failure costs no
    release.

    **`lens-reader` needs `pnpm install --ignore-workspace`.** It deliberately
    stays out of the workspace (defuddle + linkedom are ~22 MB that only that
    Worker bundles), and under pnpm a bare `pnpm install` inside it walks UP to
    the root `pnpm-workspace.yaml`, installs the five workspace projects, and
    never creates `lens-reader/node_modules` at all. Its tests then die on
    `ERR_MODULE_NOT_FOUND` with a `node_modules missing` warning as the only
    clue. npm simply installed the local `package.json`, so this is a behaviour
    change rather than a misconfiguration, and any future standalone project
    inside this tree inherits it.

    One more, verified rather than assumed: `pnpm import` does not carry
    `overrides` into the lockfile, so the first `--frozen-lockfile` install after
    adding one fails with `ERR_PNPM_LOCKFILE_CONFIG_MISMATCH` until a single
    non-frozen install bakes it in. That is a one-time step and the error names
    the fix.

30. **pnpm 12 writes a lockfile pnpm 10 cannot read, and the SELF-SWITCH is the
    only thing between that and a broken release.** Measured 2026-08-10 against
    `12.0.0-rc.3`, kept as draft #309 rather than merged. The pin here is
    **11.21.0**.

    Everything in this repo works under 12: `--frozen-lockfile` installs clean,
    the contract suite is 206/206, typecheck exits 0, and the build is
    BYTE-IDENTICAL to the pnpm 11 baseline across all 1975 files. What fails is
    an older pnpm reading what it writes. pnpm 12 prepends a `---` YAML document
    separator, and **pnpm 10.11.1, the version the Workers Builds image runs**,
    refuses it outright:

    ```
    ERR_PNPM_BROKEN_LOCKFILE  The lockfile at ".../pnpm-lock.yaml" is broken:
    expected a single document in the stream, but found more
    ```

    `lockfileVersion` STAYS `'9.0'`, so this is the separator alone rather than a
    schema bump, and one upstream line could retire the entire objection.

    **This note first said production would still build, because pnpm reads
    `packageManager` before it opens the lockfile and self-switches to the
    pinned version. That was wrong, and the correction is the whole finding:
    THE SELF-SWITCH IS WHAT BREAKS.** Measured 2026-08-11 by running the build
    image's own path, pnpm 10.11.1 with self-switching left at its default ON:

    ```
    ERROR  Failed to switch pnpm to v12.0.0-rc.3. Looks like pnpm CLI is
    missing at ".../pnpm/12.0.0-rc.3/bin" or is incorrect
    spawnSync .../pnpm/12.0.0-rc.3/bin/pnpm ENOEXEC
    ```

    The file it tries to exec is a PLACEHOLDER: *"This is a placeholder. pnpm's
    native binary replaces this file during installation (see ./install.js)."*
    pnpm 12 ships its CLI as a per-platform native executable that a postinstall
    step swaps in, where pnpm 11's equivalent is an ordinary
    `#!/usr/bin/env node` script. So the older pnpm downloads the newer one,
    finds text with no shebang, and dies before it ever reads the lockfile.

    **The lockfile incompatibility above is therefore SECOND-ORDER.** It is real,
    and nothing reaches it. Fixing the `---` separator upstream would not make
    this work.

    **It is also gotcha 29's `allowBuilds` warning coming due.** That note records
    the key as pnpm 11 only, silently ignored by the pnpm 10 the build image
    runs, and ends by saying it stops being harmless the day something genuinely
    needs its build step. pnpm 12 is that day, and the something is pnpm itself.
    Two notes filed separately turn out to describe one failure.

    Scope of the claim, since the distinction matters. The ENOEXEC, the
    placeholder, and the pnpm 11 contrast are all measured locally. That Workers
    Builds hits the SAME thing is inference: its log needs dashboard access this
    environment does not have. What is measured about production is that two
    builds of the pnpm 12 branch failed while `validate` passed on both, and the
    second ran with rc.3 at 38h, which rules out the `minimumReleaseAge` floor
    that was the other candidate.

    The general rule outlives the instance, and it is wider than this note drew
    it at first: **check that the BUILD IMAGE can RUN the version you pin, and
    then that it can READ what that version writes.** Both are interchange
    surfaces between two machines on different versions, the handoff comes
    first, and "it installs here" tests neither of them. Pinning
    `packageManager` looks like it removes the version-skew problem and actually
    moves it one layer down, into whether the old binary can launch the new one.

    **What waiting costs is worth writing down, because it is not nothing.**
    Benchmarked on this repo 2026-08-10, four runs each, steady state (the
    minimum, since pnpm 11 spanned 5.9-14.0s while the others held within 0.3s):

    | | cold | warm | no-op |
    |---|--:|--:|--:|
    | pnpm 11.21.0 | 20.0s | **5.8s** | 1.09s |
    | pnpm 12.0.0-rc.3 | 18.2s | **2.0s** | 0.44s |
    | bun 1.4.0-canary | **9.1s** | **1.8s** | 0.14s |

    The warm install is the number that matters, since a populated store with a
    deleted `node_modules` is what a branch switch produces, and **pnpm 12 is
    about 2.9x faster there**, which puts it within noise of bun. That is a
    better argument for 12 than anything in its release notes, and it is an
    argument for going the day it ships rather than for going now.

    Two things that benchmark cannot tell you, both worth knowing before rerunning
    it. Bun is not doing the same job: it resolves from `package.json` and writes
    its own `bun.lock` instead of installing `pnpm-lock.yaml` (scope was checked
    and does match, same four workspace projects, 9 top-level dirs either way).
    And **disk figures are deliberately absent**, because `du` reported 479 MB
    against 356 MB and both are junk for the reason gotcha 29 already records:
    APFS clones the store, so per-file accounting double-counts. Measuring that
    honestly needs free-space deltas.

    Two smaller notes. pnpm 12 adds `packageManagerDependencies`, pinning the
    package manager itself with per-platform binaries and integrity hashes,
    which is a real improvement and is also what makes the lockfile
    self-referential. And this repo's own `minimumReleaseAge: 1440` BLOCKED the
    first fetch of rc.3 for being thirty minutes too young, which is gotcha 29's
    policy doing precisely its job.

    The 11.20.0 → 11.21.0 bump that accompanies this note changes no lockfile
    byte and no build byte, which is the contrast worth keeping: a patch bump
    inside a major is free here, and the major is not.

31. **A rule in `_headers` does not OVERRIDE a glob it sits above, it COMBINES
    with it, and for `Cache-Control` that ships a malformed header.** Cloudflare
    applies every matching rule and appends same-named values, so specificity
    and ordering buy nothing. Measured 2026-08-11 giving `/lwe/quadgrams.txt`
    (the 16 KB quadgram model the `/lwe/vigenere` cracker fetches) a longer
    browser cache than the `/lwe/*` pages it sits beside:

    ```
    /lwe/quadgrams.txt
      Cache-Control: public, max-age=604800, stale-while-revalidate=604800
    ```

    put this on the wire:

    ```
    Cache-Control: public, max-age=604800, stale-while-revalidate=604800,
                   public, max-age=0, s-maxage=86400, stale-while-revalidate=604800
    ```

    Two conflicting `max-age` values in one field, which RFC 9111 leaves
    ambiguous and implementations resolve however they like. Strictly worse than
    the single revalidation it was meant to save, so it was reverted and
    `_headers` now carries a comment where the rule was.

    **The failure is quiet in the direction that matters.** Nothing errors, the
    asset still serves, and a browser still caches it *somehow*. Checking with
    `curl -sI` is what shows it, and only if you read the whole line rather than
    grep for the directive you added.

    So a file under a glob has exactly two ways to get a different policy: move
    it out of the glob, or set the header in the worker. Adding a narrower rule
    is not one of them. Worth knowing before reaching for the obvious fix, since
    every other layered-config system in this repo (wrangler's routes, the CSP
    map, `run_worker_first`) does let the specific entry win, and this one reads
    exactly like it should too.

32. **`pnpm run pages:check` lints AUTHORED PAGE TEXT against the house voice,
    and it is a required check.** `pipelines/content/page-contract.mjs` bans em
    dashes, AI filler (`delve`, `leverage`, `utilize`, `robust`, `game-changer`,
    `cutting-edge`), dead transitions (`furthermore`, `additionally`, `moreover`,
    `moving forward`), and the "X, not Y" corrective negation. It fails the build
    by field path:

    ```
    www/lwe/vigenere.html.understanding.questions[5].options[2].why:
    contains not X, Y negation
    ```

    That is `validate` going red on prose, which reads like a bug in the linter
    the first time you see it and is not one.

    **Its reach is narrower than its authority, and that gap is the trap.** It
    walks the `understanding` (quiz) payload and the editorial fields, so a
    violation anywhere else on the page ships. Adding one demo to
    `/lwe/vigenere` on 2026-08-11 put **17** violations in the diff and CI could
    see exactly **1**: 13 em dashes (6 in visitor-facing strings, 7 in comments),
    3 negations, one curly apostrophe. Sixteen needed fixing, one em dash was a
    deliberate glyph (below). Fixing only the flagged line would have left 15 in
    a file whose own prose and comments contain zero of any of them.

    Note the negations, since they are the ones a regex under-counts: the linter
    caught 1 and the rule covers 3, because its pattern needs a comma AFTER the
    negated clause and "what runs out is the evidence, not the count of keys"
    ends the sentence instead. Read the rule, not just the pattern.

    So run the patterns over your own diff rather than waiting for the field
    path, because the linter is a floor and the file you are editing is the
    actual spec:

    ```bash
    git diff origin/main -- www/ | grep '^+' | grep -nE '—|[‘’“”]|\b(delve|leverage|utili[sz]e|robust)\b'
    ```

    Two exceptions are legitimate and already in the tree, both in
    `/lwe/vigenere`: `"—"` as the glyph for a missing value, which is how
    `st-ioc` has always rendered an unmeasurable IoC, and the box-drawing `─` in
    section-header comments, which is a different character the linter never
    matches. Keep them; the point is to know which of your dashes is which.

33. **A speculation rule cannot be measured from the page, and no agent browser
    here can measure it at all.** Two independent traps, each of which returns a
    confident zero for a rule that is working. Hit both on 2026-08-11 while
    deciding whether the eager `/garage/*` prefetch rule earned its place (#338).

    **Resource Timing never sees a speculation fetch.** The browser's preloading
    machinery issues it, not the document, so
    `performance.getEntriesByType("resource")` reports nothing on a page whose
    rule is firing perfectly. Measure at the ORIGIN instead: `pnpm run dev` logs
    every request, and a speculated one also carries `Sec-Purpose`, which is what
    `countSpeculativeLoad` (`_worker.js/speculation.js`) already counts in
    production.

    **Chrome gates speculation on visibility, and every agent-driven browser here
    backgrounds its tab.** Both the in-app Browser pane and Claude-in-Chrome
    reported `visibilityState: "hidden"` between tool calls; a screenshot flips a
    tab visible just long enough to photograph it and it reverts. So a hover that
    lands on a real anchor and dwells four seconds produces nothing, which reads
    exactly like a broken rule. `scripts/speculation-probe.mjs` exists because of
    this: it launches a real headful window through playwright-core, attaches no
    CDP session (gotcha 15), and prints a CONTROL line first.

    **Read the control before the result, every time.** The control hovers a link
    under the `moderate` rule; if that does not reach the origin, the run measured
    the instrument. That is what separated the real finding from the two false
    ones: with the control passing, the eager prefetch rule fetched zero documents
    when `/lwe` offered it 12 matching anchors AND when the Run palette injected
    30 more, so it was deleted rather than kept as a variant.

    Generalises past speculation: **a browser feature that the page cannot
    observe needs a server-side instrument and a positive control**, and "the
    agent's browser showed nothing" is not evidence until the control says the
    browser could have shown something.

34. **A linter's `--fix` is a code change nobody reviewed, and one of them was
    wrong here on the first run.** oxlint landed 2026-08-14 (`pnpm run lint`, a
    required step in `validate`). `oxlint --fix` rewrote 18 findings across 8
    files, and `unicorn/no-useless-spread` silently broke `webmention.js`:

    ```js
    // before, correct
    [...new Uint8Array(digest).slice(0, 12)].map((b) => b.toString(16).padStart(2, "0")).join("")
    // after --fix, wrong
    new Uint8Array(digest).slice(0, 12).map((b) => b.toString(16).padStart(2, "0")).join("")
    ```

    The spread was load-bearing. `TypedArray.prototype.map` returns a TYPED
    ARRAY, so every hex string it produced was coerced straight back to a
    number. Measured on a fixed digest, the id went from
    `deadbeef0102030405060708` to `000012345678`.

    **Nothing would have caught it.** It throws no error, no test covers
    `mentionId`, and a reviewer scanning a diff full of true one-line cleanups
    reads it as one more. The effect is a changed webmention id, which breaks
    dedup against the rows already in D1 rather than failing.

    The rule is off in `.oxlintrc.json` with that measurement written at it, and
    the general form is the part to keep: **an autofixer reasons about syntax and
    this codebase is full of typed arrays and crypto digests, where the syntax is
    identical and the semantics are not.** Read every hunk `--fix` produces, and
    prefer running it on `scripts/` before anything served.

35. **A cosmetic lint fix to a CONTENT-HASHED asset costs 1400 files, and a
    comment costs nothing.** The same 2026-08-14 run wanted two useless escapes
    out of `www/nav-run.js`. Correcting them moved `/a/nav-run.e943e545.js` to
    `/a/nav-run.b5389c82.js`, which re-minted every page referencing it, every
    per-page dictionary, `_headers`, and `shell-assets.js`.

    Measured by reverting that one file and rebuilding: the diff against the
    baseline collapsed from thousands of lines to exactly the 3 Worker modules
    that had actually been edited. So the rule is sharp and worth knowing before
    any sweep:

    | edited | rebuilds |
    |---|---|
    | `scripts/**` | nothing |
    | `www/_worker.js/**`, `cal/src/**`, `serendipity/` | that module alone |
    | an unhashed client asset (`www/lwe/ask.js`) | that asset alone |
    | a HASHED client asset (`nav`, `nav-run`, `tooltip`, `lens*`, `hoist`, `quiz`, `notepad`, `luna.css`, …) | itself, every page, every page dictionary, `_headers` |

    **A comment is free on all of them**, because oxc-minify strips it and the
    hash holds (verified: the hash stayed `e943e545` through a comment-only
    edit). So the three findings in hashed assets carry an
    `oxlint-disable-next-line` plus the reason, and they get fixed on the next
    change to those files that is worth a new URL. That keeps a tooling PR from
    forcing a dictionary roll as a side effect, which is the same
    byte-identical bar gotcha 28 set for the bun evaluation.

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
  or CI job. `git log --diff-filter=D -- codemode/` finds it.

  **THE BETA OPENED (checked 2026-08-05) and the answer is still no, for a
  different reason than before.** Code Mode is documented and shipping:
  `@cloudflare/codemode` swaps individual tool calls for one `code()` tool run in
  a Dynamic Worker Loader (isolates, <10ms start, no concurrency cap, ~$0.002 per
  load). The blocker that parked this is gone.

  What replaced it is a fit argument. Code Mode's win scales with CATALOG SIZE —
  it exists so a model can drive a large API without spending its context on
  forty schemas. `/terminal/ask` has SEVEN read-only tools, whose whole schema
  set is smaller than the prompt describing Code Mode, so the direct loop in
  ask.js is both cheaper and simpler. It also runs MODEL-AUTHORED CODE, which is
  sandboxed and defensible but is the opposite of the "bounded catalog, not a
  shell" stance ask.js is built on, and $0.002 a call is real money on a public
  endpoint that is trying to be near-free.

  Revisit if either premise changes: the catalog grows past ~20 tools, or the ask
  loop starts needing to CHAIN calls (its 4-call/2-round cap is exactly the
  symptom Code Mode cures).
