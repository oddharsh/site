// Reading which version of the site answered a request.
//
// Everything here is plain HTTPS against production. No wrangler, no Cloudflare
// credential, no filesystem. That is the whole reason it is a separate file:
// `deploy-promote.ts` performs `currentDeployment()` at module scope, so
// importing it runs a ramp's worth of authenticated setup and refuses outright
// without a token. These four functions were trapped inside it, which meant the
// two checks that decide whether a release is healthy had never been reachable
// from a test or from any second caller.
//
// The second caller is `tools/soak-canary.ts`, which watches a 10% canary for
// twenty minutes and then resolves it. It needs exactly these questions
// answered and none of the credentialed ones.
//
// Moved verbatim on 2026-09-22, comments included, with two changes and no
// third: `sample` is `sampleSplit` because the bare name says nothing at an
// import site, and its per-request affinity key takes the run id as an argument
// rather than reading a module global. The ramp passes the same value it always
// generated, so the bytes on the wire are unchanged.

// Every probe reads this one route because it is the only one that reports WHICH
// version answered. Both site versions read the same D1 changelog, so
// `/updates.json` structurally cannot tell two of them apart.
export const SAMPLE_URL = "https://aadhar.sh/whoareyou.json";
export const SAMPLES = 40;
// Per-request ceiling, and the ONLY thing standing between a stalled socket and
// a wedged release. `fetch` has no default request timeout, so before this the
// 100% step of the v177 ramp exited with `Detected unsettled top-level await` in
// the middle of the sampler: traffic had already moved, and the D1 changelog
// write that runs AFTER sampling never happened. The repair was documented
// (re-run `--to 100`, which moves nothing and logs); the hang should not have
// needed one. 8s is ~5x the whole 40-request sweep measured against production
// (1.5s), so a timeout here means something is genuinely wrong rather than
// merely slow.
export const REQ_TIMEOUT_MS = 8000;
// The PINNED probe: requests aimed at one version with
// `Cloudflare-Workers-Version-Overrides`, rather than fired into the split and
// sorted afterwards. Small on purpose. The unpinned sweep needs 40 because it is
// looking for a 10% signal in noise; this one is deterministic, so 12 requests
// buy 12 real exercises of the new code instead of ~1.2.
export const PINNED_PROBES = 12;

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
// `count` exists for the soak, which repeats this read every few minutes for
// twenty minutes and does not need 40 requests to answer its question. The ramp
// needs 40 because it is looking for a 10% signal in noise. The soak is asking
// whether the target holds EVERYTHING, and 12 requests separate 10% from 100%
// by a factor no sample size makes ambiguous: at a true 10%, twelve consecutive
// hits on the target is a 1-in-10^12 event.
export async function sampleSplit(target, previous, runId, count = SAMPLES) {
  const seen = new Map();
  let errors = 0, stalls = 0;
  const errorVersions: string[] = [];
  const stallReasons: string[] = [];

  for (let i = 0; i < count; i++) {
    try {
      const res = await fetch(`${SAMPLE_URL}?s=${i}`, {
        headers: {
          accept: "application/json",
          // A DISTINCT affinity key per request, and it does two jobs.
          //
          // Cloudflare hashes this header to choose a version, so a fresh key
          // per request cannot be pinned by a reused connection. That is the
          // hazard this loop's sequential shape was already working around.
          //
          // It also keeps the sweep working once the version-affinity Transform
          // Rule exists. That rule derives the same header from ip.src, so a
          // sweep from one machine would otherwise hash to ONE version and a
          // healthy ramp would read as dead. The rule skips requests that
          // already carry a key, which is what makes this line survive it;
          // infra.json's zone.version_affinity declares that exemption and
          // check-infra.mjs asserts it.
          "cloudflare-workers-version-key": `ramp-${runId}-${i}`,
        },
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
  const answered = count - stalls;
  return { seen, errors, errorVersions, stalls, stallReasons, answered, onTarget, onPrevious, total: count };
}

// ---------------------------------------------------- the pinned probe ----

// Ask ONE version directly, with `Cloudflare-Workers-Version-Overrides`.
//
// WHY THIS EXISTS ALONGSIDE sample(). The two answer different questions, and
// until 2026-08-14 only one of them was being asked. sample() fires into the
// live split and sorts the results, so at a 10% step roughly 4 of its 40
// requests exercise the new code and the other 36 re-prove that the version
// already serving production still works. The whole reason to ramp is to catch a
// fault in the NEW version while it is small, and the check aimed at it had four
// requests behind it.
//
// The override header removes the sampling entirely: every request here is
// handled by the target, so 12 of 12 exercise the code about to take the site.
// An error found this way is conclusive in the way sample()'s errors were only
// probabilistically conclusive.
//
// TWO CONSTRAINTS, both from Cloudflare's docs and both load-bearing. The
// override only applies if the named version is IN the current deployment, so
// this can only run after the step that puts it there, never before. And it
// bypasses the split by construction, so it says nothing about whether traffic
// actually moved, which stays sample()'s job, and is why both still run.
export async function probePinned(versionId, worker) {
  const override = `${worker}="${versionId}"`;
  let onTarget = 0, offTarget = 0, errors = 0, stalls = 0;
  const errorDetail: string[] = [], stallReasons: string[] = [], strayVersions = new Set();

  for (let i = 0; i < PINNED_PROBES; i++) {
    try {
      const res = await fetch(`${SAMPLE_URL}?p=${i}`, {
        headers: { accept: "application/json", "cloudflare-workers-version-overrides": override },
        cache: "no-store",
        signal: AbortSignal.timeout(REQ_TIMEOUT_MS),
      });
      const version = await servingVersion(res);
      if (!res.ok) {
        errors++;
        errorDetail.push(version ? `${String(version).slice(0, 8)} HTTP ${res.status}` : `HTTP ${res.status}`);
        continue;
      }
      // A 200 from the WRONG version means the override was not honoured, which
      // is an instrument failure rather than a fault in the release. Counted
      // separately for that reason: treating it as an error would roll back a
      // healthy deploy because a header did not apply.
      if (String(version || "").slice(0, 8) === String(versionId).slice(0, 8)) onTarget++;
      else { offTarget++; if (version) strayVersions.add(String(version).slice(0, 8)); }
    } catch (e) {
      stalls++;
      stallReasons.push(e?.name === "TimeoutError" ? `timed out after ${REQ_TIMEOUT_MS}ms` : String(e?.message || e));
    }
  }

  return { onTarget, offTarget, errors, errorDetail, stalls, stallReasons, strayVersions: [...strayVersions], answered: PINNED_PROBES - stalls, total: PINNED_PROBES };
}

export async function servingVersion(res) {
  try {
    const body = await res.json();
    const server = (body.groups || []).find((g) => g.title === "Server");
    const field = (server?.fields || []).find((f) => f.k === "Serving version");
    return field?.v || null;
  } catch { return null; }
}

// /whoareyou.json reports the full version id; the CLI and the log line use the
// 8-char prefix. Compare on the prefix so either form matches.
export function countMatching(seen, id) {
  const want = String(id).slice(0, 8);
  let n = 0;
  for (const [k, v] of seen) if (String(k).slice(0, 8) === want) n += v;
  return n;
}
