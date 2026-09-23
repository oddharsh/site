#!/usr/bin/env node
// node tools/workerd-temporal-probe.ts
//
// Does the workerd that THIS tree's wrangler ships expose a Temporal whose
// clock agrees with Date.now(), under production's compatibility date and
// flags? It prints one JSON line, `{ present, skewMs, date }`, and
// `interpretTemporalProbe` in lib/upstream-watches.ts is what reads it.
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
// The CLOCK is half the answer on purpose. "Present" alone would read landed
// on exactly the build #6907 describes, which is the one build this repository
// most needs to hear about as NOT landed.
//
// It boots the Worker through wrangler's own `createTestHarness`, the door
// workerd-zstd-probe.ts and the route oracle use, so the workerd under test is
// whichever one the `wrangler` this file resolves to depends on: the pinned
// tree's from the repository root, the candidate's from the detached worktree
// the canary leg installs into. Nothing is written outside a temp directory it
// removes. Under node, never bun, for the reason that probe gives (gotcha 38).

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestHarness } from "wrangler";
import { parseJsonc } from "./lib/jsonc.ts";

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

// Production's date and flags, read from the tree under test, because the
// question is what the SITE's Worker would see rather than what the newest
// compatibility date allows.
const site = parseJsonc(readFileSync("wrangler.jsonc", "utf8"));
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
