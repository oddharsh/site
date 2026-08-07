#!/usr/bin/env node

// check-checkpoints.mjs — does the committed projection still match D1?
//
// D1 is the source of truth for the deploy log; content/data/checkpoints.json
// is a derived read of it that scripts/build-site.mjs renders /updates and
// /restore from. bump-checkpoint.sh stages a pending row, so the normal path keeps
// them in step. This catches the paths it cannot: a row inserted by hand or by
// another machine, a projection edited directly, or a bump whose D1 re-read failed
// and printed the warning nobody read.
//
// Drift is not cosmetic. The pages are precomputed at build time, so a stale
// projection means /updates and /restore silently ship the PREVIOUS log — the
// failure mode is a changelog that looks fine and is wrong, which is exactly the
// class of bug the whole site's check discipline exists for.
//
//   npm run checkpoints:check         compare the committed file against D1
//   npm run checkpoints:sync          rewrite the file from D1 (then commit it)
//
// Needs a D1 read. Locally that is your normal wrangler login. In CI it would need
// a D1:Read token, which is why this is NOT wired into the PR job by default — see
// the note at the bottom.

import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";

const run = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FILE = path.join(ROOT, "content/data/checkpoints.json");
const SYNC = process.argv.includes("--sync");

const fail = (msg) => { console.error(`checkpoints: ${msg}`); process.exit(1); };

// The exact query the promotion path writes from, so a column or order change here
// fails loudly instead of producing a diff nobody can read.
const QUERY = "SELECT vnum, ymd, version, slug, title FROM checkpoints ORDER BY vnum;";

let live;
try {
  const { stdout } = await run("npx", [
    "wrangler", "d1", "execute", "aadhar-restore", "--remote", "--json", "--command", QUERY,
  ], { cwd: ROOT, maxBuffer: 32 * 1024 * 1024 });
  live = JSON.parse(stdout)[0].results;
} catch (e) {
  // An unreachable D1 is an availability problem, not drift. Say so and do not
  // fail a PR over someone else's outage or a missing local login.
  console.error(`checkpoints: could not read D1 (${String(e.message || e).slice(0, 120)})`);
  console.error("  this is an availability problem, not drift — not failing");
  process.exit(0);
}

const canon = (rows) => JSON.stringify(rows, Object.keys(rows[0] || {}).sort(), 2);
const liveJson = JSON.stringify(live, null, 2) + "\n";

if (SYNC) {
  await writeFile(FILE, JSON.stringify(live, null, 2).replace(/\n$/, "") + "\n");
  console.log(`checkpoints: synced ${live.length} rows from D1 -> content/data/checkpoints.json`);
  console.log("  commit it, then deploy — /updates and /restore render from this file");
  process.exit(0);
}

let committed;
try { committed = JSON.parse(await readFile(FILE, "utf8")); }
catch { fail("content/data/checkpoints.json is missing or unparseable — run: npm run checkpoints:sync"); }

const byVnum = (rows) => new Map(rows.map((r) => [r.vnum, r]));
const c = byVnum(committed), l = byVnum(live);
const liveMax = live.length ? Math.max(...l.keys()) : 0;

// PENDING entries are the projection running ahead of D1, which is now the
// normal state between staging a release and ramping it. bump-checkpoint.sh writes
// the projection inside the PR (so /updates ships the entry with the deploy it
// describes, instead of needing a second one), and deploy:promote records the
// row in D1 only once traffic actually reached 100%.
//
// So "ahead" is legal and "behind" never is. A projection row BELOW D1's high
// -water mark that D1 does not have is not pending, it is a rewrite of history.
const pending = committed.filter((r) => !l.has(r.vnum) && r.vnum > liveMax)
  .sort((a, b) => a.vnum - b.vnum);
const pendingVnums = new Set(pending.map((r) => r.vnum));

const diffs = [];
for (const [vnum, row] of l) {
  const mine = c.get(vnum);
  if (!mine) { diffs.push(`v${vnum} present in D1, absent from the projection`); continue; }
  for (const k of ["ymd", "version", "slug", "title"]) {
    if (mine[k] !== row[k]) diffs.push(`v${vnum} ${k}: projection ${JSON.stringify(mine[k])} vs D1 ${JSON.stringify(row[k])}`);
  }
}
for (const vnum of c.keys()) {
  if (!l.has(vnum) && !pendingVnums.has(vnum)) {
    diffs.push(`v${vnum} present in the projection, absent from D1, and BELOW D1's newest (v${liveMax}) — that is a rewrite, not a pending release`);
  }
}
// The tail has to be contiguous. A gap means a vnum was minted, shipped or
// abandoned somewhere this check cannot see, and silently renumbering around it
// would put two different releases on one number later.
pending.forEach((row, i) => {
  const expected = liveMax + i + 1;
  if (row.vnum !== expected) diffs.push(`pending v${row.vnum} breaks the sequence — expected v${expected} after D1's v${liveMax}`);
});

if (diffs.length) {
  fail(
    `${diffs.length} row(s) differ from D1:\n` +
    diffs.slice(0, 8).map((d) => `  - ${d}`).join("\n") +
    (diffs.length > 8 ? `\n  … and ${diffs.length - 8} more` : "") +
    `\n  fix with: npm run checkpoints:sync && git add content/data/checkpoints.json`,
  );
}

const newest = live[live.length - 1];
console.log(`checkpoints: projection agrees with D1 (${live.length} released, newest v${newest.vnum} ${newest.version})`);
if (pending.length) {
  console.log(`  ${pending.length} staged, not yet released:`);
  for (const row of pending) console.log(`    v${row.vnum} ${row.version} — ${row.title.slice(0, 64)}`);
  console.log("  these ship to /updates on the next deploy and land in D1 when deploy:promote reaches 100%");
}
