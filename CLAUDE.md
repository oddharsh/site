# aadhar.sh

Aadharsh Pannirselvam's personal site: a Cloudflare Worker with static assets,
styled as Windows XP / Outlook Express (Luna blue title bars, Tahoma/Verdana,
bevels), with colors authored in OKLCH. `AGENTS.md` is a symlink to this file.

Read the code before trusting prose, this file included. When you learn
something that cost real time, add a gotcha to [docs/GOTCHAS.md](docs/GOTCHAS.md)
rather than a paragraph here.

## Layout

| path | holds |
|---|---|
| `src/pages/` | every HTML document, at its served path |
| `src/content/` | prose: writing posts + `posts.json`, hand Markdown twins (`md/`), `index.md` |
| `src/worker/` | the site Worker. `routes.ts` is the route list; `index.ts` binds handlers |
| `src/client/`, `src/styles/` | client islands and stylesheets, served from the root (`/nav.js`, `/luna.css`) |
| `src/dict/` | committed compression dictionaries (build input, never served) |
| `public/` | bytes that ship unchanged: photos, `/i/` tiers, OG cards, `_headers`, `.well-known` |
| `cal/`, `serendipity/` | modules the site Worker serves at `/coffee` and `/serendipity` |
| `counter/` | `aadhar-counter`, which owns the `Counter` Durable Object |
| `cf-garage/`, `lwe-ask/`, `lens-reader/` | separately deployed auxiliary Workers (TypeScript config, gotcha 41) |
| `tools/` | the build, the contract tests (`contract-*.test.mjs`), checks, generators, `photos/` |
| `pipelines/` | page generators for `garage/` and `lwe/` |
| `config/` | `infra.json`, `site-manifest.json`, `derivations.json`, `tools.json`, tsconfigs, `dev/` |
| `design/` | the Luna design system; `tokens/` and `DESIGN.md` are canonical |
| `docs/` | runbooks: `MAINTENANCE.md`, `DEPENDENCIES.md`, `PHOTO-PIPELINE.md`, `GOTCHAS.md` |

Does a build step transform the file? Then it belongs in `src/`. Does it ship
byte for byte? Then it's `public/`. The site config is `cloudflare.config.ts` +
`wrangler.config.ts` at the root (gotcha 48).

## Commands

```bash
bun run dev                 # local Worker on readable source (config/dev overlay)
bun run build               # stage .build/ (minify, hash /a/ assets, twins, dictionaries)
bun run check:fast          # lint + typecheck + test, in parallel
bun run lint                # oxlint, type-aware
bun run typecheck
bun run test                # contract suite under bun; `test:node` runs it under node
bun run --filter cal-aadhar-sh test
bun run routes:check        # route oracle against an in-process Worker
bun run derive:check        # derived artifacts still match their inputs (gotcha 46)
bun run pages:check         # house-voice lint on page text (gotcha 32)
bun run wrangler:site <cmd> # wrangler against the site config (gotcha 48)
bun run photos <paths>      # add photos: encode, upload to R2, index, caption
```

Everything else (dictionary rolls, infra checks, perf snapshots, canaries,
probes) is in `package.json` and [docs/MAINTENANCE.md](docs/MAINTENANCE.md).

## Working in this repo

- Several agents work in this tree at once. Start from a fresh `origin/main`
  (`git fetch --prune origin`) on a named branch, ideally in a worktree. A
  modified file isn't necessarily yours, so check `git status` and
  `git reflog`, and never commit a hunk you didn't write.
- Every change goes through a PR. Nothing pushes to `main`.
- When a PR exists, turn on CI auto-fix through the Claude Code desktop app:
  `ccd_pr set_monitor` with `auto_fix: true`, `address_comments: true`. The
  session that opened the PR claims it; a second claim takes the watch over.
- Labels worth applying by hand: `hashed-asset` (the diff re-mints an `/a/`
  URL, gotcha 35) and `release-path` (it touches what decides what ships).
- `validate` is the one required check: lint, typecheck, build under the perf
  budget, `derive:check`, `routes:check`, the contract suite and cal's tests.
- Measure before you claim, and run the control that would show your
  instrument can fail. Most gotchas are an instrument that couldn't.

## Release path

`origin/main` is the source of truth. CI on a merged commit runs
`promote-production.yml`, which fast-forwards the machine-owned `production`
branch. Cloudflare Workers Builds deploys `production` with `wrangler deploy`
at 100%. Branch pushes run `versions upload`, which mints a preview URL and
moves no traffic.

- Roll back with `bun run deploy:promote --rollback`; `--status` shows what's
  serving. Never roll back past `fc50de44`, since older versions bind a
  Durable Object this Worker no longer owns.
- Secrets: `bun run wrangler:site versions secret put <NAME>`, then promote.
  Plain `wrangler secret put` is refused because it would deploy.
- No deploy path may create Cloudflare resources: every deploy command passes
  `--x-provision=false --x-auto-create=false`. Resources come from
  `bun run infra:apply`, which is workstation-only.
- CI's Cloudflare token is read-only (six read scopes). Never add an Edit scope.
- Rulesets: `main` requires a PR and `validate`, with zero bypass actors;
  `production` can only move forward. Both are declared in `config/infra.json`,
  and `bun run infra:check` diffs declared against live.
- A fix for something `infra:check`'s edge tier reads can deadlock promotion,
  because CI asserts the old production behavior. Break the cycle by
  publishing the merged commit (`bun run deploy:direct`); that's the owner's
  call.
- A Workflow class registers only on `wrangler deploy`, and a Durable Object
  lifecycle change can't ship through `versions upload`.

## Prerelease pins, on purpose

Production builds with a dated bun canary (`config/bun-pin.json`, installed by
`.github/install-bun.sh`) and a `pkg.pr.new` commit of wrangler. That's
deliberate: it runs tomorrow's toolchain today and turns what breaks into
upstream reports and fixes. The nightly bumpers (`bun:pin`, `wrangler:pin`)
advance a pin only after the canary tripwire (`canary.yml`) passes its gates,
and `tools/lib/upstream-watches.ts` tracks the upstream fixes this repo is
waiting on. [docs/DEPENDENCIES.md](docs/DEPENDENCIES.md) has the detail.

## Invariants

- **Content addressing.** `/a/` (shell assets) and `/i/` (photo tiers) URLs
  name exact bytes. Any toolchain, encoder or dictionary change must prove a
  byte-identical build, or knowingly re-mint and roll the dictionaries.
- **Authoring is buildless; serving is minified.** `tools/build.ts` is the one
  build. Every transformed asset ships a readable `.src` twin. Don't add a
  build step without the owner's say-so.
- **Design.** Native fonts only: no `@font-face url()`, web fonts or font
  preloads. Three stacks: Trebuchet MS (captions), Tahoma/Verdana (UI),
  Courier New (mono). Colors and gradients come from `design/tokens/` through
  `luna.css`; write `var(--token)`, never the resolved value. Don't modernize
  the look ([design/DESIGN.md](design/DESIGN.md)).
- **Routes** are one record each in `src/worker/routes.ts`. The
  `run_worker_first` allowlist, cache paths and write guards all derive from
  it (cap 100 rows, gotcha 26). **Pages** register in
  `config/site-manifest.json`. An `agents: true` surface needs a Markdown twin
  or a declared `mimeType`.
- **aadhar-sh implements no Durable Object.** Exporting one turns off preview
  URLs. New Durable Objects go in `aadhar-counter` and are bound by
  `script_name`.
- **Only `src/worker/index.ts` imports `cloudflare:workers`** (gotcha 16).
  **Anything that rebuilds a Response preserves `encodeBody`** (gotcha 13).
- **Preview URLs run production bindings.** `src/worker/lib/preview.ts`
  default-denies writes there, and `lib/early-data.ts` answers 425 to
  replayable writes. Keep both.
- **Workers Free.** 50 subrequests per invocation (KV counts), CPU clamps
  under load, and 200K observability events a day. Cut spans at the surface
  that emits them; never lower sampling (gotcha 36).
- **Page copy follows the house voice:** no em dashes, no AI filler, no "X,
  not Y". `pages:check` enforces part of it (gotcha 32).
- **Never guess metadata.** Photo EXIF fields are nullable and the tooltip
  skips nulls.
- **AadharshBot** (`src/worker/lib/botauth.ts`) signs every outbound content
  read (RFC 9421, Web Bot Auth) and checks robots.txt first.

## Photos

New photos come from `/Users/aadharsh/Downloads/to post (from ssd)/` and
nowhere else on disk. `bun run photos` runs the pipeline: zenc squares and
encodes (q84 JPEG, 10-bit 4:4:4 AVIF q63 speed 2), uploads originals to R2,
writes the index entry, bakes histograms and captions. Metadata comes from
`exif-sooc`; `cjpeg` (mozjpeg) draws the `/garage/encoding` grids. Run
`bun run tools:check` before a pipeline session and `bun run photos:check`
after. [docs/PHOTO-PIPELINE.md](docs/PHOTO-PIPELINE.md) has the rest.

## Observability

Workers Logs (one line per request), Analytics Engine (`BOT_LEDGER`,
`PERF_PROBE`), Workers Traces (spans named `<surface>.<phase>` through
`lib/trace.ts`; spans read 0ms for CPU by design), and Workers Issues. Issues
reach GitHub through a Claude Code routine whose prompt is committed at
`docs/routines/workers-issue-triage.md`. Edit it there, then paste it into the
routine.

## Where to read next

- `src/worker/routes.ts`, `dispatch.ts`, `index.ts`: routing
- `src/worker/home.ts` (header): how `/` stays a static document with islands
- `src/worker/lens-pipeline.ts`: one pipeline for every `/lens` door
- `src/worker/lib/mcp-protocol.ts`: the dual-era MCP rules both servers share
- [docs/MAINTENANCE.md](docs/MAINTENANCE.md): task runbooks
- [docs/GOTCHAS.md](docs/GOTCHAS.md): the traps, by number
