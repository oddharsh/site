#!/usr/bin/env node
// deploy-promote.mjs — ramp an uploaded version onto production traffic.
//
//   npm run deploy:promote                  # newest version, 10% -> 50% -> 100%
//   npm run deploy:promote -- --to 25       # one step, park it at 25%
//   npm run deploy:promote -- --version <id>
//   npm run deploy:promote -- --steps 5,25,100
//   npm run deploy:promote -- --rollback    # 100% back to the previously active version
//   npm run deploy:promote -- --status      # what is serving right now, and nothing else
//
// WHY THIS EXISTS. Merging used to publish: Workers Builds ran `wrangler deploy`
// off the `production` branch and 100% of traffic moved in one step. That is a
// fine model right up to the moment a change is wrong, and then the only signal
// is a visitor noticing. This site had no way to serve a change to some traffic
// and read the result, because it had no way to serve a change at all without
// serving it to everyone.
//
// Workers Builds now runs `wrangler versions upload` instead (infra.json's
// release block). A merge produces a VERSION: fully built, fully uploaded,
// reachable at its own preview URL, serving nobody. This script is the second
// half — the part that decides how much of the world sees it.
//
// WHAT IT ACTUALLY CHECKS BETWEEN STEPS. It polls /whoareyou.json, which reports
// the serving version per request (whoareyou.js explains why that route and not
// /updates.json — both versions read the same D1 changelog, so the changelog
// cannot tell them apart). Two things come out of the sample and they fail for
// different reasons:
//
//   1. The observed split. If you asked for 10% and every sampled request comes
//      back on the OLD version, the ramp did not take, and continuing to 50%
//      would be ramping something you have not tested. Sampling error is real at
//      these counts, so the tolerance is wide and the check is for "did it move
//      at all", not for a precise percentage.
//   2. Non-200s from the new version specifically. A 500 on 10% of traffic is
//      the entire reason to ramp, and it is invisible in an aggregate error rate
//      that is still 90% healthy.
//
// WHAT IT DOES NOT CHECK, SAID PLAINLY. Latency, correctness, and anything a
// visitor would notice that still returns 200. Workers Logs is the surface for
// that (the structured line carries `v`, the version prefix, for exactly this),
// and the honest workflow is to hold a step, read the logs, then continue. The
// script pausing between steps is not ceremony; it is where you are supposed to
// look at something.
//
// WORKSTATION-ONLY. Same rule as infra:apply: this needs a token that can write
// to the Worker, and GitHub does not get one. CI can promote a commit to the
// `production` branch, which is what causes an upload. It cannot move traffic.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

const DEFAULT_STEPS = [10, 50, 100];
const SAMPLE_URL = "https://aadhar.sh/whoareyou.json";
const SAMPLES = 40;
const SETTLE_MS = 5000;

// ---------------------------------------------------------------- args ----

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? null : argv[i + 1];
};
const has = (name) => argv.includes(`--${name}`);

if (process.env.CI) {
  die("deploy:promote cannot run in CI. Moving production traffic needs a write-capable token, and GitHub deliberately holds none.");
}

// ------------------------------------------------------------- wrangler ----

async function wrangler(args, { json = false } = {}) {
  const { stdout } = await exec("npx", ["wrangler", ...args], {
    maxBuffer: 16 * 1024 * 1024,
    env: process.env,
  });
  return json ? JSON.parse(stdout) : stdout;
}

async function currentDeployment() {
  const status = await wrangler(["deployments", "status", "--json"], { json: true });
  // Shape: { versions: [{ version_id, percentage }], ... }. Normalized here so a
  // wrangler field rename fails loudly at one place instead of silently reading
  // undefined into a percentage comparison.
  const versions = status?.versions;
  if (!Array.isArray(versions)) die("could not read the current deployment (wrangler deployments status --json returned no `versions` array)");
  return versions.map((v) => ({
    id: v.version_id || v.id,
    pct: Number(v.percentage ?? 0),
  }));
}

async function newestVersion() {
  const list = await wrangler(["versions", "list", "--json"], { json: true });
  if (!Array.isArray(list) || !list.length) die("no uploaded versions found");
  // wrangler lists newest first; sort defensively on the timestamp it carries.
  const sorted = [...list].sort((a, b) =>
    String(b.metadata?.created_on || "").localeCompare(String(a.metadata?.created_on || "")));
  return sorted[0].id;
}

// -------------------------------------------------------------- sampling ----

// Poll the live site and attribute each response to a version. Sequential on
// purpose: gradual deployments have no per-request affinity by default, but
// connection reuse can pin a burst of parallel requests to one version and make
// a working ramp look like a dead one.
async function sample(target, previous) {
  const seen = new Map();
  let errors = 0;
  const errorVersions = [];

  for (let i = 0; i < SAMPLES; i++) {
    try {
      const res = await fetch(`${SAMPLE_URL}?s=${i}`, {
        headers: { accept: "application/json" },
        cache: "no-store",
      });
      const version = res.ok ? await servingVersion(res) : null;
      if (!res.ok) {
        errors++;
        errorVersions.push(version || `HTTP ${res.status}`);
        continue;
      }
      seen.set(version || "unknown", (seen.get(version || "unknown") || 0) + 1);
    } catch (e) {
      errors++;
      errorVersions.push(String(e.message || e));
    }
  }

  const onTarget = countMatching(seen, target);
  const onPrevious = previous ? countMatching(seen, previous) : 0;
  return { seen, errors, errorVersions, onTarget, onPrevious, total: SAMPLES };
}

async function servingVersion(res) {
  try {
    const body = await res.json();
    const server = (body.groups || []).find((g) => g.title === "Server");
    const field = (server?.fields || []).find((f) => f.k === "Serving version");
    return field?.v || null;
  } catch { return null; }
}

// /whoareyou.json reports the full version id; the CLI and the log line use the
// 8-char prefix. Compare on the prefix so either form matches.
function countMatching(seen, id) {
  const want = String(id).slice(0, 8);
  let n = 0;
  for (const [k, v] of seen) if (String(k).slice(0, 8) === want) n += v;
  return n;
}

// ------------------------------------------------------------------ run ----

function die(message) {
  console.error(`deploy:promote: ${message}`);
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const active = await currentDeployment();
const activeIds = active.map((v) => `${v.id.slice(0, 8)} @ ${v.pct}%`).join(", ");

if (has("status")) {
  console.log(`serving now: ${activeIds || "(nothing)"}`);
  const s = await sample(active[0]?.id || "", null);
  for (const [v, n] of [...s.seen].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(v).slice(0, 8)}  ${n}/${s.total} sampled`);
  }
  if (s.errors) console.log(`  ${s.errors} error(s): ${[...new Set(s.errorVersions)].join(", ")}`);
  process.exit(0);
}

if (has("rollback")) {
  // The previously active version is whatever holds traffic that is NOT the
  // newest upload. With a single active version there is nothing to roll back
  // TO from here, and guessing would be worse than refusing.
  const newest = await newestVersion();
  const older = active.filter((v) => v.id.slice(0, 8) !== newest.slice(0, 8));
  if (!older.length) {
    die(`nothing to roll back to: ${newest.slice(0, 8)} already holds all traffic. Pick a version explicitly with \`npx wrangler versions deploy <id>@100 --yes\`, or re-upload the previous commit.`);
  }
  const to = older.sort((a, b) => b.pct - a.pct)[0];
  console.log(`rolling back: 100% to ${to.id.slice(0, 8)}`);
  await wrangler(["versions", "deploy", `${to.id}@100`, "--yes", "--message", "rollback via deploy:promote"]);
  console.log("done. verify with --status.");
  process.exit(0);
}

const target = flag("version") || await newestVersion();
const previous = active.find((v) => v.id.slice(0, 8) !== target.slice(0, 8))?.id || null;

const steps = flag("to")
  ? [Number(flag("to"))]
  : (flag("steps") ? flag("steps").split(",").map(Number) : DEFAULT_STEPS);
if (steps.some((s) => !Number.isFinite(s) || s <= 0 || s > 100)) die(`bad steps: ${steps.join(",")}`);

console.log(`target version:   ${target.slice(0, 8)}`);
console.log(`serving now:      ${activeIds || "(nothing)"}`);
console.log(`ramp:             ${steps.join("% -> ")}%\n`);

if (previous && target.slice(0, 8) === previous.slice(0, 8)) {
  die("the target version is already the only one serving; nothing to ramp");
}

for (const pct of steps) {
  console.log(`── ${pct}% ───────────────────────────────────────────`);
  await wrangler([
    "versions", "deploy",
    `${target}@${pct}`,
    "--yes",
    "--message", `deploy:promote ramp to ${pct}%`,
  ]);

  // Let the change propagate before believing a sample of it.
  await sleep(SETTLE_MS);
  const s = await sample(target, previous);
  const pctSeen = Math.round((s.onTarget / s.total) * 100);
  console.log(`   sampled ${s.total}: ${s.onTarget} on target (${pctSeen}%), ${s.onPrevious} on previous, ${s.errors} error(s)`);

  if (s.errors) {
    console.error(`   FAILED: ${s.errors} non-200 response(s): ${[...new Set(s.errorVersions)].join(", ")}`);
    console.error(`   roll back with: npm run deploy:promote -- --rollback`);
    process.exit(1);
  }
  // The ramp not taking at all is the failure worth catching. A 10% step that
  // shows ZERO requests on the target across 40 samples is ~1.5% likely by
  // chance, and far more likely to mean the deploy did not land.
  if (pct < 100 && s.onTarget === 0) {
    console.error(`   FAILED: no sampled request reached ${target.slice(0, 8)}. The ramp did not take.`);
    process.exit(1);
  }
  if (pct === 100 && s.onPrevious > 0) {
    console.error(`   WARNING: ${s.onPrevious} request(s) still served by the previous version after a 100% step.`);
  }

  if (pct !== steps[steps.length - 1]) {
    console.log(`   holding. Read Workers Logs filtered to v=${target.slice(0, 8)} before continuing.\n`);
  }
}

console.log(`\ndone. ${target.slice(0, 8)} is at ${steps[steps.length - 1]}%.`);
console.log("log the release: ./holding/scripts/bump-version.sh <slug> \"<title>\"");
