#!/usr/bin/env node
// check-routes-harness.mjs — run the route oracle BEFORE the merge.
//
// verify-routes.mjs has always needed something already serving: production
// (which means the deploy that broke a route already happened) or a wrangler dev
// somebody remembered to start. Wrangler 4.112+ ships createTestHarness(), which
// boots this repo's Worker in-process on a real loopback port, so the same table
// can gate a PR instead of only auditing a deployment.
//
//   npm run routes:check                 # build dist/, boot the Worker, sweep, exit non-zero
//
// It points at wrangler.jsonc, NOT wrangler.dev.jsonc, deliberately: that config
// carries `build.command`, so the harness runs the static compiler and serves
// the same `dist/` tree a deploy would ship. VERIFY_BUILT=1 makes the oracle
// assert generated assets and discovery files as well as request behavior.
//
// What this does NOT prove: local KV/R2/D1 come up EMPTY, so data-backed routes
// answer from their fallback path. Status and content-type are real; a passing
// /images/manifest.json here means the handler works, not that the photos exist.
// Rows tagged `remote` in verify-routes.mjs are skipped for that reason. The
// post-deploy `node verify-routes.mjs` sweep against production stays the check
// that sees real content, and neither one replaces the other.

import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createTestHarness } from "wrangler";

const root = fileURLToPath(new URL("..", import.meta.url));
const args = process.argv.slice(2);

// --remote boots the harness on a generated config whose KV/R2/Browser bindings
// reach PRODUCTION (scripts/gen-remote-config.mjs), which un-skips the five rows
// verify-routes.mjs marks `remote` — the ones whose whole assertion is content a
// local Worker structurally cannot have. That closes the gap this file's own
// header admits to ("local KV/R2/D1 come up EMPTY, so data-backed routes answer
// from their fallback path"): with it, a passing /images/manifest.json means the
// photos are really there, not just that the handler runs.
//
// It closes PART of it. Remote bindings cover KV/R2/D1/Browser and cannot cover
// SECRETS, so /lens/fetch and /lens/shot (which want the AadharshBot signing key)
// need a gitignored .dev.vars on top. /around/json, /photos and /images/full go
// green on the bindings alone. Expect a partial pass on a clean checkout; that is
// the tool being honest, not broken.
//
// Workstation-only, and CI must never pass it. Remote bindings stand up a proxy
// Worker in the account, which takes a token that can write; the read-only token
// CI holds cannot do it, and widening that token is the one thing this repo's
// release design will not trade away. `npm run routes:check` stays the CI gate
// and stays honest about what it does not see.
const remote = args.includes("--remote");
const positional = args.find((a) => !a.startsWith("--"));

let config = positional || "./wrangler.jsonc";
if (remote) {
  if (process.env.CI) {
    console.error("routes:check --remote cannot run in CI (remote bindings need a write-capable token).");
    process.exit(2);
  }
  // No --out: the generator's default is the repo root, which is where the twin
  // has to live for wrangler.jsonc's relative `main` and `assets.directory` to
  // keep resolving (see gen-remote-config.mjs).
  const gen = spawnSync(
    process.execPath,
    ["scripts/gen-remote-config.mjs", config],
    { cwd: root, stdio: "inherit" },
  );
  if (gen.status !== 0) process.exit(gen.status ?? 1);
  config = "./.wrangler.remote.jsonc";
}

const server = createTestHarness({ workers: [{ configPath: config }] });

let code = 1;
try {
  const t0 = Date.now();
  const { url } = await server.listen();
  console.log(`harness: ${config} booted in ${Date.now() - t0}ms at ${url}`);

  code = await new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["verify-routes.mjs", String(url).replace(/\/$/, "")],
      { cwd: root, stdio: "inherit", env: { ...process.env, VERIFY_BUILT: "1", ...(remote ? { VERIFY_REMOTE: "1" } : {}) } },
    );
    child.on("error", reject);
    child.on("exit", (status, signal) => resolve(signal ? 1 : status ?? 1));
  });
} finally {
  // workerd holds the process open; close() before the exit code is reported.
  await server.close();
}

process.exit(code);
