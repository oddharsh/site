// Sample the homepage fragment handlers at :07/:37 for a per-version latency
// series in Analytics Engine. The measurement sees the cron's colo and the
// handlers' I/O; it does not measure browser load time or synchronous CPU.
import { handlePhotoGrid } from "./home.ts";
import { rnTracksHtml } from "./rn.ts";
import { CANONICAL_HOST } from "./lib/const.ts";

// Preserve the persisted column positions from the old homepage SSR series:
// doubles [assets, tracks, alt, counter, total], blobs [deadlines, version],
// index ["home"]. Retired spans stay -1 and deadlines stay empty. The total is
// the sum of completed fragment timings, so it can be partial if one throws.
export async function cronHomeProbe(env, ctx) {
  if (!env.PERF_PROBE) return;
  try {
    const request = new Request(`https://${CANONICAL_HOST}/`, {
      headers: { "user-agent": "AadharshBot/1.0 (+https://aadhar.sh/bot) perf-probe" },
    });
    // Neither fragment emits Server-Timing. Time the handler and cancellation;
    // a thrown handler has no duration, while a returned error response does.
    const time = async (fn) => {
      const s = Date.now();
      let r;
      try { r = await fn(); } catch { return null; }
      try { await r.body?.cancel(); } catch {}
      return Date.now() - s;
    };
    // warm: false, because the art warm is a visitor-colo side effect that runs
    // after the response and so is not part of what this times, and because it
    // fans out in THIS invocation, the cron tick cronEnrichTracks shares. See
    // handleRnTracksHtml in rn.ts for the tick it cost.
    const tracksMs = await time(() => rnTracksHtml(request, env, ctx, { warm: false }));
    const gridMs = await time(() => handlePhotoGrid(request, env));
    // Both arms failing means the probe learned nothing. Say nothing.
    if (tracksMs == null && gridMs == null) return;
    env.PERF_PROBE.writeDataPoint({
      blobs: ["", env.CF_VERSION_METADATA?.id || "dev"],
      doubles: [-1, tracksMs ?? -1, -1, -1, (tracksMs ?? 0) + (gridMs ?? 0)],
      indexes: ["home"],
    });
  } catch {
    // a failed probe writes nothing; a gap in the series IS the alert, and a
    // probe bug must never take the scheduled() handler down with it.
  }
}
