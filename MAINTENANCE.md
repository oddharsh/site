# Maintenance

This is the operational runbook for the blank-slate aadhar.sh implementation.
The release and safety invariants in `CLAUDE.md` remain authoritative.

## Daily development

Start substantial work in a fresh worktree from `origin/main`:

```bash
git fetch --prune origin
git worktree add ../site-<topic> -b codex/<topic> origin/main
cd ../site-<topic>
npm ci
```

Build and browse locally:

```bash
npm run dev -- --port 8790
```

The build is deterministic and recreates `dist/`. Never edit generated output.
For a focused loop, edit the canonical file under `content/`, `src/site/`,
`src/worker/`, `src/contracts/`, `assets/`, or `public/`, then rebuild.

## Full validation

```bash
npm run build
npm test
npm run perf-budget
npm run photos:check
npm run types:check
npm run check-wrangler
npm run routes:check
npm run infra:check -- --offline
npx wrangler deploy --dry-run
npx wrangler deploy --dry-run -c cf-garage/wrangler.toml
npx wrangler deploy --dry-run -c lwe-ask/wrangler.toml
git diff --check
```

`npm run routes:check` boots `wrangler.jsonc` in-process and performs 148
acceptance checks. It covers every generated page, available Markdown
negotiation, RSS feeds, security headers, live empty/fail-closed states, machine
endpoints, MCP, retired paths, redirects, and method behavior. A restricted
sandbox can block its loopback socket with `EPERM`; rerun it in a normal
workstation shell.

The offline infrastructure check verifies repo declarations. Run
`npm run infra:check` without `--offline` when current DNS, edge configuration,
repository rulesets, Workers Builds settings, and account resources are part of
the task. It is read-only.

## Content

### Homepage

Edit `content/home.json`; `src/site/pages/home.mjs` owns its structure. Rebuild
and review both `/` and `/index.md`.

### Writing

1. Add the canonical plain text to `content/writing/<slug>.txt`.
2. Add `{slug,title,date}` to `content/writing/posts.json`.
3. Run `npm run build` and `npm test`.

The compiler emits an editable Notepad-like HTML view, the original `.txt`, the
section index, and `/writing/feed.xml`. Editing in the browser is intentionally
ephemeral.

### Garage and LWE

Each page is a Markdown record with front matter under
`content/pages/<family>/<slug>.md`. Register public metadata in
`site-manifest.json`. The shared article renderer emits HTML and an explicit
Markdown representation.

The `updated` date in each page's front matter orders the generated
`/<family>/feed.xml`. The compiler escapes the registry description into RSS;
do not author or commit feed XML separately.

These pages are documents, not miniature applications. Add client code only
when an interaction itself is the subject and a static explanation cannot do
the job. Such a module must be route-scoped, removable, accessible, and remain
under the JavaScript budget with browser evidence.

### Public surface registry

`site-manifest.json` is the canonical registry for page discovery, search,
sitemap, and section projection. Do not edit generated search, sitemap, or
`llms` output in `dist/`.

## Machine contracts

Edit `src/contracts/mcp.json`, then run:

```bash
npm run gen:mcp-cards
npm run build
npm test
npm run routes:check
```

The command regenerates the site and Serendipity server cards, agent card, API
catalog, and skill index. Live `server/discover` and `tools/list` use the same
registry. A tool schema is closed and bounded; its runtime must stay read-only
unless an explicitly documented human workflow owns a write.

`src/contracts/crawlers.json` is the scheduled-crawl target list. Scheduled
jobs store normalized fields, timestamps, status, headers where needed, and
digests—not raw third-party response bodies.

## Photos

The complete workflow is in [PHOTO-PIPELINE.md](PHOTO-PIPELINE.md). Validate the
committed graph at any time with:

```bash
npm run photos:check
```

The `Remote photo pipeline` Action downloads source objects into ephemeral
runner storage and opens a PR containing only generated public artifacts.

## Local and remote bindings

Normal local dev uses isolated KV, D1, R2, Durable Objects, and Workflows.
To debug against supported production bindings:

```bash
npm run dev:remote
```

The generated `.wrangler.remote.jsonc` points KV, R2, and Browser at live
resources. D1 remains local; pass `--d1` only when production rows are genuinely
required. Remote bindings need write-capable Cloudflare authentication and are
for a workstation, never CI. Secrets remain local in `.dev.vars`.

## Checkpoints and release status

Stage the next public release record in the same PR as the change:

```bash
./scripts/bump-checkpoint.sh <slug> "<human title>"
npm run checkpoints:check
```

The first command edits only `content/data/checkpoints.json`. During a ramp,
`scripts/deploy-promote.mjs` writes the new rows to `aadhar-restore` only after
100% traffic succeeds. `npm run release` reports the commit/version relationship.

## Secrets

Because this project uploads versions before moving traffic, use:

```bash
npx wrangler versions secret put -c wrangler.jsonc <NAME>
```

Merge feature code first, attach its secret to the uploaded version second, and
ramp that resulting version third. `wrangler secret put` can deploy as a side
effect and is not the workflow here.

## Release

Normal release path:

1. Open a draft PR from a named branch.
2. Make CI green and mark the PR ready when the change is reviewable.
3. Merge to protected `main`.
4. Let CI advance `production` to the exact tested merged commit.
5. Workers Builds uploads a version without moving traffic.
6. Inspect the preview and logs.
7. Run `npm run deploy:promote` and inspect at 10%, 50%, and 100%.

Useful commands:

```bash
npm run deploy:promote -- --status
npm run deploy:promote
npm run deploy:promote -- --rollback
```

`npm run deploy` moves directly to 100% and is reserved for a deliberate
fallback. Validation never authorizes a release.

## Infrastructure

`infra.json` declares public DNS, edge rules, repository rulesets, resources,
Worker inventory, Workers Builds settings, and the curated CodeQL default setup.
IDs stay in Wrangler configs. CodeQL language aliases are compared as a set;
the assertion is workstation-only because GitHub's endpoint needs repository
Administration read permission, which a workflow `GITHUB_TOKEN` cannot hold.

```bash
npm run infra:check             # read-only comparison with live state
npm run infra:apply             # plan only
npm run infra:apply -- --confirm
```

Only the confirmed final form may mutate zone-level infrastructure. It is
workstation-only and requires the separate `CLOUDFLARE_API_TOKEN_WRITE`.

## Deliberate migrations

The normal Workers Builds command is `wrangler versions upload`, which cannot
apply a Durable Object class lifecycle migration. A new, renamed, transferred,
or deleted class therefore requires an explicit one-time deployment plan; a
feature PR must not quietly append a migration and leave the branch publisher
red. Coffee slot reservations intentionally reuse isolated instances in the
established `COUNTER` namespace for this reason.

- `/sw.js` is an unregister stub and must continue returning 200 while old
  installations age out.
- Legacy `/images/<stem>.<ext>` URLs redirect to the current content-addressed
  `/i/` bytes.
- `cal.aadhar.sh/*` redirects with method preservation to the canonical
  `/coffee` path.
- Retired Serendipity cookie/sync mutations return `410 Gone`.
