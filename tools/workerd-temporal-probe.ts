#!/usr/bin/env node
// node tools/workerd-temporal-probe.ts
//
// WHY IT EXISTS. V8's Temporal is compiled into workerd and switched off, and
// no compatibility flag turns it on (measured 2026-09-23 on 1.20260921.1).
// Cloudflare has shipped it once already: cloudflare/workerd#6907 exposed a
// Temporal whose `Now` read epoch 0 during requests, and the revert took two
// attempts. Every `typeof Temporal` guard in Worker code silently switched
// paths that week. serendipity.ts had two such guards and dropped them for
// Date, so the site no longer changes behaviour when this flips; this probe
// is how the canary leg notices that it did.
//
// It boots the Worker through wrangler's own `createTestHarness`, the door
// workerd-zstd-probe.ts and the route oracle use, so the workerd under test is
// whichever one the `wrangler` this file resolves to depends on: the pinned
// tree's from the repository root, the candidate's from the detached worktree
// the canary leg installs into. Nothing is written outside a temp directory it
// removes. Under node, never bun, for the reason that probe gives (gotcha 38).

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestHarness } from "wrangler";
import { siteConfig } from "./lib/site-config.ts";

const WORKER = `
export default {
  fetch() {
    const present = typeof Temporal !== "undefined";
    let skewMs = null;
    if (present) {
      try { skewMs = Number(Temporal.Now.instant().epochMilliseconds) - Date.now(); } catch (_e) { skewMs = null; }
    }
    return Response.json({ present, skewMs });
  },
};
`;

const site = await siteConfig();
const dir = mkdtempSync(join(tmpdir(), "workerd-temporal-probe-"));
try {
  writeFileSync(join(dir, "worker.mjs"), WORKER);
  writeFileSync(join(dir, "wrangler.jsonc"), JSON.stringify({
    name: "workerd-temporal-probe",
    main: "./worker.mjs",
    compatibility_date: site.compatibility_date,
    compatibility_flags: site.compatibility_flags,
  }));
  const server = createTestHarness({ workers: [{ configPath: join(dir, "wrangler.jsonc") }] });
  try {
    await server.listen();
    const res = await server.fetch("/");
    const body = await res.text();
    if (!res.ok) throw new Error(`probe worker answered ${res.status}: ${body.slice(0, 200)}`);
    console.log(JSON.stringify({ ...JSON.parse(body), date: site.compatibility_date }));
  } finally {
    await server.close();
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
