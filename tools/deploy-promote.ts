#!/usr/bin/env node
// deploy-promote.mjs — ramp an uploaded version onto production traffic.

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { releaseCredentialError } from "./lib/release-guard.ts";
import { promisify } from "node:util";
import { cf, d1Rows, D1 } from "./lib/cf.ts";
import { remainderHolder } from "./lib/ramp-split.ts";
import { probePinned, sampleSplit } from "./lib/version-probe.ts";

const exec = promisify(execFile);

const DEFAULT_STEPS = [10, 50, 100];
// Propagation, then re-sampling. 5s was the original settle and it measured the
// old world: creating a deployment returns when the split is RECORDED, not
// when the edge routes on it. See the retry loop for the ramp this got wrong.
const SETTLE_MS = 20000;
const RESAMPLE_MS = 25000;
const SAMPLE_ATTEMPTS = 3;
const RUN_ID = Math.random().toString(36).slice(2, 8);
const sample = (target, previous) => sampleSplit(target, previous, RUN_ID);

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? null : argv[i + 1];
};
const has = (name) => argv.includes(`--${name}`);

const credentialError = releaseCredentialError();
if (credentialError) die(credentialError);

async function cfOrDie(args) {
  try {
    return await cf(args);
  } catch (e) {
    die(`${e.message}\n\n  Nothing was changed: Cloudflare validates a deployment before it moves traffic.\n  Check \`bun run deploy:promote --status\` to confirm.`);
  }
}

async function deployVersions(specs, message) {
  const worker = await workerName();
  const body = {
    strategy: "percentage",
    versions: specs.map((v) => ({ version_id: v.id, percentage: v.pct })),
    annotations: { "workers/message": message },
  };
  await cfOrDie(["workers", "deployments", "create", "--worker", worker, "--body", JSON.stringify(body)]);
}

async function currentDeployment() {
  const listed = await cfOrDie(["workers", "deployments", "list", "--worker", await workerName()]);
  const versions = (listed?.deployments ?? listed)?.[0]?.versions;
  if (!Array.isArray(versions)) die("could not read the current deployment (cf workers deployments list returned no `versions` array)");
  return versions.map((v) => ({
    id: v.version_id || v.id,
    pct: Number(v.percentage ?? 0),
  }));
}

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

const LIST_SIZE = 100;
let versionListCache: any[] | null = null;
async function versionList() {
  if (!versionListCache) {
    const listed = await cfOrDie(["workers", "versions", "list", "--worker-id", await workerName(), "--per-page", String(LIST_SIZE)]);
    const list = listed?.items ?? listed;
    if (!Array.isArray(list) || !list.length) die("no uploaded versions found");
    versionListCache = list.map((v) => ({ ...v, created_on: v.created_on ?? v.metadata?.created_on }));
  }
  return versionListCache;
}

function createdOnFor(list, id) {
  const short = String(id).slice(0, 8);
  const raw = list.find((v) => String(v.id).slice(0, 8) === short)?.created_on;
  const at = raw ? new Date(raw) : null;
  return at && !Number.isNaN(at.getTime()) ? at : null;
}

async function newestVersion() {
  const productionAliasName = await productionAlias();
  const list = await versionList();
  const sorted = [...list].sort((a, b) =>
    String(b.created_on || "").localeCompare(String(a.created_on || "")));

  const aliasOf = (v) => (v.annotations || {})["workers/alias"] || "(no alias)";
  const production = sorted.filter((v) => aliasOf(v) === productionAliasName);

  if (!production.length) {
    const seen = sorted.slice(0, 20).map((v) => `    ${v.id.slice(0, 8)}  ${aliasOf(v)}`).join("\n");
    die(
      `no \`${productionAliasName}\` build among the ${sorted.length} most recent versions.\n\n` +
      `  The newest of what is listed:\n\n${seen}\n\n` +
      `  Pick the one you mean and pass it explicitly:\n` +
      `    bun run deploy:promote --version <id>`,
    );
  }

  const skipped = sorted.indexOf(production[0]);
  if (skipped > 0) {
    const names = sorted.slice(0, skipped).map(aliasOf).join(", ");
    console.log(`skipping ${skipped} newer non-production version(s): ${names}`);
  }
  return production[0].id;
}

async function workerName() {
  try {
    const infra = JSON.parse(await readFile(new URL("../config/infra.json", import.meta.url), "utf8"));
    const name = infra?.release?.worker;
    if (!name) throw new Error("infra.json declares no release.worker");
    return name;
  } catch (e) {
    die(`could not read the worker name from infra.json: ${e.message}`);
  }
}


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
  if (!head) {
    console.log("freshness:        unknown (no git HEAD here)\n");
    return;
  }
  if (!built) {
    console.log(
      `freshness:        unknown (${String(targetId).slice(0, 8)} is not among the ` +
      `${list.length} newest versions, so it has no timestamp to compare)\n`);
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

function die(message: string): never {
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
  const newest = await newestVersion();
  const older = active.filter((v) => v.id.slice(0, 8) !== newest.slice(0, 8));
  if (!older.length) {
    die(`nothing to roll back to: ${newest.slice(0, 8)} already holds all traffic. Pick a version explicitly with \`bun run deploy:promote --version <id> --to 100\`, or re-upload the previous commit.`);
  }
  const to = older.sort((a, b) => b.pct - a.pct)[0];
  console.log(`rolling back: 100% to ${to.id.slice(0, 8)}`);
  await deployVersions([{ id: to.id, pct: 100 }], "rollback via deploy:promote");
  console.log("done. verify with --status.");
  process.exit(0);
}

const target = flag("version") || await newestVersion();
const previous = remainderHolder(active, target);

const toFlag = flag("to");
const stepsFlag = flag("steps");
const steps = toFlag
  ? [Number(toFlag)]
  : (stepsFlag ? stepsFlag.split(",").map(Number) : DEFAULT_STEPS);
if (steps.some((s) => !Number.isFinite(s) || s <= 0 || s > 100)) die(`bad steps: ${steps.join(",")}`);

console.log(`target version:   ${target.slice(0, 8)}`);
// The WHOLE id, on its own line, for anything downstream that has to probe this
// version rather than merely name it. `Cloudflare-Workers-Version-Overrides`
// silently declines to pin on the 8-char prefix (gotcha 36), so a caller that
// scrapes the line above and passes it to a probe measures the live split while
// believing it measured one version. soak-canary.ts reads this line.
//
// The prefix line above is unchanged and stays first, because ramp.yml matches
// `^target version: ` with a literal colon, which this line does not carry.
console.log(`target version id: ${target}`);
console.log(`serving now:      ${activeIds || "(nothing)"}`);
console.log(`ramp:             ${steps.join("% -> ")}%`);
await reportTargetFreshness(target);

if (has("dry-run")) {
  console.log("--dry-run: nothing was changed.");
  process.exit(0);
}

if (previous && target.slice(0, 8) === previous.slice(0, 8)) {
  die("the target version is already the only one serving; nothing to ramp");
}

const worker = await workerName();

for (const pct of steps) {
  console.log(`── ${pct}% ───────────────────────────────────────────`);
  // BOTH SIDES OF THE SPLIT, ALWAYS. A deployment's percentages must total
  // exactly 100, and wrangler refused the command otherwise:
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
  // Below 100 the remainder goes explicitly to the version that is serving now,
  // which also keeps the intent reviewable in the log.
  const specs = pct >= 100 || !previous
    ? [{ id: target, pct: 100 }]
    : [{ id: target, pct }, { id: previous, pct: 100 - pct }];
  await deployVersions(specs, `deploy:promote ramp to ${pct}%`);

  await sleep(SETTLE_MS);

  const pinned = await probePinned(target, worker);
  const pinnedStalled = pinned.stalls ? `, ${pinned.stalls} stalled` : "";
  console.log(`   pinned ${pinned.total}: ${pinned.onTarget} answered by ${target.slice(0, 8)}, ${pinned.errors} error(s)${pinnedStalled}`);

  if (pinned.errors) {
    console.error(`   FAILED: ${pinned.errors} non-200 with traffic pinned to ${target.slice(0, 8)}: ${[...new Set(pinned.errorDetail)].join(", ")}`);
    console.error(`   every one of those was handled by the version being ramped, so this is not sampling noise.`);
    console.error(`   traffic is CURRENTLY SPLIT at ${pct}% — this script does not roll back for you.`);
    console.error(`   roll back with: bun run deploy:promote --rollback`);
    process.exit(1);
  }
  if (!pinned.answered) {
    console.log(`   note: not one pinned request completed from this machine (${[...new Set(pinned.stallReasons)][0]}). Nothing was proved either way.`);
  } else if (pinned.onTarget === 0) {
    console.log(`   note: the version override did not apply (answered by ${pinned.strayVersions.join(", ") || "an unidentified version"}).`);
    console.log(`         the pinned check proved nothing this step; the sampled one below is carrying it.`);
  }

  let s: Awaited<ReturnType<typeof sample>> | null = null;
  for (let attempt = 1; attempt <= SAMPLE_ATTEMPTS; attempt++) {
    if (attempt > 1) await sleep(RESAMPLE_MS);
    s = await sample(target, previous);
    const pctSeen = Math.round((s.onTarget / s.total) * 100);
    const note = attempt > 1 ? ` (attempt ${attempt}/${SAMPLE_ATTEMPTS})` : "";
    const stalled = s.stalls ? `, ${s.stalls} stalled` : "";
    console.log(`   sampled ${s.total}: ${s.onTarget} on target (${pctSeen}%), ${s.onPrevious} on previous, ${s.errors} error(s)${stalled}${note}`);
    if (s.stalls) console.log(`   note: ${s.stalls} request(s) never completed from THIS machine (${[...new Set(s.stallReasons)][0]}) — not an origin fault.`);
    if (s.errors) break;
    if (pct >= 100 || s.onTarget > 0) break;
    if (attempt < SAMPLE_ATTEMPTS) {
      console.log(`   nothing on target yet — waiting ${RESAMPLE_MS / 1000}s for the split to propagate and re-sampling.`);
    }
  }

  if (!s) die(`SAMPLE_ATTEMPTS is ${SAMPLE_ATTEMPTS}, so the ${pct}% step was never sampled`);

  if (s.errors) {
    console.error(`   FAILED: ${s.errors} non-200 response(s): ${[...new Set(s.errorVersions)].join(", ")}`);
    console.error(`   traffic is CURRENTLY SPLIT at ${pct}% — this script does not roll back for you.`);
    console.error(`   roll back with: bun run deploy:promote --rollback`);
    process.exit(1);
  }
  if (!s.answered) {
    console.error(`   FAILED: not one of ${s.total} samples completed from this machine (${[...new Set(s.stallReasons)][0]}).`);
    console.error(`   this says nothing about the deploy — it could not be measured. Traffic IS at ${pct}%.`);
    console.error(`   check your network, then:  bun run deploy:promote --status`);
    process.exit(1);
  }
  if (pct < 100 && s.onTarget === 0) {
    console.error(`   FAILED: no sampled request reached ${target.slice(0, 8)} across ${SAMPLE_ATTEMPTS} windows. The ramp did not take.`);
    if (pinned.onTarget > 0) {
      console.error(`   BUT ${pinned.onTarget}/${pinned.total} requests pinned to that version answered fine, so the version is healthy`);
      console.error(`   and something is stopping the SPLIT from routing. Likeliest cause: the version-affinity`);
      console.error(`   Transform Rule is overwriting the per-request keys this script sends. Its expression must`);
      console.error(`   exempt requests that already carry Cloudflare-Workers-Version-Key. Check it with:`);
      console.error(`     bun run infra:check      (the "version affinity" section)`);
    }
    console.error(`   traffic is CURRENTLY SPLIT at ${pct}% — this script does not roll back for you.`);
    console.error(`   check it with:  bun run deploy:promote --status`);
    console.error(`   roll back with: bun run deploy:promote --rollback`);
    process.exit(1);
  }
  if (pct === 100 && s.onPrevious > 0) {
    console.error(`   WARNING: ${s.onPrevious} request(s) still served by the previous version after a 100% step.`);
  }

  if (pct !== steps[steps.length - 1]) {
    console.log(`   step verified for v=${target.slice(0, 8)}; continuing to the next configured step.\n`);
  }
}

console.log(`\ndone. ${target.slice(0, 8)} is at ${steps[steps.length - 1]}%.`);

if (steps[steps.length - 1] === 100) {
  const file = new URL("../src/worker/checkpoints.json", import.meta.url);
  let staged: { vnum: number, ymd: string, version: string, slug: string, title: string }[] = [];
  try {
    const committed = JSON.parse(await readFile(file, "utf8"));
    const rows = await d1Rows(D1["aadhar-restore"], "SELECT vnum FROM checkpoints;");
    const known = new Set(rows.map((r) => r.vnum));
    staged = committed.filter((r) => !known.has(r.vnum)).sort((a, b) => a.vnum - b.vnum);
  } catch (e) {
    console.log(`\ncould not work out what to log (${String(e.message || e).slice(0, 90)}).`);
    console.log("traffic is ramped; run `bun run checkpoints:check` to see what is still staged.");
  }
  for (const row of staged) {
    const ts = Math.floor(Date.now() / 1000);
    try {
      await d1Rows(D1["aadhar-restore"],
        `INSERT INTO checkpoints (vnum, ts, ymd, version, slug, title) VALUES (${row.vnum}, ${ts}, '${row.ymd}', '${row.version}', '${row.slug}', '${row.title}');`);
      console.log(`logged: v${row.vnum} ${row.version}`);
    } catch (e) {
      console.log(`warn:   could not log v${row.vnum} (${String(e.message || e).slice(0, 90)})`);
    }
  }
  if (!staged.length) console.log("deploy log: nothing staged — this version carries no new changelog entry.");
}
