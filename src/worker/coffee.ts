// Public, read-only coffee availability. Booking remains delegated to cal and
// keeps its own fail-closed validation; this route is a small machine-facing
// view over the same slot calculation.

import { getPublicAvailability } from "../../cal/src/slots.ts";
import { jsonResponse, methodGuard } from "./lib/http.ts";

export async function handleCoffeeAvailability(request, env, ctx) {
  const refused = methodGuard(request, ["GET"]);
  if (refused) return refused;
  try {
    const payload = await getPublicAvailability(env, ctx);
    const status = payload.available ? 200 : 503;
    const headers = {
      "cache-control": payload.available ? "public, max-age=0, s-maxage=30" : "public, max-age=0, s-maxage=10",
      "x-robots-tag": "noindex",
    };
    if (!payload.available) headers["retry-after"] = "60";
    return jsonResponse(payload, status, headers);
  } catch {
    return jsonResponse({ available: false, stale: true, error: "availability is temporarily unavailable", slots: [] }, 503, {
      "retry-after": "60",
      "x-robots-tag": "noindex",
    });
  }
}
