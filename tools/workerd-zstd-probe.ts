#!/usr/bin/env node
// node tools/workerd-zstd-probe.ts
//
// Does the workerd that THIS tree's wrangler ships honour `zstdCompressSync`'s
// `dictionary` option? It prints one JSON line, `{ none, good, wrong }`, the
// three byte counts the four-line control in lib/bun-pin.ts describes, and
// `interpretZstdProbe` there is what reads it: honoured means the right
// dictionary alone came back smaller.
//
// WHY IT EXISTS. workerd accepts the option and ignores it (measured
// 2026-08-05, gotcha 14), which is why every dcz delta here is built at
// deploy time and the runtime tier that would take another ~25% off the
// non-precompressed pages is parked. cloudflare/workerd#7106 is this
// repository's fix for that; the day it ships in a workerd release, the
// wrangler pin picks it up within a day, and this probe is how the canary leg
// notices. The failure it is watching for is SILENT in every runtime: a frame
// compressed without the dictionary still decodes against it, so nothing
// throws and the only signal is a byte count that never shrank.
//
// It boots the Worker through wrangler's own `createTestHarness`, the door the
// route oracle already uses, so the workerd under test is whichever one the
// `wrangler` this file resolves to depends on: the pinned tree's from the
// repository root, the candidate's from the detached worktree the canary leg
// installs into. Nothing is written outside a temp directory it removes.
//
// Under node, never bun: wrangler refuses bun per command (gotcha 38), and a
// harness that hung would read as the probe failing rather than as its answer.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestHarness } from "wrangler";

const WORKER = `
import { zstdCompressSync } from "node:zlib";
export default {
  fetch() {
    const target = Buffer.from(("export const NAV_SHELL = {taskbar:1,start:1,clock:1};").repeat(400));
    const n = (o) => zstdCompressSync(target, o).length;
    return Response.json({
      none:  n({}),
      good:  n({ dictionary: target.subarray(0, 4096) }),
      wrong: n({ dictionary: Buffer.alloc(4096, 0x78) }),
    });
  },
};
`;

const dir = mkdtempSync(join(tmpdir(), "workerd-zstd-probe-"));
try {
  writeFileSync(join(dir, "worker.mjs"), WORKER);
  writeFileSync(join(dir, "wrangler.jsonc"), JSON.stringify({
    name: "workerd-zstd-probe",
    main: "./worker.mjs",
    compatibility_date: "2026-09-01",
    compatibility_flags: ["nodejs_compat"],
  }));
  const server = createTestHarness({ workers: [{ configPath: join(dir, "wrangler.jsonc") }] });
  try {
    await server.listen();
    const res = await server.fetch("/");
    const body = await res.text();
    if (!res.ok) throw new Error(`probe worker answered ${res.status}: ${body.slice(0, 200)}`);
    console.log(body.trim());
  } finally {
    await server.close();
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
