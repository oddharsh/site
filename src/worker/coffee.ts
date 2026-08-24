// Public, read-only coffee availability. Booking remains delegated to cal and
// keeps its own fail-closed validation; this route is a small machine-facing
// view over the same slot calculation.
import { getPublicAvailability } from "../../cal/src/slots.ts";
import { jsonResponse } from "./lib/http.ts";

export async function readCoffeeAvailability(env, ctx) {
  return getPublicAvailability(env, ctx);
}

export async function handleCoffeeAvailability(request, env, ctx) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return jsonResponse({ ok: false, error: "method not allowed" }, 405, { allow: "GET, HEAD" });
  }
  try {
    const payload = await readCoffeeAvailability(env, ctx);
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
