// Watch a 10% canary for a while, then say whether it is safe to finish.
//
// WHY THIS EXISTS. The release chain ends at a required reviewer on
// `production-full`, and measured over the last 60 `ramp.yml` runs on
// 2026-09-22 that reviewer resolved 2 of the 20 real ramps. The other 18 were
// cancelled by the next release while parked. Each one had already put its
// version at 10%, so the steady state of this repository's release path is
// production serving a split nobody chose, indefinitely, with the decision
// deferred until a newer merge deletes the run that was waiting for it.
//
// A gate nobody passes through stops being a gate. What it was FOR is reading a
// change before everyone gets it, and nothing was reading it. So this reads it:
// it exercises the canaried version directly, every few minutes, for the length
// of the soak, and hands back a verdict the workflow acts on.
//
// IT MOVES NO TRAFFIC AND HOLDS NO CREDENTIAL. Every request here is plain
// HTTPS against production, which is what lets it run in a job with no
// Cloudflare token, and what lets a test drive it. The traffic move belongs to
// `deploy:promote`, which already knows how to do it and already refuses to do
// it blind.
//
// THE VERDICTS, and the exit code each one carries:
//
//   clean      0  every pass came back 200, and at least one pass proved the
//                 override was reaching the target. Finish the ramp.
//   faulty     2  a request handled by the canaried version returned non-200.
//                 That is conclusive rather than statistical, because every one
//                 of those requests was pinned to the version in question.
//                 Roll back.
//   shipped    3  the unpinned read found the target holding everything, so a
//                 human took the fast path through `production-full` while this
//                 was soaking. Nothing left to do.
//   unproven   4  nothing could be measured: the probes stalled, or the version
//                 override never applied on any pass. Do NOTHING. This is the
//                 verdict that keeps a measurement failure from being read as a
//                 fault, which is the mistake gotcha 15 is about, and the
//                 mistake that would otherwise roll back healthy releases every
//                 time GitHub's egress had a bad afternoon.
//
// Note what is absent: there is no verdict that rolls back on a quiet signal. A
// fault has to be an origin answering badly to a request that reached the code
// being ramped. Everything else reports and stops.

import { appendFile } from "node:fs/promises";
import { probePinned, sampleSplit, PINNED_PROBES } from "./lib/version-probe.ts";

const argv = process.argv.slice(2);
const flag = (name: string) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? null : argv[i + 1];
};
const has = (name: string) => argv.includes(`--${name}`);

// Twelve requests, the same count the pinned probe uses. The question here is
// whether the target holds ALL traffic, and at a live 10% split twelve straight
// hits on it is a 1-in-10^12 event, so this separates 10% from 100% without
// needing the 40-request sweep the ramp runs.
const SPLIT_READ = PINNED_PROBES;

export type Verdict = "clean" | "faulty" | "shipped" | "unproven";
export const EXIT: Record<Verdict, number> = { clean: 0, faulty: 2, shipped: 3, unproven: 4 };

export type Pass = Awaited<ReturnType<typeof probePinned>>;

// The decision, as a pure function of what the passes saw, so a test can drive
// every verdict without a network. Keeping it separate from the loop is what
// makes "does a single stall roll back a release" an assertion rather than a
// question somebody has to re-read the loop to answer.
export function verdictFor(
  passes: { pinned: Pass; allOnTarget: boolean; sampleAnswered: number }[],
): { verdict: Verdict; reason: string } {
  if (!passes.length) return { verdict: "unproven", reason: "no pass completed" };

  // An origin error is conclusive on first sighting. A 500 does not become a 200
  // by waiting, and every request that produced one was handled by the version
  // being ramped.
  const faulty = passes.find((p) => p.pinned.errors > 0);
  if (faulty) {
    return {
      verdict: "faulty",
      reason: `${faulty.pinned.errors} non-200 from the canaried version: ${[...new Set(faulty.pinned.errorDetail)].join(", ")}`,
    };
  }

  // A human reached `production-full` first. Requires a pass where every
  // answered request came back on the target AND enough of them answered to
  // mean anything, so one lucky request against a dead network cannot read as a
  // completed release.
  const shipped = passes.find((p) => p.allOnTarget && p.sampleAnswered >= SPLIT_READ);
  if (shipped) return { verdict: "shipped", reason: "the target is already serving all sampled traffic" };

  // Nothing answered at all, anywhere. Says nothing about the release.
  if (passes.every((p) => p.pinned.answered === 0)) {
    return { verdict: "unproven", reason: "not one probe completed; this machine could not measure anything" };
  }

  // Requests answered, but never from the target. Cloudflare honours the version
  // override only for a version that is IN the current deployment, so this is
  // either a version that has since left the deployment or an override that is
  // not applying. Both mean the soak exercised the wrong code, and ramping on
  // that would put traffic on something this never read.
  if (passes.every((p) => p.pinned.onTarget === 0)) {
    const stray = [...new Set(passes.flatMap((p) => p.pinned.strayVersions))];
    return {
      verdict: "unproven",
      reason: `the version override never applied${stray.length ? ` (answered by ${stray.join(", ")})` : ""}; the canary was never exercised`,
    };
  }

  const exercised = passes.reduce((n, p) => n + p.pinned.onTarget, 0);
  return { verdict: "clean", reason: `${exercised} requests handled by the canaried version across ${passes.length} pass(es), 0 errors` };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const version = flag("version");
  const worker = flag("worker");
  if (!version || !worker) {
    console.error("usage: soak-canary --version <full-version-uuid> --worker <name> [--minutes 20] [--interval 240] [--once]");
    process.exit(1);
  }
  // THE GUARD THAT MAKES gotcha 36 STRUCTURAL. The override header declines to
  // pin on an 8-char prefix and says nothing about it, so a caller that scrapes
  // `target version:` out of the ramp log and passes it here would measure the
  // live split while believing it had measured one version. Every probe would
  // come back 200 from the incumbent and the soak would report a canary it never
  // touched as clean. `deploy:promote` prints `target version id:` for this.
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(version)) {
    console.error(`soak-canary: --version must be the FULL version uuid, got "${version}".`);
    console.error(`  The Cloudflare-Workers-Version-Overrides header silently declines to pin on a prefix,`);
    console.error(`  so a soak run this way would probe the live split and report on the wrong code.`);
    console.error(`  deploy:promote prints it on the "target version id:" line.`);
    process.exit(1);
  }

  const minutes = Number(flag("minutes") ?? 20);
  const intervalMs = Number(flag("interval") ?? 240) * 1000;
  const runId = Math.random().toString(36).slice(2, 8);
  const deadline = Date.now() + minutes * 60_000;
  const short = version.slice(0, 8);

  console.log(`soaking ${short} for ${minutes} minute(s), a pass every ${intervalMs / 1000}s`);

  const passes: { pinned: Pass; allOnTarget: boolean; sampleAnswered: number }[] = [];
  for (let n = 1; ; n++) {
    const pinned = await probePinned(version, worker);
    // The unpinned read goes second and is the cheaper question. It exists only
    // to notice that somebody already finished this ramp by hand.
    const split = await sampleSplit(version, null, `${runId}-${n}`, SPLIT_READ);
    const allOnTarget = split.answered > 0 && split.onTarget === split.answered;
    passes.push({ pinned, allOnTarget, sampleAnswered: split.answered });

    const stalled = pinned.stalls ? `, ${pinned.stalls} stalled` : "";
    console.log(
      `  pass ${n}: pinned ${pinned.onTarget}/${pinned.total} on target, ${pinned.errors} error(s)${stalled}` +
      `; split ${split.onTarget}/${split.answered} on target`,
    );

    // Stop early on anything conclusive. Waiting out the clock after finding a
    // fault leaves a broken version serving 10% for the remainder of the soak.
    const interim = verdictFor(passes);
    if (interim.verdict === "faulty" || interim.verdict === "shipped") break;
    if (has("once") || Date.now() + intervalMs >= deadline) break;
    await sleep(intervalMs);
  }

  const { verdict, reason } = verdictFor(passes);
  console.log(`\nsoak: verdict=${verdict} passes=${passes.length}`);
  console.log(`soak: ${reason}`);

  // Actions reads these; a local run just sees the lines above.
  // A STATIC import above rather than a dynamic one here, so `derive:check`'s
  // writer census can see this file at all. The census scans for write calls to
  // decide whether a tool needs a declaration in config/derivations.json, and a
  // dynamically imported `appendFile` is invisible to it. Hiding from a check by
  // accident is how gotcha 46 got nine days of head start.
  if (process.env.GITHUB_OUTPUT) {
    await appendFile(process.env.GITHUB_OUTPUT, `verdict=${verdict}\nreason=${reason}\n`);
  }
  process.exit(EXIT[verdict]);
}

// Only when run, never when imported by a test. `import.meta.main` rather than
// an argv comparison, for the reason gotcha 45 measures: node leaves argv[1]
// uncanonicalised, so the comparison reads false through a symlinked path and
// the module exits 0 having done nothing.
if (import.meta.main) await main();
