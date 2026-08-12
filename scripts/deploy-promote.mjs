#!/usr/bin/env node
// deploy-promote.mjs — ramp an uploaded version onto production traffic.
//
//   pnpm run deploy:promote                  # newest PRODUCTION build, 10% -> 50% -> 100%
//   pnpm run deploy:promote --to 25       # one step, park it at 25%
//   pnpm run deploy:promote --version <id>
//   pnpm run deploy:promote --dry-run     # resolve the target, move nothing
//   pnpm run deploy:promote --steps 5,25,100
//   pnpm run deploy:promote --rollback    # 100% back to the previously active version
//   pnpm run deploy:promote --status      # what is serving right now, and nothing else
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
// RUNS ANYWHERE THAT CAN AUTHENTICATE. It was workstation-only until 2026-08-06,
// on the rule that GitHub never holds a Cloudflare token that can write; that
// rule was retired, and .github/workflows/ramp.yml now drives this with a
// narrowly scoped token held as an ENVIRONMENT secret behind required
// reviewers. lib/release-guard.mjs is the check that replaced the flat CI ban.
//
// infra:apply is NOT covered by that change and still refuses to run in CI. It
// can create and destroy zone-level DNS, which no pipeline here needs to do.

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { releaseCredentialError } from "./lib/release-guard.mjs";
import { promisify } from "node:util";

const exec = promisify(execFile);

const DEFAULT_STEPS = [10, 50, 100];
const SAMPLE_URL = "https://aadhar.sh/whoareyou.json";
const SAMPLES = 40;
// Propagation, then re-sampling. 5s was the original settle and it measured the
// old world: `wrangler versions deploy` returns when the split is RECORDED, not
// when the edge routes on it. See the retry loop for the ramp this got wrong.
const SETTLE_MS = 20000;
const RESAMPLE_MS = 25000;
const SAMPLE_ATTEMPTS = 3;
// Per-request ceiling, and the ONLY thing standing between a stalled socket and
// a wedged release. `fetch` has no default request timeout, so before this the
// 100% step of the v177 ramp exited with `Detected unsettled top-level await` in
// the middle of sample(): traffic had already moved, and the D1 changelog write
// that runs AFTER sampling never happened. The repair was documented (re-run
// `--to 100`, which moves nothing and logs); the hang should not have needed one.
// 8s is ~5x the whole 40-request sweep measured against production (1.5s), so a
// timeout here means something is genuinely wrong rather than merely slow.
const REQ_TIMEOUT_MS = 8000;

// ---------------------------------------------------------------- args ----

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? null : argv[i + 1];
};
const has = (name) => argv.includes(`--${name}`);

const credentialError = releaseCredentialError();
if (credentialError) die(credentialError);

// ------------------------------------------------------------- wrangler ----

async function wrangler(args, { json = false } = {}) {
  try {
    const { stdout } = await exec("pnpm", ["exec", "wrangler", ...args], {
      maxBuffer: 16 * 1024 * 1024,
      env: process.env,
    });
    return json ? JSON.parse(stdout) : stdout;
  } catch (e) {
    // Report what wrangler actually said, not a Node spawn dump. The first real
    // ramp died here and printed thirty lines of ChildProcess internals around
    // one line of usable error, which is a poor way to learn that traffic did
    // not move. wrangler puts its diagnostics on stderr.
    const said = String(e.stderr || e.stdout || e.message || "")
      // eslint-disable-next-line no-control-regex
      .replace(/\[[0-9;]*m/g, "")
      .split("\n").map((l) => l.trim()).filter(Boolean)
      .filter((l) => !l.startsWith("🪵"))
      .slice(0, 6).join("\n    ");
    die(`\`wrangler ${args.slice(0, 2).join(" ")}\` failed:\n    ${said}\n\n  Nothing was changed — wrangler validates before it moves traffic.\n  Check \`pnpm run deploy:promote --status\` to confirm.`);
  }
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

// The production branch's alias, read from infra.json so it cannot drift from
// the branch Workers Builds actually publishes.
//
// Called lazily from newestVersion() rather than resolved at module scope, so
// `--status` stays what its help text promises: what is serving right now, and
// nothing else. Reading infra.json up here would let a malformed file break the
// one subcommand you reach for when you are trying to find out what is going on.
async function productionAlias() {
  try {
    const infra = JSON.parse(await readFile(new URL("../config/infra.json", import.meta.url), "utf8"));
    const branch = infra?.release?.production_branch;
    if (!branch) throw new Error("infra.json declares no release.production_branch");
    // Workers Builds sanitizes a branch name into an alias by replacing runs of
    // non-alphanumerics with a single dash. Identity for "production"; correct
    // if the production branch is ever renamed to something with a slash.
    return String(branch).replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "").toLowerCase();
  } catch (e) {
    die(`could not read the production branch from infra.json: ${e.message}`);
  }
}

// The newest PRODUCTION build, which is not the same thing as the newest upload.
//
// This returned the newest version outright until 2026-08-07, and that was a
// live way to ramp somebody else's branch onto production traffic. Workers
// Builds uploads a version for EVERY branch push, not just `production`
// (infra.json's release.non_production_deploy_command), and several agents push
// branches to this repo all day. Observed minutes before a real ramp: of the
// three newest versions, the top was aliased `codex-site-cleanup-foundations`
// and the second `fix-pin-cloudflare-account-id`, with the production build
// third. A bare `pnpm run deploy:promote` at that moment would have walked a
// feature branch to 100%.
//
// It would also have LOOKED fine. The sampler checks that traffic moved and
// that the target returns 200s, and a feature branch that built and deployed
// satisfies both. Nothing downstream of this line could have caught it.
//
// `workers/alias` is the branch a build came from and the only branch signal a
// version carries — the objects hold no commit sha (checked against the live
// API, not assumed). So the alias is what this filters on.
// Memoized, because two things read it now: the alias filter below, and the
// freshness check, which needs `created_on` for whatever target was resolved —
// including one passed as `--version`, where newestVersion() never runs.
let versionListCache = null;
async function versionList() {
  if (!versionListCache) {
    const list = await wrangler(["versions", "list", "--json"], { json: true });
    if (!Array.isArray(list) || !list.length) die("no uploaded versions found");
    versionListCache = list;
  }
  return versionListCache;
}

function createdOnFor(list, id) {
  const short = String(id).slice(0, 8);
  const raw = list.find((v) => String(v.id).slice(0, 8) === short)?.metadata?.created_on;
  const at = raw ? new Date(raw) : null;
  return at && !Number.isNaN(at.getTime()) ? at : null;
}

async function newestVersion() {
  const productionAliasName = await productionAlias();
  const list = await versionList();
  // wrangler lists newest first; sort defensively on the timestamp it carries.
  const sorted = [...list].sort((a, b) =>
    String(b.metadata?.created_on || "").localeCompare(String(a.metadata?.created_on || "")));

  const aliasOf = (v) => (v.annotations || {})["workers/alias"] || "(no alias)";
  const production = sorted.filter((v) => aliasOf(v) === productionAliasName);

  if (!production.length) {
    // FAIL CLOSED, and this is a case that will really happen. `wrangler
    // versions list` is hard-capped at the 10 most recent with no pagination
    // flag, so on a busy day ten branch pushes can bury the production build
    // entirely. Guessing here is exactly the bug being fixed, so name the
    // candidates and let a human choose.
    const seen = sorted.map((v) => `    ${v.id.slice(0, 8)}  ${aliasOf(v)}`).join("\n");
    die(
      `no \`${productionAliasName}\` build among the ${sorted.length} most recent versions.\n\n` +
      `  wrangler lists only the 10 newest and cannot page, so a run of branch\n` +
      `  builds can push the production one off the end. What is listed:\n\n${seen}\n\n` +
      `  Pick the one you mean and pass it explicitly:\n` +
      `    pnpm run deploy:promote --version <id>`,
    );
  }

  // Say the number out loud, the same way the ramp steps do. If this line ever
  // reads "skipping 6 newer", that is the trap this filter exists for.
  const skipped = sorted.indexOf(production[0]);
  if (skipped > 0) {
    const names = sorted.slice(0, skipped).map(aliasOf).join(", ");
    console.log(`skipping ${skipped} newer non-production version(s): ${names}`);
  }
  return production[0].id;
}

// -------------------------------------------------------------- sampling ----

// Poll the live site and attribute each response to a version. Sequential on
// purpose: gradual deployments have no per-request affinity by default, but
// connection reuse can pin a burst of parallel requests to one version and make
// a working ramp look like a dead one.
// ERRORS AND STALLS ARE DIFFERENT THINGS and this used to conflate them, which
// is why adding a timeout needed this rewrite rather than one option.
//
// An error is the ORIGIN answering badly: a non-2xx from the version being
// ramped. It is conclusive, it is what the ramp exists to catch, and the right
// response is to stop and consider rolling back.
//
// A stall is THIS MACHINE failing to complete a request: a timeout, a DNS
// blip, a dropped socket on a laptop that just moved networks. It says nothing
// about the deploy. Counting one as the other would mean a flaky cafe
// connection could roll back a perfectly healthy release, so the ramp reports
// them separately and only treats a total blackout (nothing answered at all) as
// disqualifying.
async function sample(target, previous) {
  const seen = new Map();
  let errors = 0, stalls = 0;
  const errorVersions = [];
  const stallReasons = [];

  for (let i = 0; i < SAMPLES; i++) {
    try {
      const res = await fetch(`${SAMPLE_URL}?s=${i}`, {
        headers: { accept: "application/json" },
        cache: "no-store",
        // No default request timeout exists on fetch. Without this a single
        // stalled socket hangs the whole ramp mid-step.
        signal: AbortSignal.timeout(REQ_TIMEOUT_MS),
      });
      // Read the body on BOTH paths. It is what identifies the version that
      // served an error, which the old code claimed to report and could not
      // (it passed null on the !ok branch, so `version ||` was dead and every
      // error read `HTTP 5xx`). It also drains the response instead of leaking
      // one connection per bad sample.
      const version = await servingVersion(res);
      if (!res.ok) {
        errors++;
        errorVersions.push(version ? `${String(version).slice(0, 8)} HTTP ${res.status}` : `HTTP ${res.status}`);
        continue;
      }
      seen.set(version || "unknown", (seen.get(version || "unknown") || 0) + 1);
    } catch (e) {
      stalls++;
      stallReasons.push(e?.name === "TimeoutError" ? `timed out after ${REQ_TIMEOUT_MS}ms` : String(e?.message || e));
    }
  }

  const onTarget = countMatching(seen, target);
  const onPrevious = previous ? countMatching(seen, previous) : 0;
  // How many requests actually came back, error or not. Zero means the sample
  // proved nothing, which is not the same as proving the deploy is fine.
  const answered = SAMPLES - stalls;
  return { seen, errors, errorVersions, stalls, stallReasons, answered, onTarget, onPrevious, total: SAMPLES };
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

// ------------------------------------------------------- target freshness ----

// WHY. Workers Builds takes a couple of minutes to upload after a merge, and a
// ramp inside that window silently targets the PREVIOUS release. Nothing
// downstream can catch it: the version it picks is a legitimate production
// build, it has the production alias, traffic moves, the sampler sees 200s, and
// the run reports success. The only evidence is a timestamp nobody was
// comparing.
//
// It happened TWICE on 2026-08-10, both times to a change that had just merged.
// #316's fix ramped `4b447b34`, uploaded at 21:16:17Z, against a merge at
// 21:21:18Z — five minutes older than the commit it was supposed to ship, and
// the ramp said `done. 4b447b34 is at 100%`.
//
// So compare the target's `created_on` against the local HEAD's COMMIT time.
// Committer time is when the squash-merge landed on main, and Workers Builds
// uploads strictly after that, so a target older than HEAD cannot contain HEAD.
//
// Deliberately a WARNING and not a refusal. Ramping something older than HEAD is
// legitimate more than once here: re-ramping the serving version to write a
// missed changelog row (gotcha 24), parking an older build while a fix lands, or
// running from a tree that is simply ahead of production. A refusal would block
// the repair path this note exists to describe.
//
// The healthy case PRINTS TOO. Silence is what let this through twice, and a
// line saying the target was built after HEAD is the difference between "the
// check passed" and "the check never ran" — the same reason `rn.art.warm`
// reports `already` alongside `warmed`.
async function headCommit() {
  try {
    const { stdout } = await exec("git", ["log", "-1", "--format=%h %cI"], { env: process.env });
    const [sha, iso] = stdout.trim().split(" ");
    const at = new Date(iso);
    return sha && !Number.isNaN(at.getTime()) ? { sha, at } : null;
  } catch {
    // No git, no repo, no HEAD: the check simply does not apply. A ramp must
    // never fail because a workstation is arranged unusually.
    return null;
  }
}

function humanGap(ms) {
  const s = Math.round(Math.abs(ms) / 1000);
  if (s < 90) return `${s}s`;
  const m = Math.round(s / 60);
  return m < 90 ? `${m}m` : `${(m / 60).toFixed(1)}h`;
}

async function reportTargetFreshness(targetId) {
  const [head, list] = await Promise.all([headCommit(), versionList()]);
  const built = createdOnFor(list, targetId);
  // Name WHICH input was missing. The two causes want different responses, and
  // one line saying "unknown" for both sends you looking in the wrong place.
  if (!head) {
    console.log("freshness:        unknown (no git HEAD here)\n");
    return;
  }
  if (!built) {
    // `wrangler versions list` is hard-capped at 10 with no pagination, so any
    // target older than the last ten uploads lands here. That is not an error,
    // and on a busy day it is the normal answer for a deliberately old target.
    console.log(
      `freshness:        unknown (${String(targetId).slice(0, 8)} is not among the ` +
      `${list.length} versions wrangler lists, so it has no timestamp to compare)\n`);
    return;
  }
  const gap = built.getTime() - head.at.getTime();
  if (gap >= 0) {
    console.log(`freshness:        built ${humanGap(gap)} AFTER HEAD ${head.sha}\n`);
    return;
  }
  console.log(
    `\n  ⚠ STALE TARGET: ${String(targetId).slice(0, 8)} was built ${humanGap(gap)} BEFORE your HEAD commit.\n` +
    `\n    HEAD    ${head.sha}  committed ${head.at.toISOString()}` +
    `\n    target  ${String(targetId).slice(0, 8)}  built     ${built.toISOString()}\n` +
    `\n    A version uploaded before a commit cannot contain it. If you just merged,` +
    `\n    Workers Builds has probably not finished uploading — wait a couple of` +
    `\n    minutes and re-run --dry-run until this line clears.\n` +
    `\n    Ramp anyway only if you MEAN to serve an older build (a rollback, or` +
    `\n    re-ramping the serving version to write a missed changelog row).\n`,
  );
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
  if (s.stalls) console.log(`  ${s.stalls} stalled from this machine: ${[...new Set(s.stallReasons)].join(", ")}`);
  process.exit(0);
}

if (has("rollback")) {
  // The previously active version is whatever holds traffic that is NOT the
  // newest upload. With a single active version there is nothing to roll back
  // TO from here, and guessing would be worse than refusing.
  const newest = await newestVersion();
  const older = active.filter((v) => v.id.slice(0, 8) !== newest.slice(0, 8));
  if (!older.length) {
    die(`nothing to roll back to: ${newest.slice(0, 8)} already holds all traffic. Pick a version explicitly with \`pnpm exec wrangler versions deploy <id>@100 --yes\`, or re-upload the previous commit.`);
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
console.log(`ramp:             ${steps.join("% -> ")}%`);
// Before the dry-run exit, so it prints on BOTH paths. A warning that only
// appears in --dry-run is worth nothing on the run that skips the dry run, and
// skipping it is exactly what someone does when they are moving quickly.
await reportTargetFreshness(target);

// Resolve and print the target, move nothing. The point is to make the version
// choice READABLE before it is acted on: the bug this flag ships with was one
// where the wrong target was picked silently and every downstream check passed.
// Also the only way to exercise the selection without moving production
// traffic, since the surrounding module runs on import and cannot be tested.
if (has("dry-run")) {
  console.log("--dry-run: nothing was changed.");
  process.exit(0);
}

if (previous && target.slice(0, 8) === previous.slice(0, 8)) {
  die("the target version is already the only one serving; nothing to ramp");
}

for (const pct of steps) {
  console.log(`── ${pct}% ───────────────────────────────────────────`);
  // BOTH SIDES OF THE SPLIT, ALWAYS. `wrangler versions deploy` requires the
  // percentages to total exactly 100 and refuses the command otherwise:
  //
  //   ✘ The specified traffic percentages add up to 10%, but must total
  //     exactly 100%.
  //
  // The first version of this script passed only `<target>@<pct>`, which reads
  // naturally ("put 10% on the new one") and is rejected for every step except
  // 100. Caught on the first real ramp, 2026-08-04. It failed SAFELY — wrangler
  // validates before it moves anything — but it failed on every intermediate
  // step, which is to say the ramp could only ever have gone straight to 100%,
  // which is the one thing this script exists to avoid.
  //
  // Below 100 the remainder goes explicitly to the version that is serving now.
  // Wrangler would also accept a bare `<previous>` and infer the remainder, but
  // saying the number out loud is what makes the intent reviewable in the log.
  const specs = pct >= 100 || !previous
    ? [`${target}@100`]
    : [`${target}@${pct}`, `${previous}@${100 - pct}`];
  await wrangler([
    "versions", "deploy",
    ...specs,
    "--yes",
    "--message", `deploy:promote ramp to ${pct}%`,
  ]);

  // Let the change propagate before believing a sample of it, then RETRY rather
  // than trusting one window.
  //
  // The first real ramp failed here on a split that was working fine. It read
  // 0 of 40 on a live 10% split; a hand sample minutes later read 3 of 60, which
  // is 5% against a 10% target and entirely ordinary. Two things made a healthy
  // ramp look dead:
  //
  //   1. FIVE SECONDS IS NOT PROPAGATION. `wrangler versions deploy` returns as
  //      soon as the split is recorded, and the edge takes longer than that to
  //      route on it. The early samples were measuring the old world.
  //   2. ZERO IS NOT RARE ENOUGH AT n=40. At a true 10%, 0.9^40 is ~1.5% — small
  //      until you run it on every intermediate step of every release, at which
  //      point a false abort is a matter of when. Sampling a 4-in-40 signal and
  //      failing hard on the low tail was never going to hold.
  //
  // So: sample, and if nothing lands on the target, wait and sample again before
  // calling it. A genuinely dead ramp stays at zero across all three windows; a
  // live one at 10% clears 0-of-40 three times running about 1 in 300,000.
  let s = null;
  for (let attempt = 1; attempt <= SAMPLE_ATTEMPTS; attempt++) {
    await sleep(attempt === 1 ? SETTLE_MS : RESAMPLE_MS);
    s = await sample(target, previous);
    const pctSeen = Math.round((s.onTarget / s.total) * 100);
    const note = attempt > 1 ? ` (attempt ${attempt}/${SAMPLE_ATTEMPTS})` : "";
    const stalled = s.stalls ? `, ${s.stalls} stalled` : "";
    console.log(`   sampled ${s.total}: ${s.onTarget} on target (${pctSeen}%), ${s.onPrevious} on previous, ${s.errors} error(s)${stalled}${note}`);
    if (s.stalls) console.log(`   note: ${s.stalls} request(s) never completed from THIS machine (${[...new Set(s.stallReasons)][0]}) — not an origin fault.`);
    // Errors are conclusive on the first sighting: a 500 does not become a 200
    // by waiting, and that is the failure the whole ramp exists to catch.
    if (s.errors) break;
    if (pct >= 100 || s.onTarget > 0) break;
    if (attempt < SAMPLE_ATTEMPTS) {
      console.log(`   nothing on target yet — waiting ${RESAMPLE_MS / 1000}s for the split to propagate and re-sampling.`);
    }
  }

  if (s.errors) {
    console.error(`   FAILED: ${s.errors} non-200 response(s): ${[...new Set(s.errorVersions)].join(", ")}`);
    console.error(`   traffic is CURRENTLY SPLIT at ${pct}% — this script does not roll back for you.`);
    console.error(`   roll back with: pnpm run deploy:promote --rollback`);
    process.exit(1);
  }
  // Nothing came back at all. Distinct from an origin error and reported as
  // such, because the remedy is different: check this machine's network and
  // re-run, rather than roll back a deploy that may be perfectly healthy. It
  // still stops the ramp, since a step nobody could measure is not a step that
  // passed — and at 100% it is what keeps an unverified run from writing the
  // changelog as though traffic were confirmed.
  if (!s.answered) {
    console.error(`   FAILED: not one of ${s.total} samples completed from this machine (${[...new Set(s.stallReasons)][0]}).`);
    console.error(`   this says nothing about the deploy — it could not be measured. Traffic IS at ${pct}%.`);
    console.error(`   check your network, then:  pnpm run deploy:promote --status`);
    process.exit(1);
  }
  if (pct < 100 && s.onTarget === 0) {
    console.error(`   FAILED: no sampled request reached ${target.slice(0, 8)} across ${SAMPLE_ATTEMPTS} windows. The ramp did not take.`);
    console.error(`   traffic is CURRENTLY SPLIT at ${pct}% — this script does not roll back for you.`);
    console.error(`   check it with:  pnpm run deploy:promote --status`);
    console.error(`   roll back with: pnpm run deploy:promote --rollback`);
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

// ── record the release ────────────────────────────────────────────────────
// The changelog entry was authored in the PR (bump-version.sh writes only the
// committed projection), so /updates and /restore have been serving it since
// this version started answering. What was still missing is D1's record that it
// SHIPPED, and this is the only place that knows traffic actually moved.
//
// Deliberately after the last step and never before: a row here means the
// version reached 100%, not that someone intended it to. A ramp that aborts at
// 10% leaves the entry staged, which is exactly what it is.
if (steps[steps.length - 1] === 100) {
  const file = new URL("../www/_worker.js/checkpoints.json", import.meta.url);
  let staged = [];
  try {
    const committed = JSON.parse(await readFile(file, "utf8"));
    // `wrangler(..., { json: true })` already returns parsed JSON. Wrapping it in
    // a second JSON.parse stringifies the object to "[object Object]" and throws,
    // which the catch below then reported as D1 being unreachable — so every ramp
    // since the staged-projection refactor skipped its own changelog write while
    // printing a message that blamed the database. D1 was fine every time.
    const rows = (await wrangler(
      ["d1", "execute", "aadhar-restore", "--remote", "--json", "--command", "SELECT vnum FROM checkpoints;"],
      { json: true },
    ))[0].results;
    const known = new Set(rows.map((r) => r.vnum));
    staged = committed.filter((r) => !known.has(r.vnum)).sort((a, b) => a.vnum - b.vnum);
  } catch (e) {
    // Do NOT name a cause here. This block covers a local file read, a wrangler
    // spawn, and the shape of what comes back; asserting "D1 is unreachable" sent
    // the one person reading it to check a database that was answering fine.
    console.log(`\ncould not work out what to log (${String(e.message || e).slice(0, 90)}).`);
    console.log("traffic is ramped; run `pnpm run checkpoints:check` to see what is still staged.");
  }
  for (const row of staged) {
    const ts = Math.floor(Date.now() / 1000);
    try {
      await wrangler(["d1", "execute", "aadhar-restore", "--remote", "--command",
        `INSERT INTO checkpoints (vnum, ts, ymd, version, slug, title) VALUES (${row.vnum}, ${ts}, '${row.ymd}', '${row.version}', '${row.slug}', '${row.title}');`]);
      console.log(`logged: v${row.vnum} ${row.version}`);
    } catch (e) {
      // Not fatal. Traffic already moved, and a missing log row is a changelog
      // gap rather than an outage — reporting it beats unwinding a good release.
      console.log(`warn:   could not log v${row.vnum} (${String(e.message || e).slice(0, 90)})`);
    }
  }
  if (!staged.length) console.log("deploy log: nothing staged — this version carries no new changelog entry.");
}
