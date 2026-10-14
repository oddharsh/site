import { handlePhotoGrid } from "./home.ts";
import { rnTracksHtml } from "./rn.ts";
import { CANONICAL_HOST } from "./lib/const.ts";

export async function cronHomeProbe(env, ctx) {
  if (!env.PERF_PROBE) return;
  try {
    const request = new Request(`https://${CANONICAL_HOST}/`, {
      headers: { "user-agent": "AadharshBot/1.0 (+https://aadhar.sh/bot) perf-probe" },
    });
    const time = async (fn) => {
      const s = Date.now();
      let r;
      try { r = await fn(); } catch { return null; }
      try { await r.body?.cancel(); } catch {}
      return Date.now() - s;
    };
    const tracksMs = await time(() => rnTracksHtml(request, env, ctx, { warm: false }));
    const gridMs = await time(() => handlePhotoGrid(request, env));
    if (tracksMs == null && gridMs == null) return;
    env.PERF_PROBE.writeDataPoint({
      blobs: ["", env.CF_VERSION_METADATA?.id || "dev"],
      doubles: [-1, tracksMs ?? -1, -1, -1, (tracksMs ?? 0) + (gridMs ?? 0)],
      indexes: ["home"],
    });
  } catch {}
}
