# Maintenance runbook

For future me. Every recurring chore on aadhar.sh, organized by "I want to ___",
with the exact command and the gotcha that bit me last time. Deep design notes
and the full conventions list live in [CLAUDE.md](CLAUDE.md); this is the ops sheet.

One site Worker, with three source islands:
- **public/** (aadhar.sh): the **Cloudflare Worker with static assets** (migrated off Pages 2026-06-30). Config is `wrangler.jsonc` at the repo root: it points `main` + `assets.directory` at `.build/public` and runs `build.ts` via its `build.command`, so `assets.run_worker_first` (an allowlist mirroring the `ROUTES`/`PREFIX` tables in `index.js`; static is the default) applies to the built tree; `workers_dev:false` (custom domain only). **Production deploy: merge to `main`; GitHub CI promotes the exact tested commit to the machine-owned `production` branch, then Cloudflare Workers Builds deploys it.** The config self-builds, so the Workers Build Deploy command ships the minified tree; local dev uses `wrangler.dev.jsonc` (readable `public/`, fast reload). A local `wrangler deploy` is fallback-only. Verify after every deploy with `node tools/verify-routes.ts https://aadhar.sh` (now also asserts `/nav.js` minified + `.src` twins resolve). All site bindings live in `wrangler.jsonc`; secrets via `wrangler versions secret put`.
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
bun install --frozen-lockfile
bun run --filter cal-aadhar-sh test
bun run build
bun run wrangler deploy --dry-run -c wrangler.jsonc
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
  but their intended values are now declared in [`infra.json`](../config/infra.json) and
  diffed by `bun run infra:check`. See "Infrastructure declaration" below.
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
Worker secrets. Use `bun run wrangler secret list -c wrangler.jsonc` to confirm the
secret is present without printing its value.

### Change the availability calendar (`ICAL_URL`)

Create a new Google Calendar **secret address in iCal format** (or the
equivalent read-only iCloud feed), then replace the secret:

```bash
bun run wrangler versions secret put -c wrangler.jsonc ICAL_URL
```

Paste the new feed URL when prompted. To make the new source take effect
immediately instead of waiting for the current `cal:busy` snapshot to age out,
delete only that derived snapshot and ask the live slots endpoint to refresh:

```bash
BOOKINGS_NS="37acb65118fe485583a90a94cb89365e"
bun run wrangler kv key delete --namespace-id="$BOOKINGS_NS" "cal:busy" --remote
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
bun run wrangler versions secret put -c wrangler.jsonc WORK_CALENDAR_URL
bun run wrangler versions secret put -c wrangler.jsonc WORK_CALENDAR_SLUG
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
openssl rand -hex 32 | bun run wrangler versions secret put -c wrangler.jsonc SIGNING_SECRET
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
configs, and runs `bun run --filter cal-aadhar-sh test`. The `cf-garage/` dry-run is the odd one out:
that project moved to wrangler's experimental TypeScript config on 2026-08-23,
so its step passes `--x-new-config` and passes no `-c` (the flag refuses
`--config` and reads the config from the working directory instead). Cal and Serendipity are bundled into the site
Worker; their source modules and Cal behavioral suite remain inside the
pull-request gate.

**`bun run infra:check` runs LAST in that job, and the order is deliberate.** It is
the only step asserting against live production rather than against the tree, so
its result depends on the deployed world instead of on the diff. Steps run
sequentially and stop at the first failure, so while it sat near the front a
production drift did not merely redden a PR, it SKIPPED all ten code gates behind
it and reported nothing about the change. That happened on 2026-07-31: a Workers
Cache regression on `/` put the edge out of sync with `infra.json`, and four
unrelated PRs went red with `Build homepage` through `Validate LWE ask Worker
config` all skipped, one of them belonging to someone with no way to know why.
Keep it last. A production incident should still be able to redden a PR; it should
not be able to hide whether the PR's own code is sound.

It stays FATAL, so drift cannot merge unnoticed. The consequence worth knowing: a
change whose purpose is to FIX production drift cannot turn its own check green
before it deploys, because the thing it asserts against is the thing it repairs.
Deploy that one with the local fallback (`bun run deploy:direct`), then re-run CI.

Dependabot (`.github/dependabot.yml`) keeps the Wrangler pin current: the npm
ecosystem entry at the repository root bumps the single exact root pin (and the
shared lockfile) via PR, alongside the cargo, pip, and github-actions
ecosystems. The exact lockfile pin keeps a release reproducible; the Dependabot
PR keeps it current. Wrangler's npm dependency metadata instrumentation is
explicitly enabled in every Worker config.

**CodeQL analyzes `actions` and `javascript-typescript` only, and since
2026-08-15 that list is a FILE.** It lives in
[`.github/workflows/codeql.yml`](../.github/workflows/codeql.yml) as the job
matrix, declared in [`infra.json`](../config/infra.json) under
`repository.code_scanning`, and `bun run infra:check` fails on drift between the
two. This paragraph used to say the list was a repo setting with no file in this
tree, which was true of default setup and is the exact thing the move retired.

To change what is scanned, edit the matrix and the declaration in one commit. The
checker reads the workflow's own `- language:` lines, so it needs no credential
and runs on every PR.

**The move bought a check that CI can actually make.** Default setup kept the
curation in dashboard state whose endpoint wants the repository `Administration`
read, which is not among the keys a workflow may grant its `GITHUB_TOKEN`
(`security-events: read` was tried in `ci.yml` on 2026-08-07 and measured to
change nothing, still HTTP 403, so it was removed rather than left looking
load-bearing). Re-enabling rust or python from the Security tab was therefore
invisible to every PR. Now it is a diff.

**One assertion stays workstation-only: that default setup is still OFF.** Both
scanners on would analyze every commit twice and file duplicate alerts, and the
dashboard is one click from it. That read wants the same `Administration`
permission, so CI reports one advisory naming the limit and never fails a PR. Run
it locally after touching anything in the Security tab, and note that being
logged in is not the bar, since the script reads the variable:

```bash
GITHUB_TOKEN=$(gh auth token) bun run infra:check
gh api repos/oddharsh/site/code-scanning/default-setup   # expect state not-configured
```

The workflow tier asserts three things, and two of them are ABSENCES: the matrix
equals the declared languages, every action is SHA-pinned, and the file sets
neither `queries:` nor a threat model, so CodeQL's own defaults (`default` suite,
`remote` model) are what hold. `threat_model` is asserted because the argument
below depends on it.

`rust` and `python` were dropped 2026-08-06. Between them they cost about 3 of the
scan's 4 minutes to analyze four files: `tools/photos/zenc/src/main.rs` and the
three `tools/photos/*.py` pipeline scripts. Every one of them is workstation and
CI build tooling that runs before a deploy and never answers a request, while the
configured threat model is `remote`. The Worker, which is the code an attacker can
actually reach, is JavaScript and stays covered.

Turn one back on the moment its language starts serving traffic. A Rust wasm module
inside the Worker, or a Python endpoint of any kind, moves that code from the build
side of the line to the served side, and this reasoning stops holding.

`.github/workflows/promote-production.yml` runs after a successful `CI` run for
`main` associated with a merged PR (or an explicit manual dispatch). It refuses
unmerged commits, then advances the machine-owned `production` branch to the
exact tested SHA. Cloudflare Workers Builds watches that branch and is the only
production publisher. Configure one Workers Build project for the site Worker
with `production` as the production branch and monorepo root `.`, leave its
dashboard Build command blank, and use
`bash .github/deploy-wrangler.sh versions upload --x-provision=false
--x-auto-create=false` as the Deploy command. That wrapper runs wrangler's entry file
under node, which is what lets one dashboard string serve both a pnpm tree and a
bun one: wrangler does not support bun, and the refusal is per-COMMAND, so a bun
invocation publishes fine and does no work at all on `check startup`. It used to
branch on the lockfile; that branch is gone. GitHub never holds a Cloudflare
token that can write, so it cannot publish to production even if the workflow
guard is defeated.

### Ramp a release (`bun run deploy:promote`)

Reaching `production` uploads a version. It does not move traffic. That is the
whole change: a merge now produces a fully built, fully uploaded Worker version
with its own preview URL, serving nobody, and a human decides how much of the
world sees it.

```bash
bun run deploy:promote                  # newest version, 10% -> 50% -> 100%
bun run deploy:promote --status      # what is serving right now
bun run deploy:promote --to 25       # one step, park it there
bun run deploy:promote --steps 5,100
bun run deploy:promote --rollback    # 100% back to the previous version
```

Between steps it runs two probes against `/whoareyou.json`, reading the **Serving
version** field out of each response. They answer different questions and neither
replaces the other:

| probe | requests | asks |
|---|--:|---|
| pinned | 12 | is the NEW version healthy? Each request carries `Cloudflare-Workers-Version-Overrides`, so all 12 are handled by the target. A non-200 here is conclusive and stops the ramp. |
| sampled | 40 | did the split actually take? Unpinned, one `Cloudflare-Workers-Version-Key` per request. Pinning bypasses the split by construction, so only this probe can see routing. |

The pinned probe is the one that catches a bad release. Before it existed, errors
were found only in whatever share of the 40 sampled requests happened to land on
the new code, which at a 10% step is about four: a fault in the version being
ramped had four requests looking for it. Cloudflare honours the override header
only for a version already in the current deployment, so the probe necessarily
runs after each step rather than before it.

Two failures stop the ramp: a non-200 from the pinned probe, and a step where not
one sampled request reached the target (the deploy did not land, and continuing
would ramp something untested). It sleeps 20s after each step before believing
anything, and it polls sequentially.

The per-request keys in the sampled probe are what let it work under version
affinity (below). Without them a sweep from one machine hashes to one version and
a healthy ramp reads as dead. If a step ever fails with "the ramp did not take"
while the pinned probe reported the version answering fine, that is the shape of
it, and the error says so.

**Read the logs at the hold points.** The script checks status codes and nothing
else. It cannot tell you the page is wrong, only that it answered. Filter Workers
Logs on `v` (the 8-char version prefix, in every structured line) and compare the
new version against the old one on latency and on the routes you touched. That is
the step the ramp exists to make possible; skipping it makes the ramp a slower
way to do what `bun run deploy:direct` already did.

`bun run deploy:direct` still goes straight to 100% and is the right tool for the
`infra:check` deadlock above, where the extra step is the liability.

### Version affinity (the Transform Rule)

**Not yet created.** It needs a zone write, which no script in this repo has: the
one write token is DNS-scoped and workstation-only. This is the recipe, and
`bun run infra:check` fails until the rule exists, because it is declared in
`config/infra.json` under `zone.version_affinity`.

**What it fixes.** Every document here references content-hashed shell assets
(`/a/luna.<hash8>.css`, `/a/nav.<hash8>.js`), the build keeps exactly one hash per
asset, and during a gradual deployment each request routes to a version
independently. So a document from one version asks for an asset the other version
has never heard of and gets a 404. `/a/*` is `run_worker_first` and is not in
`WORKERS_CACHEABLE_PATHS`, so nothing bridges the two. At the 10% canary step that
is roughly 90% of the new-HTML cohort plus 10% of the old-HTML cohort, per changed
asset, on any release touching `nav.js` or `luna.css`. Cloudflare's docs name this
exact case as what version affinity is for.

On the `aadhar.sh` zone, go to **Rules**, create a rule, and pick **Request
Header Transform Rule** from the type list (under "Transform requests or
responses"). The list also offers Redirect, URL Rewrite, Configuration, Origin,
Cache and Response Header rules; none of those can set a request header.

Then, in the two panes of the editor:

| pane | field | value |
|---|---|---|
| When incoming requests match | Expression (use the Expression Editor, not the visual builder) | `not any(http.request.headers.names[*] eq "cloudflare-workers-version-key")` |
| Then | Operation | Set dynamic |
| Then | Header name | `Cloudflare-Workers-Version-Key` |
| Then | Value | `ip.src` |

The visual builder has no field for "this header is absent", which is why the
expression goes in as raw text. Validate it in the dashboard's own editor before
saving; that editor is the only thing anywhere that checks this syntax.

**The expression guard is load-bearing.** A blanket `true` would overwrite the
per-request keys `deploy:promote` sends and collapse every sampled sweep onto one
version, which the ramp reads as a dead deploy. That fails closed rather than
shipping anything bad, and it aborts healthy releases until someone works out why,
so `check-infra.mjs` asserts the exemption and a contract test pins it against the
header the sampler actually sends.

`ip.src` rather than the cookie Cloudflare's docs prefer. A cookie means minting
one per visitor, which is a tracking-shaped change to a site whose `/whoareyou`
makes claims about what it does not collect, and a `Set-Cookie` on the HTML
response would take the page out of shared caches.

Verify it after the next ramp reaches a split:

```bash
curl -s https://aadhar.sh/whoareyou.json -H 'Cloudflare-Workers-Version-Key: probe-1' | jq -r '.groups[]|select(.title=="Server").fields[]|select(.k=="Serving version").v'
```

Same key twice must report the same version; different keys should spread across
both. `bun run infra:check` reads the rule itself, and needs a token carrying
`Zone:Transform Rules:Read` and `Zone:Zone:Read`. Neither is among CI's six
account reads, so in CI that section always degrades to a note and the assertion
is a workstation run, the same standing as `repository.code_scanning`.

### Preview URLs

`preview_urls: true` in `wrangler.jsonc`, with `workers_dev: false` kept.
Production has no workers.dev address; each uploaded VERSION does, at
`<version-prefix>-aadhar-sh.<subdomain>.workers.dev`. Wrangler prints it on
upload, and `--preview-alias` gives a version a stable name instead of a prefix.

The setting is explicit because `preview_urls` defaults to whatever
`workers_dev` is. Deleting the line silently turns every preview back off, which
is exactly what had been happening: every version this repo ever uploaded was
unservable and nothing said so.

**A preview runs production bindings and secrets.** There is no per-version
override in Cloudflare, so it is the same RN_KV, the same `aadhar-photos`
bucket, the same three D1 databases, the same `RESEND_API_KEY`.
`src/worker/lib/preview.ts` is what makes the URL safe to paste into a
PR:

- every response gets `X-Robots-Tag: noindex, nofollow`, including redirects and
  images, which the security wrapper otherwise skips
- unsafe methods are refused by default, so a POST route added next month is
  guarded the day it is written and nobody has to remember
- the GET-shaped writes are named individually, because the method rule cannot
  see them: `/hit`, `/approve`, `/decline`, `/webmention/approve`,
  `/webmention/decline`, `/ledger/prefetch`
- `/mcp` is the one POST exception (read-only JSON-RPC over an allowlist)
- reads all pass, `/lens/*` included

Three contract tests cover it. If you ever need previews without the guard, the
answer is Cloudflare Access on the hostname, not deleting the guard.

### Local dev and the route oracle against production data

```bash
bun run dev:remote            # wrangler dev, KV/R2/Browser bindings remote
bun run routes:check:remote   # the oracle, with those bindings
```

Both derive a config with `tools/gen-remote-config.ts` and never commit it
(`.wrangler.remote.jsonc`, gitignored). Your Worker code still runs locally; the
binding calls hop to the real resource.

`routes:check:remote` un-skips the six rows `verify-routes.mjs` marks `remote`
(`/lens/fetch`, `/lens/shot`, `/around/json`, `/photos`, `/images/full/<key>`),
whose assertions depend on content a local Worker structurally cannot have.
Plain `bun run routes:check` stays the CI gate and stays honest about what it
skips.

Three things the generator does on purpose:

- **D1 stays local** unless you pass `--d1`. Nothing in the remote rows needs it,
  and the D1 bindings are the write-heaviest on the Worker: `SERENDIPITY_DB`
  takes the Luma sync, `SOCIAL_DB` takes moderated third-party webmentions,
  `RESTORE_DB` is the append-only deploy log both `/restore` and `/updates` read.
- **Crons are stripped.** A local tick must not fire the real `/around` crawl or
  the Luma sync into the production KV it is now holding.
- **It refuses to run in CI.** Remote bindings stand up a proxy Worker in the
  account, which needs a token that can write. CI holds a read-only one and
  keeps holding only that.

### Infrastructure declaration

`wrangler.jsonc` declares the compute layer and CI dry-runs it, so a bad route
or a missing binding already fails a PR. [`infra.json`](../config/infra.json) covers the
layer above that: DNS records, the account resources the bindings point at, the
Worker inventory, and the Workers Build settings. `bun run infra:check` diffs
the declaration against reality. It is read-only by design and has no apply
path; editing `infra.json` changes what the check demands of production, never
production itself.

Three tiers, by what they cost to run:

| tier | needs | covers |
|---|---|---|
| tree | nothing | binding names agree with `wrangler.jsonc`; every `consumer` file exists; the release block agrees with the Worker config |
| dns | network | every declared record, via DoH against two independent resolvers, plus the nameservers and the DNSSEC `DS` |
| edge | network | zone settings that are load-bearing for something this repo does, read as observed production responses |
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
Scope the token to reads only: Account Settings:Read, Workers Scripts:Read,
Workers KV Storage:Read, Workers R2 Storage:Read, D1:Read, **Workers Builds Configuration:Read**.
Nothing in this repo may hold an `Edit` scope, because Workers Builds being the
only publisher is the release backstop.

```bash
gh secret set CLOUDFLARE_API_TOKEN --repo oddharsh/site
```

**The permission is called `Workers Builds Configuration` in the token form, not
`Workers CI`.** Cloudflare's own permissions reference lists it as "Workers CI"
and the Builds API docs call it "Workers Builds Configuration"; the dashboard
agrees with the API docs, and the dashboard is where you actually click. Typing
"Workers CI" into the permission search returns Workers Scripts, Workers Agents
Configuration, and Workers Builds Configuration, and none of them is named what
you searched for. Verified at the form 2026-08-04.

`Workers Builds Configuration:Read` joined the list on 2026-08-04, when the release block stopped
being a manual review item. It lets `infra:check` read the live Workers Builds
triggers and fail on drift in the Deploy command, Build command, or root
directory — the one part of the release path that lives outside this repo and
could previously be changed with nothing noticing. It is the read half of the
permission whose Edit half changes those fields, so it detects drift and cannot
cause it. Until you add it, that section degrades to a note naming the missing
scope and the values fall back to intent.

#### Roll it out in this order, or you rebuild the deadlock

The `infra:check` promotion deadlock described above is not a one-off; it is what
happens whenever a check asserts against production state that a merge has not
reached yet. Turning on this verification is exactly that shape, so the sequence
matters:

1. **Merge the change** that declares `versions upload` in `infra.json`, with the
   CI token still on its old scopes. The new section degrades to a note, nothing
   fails, and the merge deploys normally under the current dashboard command.
2. **Flip the dashboard**: Workers Builds → the site Worker → Settings → Build →
   Deploy command → `bash .github/deploy-wrangler.sh versions upload
   --x-provision=false --x-auto-create=false`, the string declared in
   `infra.json` and exact-matched by `check-infra.mjs`. Leave Build command
   blank and the non-production command alone (it already uploads).
3. **Then** rotate `CLOUDFLARE_API_TOKEN` to add `Workers Builds Configuration:Read`.

Backwards — scope first, dashboard second — and `infra:check` starts failing on a
drift that only the dashboard can fix, on every branch, while promotion is gated
on that same check. The way out would again be the local `bun run deploy:direct`
fallback, which is a silly thing to need over a settings form.

Each resource class is queried independently, so a token missing one scope
degrades only that section and the advisory names the scope to add. Cloudflare
returns error 10000 for both "bad token" and "token lacks this scope", so the
message says which permission the failing section wanted.

### The compression rule (brotli ahead of zstd)

**Owner-run, once, by hand.** `infra:apply` is scoped to DNS and cannot create a
Rules entry, and nothing in this repo may hold an `Edit` scope. So this is a
dashboard or personal-token action; `infra.json`'s `compression-prefers-brotli`
check is what keeps it honest afterwards.

**It fixes two things.** One is a preference, the other is a hole.

*Preference.* Cloudflare's default is zstd, and Chrome and Edge both advertise
zstd, so most visitors get it. Its on-the-fly zstd is *worse* than its own
on-the-fly brotli on this content. Measured 2026-07-28 against
`/images/manifest.json`, whose 35,162-byte body is identical on every request
(the homepage's is not — a random 12-photo grid swings the size ~1.4KB per
render, wider than the effect being measured):

| encoding | bytes | vs brotli |
|---|---|---|
| br | 6,642 | — |
| zstd | 6,847 | +205 (+3.1%) |
| gzip | 7,159 | +517 |

*Hole.* Cloudflare's default content-type list carries `text/x-markdown`, the
pre-RFC name, and **not** `text/markdown`, the RFC 7763 type this site correctly
serves. So every Markdown surface shipped uncompressed — `/index.md`, `/auth.md`,
`/whoareyou.md`, `/bot.md`, and the `src/content/md/` twins. 12,302 bytes that brotli
takes to 5,943, a 52% loss on exactly the surfaces built for agents and LLM
crawlers, which prefer the `.md` representation. Serving `text/x-markdown` to win
compression is the wrong fix: that is a deprecated type, and agents expect the
registered one.

**The rule is scoped by PREFIX, not by an enumerated list**, because the markdown
hole is what an enumerated list costs. `text/*` covers html, plain, css, xml,
markdown, and anything text-shaped added later; `application/*` covers json,
javascript, wasm, ld+json, manifest+json; `image/svg+xml` is the one image type
worth compressing. Everything binary is excluded by construction rather than by
omission:

```
starts_with(http.response.content_type.media_type, "text/")
or starts_with(http.response.content_type.media_type, "application/")
or http.response.content_type.media_type == "image/svg+xml"
```

**What this does to the dcz deltas: nothing, but verify it rather than assume it.**
`dcz` is not `zstd` — they are different `Content-Encoding` values, and the rule's
algorithm list governs only what the EDGE compresses. Delta responses arrive from
the Worker already encoded (`encodeBody: "manual"`), and shared-dictionaries
passthrough is explicit that Cloudflare "treats `dcb` and `dcz` as valid
Content-Encoding values end to end, without recompressing them." Dropping zstd
from the candidate list does not drop dcz.

The residual risk is that the expression above *does* match those paths by content
type: `/a/nav.<hash>.js` is `text/javascript` and `/a/luna.<hash>.css` is
`text/css`, both already carrying `content-encoding: br` or `dcz` from the Worker.
Cloudflare's compression-rules docs do not state what a rule does to a response
that is already encoded. Standard CDN behaviour is to pass it through, and the
passthrough guarantee above covers the dangerous half — but double compression is
precisely the bug gotcha 13 records, it survived three wrong suspects, and on the
render-blocking shell it fails as a white screen rather than a slow page. So
`bun run dcz:check` after deploying the rule is a gate, not a formality.

A path exclusion (`and not starts_with(http.request.uri.path, "/a/")`) is
available as belt-and-braces and costs nothing, since those bytes are already
brotli q11 and CF could only make them worse. It does NOT generalize to the static
pages: `/garage/*` and `/lwe/*` serve dcz when a dictionary is offered and are
compressed by Cloudflare when one is not, so no path predicate separates the two
cases. Verification is what covers those either way.

**Do not use "All incoming requests"**, tempting as it is for the same
list-rot reason. This site is unusually binary-heavy: ~3GB of R2 originals served
from `/images/full/*` at ~26MB each **with Range support** (206, `content-range`,
`accept-ranges: bytes`), plus 474 already-compressed thumbnail files under `/i/`.
Ranges and compression are in tension — a byte range into a compressed body does
not map to a range in the original — so an edge told to compress those has to
either drop `Accept-Ranges` or skip the work, and Cloudflare's documentation
states neither. Compressing JPEG/AVIF/PNG also buys nothing; they are already
entropy-coded. The prefix expression sidesteps all of it.

**Dashboard: Rules → Overview → Create rule → Compression Rule.**

| field | pick |
|---|---|
| If incoming requests match | **Custom filter expression**, pasting the expression above |
| Compression options | **Enable Brotli and Gzip Compression** |

That preset reads "Brotli is the preferred compression algorithm. It will
automatically fall back to Gzip," which is the intent exactly, so Custom ordering
would be a hand-rolled copy of a built-in. It drops zstd from the candidate list
rather than ranking it below brotli, which is deliberate: every browser that
speaks zstd also speaks gzip, so nothing loses compression, and an omission
re-reads later as a decision where a subtle ordering would not. If Cloudflare's
zstd ever overtakes their brotli here, this is the switch to flip back.

By API:

```bash
curl "https://api.cloudflare.com/client/v4/zones/$ZONE_ID/rulesets/phases/http_response_compression/entrypoint" \
  --request PUT \
  --header "Authorization: Bearer $CF_RULES_TOKEN" \
  --json '{
    "rules": [
      {
        "expression": "starts_with(http.response.content_type.media_type, \"text/\") or starts_with(http.response.content_type.media_type, \"application/\") or http.response.content_type.media_type == \"image/svg+xml\"",
        "action": "compress_response",
        "description": "brotli over zstd (+3.1% here) and text/markdown, which CF default types miss — see infra.json",
        "action_parameters": {
          "algorithms": [
            { "name": "brotli" },
            { "name": "gzip" }
          ]
        }
      }
    ]
  }'
```

Verify in this order. The first two are the point of the change; the rest are the
regression check, because a compression change on a render-blocking path fails as
a white screen rather than as a slow page (gotcha 13 in CLAUDE.md):

```bash
bun run infra:check     # compression-prefers-brotli AND markdown-compressed must pass
bun run dcz:check       # deltas must still come back dcz, not recompressed
# the precompressed shell must be untouched, and the range-served originals must keep their ranges:
curl -sS -o /dev/null -D - -H 'accept-encoding: gzip, deflate, br, zstd' https://aadhar.sh/a/luna.0f8b829a.css | grep -i content-encoding
curl -sS -o /dev/null -D - -H 'range: bytes=0-99' https://aadhar.sh/images/full/XT509488.jpg | grep -iE "^HTTP|content-range|accept-ranges"
```

`infra:check` fails until the rule exists, by design: `infra.json` declares intent
and the checker reports reality, so a declared-but-absent rule is drift like any
other. Expect CI red on the PR that adds the declaration until the rule is live.

### Rebuilding the zone

`bun run infra:apply` is the write path, and the only thing in this repo that
can mutate Cloudflare. It prints a plan and stops; `--confirm` applies it.

```bash
bun run infra:apply                # plan; needs no credential at all
bun run infra:apply --confirm   # apply; needs CLOUDFLARE_API_TOKEN_WRITE
bun run infra:apply --prune     # also remove undeclared values on declared names
```

The plan diffs `infra.json` against public DNS over DoH, so producing one costs
nothing and reveals nothing. Only the write needs a token, and it reads a
**different environment variable** (`CLOUDFLARE_API_TOKEN_WRITE`) from the
read-only `CLOUDFLARE_API_TOKEN` the check uses. Two names means the write token
can never be picked up by the check path by accident, and CI's read-only token
can never satisfy the write path.

**It refuses to run in CI.** Production is unreachable from GitHub on purpose:
Workers Builds is the only publisher, and CI holds a read-only token so it
cannot become a second one. A write token in Actions would dissolve that, so the
script exits 1 the moment it sees `CI`.

**Deleting a record means emptying its `expect`, not deleting its entry.**
Removing the block from `infra.json` makes the record undeclared, and `--prune`
only ever touches declared names, so the record becomes invisible rather than
removed. To actually delete one, keep the entry and set `"expect": []`, run
`--prune --confirm`, then remove the entry once the record is gone.

**Scope is DNS records whose `match` is `exact`, and nothing else.** That is the
exact set where `infra.json` knows the whole desired value, so it is the only set
recreatable from this file without inventing something. The plan lists what it
will not fix, and who owns it instead: Resend owns the DKIM key, Cloudflare
creates the proxied apex with the Worker custom domain, wrangler creates KV/R2/D1,
and Workers Builds deploys the Worker. Creates and updates happen by default;
deleting needs `--prune`, because an undeclared record is more often a
third-party verification TXT than junk.

**Full rebuild order**, if the zone is ever gone. Each step feeds the next:

1. Point the registrar at the nameservers in `infra.json` (`zone.nameservers`),
   then republish the DS record so `zone.dnssec.ds` matches again.
2. Create the storage with wrangler (`kv namespace create`, `r2 bucket create`,
   `d1 create`, `vectorize create`). Each mints a NEW id; paste them into
   `wrangler.jsonc`, which stays the only place ids live.
3. Ship the Worker through the normal path (merge to `main`, CI promotes to
   `production`, Workers Builds deploys). This is what creates the proxied
   `aadhar.sh`, `www` and `cal` records, so do not hand-author them.
4. `bun run infra:apply --confirm` for the mail and agent-discovery records:
   MX, SPF, DMARC, BIMI, SVCB. Nothing else rebuilds these, which is exactly why
   this path exists.
5. Re-verify the domain in Resend to reissue the DKIM key.
6. `bun run infra:check` should come back green.

**The edge tier.** Cloudflare exposes dozens of zone toggles and almost all of
them are defaults nobody here has an opinion about. The five in `infra.json`'s
`edge` block are the ones with a real consequence for something this repo does,
and three of the five are must-stay-OFF, which is the category that rots
quietest: enabling a helpful-sounding feature never looks like a regression at
the time.

- **Polish off.** It would re-encode images at the edge and silently discard the
  whole encoder toolchain (zenc, 10-bit AVIF, the q84 tuning, the benchmark
  behind those choices). The site would look fine and the craft would be gone.
- **Rocket Loader off.** It rewrites script loading, over the top of the
  hand-tuned inline-loader and `defer` order in `index.html`.
- **HTTP/3 on**, because the DNS-AID SVCB record advertises `alpn=h2,h3`. Turn
  it off and DNS promises a protocol the edge cannot speak, while the DNS tier
  stays green because the record itself never changed.
- **Compression on**, because the performance budget is denominated in
  compressed bytes and `perf-budget.mjs` compresses locally, so it would keep
  passing while real visitors stopped getting compressed responses.
- **HSTS** exact-matched like SPF and DMARC, because it is hand-chosen policy.
  Raising `max-age` is fine and should update the declaration.

They are checked as observed responses, not dashboard toggles. That needs no
credential, so the tier runs on every PR, and it asserts the thing that actually
matters: a toggle can read `on` while a cache rule overrides it for one path.

**This tier tests production, not the branch.** A failure here is not caused by
the PR that surfaced it, so its findings are prefixed `production edge:`. If one
fires on an unrelated PR, fix the zone rather than the branch.

**Known blind spot.** Cloudflare publishes no REST endpoint for Workers Builds
project configuration, so the `release` block in `infra.json` is recorded but
unverifiable, and the checker says so on every run. It matters more than most of
what is checked: a non-empty dashboard Build command builds twice, and a command
that runs anything other than `build.ts` is how production once served an
unminified 78KB `nav.js`. Review it by eye when you touch build settings.

### Performance budget semantics

`bun run perf-budget` is intentionally split into hard build invariants and
advisory wire-size observations. Hard failures cover CSS validity, deploy-time
minification markers, readable source twins, and missing expected assets. The
client asset envelopes are measured in gzip and Brotli, not raw authoring bytes;
they are role-aware and deliberately have room for ordinary feature work. The
Worker gzip number is a growth alert, not a user-experience ceiling: Worker code
is server-side, so it must earn a hard limit through measured TTFB or CPU impact.

**That CPU impact is measured on EVERY RUN now, rather than by hand when someone
remembers.** `wrangler check startup` (available 2026-07-30, no credential
needed) profiles the Worker's initialization and reports active startup CPU;
perf-budget runs it on the prebuilt bundle the dry-run already produced, so it
adds no second build. Reading on 2026-08-04: **~8 ms active against a 400 ms
platform limit**.

Read it for what it is. The baseline comment in `perf-budget.mjs` already
established by hand that bundle bytes are two orders of magnitude away from being
a latency problem, and its caveat still holds: `check startup` ranks frames but
does not cost them, and it profiles a local machine whose CPU is not
Cloudflare's. So this is a DIAGNOSTIC, and a breach means "go re-measure", never
"cold start regressed".

It stays advisory, and the reason is the instrument. The profile window is about
20 ms and lands roughly 5 samples, so consecutive runs differ with nothing
changed: 9.6, 7.6, 6.4 across three runs, then 16.4 on a fourth (2026-08-08), a
2.6x spread on bytes nobody had touched. A sampled profile at that resolution has
no business failing a PR, so the ceiling is 50 ms: six times the observed value
and still an order of magnitude under the limit. When it fires, the cpuprofile is
at `.build/.perfbudget/worker-startup.cpuprofile` and opens in Chrome DevTools as
a flamegraph.

**It is not the regression tripwire, and it used to be described as one here.**
That job belongs to the deterministic numbers: the bundle gzip, the per-module
attribution, and the wire-size diff below. Diffing two draws from a 2.6x-spread
distribution manufactures findings, which is why `perf-snapshot.mjs` records
neither this reading nor anything else sampled.

This also closes out an older open question. The standing conclusion that cold
start here is not eval-bound came from a 2026-07-28 experiment where lazy route
imports bought nothing but +27 KB of wrappers, which was an argument from bundle
structure. The startup profile measures it directly and agrees.

The bundle baseline itself lives in `perf-budget.mjs` with its full history (86 →
129.23 → 204.24 KiB gzip) and the argument for each move. Read that comment
before treating a breach as a regression; two of the three moves were legitimate
growth, and it also records why the dry-run number and the `check startup` number
are not interchangeable.

That growth alert now names its cause. The dry-run passes `--metafile`, so
esbuild writes per-input byte attribution to `.build/.perfbudget/bundle-meta.json`
and the script reads it back. A green run prints one line (module count plus the
largest single module); a run over the advisory threshold prints the top 5 with
sizes, so "the bundle grew" arrives with the modules that grew it instead of a
number to bisect by hand.

### The wire-size diff (the differential half)

Everything above is ABSOLUTE: a number against a constant somebody typed. That
constant rots, and the baseline history in `perf-budget.mjs` is the receipt — 86
→ 129.23 → 204.24 KiB, with the 129.23 era spent permanently in breach while CI
printed "hard checks green" over it. The 204.24 baseline set on 2026-08-04 was
itself already firing by 2026-08-08 (258.34 KiB observed at `295ee97`).

`tools/perf-snapshot.ts` is the other half, and it has no constants to rot:

```bash
bun run perf:snapshot record base.json --label main   # self-builds via the dry-run
bun run perf:snapshot record head.json --label mine
bun run perf:snapshot compare base.json head.json     # markdown to stdout
```

`.github/workflows/perf-diff.yml` runs that on every PR touching served code: it
builds the merge base, builds HEAD, measures BOTH WITH HEAD'S COPY of the script
(stashed in `$RUNNER_TEMP` before the first `git switch`, since the base does not
have it and measuring each side with its own copy would report a change to the
measurement as a change in wire size), and posts the delta as a marker-updated PR
comment. It is deliberately **not** part of `validate`: `validate` is the one
required check on `main`, so anything living there is a merge gate, and a perf
number that blocks a merge teaches people to widen thresholds. This one fails on
nothing.

Two design notes worth knowing before editing it. **Everything measured is
deterministic**, so an unchanged file produces no row and a tooling-only PR
produces a diff that says "No change" four times; that silence is the feature,
because a report that always has content stops being read. And the **noise floor
is asymmetric**: pages get a 128-byte floor, client assets get none. A page
carries `/a/<name>.<hash8>.<ext>` references, so touching one shared asset flips
its hash and moves every page's compressed size by a few bytes (measured: a
one-line `nav.js` edit moved 38 of 46 pages, max 41 bytes, net -0.03 KiB); an
asset's bytes are its own content, so nothing but editing it can move them and
every byte is signal. One floor everywhere would have hidden the 50-byte `nav.js`
change that produced the churn. Sub-floor movers are collapsed into a counted
aggregate line, never dropped, and they stay in the totals.

The shape is lifted from `astral-sh/ruff`'s `memory_report.yaml` and its ecosystem
job: build the merge base, build HEAD, run both, post the difference, gate on
nothing.

### The trend (`/garage/dyno`, and the `perf-history` branch)

The diff catches the STEP one PR makes. It structurally cannot see DRIFT, and
drift is the failure this repo actually had: 86 → 129.23 → 204.24 → 258.34 →
261.74 KiB gzip, every number found by somebody tripping over a stale constant
because nothing drew the slope.

`.github/workflows/perf-history.yml` runs at 09:00 UTC, skips when nothing was
committed in 25 hours, records a snapshot of `main`, reduces it to one JSONL line
(`perf-snapshot.mjs row`, ~430 bytes), and appends it to **`perf-history`**, an
orphan branch holding `history.jsonl` and a README. `/garage/dyno` renders it, SWR-cached
in KV for 6h.

**Why a branch and not D1 or a commit to `main`.** `main`'s ruleset has zero
bypass actors, so no workflow can push there. D1 writes need a Cloudflare Edit
token, and the only one that exists is environment-gated behind a required
reviewer for the ramp. A branch outside both rulesets is the one write target a
nightly job can reach without weakening something load-bearing. The job's
`contents: write` is a GitHub token scoped to that job and reaches only that
branch, so the standing rule about no Cloudflare write token in CI is untouched.

`perf-history` is MACHINE-OWNED, like `production`. Do not hand-edit it. The
append is idempotent by date (a re-run replaces its own row rather than adding a
second point for one day) and the workflow's concurrency group is `perf-history`
with `cancel-in-progress: false`, because an append is a read-modify-write over a
file with no locking and two writers would silently drop a row.

Three things about the page, all about honesty rather than looks:

- **The chart is server-rendered SVG with zero client JS.** Served pages here
  carry no cross-origin assets and inline scripts need per-document CSP hashes,
  so a chart that draws itself on the server costs one `<svg>` and no exceptions.
  Point tooltips are native `<title>` elements.
- **Hand-entered history is drawn dashed.** `src/worker/dyno-seed.json`
  carries the four points from `perf-budget.mjs`'s baseline comment so the page
  is useful before the series fills up. They live in the repo rather than seeded
  into the branch so every hand-entered number goes through PR review, and they
  render differently from measured ones because a number somebody typed into a
  code comment and a number a runner measured last night are not the same kind of
  fact. A contract test pins that distinction.
- **The x-axis is time-proportional, not index-proportional.** The nightly job
  skips days with no commits, so evenly spacing the points would draw a steady
  cadence the data does not have. A gap in the series is a gap in the chart.

If the fetch fails, `/garage/dyno` degrades to the seeded points and still renders; the
route oracle asserts exactly that, since the local harness has no KV and cannot
reach GitHub. The `swrKV` guard is `isValid: rows.length > 0`, so a GitHub outage
can never overwrite a good cached history with nothing.

**One trap worth knowing before editing the chart CSS.** A bare
`.chart .s-worker { stroke; fill }` outranks `.chart polyline { fill: none }` on
specificity, so every series fills down to the axis and the chart renders as three
coloured blobs. It looks like a data bug and is a cascade bug. Every series rule
is element-qualified (`polyline.s-worker`, `circle.s-worker`) for that reason, and
a contract test fails if one goes back to being unqualified.

Backfill or force a run with `workflow_dispatch`; it takes an optional `date` to
place the row. Raw series at `/garage/dyno.json`.

Browser RUM is deliberately off. No page loads Cloudflare Web Analytics, the Worker
has no `/ledger/rum*` proxy or collector, and `build.ts` tripwire #7b hard-fails if
any of that runtime wiring returns. That removes client-side field collection: this
site does not currently observe real-user LCP, INP, CLS, FCP, or Navigation Type.

Use a controlled mobile/4G browser run for repeatable performance checks, and keep
the per-PR wire-size diff plus nightly trend as regression signals. Do not turn an
advisory asset envelope into a CI failure or claim a route/cohort SLO without a new,
explicitly approved field-measurement source.

The Workers Build project should expose its build/deploy status on the release
commit. After enabling it, verify the live homepage route surface plus
`/coffee`, `/coffee/slots`, and `/serendipity`. GitHub-side branch protection is
live as of 2026-08-05: the repo is public, so repository rulesets cost nothing,
and `main` and `production` each carry an active one with zero bypass actors.
`validate` is a REQUIRED check on `main`, which is why a PR can sit at
`mergeStateStatus: BLOCKED` purely because CI is red. The rulesets are declared
in [`infra.json`](../config/infra.json) under `repository` and `bun run infra:check` fails
on drift; CLAUDE.md carries the argument for each rule.

The promotion workflow guard is still the release backstop, and the ruleset does
not replace it. `production` restricts deletion and non-fast-forward alone, so it
governs how that ref may MOVE and not who may move it. What keeps a non-CI commit
off `production` is `promote-production.yml` checking that the commit is still
current `main` and belongs to a merged PR.

Before merging the first revision that uses this path, change each Workers
Build project's production branch from `main` to `production`. Otherwise the
merge push can still trigger the old direct production build.

## Re-run the user-agent survey (`/garage/useragent`)

```bash
bun run ua:survey > /tmp/ua.json          # 16 identities x 11 targets x 3 trials
TRIALS=1 bun run ua:survey nytimes        # one target, one pass
```

It writes a JSON report to stdout and a per-request progress log to stderr. To
publish a new run, refresh `src/data/ua-survey.json`, then re-embed the compact
copy in `pipelines/garage/specs/useragent.json` under `pageJs` and regenerate:

```bash
node pipelines/garage/generate.mjs page useragent && bun run gen:shell
```

**Read the control rows before reading anything else.** Every target carries a
`verdict` of `measurable` or `unmeasurable`, decided by whether ANY control
identity (Chrome, curl, our own honest string) got a readable response. An
`unmeasurable` row means the origin refused the instrument, so its crawler
columns say nothing about user-agent policy and must not be quoted as though
they did. On the 2026-08-21 run that disqualified `medium.com`, `quora.com`,
`stackoverflow.com` and `reddit.com`.

**Expect the sample to shrink as you re-run it.** `linkedin.com` served Chrome
about 11,800 words early on and was answering `999` to all sixteen identities by
the third pass, from the same address. A survey that keeps sampling a defended
origin trains that origin to refuse it, so widen `TARGETS` rather than
re-hammering one host, and treat a target that went quiet as spent rather than as
having changed policy.

**A 200 is not access.** `reddit.com` answers 200 with one word to every
identity including browsers, so the harness scores that as `shell` rather than
`ok`. Anything under `SHELL_WORDS` (50) is a frame instead of a document.

The same control reasoning governs `/lens`'s Bot views table, which shares the
roster shape; see the `/lens` bot views section in CLAUDE.md.

## Understanding-first review

Every pull request uses the author claim card in
`.github/pull_request_template.md`. The canonical practice is documented in
[UNDERSTANDING-REVIEW.md](UNDERSTANDING-REVIEW.md): reconstruct the model, name
a falsifier, inspect evidence, and leave residual uncertainty visible. It is
advisory; it is not a prose-quality or AI-scoring gate.

There is no reviewer-prompt bot anymore. A workflow posted the same comment on
every PR until 2026-08-06; the reasoning for removing it is in that document
under "What the automation does, and why it stopped".

## Author a new LWE or Garage explainer

The page generators carry the current editorial contract forward. LWE authors
write `pipelines/lwe/specs/<id>.json`; Garage authors write
`pipelines/garage/specs/<id>.json` and register the page in
`pipelines/garage/pages.json`. Both specs require a reader/problem/thesis/
evidence/uncertainty card and a three-to-seven-question understanding check.

```bash
node pipelines/lwe/generate.mjs page <id>
node pipelines/lwe/generate.mjs wire
node pipelines/garage/generate.mjs page <id>
node pipelines/garage/generate.mjs wire
bun run pages:check
bun run og-cards   # bake the page's OG/Twitter card once it's live (see below)
```

The shared contract lives in
[`pipelines/content/page-contract.mjs`](pipelines/content/page-contract.mjs).
It emits the shared quiz payload and runtime, checks the LRS/style guardrails,
and keeps the understanding check diagnostic rather than a gate. Read the
[LWE authoring guide](pipelines/lwe/README.md) and
[Garage authoring guide](pipelines/garage/README.md) before starting a page.

Key facts (don't hardcode these elsewhere, they drift):
- RN_KV namespace id: `3cb8a107c58e47dc9244e75b33401f36`
- R2 bucket: `aadhar-photos` (SOOC originals + full-res JPGs)
- Thumbnails are content-addressed at `/i/<stem>.<hash8>.<ext>` (hashes.json via `hash-thumbnails.sh`); `THUMB_VERSION` is gone entirely (retired with the last legacy fallback — `lib/const.js` keeps only `CANONICAL_HOST` + `ARCHIVE_VERSION`).
- The service worker RETIRED in v136 (2026-07-03): `src/client/sw.js` is an unregister stub that must keep serving 200 for a year+. There is no `CACHE_VERSION`; the deploy-log number lives in D1 (`bump-version.sh` derives the next from `MAX(vnum)`).
- Canonical photo source: the aadhar-photos R2 bucket. Raw source files are
  never committed to GitHub; the Actions workflow downloads only the requested
  object keys into disposable runner storage.

---

## Route map (where each URL's code lives)

`src/worker/` is a **directory** bundled by Cloudflare at deploy. The
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
| `/serendipity`, `/serendipity/*` | Serendipity module delegation + local CSP | `../serendipity/serendipity.ts` |
| `/lens.js` | static client renderer | `src/client/lens.js` (served asset) |
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
wrangler.jsonc; secrets on the Worker via `wrangler versions secret put`. Every use is
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
| `RN_SIGNING_KEY_JWK` | secret | AadharshBot Ed25519 signing key (RFC 9421). Absent → every signed outbound fetch throws, by design |
| `RN_SIGNING_KEY_MLDSA_JWK` | secret | **UNUSED since 2026-08-15.** It held AadharshBot's ML-DSA-44 key while `sig2` shipped. The code now ignores it and a contract test pins that, because deleting a secret is its own release and the value outlived the feature. Safe to delete with `wrangler versions secret delete` whenever a release is going out anyway |
| `BROWSER` | Browser Run | binding behind `/lens/shot` + `/lens/browser`; absent → clean 503 |
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

- **`public/bimi.svg`** is the BIMI logo (SVG Tiny-PS, square and full-bleed
  because inboxes circle-crop it). Its consumer is a Cloudflare DNS record, so
  deleting the file breaks mail rather than the site.

  **This one now goes red.** The BIMI record in [`infra.json`](../config/infra.json)
  carries a `consumer` field naming this path, and `bun run infra:check` fails
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

`node tools/verify-routes.ts [baseUrl]` curls every route and asserts status +
content-type (+ markers). All-green ("0 hard failure(s)") is the gate before and
after any deploy. The skeuomorphic `_worker.js/` module tree was extracted with
this as the regression tripwire; keep it green on every future change.

The same table runs **before** a merge through `bun run routes:check`, which
boots the Worker in-process with Wrangler's `createTestHarness()` and points the
oracle at it (about 5s end to end, build.ts included, since the harness honours
`wrangler.jsonc`'s `build.command` and therefore serves the minified tree). CI
runs it on every PR. Five rows carry `remote: true` and sit out the local pass,
because a local Worker structurally cannot have what they assert: production R2
objects (`/images/full/…`, `/photos`), the cron's KV snapshot (`/around/json`),
or the AadharshBot signing secret (`/lens/fetch`, `/lens/shot`). Everything else
is asserted identically. Note the local run proves the HANDLER, not the DATA:
empty local KV/R2/D1 means a passing `/images/manifest.json` says the manifest
builder works, not that the photos are there. The production sweep is still the
one that sees real content.

`bun run routes:check:remote` closes **part** of that gap on the workstation: it
boots the same harness on a config whose KV/R2/Browser bindings reach production,
sets `VERIFY_REMOTE=1`, and runs all 91 rows. It cannot run in CI (remote
bindings need a write-capable token) so `bun run routes:check` remains the merge
gate. See "Local dev and the route oracle against production data" above.

**Part, and the boundary matters.** Remote bindings cover KV, R2, D1, and Browser
Run. They explicitly do NOT cover secrets, vars, Durable Objects, Workflows,
static assets, version metadata, or Analytics Engine. So of the five rows:

| row | needs | remote bindings fix it? |
|---|---|---|
| `/around/json` | the cron's KV snapshot | yes |
| `/photos` | production R2 + manifest | yes |
| `/images/full/<key>` | `PHOTOS_R2` | yes |
| `/lens/shot` | Browser Run **and** the AadharshBot signing secret | partly |
| `/lens/fetch` | the AadharshBot signing secret | no |

The two `/lens` rows want `RN_SIGNING_KEY_JWK`, and a secret cannot be made
remote by any flag. Getting those green locally means a `.dev.vars` file, which
is gitignored and stays that way. The production sweep remains the only pass that
sees everything.

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
   production-promotion path. The deploy IS the go-live: the worker bundles
   `photo-index.json` + `hashes.json`, so there is no cache to bust and no
   post-deploy step. (The old "Bust remote photo manifest" workflow retired
   with the `manifest:images` KV cache, 2026-07-28.)

The photo-processing workflow needs no Cloudflare secret: it reads source
objects through the public /images/full/<key> route and skips R2 writes.

The GitHub-hosted macOS runner installs the Homebrew tools, builds the `zenc`
encoder with cargo, runs the selected routine, and discards the source files when
the job ends. The runner is the only execution host; nothing on the author's
machine is part of the contract.

Dependabot covers the encoder now: its cargo ecosystem tracks the zenjpeg pin in
`tools/photos/zenc`, opening a version-bump PR on the weekly cadence alongside
the Actions, npm, and Pillow layers. This retired the old `Refresh image toolchain`
workflow that hand-tracked the from-source jpegli commit. Only Homebrew formulas
(mozjpeg, libavif) fall outside Dependabot and update on their own cadence.

**The AVIF encoder left that ambient set on 2026-08-26.** `tools/photos/libavif/build.sh`
builds `avifenc` from source at a pinned `LIBAVIF_TAG`, and the photo pipeline
prefers it over anything on PATH. Dependabot does not track it either, but a pin
does not drift: bumping it is an edit to a committed script rather than something
`brew upgrade` can do behind you. That matters because `/i/` is content-addressed,
so the encoder decides shipped URLs. Brew's `libavif` is still wanted for the
`/garage/encoding` grid scripts.

## Local fallback setup

```bash
# the photo pipeline
brew install jq mozjpeg libavif              # mozjpeg = jpegtran + cjpeg; libavif = avifenc for the /garage/encoding grids
brew install cmake ninja                     # for the pinned avifenc below
# the AVIF encoder the photo tiers actually use: libavif at a pinned tag, built
# with aom + libsharpyuv + libyuv. First run clones and builds all four (~10 min,
# needs network); after that it is a no-op. Byte-identical to brew's avifenc at
# q63 -d 10 --yuv 420 at BOTH --speed 4 (2026-08-26) and --speed 2 (2026-08-28,
# 3 stems across both yuv paths), so building it re-mints no /i/ URL.
./tools/photos/libavif/build.sh
brew install uv && bun run photos:env               # Pillow, for gen-pixel-peeper.py only (brew's python3 is PEP 668; pip into it fails)
# the JPEG encoder (zenc) builds itself on first pipeline run; needs rust (rustup.rs)
cargo build --release --locked --manifest-path tools/photos/zenc/Cargo.toml
bun run wrangler login                                         # Cloudflare auth (deploys + KV + R2 all use it)

# the study pages, which are NOT needed to add a photo
brew install webp ffmpeg                              # cwebp for the encoding grids; ffmpeg for their PNG -> PPM step
```
This is an emergency fallback only. sips is macOS-native (no install), and the
normal path is the remote workflow above.

`export-for-instagram.sh` additionally wants **ssimulacra2** and
**butteraugli_main**, the two perceptual metrics it searches quality against.
Those are libjxl tools built with `-DJPEGXL_ENABLE_TOOLS=ON`, and Homebrew's
`jpeg-xl` formula does not ship them, so there is no brew line for this row. The
script falls back to `/opt/zerobrew/prefix/bin`, which is where this workstation's
source build put them.

**`bun run tools:check` is the check on all of it**, declared in
[`config/tools.json`](../config/tools.json). Its declaration tier runs on every
PR and needs no binary; its presence tier probes this machine and is advisory in
CI. Run it before a pipeline session on a fresh machine and it names what is
missing and how to get it, rather than letting a script exit on a raw shell
error four steps in. Four of the tools above were required and documented nowhere
until it was written.

---

## Add photos (local fallback only)

```bash
# The normal remote path is the Remote photo pipeline workflow above.
# This local command remains for recovery when Actions or R2 ingress is unavailable.
./tools/photos/add-photos.sh "/path/to/photo.HIF" [more files...]
# then it prints the deploy line; run it:
bun run deploy:direct   # local fallback only; normal production is merge + CI promotion
```
- Accepts JPG/PNG/HEIF/HIF. JPGs are uploaded as supplied; HEIF/HIF sources
  remain archive objects and also produce a full-resolution maximum-quality
  q100 JPG export as the `/images/full/<stem>.jpg` click target.
- Emits the 600px JPG fallback, 600px AVIF, and 400px mobile AVIF tiers;
  writes the stem's entry into `src/worker/photo-index.json` (the
  committed pool the worker bundles — R2 key, byte size, upload date);
  regenerates EXIF metadata; bakes the four 64-bin RGB/luminance histograms;
  and runs `bun run photos:check` as the final gate.
- A photo appears in the grid at DEPLOY, when its index entry ships with the
  worker. There is no KV manifest and nothing to bust.
- A thumbnail can't go stale anymore: its URL is its bytes (`/i/<stem>.<hash8>`). If one looks wrong, re-run `hash-thumbnails.sh`, commit, deploy; a changed file gets a new URL automatically.
- To REMOVE a photo: delete its `photo-index.json` entry, its `hashes.json`
  entry, its `/i/` tiers, metadata, and caption, then deploy (photos:check
  enforces the bijection). Delete the R2 object separately if the original
  should go too.

### Regenerate just the EXIF metadata (photos already uploaded)
```bash
./tools/photos/extract-photo-metadata.sh "/path/to/sooc-originals"
```
The normal remote equivalent is the `refresh-metadata` routine in the Remote
photo pipeline workflow. Local `--merge` mode updates only a selected batch;
the full directory mode rebuilds the metadata index. Every field is nullable;
the tooltip skips nulls rather than guess.

### Re-encode ALL thumbnails (e.g. a new resolution/quality)
```bash
./tools/photos/reencode-thumbnails.sh           # re-encodes every grid thumb as pre-cropped center squares
./tools/photos/hash-thumbnails.sh               # re-hash the tiers into /i/ + rewrite hashes.json
# commit + deploy (new bytes = new URLs; the worker bundles the index + hashes, so the deploy is the bust)
```
`SQ_SM` (mobile tier) must match `THUMB_SMALL_PX` in `_worker.js` (the `-<N>.avif` suffix). add-photos.sh mirrors this script's two encode paths; keep them in sync.

### Add a car reference photo (homepage tooltip)
```bash
./tools/photos/add-car-photo.sh <stem> <input-image>   # stem: singer | tuthill | hwa-evo | f355
```
Outputs `public/cars/<stem>.{avif,jpg}` (no EXIF, no R2). Bump the `?v=` on that car image in `index.html` if you replace one in place, then deploy.

### Generate AI alt text for the grid
`add-photos.sh` already does this in phase 4, so a normal add needs nothing here.
Run it by hand to backfill or to retry after a rate limit:
```bash
bun run captions                            # writes public/images/alt.json {stem: alt}
```
Resumable: only fills uncaptioned stems, so a 429 (Workers-AI neuron budget) just means run again later.

**Set a token once and captions work pre-deploy.** With `CLOUDFLARE_API_TOKEN` in
the environment, the script reads the committed `public/i/<stem>.<hash8>.jpg` and
posts those bytes straight to Workers AI, so a photo added seconds ago gets
captioned in the same run. Without one it falls back to handing a stem to
`/garage/cf/caption`, which fetches the thumbnail from production and therefore
only sees photos that are already live.
```bash
export CLOUDFLARE_API_TOKEN=...             # Account · Workers AI · Read
```
`check-photo-pipeline.mjs` fails on any stem with no caption, the same way it does
for a missing pixel tier or histogram, so an unlabelled image can't reach a deploy.

### Release a change
```bash
bun run release                 # where the release is, and the ONE next command
```
Reads git, Cloudflare and D1 and prints one next action. Read-only and safe to
run mid-ramp.

The changelog entry is staged **in the PR**, alongside the change it describes:
```bash
./tools/photos/bump-version.sh <slug> "<title>"
```
That writes one file and touches no network — the vnum comes from the committed
projection, so it needs no D1, no wrangler and no account selection. Commit it
with the work. `/updates` and `/restore` render from that file at build time, so
the entry ships with the deploy it describes instead of needing a second one.

`bun run deploy:promote` records the staged rows in D1 when traffic reaches
**100%** — the one place that knows traffic actually moved. A ramp that stops at
10% leaves the entry staged, which is exactly what it is. `bun run
checkpoints:check` therefore allows the projection to run AHEAD by a contiguous
tail of unreleased entries, and fails on anything else: behind, mismatched, or a
gap in the tail.

Traffic moves either from a workstation (`bun run deploy:promote`) or through
`.github/workflows/ramp.yml`, which canaries at 10% and then waits on a required
reviewer before 50% and 100%.

### Turn on Kitesurf for the Browser view
`/lens/browser` (the Browser view) works out of the box on the Browser Run
BINDING (Chromium, no credential). Kitesurf, Cloudflare's WASM browser engine for
agents, is REST-only — the binding's payload schema rejects the `browser` key
outright — so it needs a token:

```bash
# Cloudflare dashboard -> API Tokens -> Create Custom Token
#   Permission: Account · Browser Rendering · Edit
bun run wrangler versions secret put -c wrangler.jsonc BROWSER_RUN_TOKEN
```

**That is an EDIT scope.** It lives as a Worker secret, never in GitHub, so the
repo's no-write-token rule is untouched — but it is not a read token and should
not be described as one. Without it the route silently uses the binding and
reports `engine: "chromium-binding"`, so the view degrades rather than breaks.

`browser=kitesurf` is documented only on Cloudflare's Kitesurf page, not in the
Quick Actions reference. The code therefore tries the parameter, falls back once
on a 400, and remembers the answer for the isolate. If Cloudflare ships it into
the binding, delete `renderOverRest` and the token with it.

**The selector rides `/browser-run/<action>`, not `/browser-rendering/<action>`.**
Both spellings route, so the wrong one drops the opt-in without an error. Fixed
2026-08-08; `restUrl()` in `lens-render.js` is the single source and a contract
test pins the path.

**`engine: "kitesurf-requested"` means the selector was sent and the call came
back 200.** It does NOT mean Kitesurf served the render: the response envelope
carries no engine field, so an endpoint that ignores the parameter is
indistinguishable from one that honours it. To settle it, run the control:

```bash
BROWSER_RUN_TOKEN=... bun run kitesurf:check            # free, may be inconclusive
BROWSER_RUN_TOKEN=... bun run kitesurf:check --render  # decisive, ~2 tiny renders
```

It sends an invented engine name. A rejection proves the parameter is validated,
which is what makes a 200 carrying `kitesurf` mean Kitesurf; on that verdict,
promote the label in `lens-render.js` to a bare `kitesurf` and record the date
and outputs at the control. Ration it: the account has 10 free browser-minutes a
day and `--render` spends from the same budget `/lens/browser` does.

Read which engine actually answered, and the shape it measured:
```bash
curl -s 'https://aadhar.sh/lens/browser?url=https://react.dev/' | jq '.engine, .shape'
```

### Warm the /lens browser caches before a demo

Browser Run on the free plan allows 6 calls a minute account-wide and 10
browser-minutes a DAY, shared by `/lens/shot`, `/lens/browser` and `/lens/wire`.
One render costs about 19s of that. So the Human and Browser panes are fine on a
quiet afternoon and blacked out the moment anybody leans on them, which is
exactly what a live demo does.

Every browser route caches to KV for 6h, so the fix is spending the budget
EARLIER rather than asking for a bigger one. Run this within 6 hours of the
demo, because an expired warm is the same as no warm:

```bash
node tools/lens-warm.ts                 # the seeded /lens chips, production
node tools/lens-warm.ts https://foo/    # specific URLs instead
```

It performs REAL Browser Run calls, away from an audience. Re-running it is also
the check: an already-warm URL comes back cached in milliseconds and bills
nothing. There is deliberately no `--check` mode, because a probe that reports
"is this warm?" warms it as a side effect, and a miss costs a full render.

**When the daily allowance is already gone, warming has nothing left to spend.**
The allowance resets at 00:00 UTC and not before, so a demo landing after that
ceiling needs the other script:

```bash
node tools/lens-seed.ts --dry-run   # capture locally, write nothing, print sizes
node tools/lens-seed.ts             # capture and seed production KV (24h TTL)
```

That drives real headless Chrome on this machine (playwright-core, channel
chrome) and writes the results into the same cache keys Browser Run would have
filled. Every byte still comes from a real browser really loading the real URL.
What changes is WHERE the browser ran, and the snapshot says so: it carries
`engine: "chromium-local-capture"`, which the pane prints under every comparison
it draws. **Do not relabel those as `chromium-binding` to make the caption
tidier.** The server already reports a cache read as "KV cache", so nothing
claims to be a fresh render.

Two fields are honestly derived rather than captured, and both are marked at the
code: `markdown` comes from this repo's own HTML-to-Markdown converter run over
the rendered DOM, since there is no way to ask Browser Run for its own, and
`accessibilityTree` is rebuilt from CDP's flat AX node list.

It seeds three keys per URL, so all three browser-backed tabs survive:
`lens:browser:<sha>` (the Browser pane), `lens:shot:<sha>` (the Human view's
fallback screenshot for a site that forbids framing), and `lens:wire:<sha>`
(the Wire tab). Pass `--no-shot` or `--no-wire` to skip either.

**The Wire capture reuses the production summariser rather than reimplementing
it.** `/lens/wire` builds its entire payload by handing raw CDP events to
`summariseWire(events, url)`, so a local CDP session produces the same events and
the same exported function turns them into the payload. That matters because the
summariser owns real judgement calls: a `loadingFailed` carrying a status is
`aborted` rather than `failed`, wire bytes come off `loadingFinished` and not off
the response, and a redirect arrives as a second `requestWillBeSent` on one id. A
hand-rolled copy would drift from all three silently.

One gap worth knowing: the Wire pane does not display `engine`, so a locally
captured waterfall does not announce itself there the way the Browser pane does.
That is true of a real `chromium-cdp` capture too, so it is a pre-existing gap
rather than something this introduces, and the field is in the JSON either way.

Both scripts take their target list from `tools/lib/lens-chips.ts`, which
reads the chips out of the shell renderer in `src/worker/lens.ts`. Adding a
chip there is all it takes; nothing needs updating here.

The TTL is a day rather than a week on purpose. A stale local capture outliving
the outage it covered is the failure to avoid, and the site returns to live
Browser Run renders the moment the entries expire. To undo sooner, delete the
`lens:browser:<sha>` and `lens:shot:<sha>` keys the script prints.

### Add or change a /lens interaction recipe

Recipes are the fixed scripts `/lens/browser?do=<id>` runs inside a page before
reading it. They live in `src/worker/lens-recipes.ts` and are published
verbatim, so anyone can check what ran:

```bash
curl -s 'https://aadhar.sh/lens/browser?recipes=1' | jq '.recipes[] | {id, label}'
curl -s 'https://aadhar.sh/lens/browser?url=https://example.com&do=expand' | jq '.interaction'
```

**Rules a new recipe has to clear, each pinned by a contract test.** It must not
click or submit anything. It must not contain `fetch(`, `XMLHttpRequest`,
`eval(`, `new Function`, `document.cookie`, `localStorage`, `sendBeacon` or
`postMessage`, because a recipe is a DOM edit and never a network actor. Its id
must match `/^[a-z][a-z0-9-]{1,15}$/`. And it reports through
`__receipt({acted, scanned, note})` with integers and a fixed enum only, never a
string lifted off the page: that string would be the one place attacker bytes
could ride back into our JSON.

`acted: 0` is a success, not a failure. `scanned` is what makes it readable
("examined 37 overlays, none matched"), so populate it.

**An ASYNC recipe is not buildable until the probe says so.** Both shipping
recipes are synchronous. Anything whose effect lands after a tick needs
`waitForTimeout` to delay the capture, and whether that key is accepted and
lands after injection is exactly what the probe measures:

```bash
BROWSER_RUN_TOKEN=... node tools/lens-inject-probe.ts
```

Seven cases, one render each, spaced 11s apart against the 6/min account-wide
ceiling. Read case 1 first: if the synchronous marker does not survive the
capture, nothing here works. Case 3 against case 4 is the async verdict.

The one case that script cannot run is the Workers binding, which only exists
inside a Worker:

```bash
bun run dev:remote
curl -s 'http://localhost:8787/lens/browser?url=https://example.com&do=expand' | jq '.interaction, .engine'
```

A binding that refuses `addScriptTag` surfaces as the existing `upstream_not_ok`
502 carrying `unrecognized_keys`, the same signature the Kitesurf probe gave.

### Regenerate the photo search expansion
`images/semantics.json` is what `photo_query` ranks against beyond the caption and
the EXIF. Two tiers, and every stem records which it got:
```bash
node tools/photos/gen-photo-semantics.ts            # derived tier only
node tools/photos/gen-photo-semantics.ts --vision   # + model-written terms
```
The **derived** tier needs no network and no credential — it is vocabulary repair,
mapping what the camera writes to what a person types (`Nostalgic Neg` →
"nostalgic negative", `LEICA M MONOCHROM` → "monochrome black and white", ISO ≥
3200 → "low light"). Rerun it after adding photos; it is deterministic, so the
diff is exactly the new stems.

The **vision** tier asks the caption model for retrieval keywords under a
different prompt than alt text, and needs `CLOUDFLARE_API_TOKEN`. It is resumable
and writes after every photo, so a 429 against the daily neuron budget costs
nothing already paid for.

**The model never runs on the request path, and that is the point.** Embedding a
query per request would put a Workers AI credential back in the Worker, which is
what deleting `/ask` removed. Expanding the documents offline keeps the Worker at
zero credentials and zero subrequests, and it still works on the free plan. Delete
`semantics.json` and the query keeps working one tier down, reporting
`ranking.semantic: false`.

### Regenerate the /garage/encoding study samples
```bash
./tools/photos/gen-encoding-samples.sh [STEM] [SRC_DIR]
```
Prints byte counts + bytes-per-pixel so the figcaptions on `/garage/encoding` can be updated to match. The grayscale (`g-*`) set is generated separately and is not touched.

---

## Regenerate the OG / Twitter cards

Every garage + lwe page unfurls as a 1200x630 card showing its live demo floated
on the Bliss desktop (`public/og/<section>-<name>.png`), wired via
`og:image`/`twitter:card` in each page's `<head>`. Regenerate when a demo's look
changes or a new page lands:

**Easiest path: run it from the repo.** `.github/workflows/og-cards.yml` does both
commands below on a runner and opens a PR, with an `only` input that maps to
`OG_ONLY` so you can re-bake one card. Actions tab, "OG cards", Run workflow.

It is **dispatch-only on purpose, never scheduled.** The cards capture production
so data-driven demos render populated, and the photo grid, the live counters and
the routing prober are not deterministic between runs, so a nightly job would
open a PR of changed PNGs every night that meant nothing. `dictionary-roll.yml`
can be nightly because its output is a pure function of what production serves;
this is not that.

By hand:

```bash
bun run og-cards                    # captures LIVE aadhar.sh (data-driven demos render populated)
node tools/photos/inject-og-meta.ts   # add the meta to any page missing it (idempotent)
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
  `bun run og-cards` run before the URL resolves).
- Worker-rendered routes (no static HTML for the generator to walk) live in
  `WORKER_PAGES{}` beside `HERO{}`, with their meta emitted from the page's own
  renderer instead of `inject-og-meta.mjs`. `/lens` is one: its card captures a
  live scan of stripe.com, so prewarm the two Browser-Rendering caches first or
  `networkidle` waits them out, and scope the run so the other 25 committed
  PNGs don't get rewritten with fresh-but-equal pixels:

  ```bash
  curl -s "https://aadhar.sh/lens/shot?url=https%3A%2F%2Fstripe.com%2F" -o /dev/null
  curl -s "https://aadhar.sh/lens/browser?url=https%3A%2F%2Fstripe.com%2F" -o /dev/null
  OG_ONLY=lens bun run og-cards
  ```

### The GitHub repo card

Separate generator, separate size, separate destination. GitHub's social preview
is **1280x640** and it is uploaded through the repository settings, not served by
this site, so it lives in `.github/` rather than `public/og/` and no page links it.

```bash
bun run repo-card                        # both variants, into .github/
bun run repo-card desktop                # just one (desktop | card)
bun run repo-card --out /tmp/preview     # somewhere throwaway
```

Two variants ship because the card has two honest jobs:

- `social-preview-card.png` is a composed Luna window on the Bliss wallpaper:
  the name at 96px, one line of subtitle, four measured facts. **This is the one
  uploaded to GitHub**, because it is the one that survives a Slack thumbnail,
  where a whole desktop reads as blue mush.
- `social-preview-desktop.png` is the LIVE homepage at 2:1, full bleed. No copy
  at all: desktop icons, the window, the taskbar, real photos. It is generated on
  demand and **deliberately not committed**: the homepage draws a random 12 of
  158 photos per request, so every run would land a different PNG in the diff,
  the same non-determinism that keeps `og-cards.yml` dispatch-only. Run
  `bun run repo-card desktop` when you want one for a talk or a post.

The chips are COUNTED from `config/site-manifest.json` and
`public/images/hashes.json` rather than typed, because a card outlives most of what
it describes. The wallpaper and the window icon are read out of `src/styles/luna.css`
and `src/pages/index.html` for the same reason, so there is no second copy of either.

Nothing in the pipeline uploads it: GitHub exposes no API for the social preview.
Settings, then Social preview, then upload the PNG by hand.


---

## Change the now-playing playlist

The homepage scrapes a Spotify playlist; `playlist-id` in KV points at it. To swap it
(this is the sequence that actually works, the `/rn/set` endpoint needs `RN_BUST_SECRET`):

```bash
NS="3cb8a107c58e47dc9244e75b33401f36"
OLD=$(bun run wrangler kv key get --namespace-id="$NS" playlist-id --remote)   # save the current id
bun run wrangler kv key put --namespace-id="$NS" playlist-id "<NEW_22_CHAR_ID>" --remote
# clear the old playlist's SWR entry (the freshness stamp is its KV metadata,
# so the value key is the only one to drop):
bun run wrangler kv key delete --namespace-id="$NS" "tracks:${OLD}" --remote
curl -s "https://aadhar.sh/rn/tracks" >/dev/null                       # warms tracks:<new> by scraping
```
- The id is the 22 chars after `/playlist/` in the share URL (drop `?si=...`).
- **No redeploy, and this bullet used to call for one.** It read: the worker caches
  `playlist-id` in a module variable (`_playlistId`) per warm isolate, so a redeploy
  recycles isolates and the homepage *prerenders* the new list immediately. Both halves
  have expired. `_playlistId` is gone and every reader now fetches the id from KV per
  request (`playlistUrl`, `handleRnTracks`, `cronEnrichTracks` in `src/worker/rn.ts`), so
  there is nothing warm holding a stale one. And `/` stopped prerendering the playlist
  when `serveHomepageWithPrerenderedTracks` and `SSR_DEADLINE_MS` were deleted: the
  document is deterministic and static, and the tracklist hydrates client-side from
  `/rn/tracks.html`.
- **What is left is a ten-minute stale window on one fragment, and it clears itself.**
  `/rn/tracks.html` is in `WORKERS_CACHEABLE_PATHS` under `s-maxage=600`, so a copy
  rendered just before the swap keeps serving the old list until it ages out. A deploy
  WOULD flush it at once, since `edgeKey` folds the worker version into the cache key,
  but that is a full production release to save under ten minutes. Confirm the origin is
  right rather than waiting on the cache: a query string bails `shouldUseWorkersCache`,
  so `curl -s "https://aadhar.sh/rn/tracks.html?cb=1"` renders fresh.
- **zsh gotcha:** brace the parameter. This used to delete a second `tracks:${OLD}:fresh` key, and bare `tracks:$OLD:fresh` triggers a zsh history modifier (`:r` etc.) that silently mangles it. The sentinel is gone; the habit is worth keeping for any key that carries a colon after a parameter.
- One-shot alternative once you have the secret: `curl "https://aadhar.sh/rn/set?secret=$RN_BUST_SECRET&url=<playlist-url>"`.

---

## Bust a cache

```bash
NS="3cb8a107c58e47dc9244e75b33401f36"
# (the photo manifest is no longer a cache: the worker bundles photo-index.json,
#  so a deploy replaces it atomically and there are no manifest:* keys to touch)
# directory-listing indexes:
bun run wrangler kv key delete --namespace-id="$NS" "idx:images" --remote
bun run wrangler kv key delete --namespace-id="$NS" "idx:imagesfull" --remote
# a specific playlist's tracks (delete both keys):
bun run wrangler kv key delete --namespace-id="$NS" "tracks:<id>" --remote
bun run wrangler kv key delete --namespace-id="$NS" "tracks:<id>:fresh" --remote
```

### Bump THUMB_VERSION (retired — nothing to bump)
Fully retired (hash cutover 2026-07-03): thumbnails are content-addressed at `/i/<stem>.<hash8>.<ext>`, so a re-encode mints new URLs by itself — run `./tools/photos/hash-thumbnails.sh` after re-encoding, commit, deploy (the bundled index/hashes make the deploy the bust). The constant no longer exists in `lib/const.js`; legacy `/images/<stem>.<ext>[?v=N]` URLs just 301 into `/i/` regardless of their `?v`. The worker route still clamps unknown-thumb 404s to `max-age=0` so misses do not inherit immutable caching.

### Read the homepage perf probe
A cron (`7,37 * * * *`) renders `/` in-process, parses its own Server-Timing,
and writes the spans to the `aadhar_perf_probe` Analytics Engine dataset
(perf-probe.js). Columns are positional: `double1..5` = assets, tracks, alt,
counter, total (`-1` = span absent); `blob1` = CSV of spans that hit the 25ms
SSR deadline (`""` = none); `blob2` = the worker version id, so consecutive
deploys A/B directly. Read it with the same token /ledger uses:
```bash
curl -s "https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT_ID/analytics_engine/sql" \
  -H "Authorization: Bearer $ANALYTICS_READ_TOKEN" \
  -d "SELECT timestamp, double1 AS assets, double2 AS tracks, double3 AS alt,
      double4 AS counter, double5 AS total, blob1 AS deadlined, blob2 AS version
      FROM aadhar_perf_probe WHERE timestamp > NOW() - INTERVAL '2' DAY
      ORDER BY timestamp DESC FORMAT JSON"
```
A gap in the series means the probe itself failed — it writes nothing rather
than fabricate a datapoint.

### Read a trace (Workers Traces)
Enabled in `wrangler.jsonc` under `observability.traces`, 100% sampled. Read them
in the dashboard: **Workers & Pages -> aadhar-sh -> Observability -> Traces**.
Every outbound fetch, binding call, and handler invocation is auto-instrumented;
the named spans on top come from `lib/trace.js` (vocabulary table in CLAUDE.md).

The queries worth knowing, because each one used to be unanswerable:
- **"why was that /lens scan slow"** — open a `route /lens/fetch` trace and read
  `lens.discovery`. Its ~28 child fetches are named by URL, so the straggling
  well-known file identifies itself. Note `lens.inspect.fetch` is what the JSON's
  public `elapsedMs` reports; the parent `lens.inspect` is the honest total.
- **"is a neighbor silently not being crawled"** — `cron.around` -> read
  `around.crawled` / `around.skipped` / `around.errored`, then the
  `around.neighbor` children where `around.outcome != "crawled"`.
- **"is the census still writing 16 rows"** — `census.sweep`, attributes
  `census.written` vs `census.roster`.
- **"did anyone fail to book a coffee"** — `cal.busy` where
  `cal.fail_closed = true` (or `cal.source = "none"`). That is a 503 on `/book`.
- **"did the webmention run finish"** — `webmention.send`, attribute
  `webmention.capped`.
- **"is the serendipity pool still syncing"** — `cron.serendipity` (fires
  00/06/12/18:23 UTC), then the run's summary log line: per-contributor
  `{synced}` or `{error}`. A `Luma 401` there means the stored session finally
  died and the fix is a cookie re-paste at `/serendipity/contribute`; the cron
  plus the Set-Cookie capture in `serendipity.js` (`cookieJar`) exist to make
  that rare, since every sync both keeps the session warm and persists any
  rotated cookie Luma issues back to D1.

**Do not chase a 0ms span.** `home.grid.render` and `lens.inspect.parse` read 0
and always will: Workers spans advance their clock across I/O only, never during
synchronous execution, so they cannot measure CPU. Verified in production on a
752KB page where the parse span read 0 right after emitting 81KB of markdown.
Those two spans are kept for their attributes. When you actually want CPU:
```bash
bun run wrangler tail aadhar-sh --format json | grep -o '"cpuTime":[0-9]*'
```

Only `_worker.js/index.js` may import `cloudflare:workers` (CLAUDE.md gotcha 16)
— the tracer is injected into `lib/trace.js` and `cal/src/trace.js` from there.
That injection runs at module scope, and workerd loads that module locally too,
which is why the next section works with no setup at all.

### Read a trace LOCALLY (wrangler dev, no deploy)

**This section replaces a claim that was true until 2026-08-04 and is not any
more.** It used to say local `wrangler dev` reports `span.isTraced === false` and
records nothing. Cloudflare shipped OpenTelemetry traces in local dev that day;
Wrangler 4.118.0 already has it, and there is nothing to install, enable, or bump.

```bash
bun run dev            # or: bun run wrangler dev -c wrangler.dev.jsonc --port 8799
curl -s localhost:8799/photos/grid.html > /dev/null      # make some spans

# the named spans, newest first
curl -s -X POST localhost:8799/cdn-cgi/local/explorer/api/local/observability/query \
  -H 'content-type: application/json' \
  -d '{"sql":"SELECT name, duration_ms, json(attributes) FROM spans WHERE kind = ? ORDER BY start_ms DESC LIMIT 20","params":["span"]}'
```

The body is `{sql, params}`, one read-only SELECT/WITH, 10000 rows max, `?`
placeholders rather than interpolation. `attributes` is JSONB, so read it back
through `json(attributes)`. The schema is `spans(trace_id, span_id, parent_id,
service, name, kind, start_ms, duration_ms, outcome, error, attributes)` plus a
`logs` table correlated by `trace_id`; `parent_id IS NULL` marks a root
invocation span, and `duration_ms` is NULL while a span is still open.

`GET /cdn-cgi/explorer/api` returns the whole OpenAPI schema. Traces are one part
of it: the Local Explorer also exposes local KV, D1, R2, Durable Object and
Workflow state, which is a faster way to answer "what is actually in the local
namespace" than a wrangler subcommand per binding.

Verified output from that exact recipe, 2026-08-04:

```
route /photos/grid.html | 0 ms | {"route.template":"/photos/grid.html","route.kind":"exact",...}
home.grid.manifest      | 0 ms | {}
home.grid.render        | 0 ms | {"home.grid.served":true,"home.grid.pool_size":158,"home.grid.alt_known":158}
route /photos           | 8 ms | {"route.template":"/photos","route.kind":"exact",...}
```

**The 0ms rule above holds locally, and that is the one thing worth checking your
intuition against.** The reasonable guess is that local dev, with no Spectre
mitigation to worry about, would finally measure the synchronous work. It does
not: `home.grid.render` reads 0 locally too, having just built a 158-photo pool.
Local spans buy you the tree and the attributes, not CPU. `route /photos` reads 8
ms because it spans real I/O.

What this changes day to day: a new span's NAME and ATTRIBUTES can be checked
before it ships. Previously the cheapest way to find out whether a span was
usefully named was to deploy it and open the dashboard.

### Read the observability event budget (`bun run obs:check`)

Tracing is free until **2026-10-01**. After that each SPAN is one observability
event on the same daily quota as Workers logs: **200,000 events/day on Workers
Free**, which is the plan this account stays on. OTLP export would move spans off
that quota and is documented as unavailable on Free, so the lever is knowing the
number.

```bash
CLOUDFLARE_API_TOKEN=... bun run obs:check              # 3 days, the Free retention window
CLOUDFLARE_API_TOKEN=... bun run obs:check --days 2     # a shorter window
CLOUDFLARE_API_TOKEN=... bun run obs:check --days 7     # REFUSED: 4 days past Free retention
bun run obs:check --control                             # exercises the refusals; no credential
```

It posts to `POST /accounts/<id>/workers/observability/telemetry/query`, the
endpoint the Observability dashboard itself calls, and prints the window total
plus one row per UTC day: the count, its share of the ceiling, and the headroom
in `/lens` scans at ~40 spans each. 200,000 divided by ~40 is roughly 5,000 scans
a day.

**WHAT IT DOES NOT ANSWER: the number is never broken down by dataset or by
Worker.** A spans-versus-logs split and two breakdowns (events by Worker, events
by span name) shipped in #667 and were REMOVED on 2026-08-30, after four
adversarial reviews found one defect class every time. A printed number that is
not a measurement, and every instance an inferred zero: the split rendered `0` in
a dataset column for a day its own query had never answered, beside a real total
of 100,000. Take the by-dataset and by-Worker question to the Observability
dashboard. Adding either tier back needs the bar this tool already sets, which is
that every cell owes a reading of its own and may not borrow another query's.

**The token wants `Workers Observability : Read` and that is a SEVENTH read
scope this repo does not otherwise have.** It is workstation-only and is wired
into no workflow. Do NOT add it to the CI token: nothing in CI reads this, and
the six-read-scopes rule under "Infrastructure declaration" is the point.
Measured 2026-08-29, wrangler's own OAuth token does not carry it either and
answers 403; `wrangler login` on 4.127.0 does request the scope, so re-logging in
is the alternative to minting a token.

**Do not answer a tight number by lowering `head_sampling_rate`.** It is
per-Worker, not per-route, so it thins the rare expensive events tracing exists
for at the same rate as the cheap ones. Cut spans on the surface that emits them.

**A zero from this tool is a measured zero, and that took the whole design.**
"0 events today, plenty of headroom" is indistinguishable from a broken read and
would be believed right up to the moment the quota bit, so the rule is that a
number prints only when it is a MEASUREMENT: cannot run (exit 2, no credential
or the request never reached the API), query error (exit 1), no data (exit 1),
and a real zero day inside a window that has data (exit 0, prints `0`). The
`dry` flag in Cloudflare's own request schema defaults to TRUE and a dry run
returns nothing, so every body sets it false AND every response is checked for
the `dry` and `granularity` the API echoes back. A count of 0 next to a real
event is reported as a contradiction rather than as zero.

**ONE count is corroborated by a second `view: events` query, the window
total.** The per-day counts are not: that probe answers "does any event exist in
this window" and nothing finer, so corroborating a single day would need its own
query per day to answer what the day's own `run` echo already settles. #667
claimed every count was corroborated; it was one.

**Three states REFUSE where #667 warned and then printed a table.** A sampled
dataset (counts understate ingestion by an unknown factor, so no table is
printed and no estimate is invented), an echoed `granularity` that is not what
was asked for (hourly buckets rendered as daily rows understate the peak 24x),
and a `--days` window reaching past retention (those days return nothing, and
nothing is not a zero). All three exit non-zero. Note that sampling is NOT
evidence of being over the daily quota: Cloudflare's trigger is 5 billion logs
per account per day, after which a 1% head-based sample applies for the rest of
the day, which is 25,000x the ceiling this tool prints.

**Every percentage assumes Workers Free and the output says so**, because the
token carries Workers Observability : Read alone and cannot see a subscription.
Workers Paid is 20 million events per MONTH with 7-day retention, a different
figure over a different period, so a reader on Paid must not read these shares
at all.

`--control` exercises the refusals with no credential. What it proves without a
token is narrower than it looks, and it says so on the run: both live cases stop
at the auth layer and come back byte-identical, so they are ONE assertion rather
than two, and the classifier, the run check and the renderer are proven offline.
Both live cases now require an HTTP RESPONSE, so a control run with the network
down fails instead of printing two green refusals it never earned.

### Log a deploy (bump-version.sh)
`./tools/photos/bump-version.sh <slug> "<title>"`, then deploy. Inserts the next checkpoint into D1 (vnum from `SELECT MAX(vnum)`), which is what `/updates` and `/restore` render. Nothing edits sw.js anymore: the service worker retired in v136, `nav.js`/`notepad.js` updates land via their short `_headers` max-age plus the per-deploy edge purge, and the stub at `/sw.js` cleans up old installs.

---

## Verify things

```bash
dig _index._agents.aadhar.sh SVCB +dnssec +short          # DNS-AID agent-discovery record
curl -s https://aadhar.sh/.well-known/http-message-signatures-directory | jq .   # AadharshBot JWKS (Web Bot Auth)
curl -sD- -o /dev/null "https://aadhar.sh/images/<stem>.avif?v=<N>"  # a thumb: expect 200 image/avif, 1yr immutable
curl -s "https://aadhar.sh/images/manifest.json" | jq length          # photo count
```

### Markdown twins

Nothing to run by hand: `build.ts` generates them, and the deploy fails if fewer
than 30 appear. To check the live surface:

```bash
curl -s -o /dev/null -w "%{http_code} %{content_type}\n" https://aadhar.sh/garage/encoding.md
curl -s -o /dev/null -w "%{http_code} %{content_type}\n" -H "Accept: text/markdown" https://aadhar.sh/garage/encoding
curl -s https://aadhar.sh/garage/llms.txt | head
```

The first two must both answer `text/markdown`; a browser `Accept` header and a
bare `*/*` must both still get `text/html`. `/bot` and `/whoareyou` are the two
twins written BY HAND (in `src/content/md/`), because those pages render from Worker
template literals no build step can read. Edit either page and the deploy fails
until its twin agrees: `checkTwinFacts()` recomposes the User-Agent from
`botauth.js`'s own constants and requires it verbatim in `bot.md`, so a
`BOT_VERSION` bump is caught instead of quietly leaving the twin a version behind.

---

## The scripts (`tools/photos/`)

| script | what it does |
|---|---|
| `add-photos.sh` | Full pipeline for new photos: resize, EXIF-rotate, encode AVIF+JPG center-square thumbs, upload the full-resolution browser copy to R2, write the stem's `photo-index.json` entry, regenerate metadata, bake histograms, and validate the artifact graph. |
| `check-photo-pipeline.mjs` | CI-safe invariant check: every metadata stem has all three hashed tiers, per-photo metadata, and four 64-bin histogram channels, with no orphaned pixel files. Also walks the authored HTML/JS for hardcoded `/i/<stem>.<hash>` URLs (the `/garage/tooltips` demo slots have three) and fails if a re-encode has pruned the bytes one of them names. |
| `extract-photo-metadata.sh` | Read EXIF from the SOOC folder, emit `images/metadata.json` + per-photo `images/meta/<stem>.json`. Pulls the Fuji recipe fields too. Requires exif-sooc + jq. **Two schemas, on purpose:** `metadata.json` is the RECORD (long, self-documenting field names, plus the derived `recipe` card) and the per-photo files are the tooltip's RENDER CACHE (short keys, tooltip-only fields, nulls dropped, ~28% smaller compressed because one is fetched per hover). Bump `META_V` in `tooltip.js` when the per-photo shape changes. |
| `build-exif-index.mjs` | **RETIRED 2026-08-29**, along with `build-image-fingerprints.ts`. Both rolled a committed index out of the pipeline's own leftovers, and both are BUILD OUTPUT now: `tools/lib/photo-indexes.ts` holds the two derivations and `build.ts` step 1a stages `images/exif.json` and `images/fingerprints.json` into `.build/public` on every deploy, so both still ship at the URLs they always had. Neither script has a caller left; `extract-photo-metadata.sh` and `hash-thumbnails.sh` each dropped one line. **Why exif.json exists at all:** the homepage draws a random 12 of 165 per request, so warming metadata per visible slot was 12 cold requests on nearly every visit (a given slot repeats ~7.6% of the time). One immutable index is smaller than that on the first visit and free after. Histograms stay out of it because they are 623 of a per-photo file's ~977 bytes, so folding them in would take the index from 2.6KB to 24KB for bars most visitors never see. |
| `build-recipes.py` | **RETIRED 2026-08-14.** The Fujifilm recipe card is derived during extraction now, by `exif-sooc --keyed`, from the Fuji tags rather than from the flattened record this script re-read. Same idiom and same output: all 158 committed cards regenerate byte-identical. One behaviour change worth knowing, since the old script rewrote every card on every run: a `--merge` run now refreshes the BATCH only, so re-run a full extraction after an exif-sooc upgrade that changes the card. Query it with `/photos/query.json?recipe=DR400` as before. |
| `reencode-thumbnails.sh` | Re-encode every published grid thumb from the source folder at a new resolution (pre-cropped squares, two tiers). Follow with `hash-thumbnails.sh`, then commit + deploy. |
| `add-car-photo.sh` | One resto-mod reference photo -> `cars/<stem>.{avif,jpg}` for the homepage car tooltips. No EXIF, no R2. |
| `zenc/` | The JPEG thumbnail encoder: a Rust crate wrapping zenjpeg (hybrid trellis + progressive scan search). `cargo build --release` (auto-built on first pipeline run). `zenc <in> <out> -q 84`. dependabot tracks the zenjpeg pin; replaced the from-source jpegli build in 2026-07. |
| `download-remote-photos.sh` | Download selected R2 object keys into disposable runner storage for the GitHub Actions photo workflow; accepts `all` for the public manifest. |
| `gen-alt-text.py` | AI alt text for grid photos -> `images/alt.json`. Run by `add-photos.sh` phase 4. Posts the committed `i/` thumbnail to Workers AI when `CLOUDFLARE_API_TOKEN` is set (captions pre-deploy), else asks `/garage/cf/caption` by stem (deployed photos only). Resumable. |
| `gen-photo-semantics.mjs` | Retrieval terms for `photo_query` -> `images/semantics.json`. Derived tier (EXIF vocabulary repair) needs nothing; `--vision` adds model-written keywords and needs `CLOUDFLARE_API_TOKEN`. Deliberately offline so the Worker keeps zero AI credentials. Resumable. |
| `gen-encoding-samples.sh` | Regenerate the color sample set for `/garage/encoding` through every encoder; defaults to the committed `garage/enc/c-png.png` fixture and prints byte counts. |
| `zenc histogram --root public` | Bakes four 64-bin RGB/luminance histogram channels into each per-photo `images/meta/<stem>.json` from the shipped hashed JPG tier. A subcommand of the encoder crate since 2026-08-14 (it was `photo-histograms.py` + Pillow), called by both metadata extraction and `add-photos.sh`. `--check` compares against what is on disk and writes nothing, which is how you tell a decoder bump from an edit. |
| `gen-og-cards.mjs` | Render the 1200x630 OG/Twitter card per garage + lwe page (live demo on the Bliss desktop) into `public/og/`. `bun run og-cards`. Drives the installed Chrome via `playwright-core`; captures production so data-driven demos render full. Hero selectors + presets in the `HERO{}` map. See "Regenerate the OG / Twitter cards". |
| `inject-og-meta.mjs` | Idempotently add `og:image`/`twitter:card` meta to any garage + lwe page missing it, pointing at `/og/<section>-<name>.png`. `--check` reports gaps without writing. |
| `hash-thumbnails.sh` | sha256 each pixel tier into `public/i/<stem>.<hash8>.<ext>`, write `images/hashes.json`, and prune tiers no longer named by it. Run by `add-photos.sh`; a re-encode mints new URLs, so there is no version to bump. It also built the full-byte `images/fingerprints.json` until 2026-08-29; the build derives that from these same bytes now. |
| `gen-encoding-grids.sh` | Regenerate the ZOOMED 96px comparison crops (`garage/enc/z-*`) that `/lwe/encoding` fetches. Run by the `regenerate-encoding-study` routine of the photo workflow. |
| `gen-desktop-partial.mjs` | Bake the XP desktop shell into `_worker.js/lib/desktop.js` and patch it into the 28 static pages, generated from nav.js's own `PROFILES`/`SUBPAGES`/`SECTION_ICONS`/tray template so the two cannot drift. Re-run after editing any of those. A run on an unchanged tree is a byte-exact no-op. |
| `bump-version.sh` | Insert one `checkpoints` row into the `aadhar-restore` D1 database, deriving the next vnum from `MAX(vnum)`. Both `/restore` and `/updates` read that table, so this is the only place a deploy gets logged. `./tools/photos/bump-version.sh <slug> "<title>"`. |

---

## Gotchas that have bitten me

- **Thumbnail 404s must be uncacheable.** Workers static assets no longer return homepage HTML for missing files, but a real miss under `/images/*` can still inherit the immutable cache rule unless the worker clamps it. Keep the thumbnail route worker-first; a re-encode mints a fresh `/i/` URL by itself, so there is no version to bump.
- **zsh eats `${var}:something`.** Brace-quote KV key names with colons (`"tracks:${OLD}:fresh"`), and use `${=flag}` if you need word-splitting in ad-hoc snippets (the scripts use `#!/usr/bin/env bash` so they are safe internally).
- **`jpegtran` / mozjpeg strip EXIF.** Rotate losslessly with `jpegtran -copy none -rotate N` *before* recompressing, and send its binary stdout to a file (`2>/dev/null > out.jpg`), not through a pipe that could mix in stderr.
- **Production deploy = merge to `main`, CI promotion to `production`, then Workers Builds**; the single site Worker deploys the root `wrangler.jsonc`, bundling `public/`, `cal/src/`, and `serendipity/` from that exact release branch. The deploy config points `main` + `assets` at `.build/public` and runs `build.ts` first through its `build.command`, so the production path self-builds and ships the minified client scripts + `luna.css`. Local dev is the exception: `wrangler dev -c wrangler.dev.jsonc` (`bun run dev`, wired into `.claude/launch.json`) serves the readable tree directly. Before merging, CI runs `bun run perf-budget`; after configuring Workers Builds, verify its release status and run `node tools/verify-routes.ts https://aadhar.sh` plus the `/coffee` and `/serendipity` route smoke checks.
- **`_playlistId` is module-cached per isolate.** After changing `playlist-id`, redeploy to flush it (see the playlist section).
- **The worker is bundled, not hand-concatenated.** `_worker.js/` imports sibling modules; wrangler bundles them at deploy via built-in esbuild.
- **Authoring is buildless; SERVING is minified.** `build.ts` (repo root; minifier devDependencies: `@minify-html/node`, `lightningcss`, `oxc-minify`) copies `public/` to `.build/` and minifies: `index.html` (structure via minify-html, inline CSS/JS through the same Lightning CSS + Oxc settings, with marker tripwires and a readable `/index.src.html` twin), the six client scripts (`nav.js`, `notepad.js`, `lens.js`, `lens-browser.js`, `quiz.js`, `tooltip.js`), `luna.css` (owner-approved 2026-07), and the worker modules' `/*min*/` CSS literals — each with a readable `/<name>.src.*` twin (the banner in each minified file points there). It hard-fails the deploy if `luna.css` doesn't parse as valid CSS (the v143 corruption slipped through for three releases), and content-hashes `nav.js` + `luna.css` into immutable `/a/` URLs. Garage/lwe HTML, images, and `_headers` ship byte-identical to git (View Source is part of the design). Do NOT extend the build into bundling or version auto-bumps; the scripts remain independently readable islands.
