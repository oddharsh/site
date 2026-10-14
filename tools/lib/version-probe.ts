// Reading which version of the site answered a request.

export const SAMPLE_URL = "https://aadhar.sh/whoareyou.json";
export const SAMPLES = 40;
export const REQ_TIMEOUT_MS = 8000;
export const PINNED_PROBES = 12;

// Poll the live site and attribute each response to a version. Sequential on
// purpose: gradual deployments have no per-request affinity by default, but
// connection reuse can pin a burst of parallel requests to one version and make
// a working ramp look like a dead one.
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
          // Cloudflare hashes this header to choose a version, so a fresh key
          // per request cannot be pinned by a reused connection. That is the
          // hazard this loop's sequential shape was already working around.
          "cloudflare-workers-version-key": `ramp-${runId}-${i}`,
        },
        cache: "no-store",
        signal: AbortSignal.timeout(REQ_TIMEOUT_MS),
      });
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
  const answered = count - stalls;
  return { seen, errors, errorVersions, stalls, stallReasons, answered, onTarget, onPrevious, total: count };
}

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

export function countMatching(seen, id) {
  const want = String(id).slice(0, 8);
  let n = 0;
  for (const [k, v] of seen) if (String(k).slice(0, 8) === want) n += v;
  return n;
}
