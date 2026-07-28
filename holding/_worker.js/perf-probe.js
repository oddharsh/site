// perf-probe.js — the homepage's Server-Timing spans, sampled on a cron and
// written to Analytics Engine so latency regressions show up as data instead
// of anecdotes. Bundled by wrangler at deploy; not served (inside _worker.js/).
//
// Why this exists: this site's failure modes are INTERMITTENT. KV eviction
// cold-reads (100-200ms, any moment, untunable) and cold isolates both hide
// from one-off curls — every diagnosis in home.js's comment history burned a
// session rediscovering them by hand. The probe renders `/` in-process every
// 30 minutes (offset :07/:37), parses the same Server-Timing header a curl
// would see, and writes the spans + any `;desc=deadline` marks to the
// aadhar_perf_probe dataset. After a perf deploy, the before/after is a SQL
// query instead of a sampling session.
//
// In-process on purpose: a `fetch("https://aadhar.sh/")` from inside this
// worker is blocked as recursion (error 1042), and dispatching through the
// handler measures exactly what gates a visitor's first byte — the KV fan-out
// behind `/`. Two honest limits, both acceptable for regression-watching:
// the probe sees only the colo the cron fires in, and it measures worker time,
// not edge/network time. The 30-minute gap deliberately exceeds every
// cacheTtl on the render path (max 300s), so each sample finds the colo's KV
// cache in whatever state eviction left it rather than in a probe-warmed one.
// (The render's own SWR refreshes fire as on any visit; the probe IS a visit.)
import { serveHomepageWithPrerenderedTracks } from "./home.js";
import { CANONICAL_HOST } from "./lib/const.js";

// "assets;dur=5, tracks;dur=25;desc=deadline" -> { spans: {assets: 5, ...},
// deadlined: ["tracks"] }. Tolerates reordering, missing spans, and unknown
// params; a span it cannot parse is skipped rather than guessed at.
export function parseServerTiming(header) {
  const spans = {};
  const deadlined = [];
  for (const part of String(header || "").split(",")) {
    const fields = part.trim().split(";").map((f) => f.trim());
    const name = fields[0];
    if (!/^[a-z][a-z0-9_-]*$/i.test(name)) continue;
    const dur = fields.find((f) => f.startsWith("dur="));
    if (!dur) continue;
    const v = Number(dur.slice(4));
    if (!Number.isFinite(v)) continue;
    spans[name] = v;
    if (fields.includes("desc=deadline")) deadlined.push(name);
  }
  return { spans, deadlined };
}

// One datapoint per probe. Fixed column meanings (AE columns are positional):
//   doubles: [assets, tracks, alt, counter, total]   (-1 = span absent)
//   blobs:   [deadlined CSV ("" = none), worker version id]
//   indexes: ["home"]
// The version blob is what turns this into a deploy A/B: group by blob2 and
// the cold-start behavior of consecutive versions sits side by side.
export async function cronHomeProbe(env, ctx) {
  if (!env.PERF_PROBE) return;
  try {
    const request = new Request(`https://${CANONICAL_HOST}/`, {
      headers: { "user-agent": "AadharshBot/1.0 (+https://aadhar.sh/bot) perf-probe" },
    });
    const res = await serveHomepageWithPrerenderedTracks(request, env, ctx);
    const { spans, deadlined } = parseServerTiming(res.headers.get("server-timing"));
    // headers are complete before the body streams (finish() stamps them at
    // return); cancel the rewriter stream rather than pull 13KB for nothing.
    try { await res.body?.cancel(); } catch {}
    env.PERF_PROBE.writeDataPoint({
      blobs: [
        deadlined.join(","),
        env.CF_VERSION_METADATA?.id || "dev",
      ],
      doubles: [
        spans.assets ?? -1,
        spans.tracks ?? -1,
        spans.alt ?? -1,
        spans.counter ?? -1,
        spans.total ?? -1,
      ],
      indexes: ["home"],
    });
  } catch {
    // a failed probe writes nothing; a gap in the series IS the alert, and a
    // probe bug must never take the scheduled() handler down with it.
  }
}
