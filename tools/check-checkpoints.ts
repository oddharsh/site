#!/usr/bin/env node

// check-checkpoints.ts: does the committed projection still match D1, and has
// every release that reached production been recorded there?
//
// D1 is the record of what SHIPPED; src/worker/checkpoints.json is what a
// release CLAIMS to be, staged in its PR by bump-version.sh, and build.ts renders
// /updates and /restore from it. So the projection may run ahead of D1. What it
// may not do is disagree with D1 about a row both hold, or carry a released
// entry D1 never got.
//
// Drift is not cosmetic. The pages are precomputed at build time, so a stale
// projection means /updates and /restore silently ship the PREVIOUS log, and a
// D1 that misses rows is a history the restore story can't stand on.
//
//   bun run checkpoints:check         compare the projection, D1 and production
//   bun run checkpoints:sync          rewrite the file from D1 (then commit it)
//   bun run checkpoints:record        insert released-but-unrecorded rows into D1
//
// NOTHING ON THE RELEASE PATH WRITES D1 since 2026-09-28 (#1002). Production
// ships through promote-production.yml and Workers Builds' `wrangler deploy`,
// and CI's Cloudflare token is read-only by rule. deploy-promote.ts still writes
// the row at the end of a manual ramp to 100%, which normal releases no longer
// run. So `checkpoints:record` is the writer: a workstation step after a release
// that carried a bump-version.sh entry (docs/MAINTENANCE.md, "Release a change").
// tools/lib/checkpoints.ts defines "released" and holds the INSERT.
//
// Needs a D1 read: your `cf auth login` locally (tools/lib/cf.ts). It is NOT in
// the PR job; ci.yml lists it with the other network checks run by hand.

import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { D1, d1Rows } from "./lib/cf.ts";
import { checkpointInsert, PROJECTION, RELEASED_REF, releasedProjection, shippedAt } from "./lib/checkpoints.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FILE = path.join(ROOT, PROJECTION);
const SYNC = process.argv.includes("--sync");
const RECORD = process.argv.includes("--record");

function fail(msg: string): never {
  console.error(`checkpoints: ${msg}`);
  process.exit(1);
}

// The fields a checkpoints.json row carries, in vnum order: --sync writes these
// rows out as the file.
const QUERY = "SELECT vnum, ymd, version, slug, title FROM checkpoints ORDER BY vnum;";

if (RECORD && process.env.CI) {
  fail("--record writes D1, and CI holds a read-only Cloudflare token by rule. Run it from a workstation.");
}
// --record acts on what production carries, so it reads a fresh ref. The check
// reads whatever origin/production the clone already has and names its sha.
if (RECORD) {
  try {
    execFileSync("git", ["fetch", "--quiet", "origin", "production"], { cwd: ROOT, stdio: "inherit" });
  } catch {
    fail("could not fetch origin/production, so what shipped is unknown. Nothing was written.");
  }
}

let live;
try {
  live = await d1Rows(D1["aadhar-restore"], QUERY);
} catch (e) {
  // An unreachable D1 is an availability problem, not drift. Say so and do not
  // fail over someone else's outage or a missing local login. A first run can
  // land here too: `bun x cf@<pin>` prints its install to stderr, and that is
  // what this message then quotes.
  console.error(`checkpoints: could not read D1 (${String(e.message || e).slice(0, 120)})`);
  console.error("  this is an availability problem, not drift: not failing");
  process.exit(RECORD ? 1 : 0);
}

if (SYNC) {
  await writeFile(FILE, JSON.stringify(live, null, 2).replace(/\n$/, "") + "\n");
  console.log(`checkpoints: synced ${live.length} rows from D1 -> ${PROJECTION}`);
  console.log("  commit it, then deploy: /updates and /restore render from this file");
  process.exit(0);
}

let committed;
try {
  committed = JSON.parse(await readFile(FILE, "utf8"));
} catch {
  fail(`${PROJECTION} is missing or unparseable: run bun run checkpoints:sync`);
}

const byVnum = (rows): Map<number, any> => new Map(rows.map((r) => [r.vnum, r]));
const c = byVnum(committed),
  l = byVnum(live);
const liveMax = live.length ? Math.max(...l.keys()) : 0;

// "Ahead" is legal and "behind" never is. A projection row BELOW D1's high
// -water mark that D1 does not have is not pending, it is a rewrite of history.
const pending = committed.filter((r) => !l.has(r.vnum) && r.vnum > liveMax).sort((a, b) => a.vnum - b.vnum);
const pendingVnums = new Set(pending.map((r) => r.vnum));

const diffs: string[] = [];
for (const [vnum, row] of l) {
  const mine = c.get(vnum);
  if (!mine) {
    diffs.push(`v${vnum} present in D1, absent from the projection`);
    continue;
  }
  for (const k of ["ymd", "version", "slug", "title"]) {
    if (mine[k] !== row[k]) diffs.push(`v${vnum} ${k}: projection ${JSON.stringify(mine[k])} vs D1 ${JSON.stringify(row[k])}`);
  }
}
for (const vnum of c.keys()) {
  if (!l.has(vnum) && !pendingVnums.has(vnum)) {
    diffs.push(`v${vnum} present in the projection, absent from D1, and BELOW D1's newest (v${liveMax}): that is a rewrite, not a pending release`);
  }
}
// The tail has to be contiguous. A gap means a vnum was minted, shipped or
// abandoned somewhere this check cannot see, and silently renumbering around it
// would put two different releases on one number later.
pending.forEach((row, i) => {
  const expected = liveMax + i + 1;
  if (row.vnum !== expected) diffs.push(`pending v${row.vnum} breaks the sequence: expected v${expected} after D1's v${liveMax}`);
});

if (diffs.length) {
  fail(
    `${diffs.length} row(s) differ from D1:\n` +
      diffs
        .slice(0, 8)
        .map((d) => `  - ${d}`)
        .join("\n") +
      (diffs.length > 8 ? `\n  … and ${diffs.length - 8} more` : "") +
      `\n  fix with: bun run checkpoints:sync && git add ${PROJECTION}`,
  );
}

// Unrecorded rows come from PRODUCTION's projection, never this tree's: an
// entry there is serving on /updates already, and a stale worktree (gotcha 24)
// must not hide one or record a different title than the one that shipped.
// An entry only in this tree is genuinely staged.
const released = releasedProjection(ROOT);
const shippedVnums = new Set((released?.rows ?? []).map((r) => r.vnum));
const unrecorded = (released?.rows ?? []).filter((r) => !l.has(r.vnum)).sort((a, b) => a.vnum - b.vnum);
const staged = pending.filter((r) => !shippedVnums.has(r.vnum));
const at = released ? `${RELEASED_REF} ${released.sha.slice(0, 8)}` : RELEASED_REF;
// The same contiguity rule as the tree's tail, for the same reason.
unrecorded.forEach((row, i) => {
  if (row.vnum !== liveMax + i + 1)
    fail(`${at} carries v${row.vnum}, which D1 lacks, out of sequence after D1's v${liveMax}. Nothing was written; read both before recording.`);
});

if (RECORD) {
  if (!released) fail(`${RELEASED_REF} has no ${PROJECTION}, so nothing can be called released. Nothing was written.`);
  if (!unrecorded.length) {
    console.log(`checkpoints: nothing to record. D1 holds every entry ${at} carries (newest v${liveMax}).`);
    process.exit(0);
  }
  // Oldest first, so a failure part way leaves D1 a contiguous prefix and the
  // next run picks up where this one stopped.
  for (const row of unrecorded) {
    const ts = shippedAt(ROOT, released.sha, row.vnum);
    try {
      await d1Rows(D1["aadhar-restore"], checkpointInsert(row, ts));
    } catch (e) {
      fail(`could not record v${row.vnum} (${String(e.message || e).slice(0, 120)}). Rows before it were written; rerun to continue.`);
    }
    console.log(`recorded: v${row.vnum} ${row.version} (shipped ${new Date(ts * 1000).toISOString().slice(0, 16)}Z)`);
  }
  console.log("checkpoints: run bun run checkpoints:check to confirm.");
  process.exit(0);
}

const newest = live[live.length - 1];
console.log(`checkpoints: projection and D1 agree on all ${live.length} recorded rows (newest v${newest.vnum} ${newest.version}, ${newest.ymd})`);
if (!released) {
  console.log(`  ${RELEASED_REF} is not in this clone, so released and staged can't be told apart. Run: git fetch origin production`);
}
if (staged.length) {
  console.log(`  ${staged.length} staged, not on ${at} yet:`);
  for (const row of staged) console.log(`    v${row.vnum} ${row.version}: ${row.title.slice(0, 64)}`);
  console.log("  they ship to /updates when production next moves; record them after that");
}
if (unrecorded.length) {
  fail(
    `${unrecorded.length} released entr${unrecorded.length === 1 ? "y is" : "ies are"} on ${at} but not in D1:\n` +
      unrecorded.map((r) => `  - v${r.vnum} ${r.version}`).join("\n") +
      "\n  nothing on the release path writes D1 since 2026-09-28 (#1002)." +
      "\n  record with: bun run checkpoints:record",
  );
}
