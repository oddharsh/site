# Wrangler workspace hoist — migration notes (DO NOT MERGE until step 2 is done)

This branch (`chore/wrangler-workspace-hoist`) collapses the five separate
Wrangler installs (root + `cal` + `cf-garage` + `lwe-ask` + `serendipity`, each
carrying its own ~180MB toolchain) into **one hoisted install** via npm
workspaces. The re-pin to Wrangler 4.111.0 already landed separately; this is
purely the "stop installing the same toolchain five times" change.

**It cannot ship until the Cloudflare Workers Builds projects are reconfigured
(step 2), because that is where the current per-subdir `npm ci` lives.** Merging
this to `main` before the dashboard change would break the coffee and
serendipity production deploys. It is staged on its own branch for exactly that
reason.

## What the repo change does

- `package.json` gains `"workspaces": ["cal", "cf-garage", "lwe-ask", "serendipity"]`.
- The four sub-`package-lock.json` files are deleted; there is now one root
  lockfile that resolves every project's deps together and hoists the shared
  Wrangler toolchain to the root `node_modules`.
- `scripts/check-wrangler.mjs` is rewritten to validate the single workspace
  lockfile instead of five separate ones.
- `.github/workflows/ci.yml` drops the four per-subdir `npm ci` steps; one root
  `npm ci` now installs the whole workspace. The per-worker validation still runs
  as `wrangler deploy --dry-run -c <dir>/wrangler.toml` from the root install
  (the pattern CI already used for cal + serendipity).
- `.github/workflows/update-wrangler.yml` bumps Wrangler once at the root plus
  each workspace `package.json`, then regenerates the single lockfile.

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

## Known caveat

`cal`'s test dependency `@cloudflare/vitest-pool-workers` pulls its own nested
Wrangler (a transitive of the test tool, not the deploy path). `check-wrangler`
warns on it rather than failing, because forcing it to match via an `overrides`
entry de-hoists the primary install (npm plants a per-workspace copy in every
project — the opposite of the goal). The deploy path uses the single root
Wrangler; the test tool's copy only matters for `npm test -w cal`.

## To abandon this branch

Nothing here touched `main` or the live deploys. Delete the branch and
`npm ci` on your working branch to restore the per-project installs.
