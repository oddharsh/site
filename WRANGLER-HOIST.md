# Wrangler workspace hoist — migration notes (DO NOT MERGE until step 2 is done)

This branch (`chore/wrangler-workspace-hoist`) collapses the five separate
Wrangler installs (root + `cal` + `cf-garage` + `lwe-ask` + `serendipity`, each
carrying its own ~180MB toolchain) into **one hoisted install** via npm
workspaces. Wrangler is declared and pinned exactly once in the root
`package.json`; workspace scripts resolve that root binary through npm's
workspace PATH. The re-pin to Wrangler 4.111.0 already landed separately; this
is the "stop installing the same toolchain five times" change.

**It cannot ship until the Cloudflare Workers Builds projects are reconfigured
(step 2), because that is where the current per-subdir `npm ci` lives.** Merging
this to `main` before the dashboard change would break the coffee and
serendipity production deploys. It is staged on its own branch for exactly that
reason.

## What the repo change does

- `package.json` gains `"workspaces": ["cal", "cf-garage", "lwe-ask", "serendipity"]`.
- The root `package.json` is the only manifest that declares Wrangler. The four
  workspace manifests use the shared root binary rather than repeating the pin.
- The four sub-`package-lock.json` files are deleted; there is now one root
  lockfile that resolves every project's deps together and hoists the shared
  Wrangler toolchain to the root `node_modules`.
- `scripts/check-wrangler.mjs` is rewritten to validate the single workspace
  lockfile instead of five separate ones, and fails if a workspace adds a
  duplicate direct Wrangler declaration or install.
- `.github/workflows/ci.yml` drops the four per-subdir `npm ci` steps; one root
  `npm ci` now installs the whole workspace. The per-worker validation still runs
  as `wrangler deploy --dry-run -c <dir>/wrangler.toml` from the root install
  (the pattern CI already used for cal + serendipity).
- `.github/dependabot.yml` watches the root npm manifest weekly and opens one
  Wrangler-only PR. CI checks the exact root pin, lockfile, workspace tests,
  builds, and every Worker dry-run before merge.

## Step 1 — materialize the hoist locally (safe, reversible)

```bash
git switch chore/wrangler-workspace-hoist
rm -rf node_modules cal/node_modules cf-garage/node_modules lwe-ask/node_modules serendipity/node_modules
npm install                 # one hoisted install for the whole workspace
npm run check-wrangler      # must pass: one deploy-path Wrangler 4.111.0
npx wrangler deploy --dry-run                              # homepage
npx wrangler deploy --dry-run -c cal/wrangler.toml         # coffee
npx wrangler deploy --dry-run -c serendipity/wrangler.toml # serendipity
npx wrangler deploy --dry-run -c lwe-ask/wrangler.toml
npx wrangler deploy --dry-run -c cf-garage/wrangler.toml
npm test        # homepage contracts
npm test -w cal # coffee worker tests (vitest resolves from the hoisted install)
```

If every dry-run and test passes, the hoist works locally.

## Step 2 — reconfigure Workers Builds (REQUIRED before merge; dashboard-only)

The three production Workers Builds projects deploy from the `production` branch.
Today each is rooted at its own subdirectory and runs `npm ci` there. With one
root lockfile, a subdir has no lockfile, so `npm ci` in a subdir fails. Point
each build at the repo root and deploy the specific worker with `-c`:

| Workers Builds project | Root directory | Deploy command |
|---|---|---|
| homepage (`aadhar-sh`) | `.` (unchanged) | `npx wrangler deploy` (unchanged — self-builds via build.command) |
| coffee (`cal-aadhar-sh`) | change `cal` → `.` | `npx wrangler deploy -c cal/wrangler.toml` |
| serendipity | change `serendipity` → `.` | `npx wrangler deploy -c serendipity/wrangler.toml` |

Leave each project's separate dashboard Build command blank (Wrangler owns the
homepage build via `wrangler.jsonc`'s `build.command`; the satellites have no
build step). `lwe-ask` and `cf-garage` deploy by hand, not via Workers Builds —
run them from the repo root with `npx wrangler deploy -c <dir>/wrangler.toml`
(or `npm run -w lwe-ask deploy`).

## Step 3 — merge

Only after step 2 is live and the dry-runs in step 1 pass. Then a normal merge
to `main` promotes to `production`, and the reconfigured Workers Builds projects
deploy from the single hoisted install.

## Ongoing pin maintenance

Dependabot monitors only the root npm manifest and opens a single weekly PR for
the exact Wrangler pin. There is no second updater workflow and no per-project
lockfile for it to keep synchronized. The normal CI job is the gate for those
PRs; it runs `check-wrangler`, which rejects both a stale root lock and a new
workspace-local Wrangler declaration.

For a manual refresh, run this from the repository root and commit the root
manifest plus lockfile together:

```bash
npm install --ignore-scripts --no-audit --no-fund --save-dev --save-exact wrangler@4.112.0
npm run check-wrangler
```

## Known caveat

`cal`'s test dependency `@cloudflare/vitest-pool-workers` pulls its own nested
Wrangler (a transitive of the test tool, not the deploy path). `check-wrangler`
reports it rather than failing, because forcing it to match via an `overrides`
entry de-hoists the primary install (npm plants a per-workspace copy in every
project — the opposite of the goal). The deploy path uses the single root
Wrangler; the test tool's copy only matters for `npm test -w cal`.

## To abandon this branch

Nothing here touched `main` or the live deploys. Delete the branch and
`npm ci` on your working branch to restore the per-project installs.
