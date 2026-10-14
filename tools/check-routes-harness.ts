#!/usr/bin/env node
// check-routes-harness.mjs — run the route oracle BEFORE the merge.

import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { createTestHarness } from "wrangler";
import { writeSiteConfigFile } from "./lib/site-config.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const { values, positionals } = parseArgs({
  options: { remote: { type: "boolean" }, prebuilt: { type: "string" } },
  allowPositionals: true,
});
if (positionals.length > 1 || values.prebuilt === "") {
  console.error("usage: routes:check [config] [--remote] [--prebuilt <dry-run directory>]");
  process.exit(2);
}

const remote = values.remote;
const [positional] = positionals;

// The default is the site config projected into the legacy shape the harness
// reads (tools/lib/site-config.ts): createTestHarness takes a config PATH or an
// inline legacy object and has no door for cloudflare.config.ts, which replaced
// wrangler.jsonc on 2026-09-28. A local run takes the credential-free twin,
// which drops the bindings that only exist remotely (REMOTE_ONLY_KEYS, the AI
// binding); --remote takes the full projection, since it has a credential.
let config = positional || "./" + (await writeSiteConfigFile({ localOnly: !values.remote }));
if (remote) {
  if (process.env.CI) {
    console.error("routes:check --remote cannot run in CI (remote bindings need a write-capable token).");
    process.exit(2);
  }
  const gen = spawnSync(
    process.execPath,
    ["tools/gen-remote-config.ts", config],
    { cwd: root, stdio: "inherit" },
  );
  if (gen.status !== 0) process.exit(gen.status ?? 1);
  config = "./.wrangler.remote.jsonc";
}

// The site's COUNTER binding names the aadhar-counter Worker since step 3 of
// "Moving Counter out" (CLAUDE.md), and workerd refuses to start a Worker whose
// binding names a service nobody defined. So the counter boots beside the site:
// the site stays first, which is the one the harness URL serves.
const server = createTestHarness({
  workers: [
    { configPath: config, prebuiltWorkerDir: values.prebuilt },
    { configPath: `${root}counter/wrangler.jsonc` },
  ],
});

let code = 1;
try {
  const t0 = Date.now();
  const { url } = await server.listen();
  console.log(`harness: ${config} booted in ${Date.now() - t0}ms at ${url}`);

  const childEnv: Record<string, string | undefined> = { ...process.env, VERIFY_BUILT: "1" };
  if (remote) childEnv.VERIFY_REMOTE = "1";

  code = await new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["tools/verify-routes.ts", String(url).replace(/\/$/, "")],
      { cwd: root, stdio: "inherit", env: childEnv },
    );
    child.on("error", reject);
    child.on("exit", (status, signal) => resolve(signal ? 1 : status ?? 1));
  });
} finally {
  // workerd holds the process open; close() before the exit code is reported.
  await server.close();
}

process.exit(code);
