#!/usr/bin/env node
// check-routes-harness.mjs — run the route oracle BEFORE the merge.
//
// verify-routes.mjs has always needed something already serving: production
// (which means the deploy that broke a route already happened) or a wrangler dev
// somebody remembered to start. Wrangler 4.112+ ships createTestHarness(), which
// boots this repo's Worker in-process on a real loopback port, so the same table
// can gate a PR instead of only auditing a deployment.
//
//   npm run routes:check                 # boot .build/holding, sweep, exit non-zero on failure
//
// It points at wrangler.jsonc, NOT wrangler.dev.jsonc, deliberately: that config
// carries `build.command`, so the harness runs build.mjs itself and serves the
// minified tree with the /a/<hash8> shell — the bytes a deploy would ship. That
// is also why VERIFY_BUILT=1 is set, which re-arms the build-output rows
// (minified banners, .src twins, the luna.css size ceiling) that verify-routes
// otherwise skips on a local base.
//
// What this does NOT prove: local KV/R2/D1 come up EMPTY, so data-backed routes
// answer from their fallback path. Status and content-type are real; a passing
// /images/manifest.json here means the handler works, not that the photos exist.
// Rows tagged `remote` in verify-routes.mjs are skipped for that reason. The
// post-deploy `node verify-routes.mjs` sweep against production stays the check
// that sees real content, and neither one replaces the other.

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createTestHarness } from "wrangler";

const root = fileURLToPath(new URL("..", import.meta.url));
const config = process.argv[2] || "./wrangler.jsonc";

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
      { cwd: root, stdio: "inherit", env: { ...process.env, VERIFY_BUILT: "1" } },
    );
    child.on("error", reject);
    child.on("exit", (status, signal) => resolve(signal ? 1 : status ?? 1));
  });
} finally {
  // workerd holds the process open; close() before the exit code is reported.
  await server.close();
}

process.exit(code);
