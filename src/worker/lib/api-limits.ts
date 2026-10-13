// lib/api-limits.ts: the caps and defaults of the public JSON endpoints, once.
//
// Each number here is enforced by its handler AND published: in /openapi.json
// (lib/public-api.ts, written at build), in the MCP tool schemas (lib/tools.ts),
// and on /developers. They were five hand copies of the same literals until
// 2026-10-13, and only the page prose had a drift check. Now the handler reads
// the same constant the documents print, so the two cannot disagree.
//
// The per-feature rate budgets live beside the code that spends them:
// LENS_BUDGETS (lens-pipeline.ts) and ASK_BUDGET (ask-rank.ts). The one here is
// the API's own. Each is held to its cloudflare.config.ts ratelimit by
// contract-lens-per-ip-crawl-budgets.
//
// Node-safe (gotcha 16): no imports.

/** /search.json and the search_site tool. */
export const SEARCH_LIMITS = { queryMax: 160, limitDefault: 20, limitMax: 50 } as const;

/** /photos/query.json and the photo_query tool. */
export const PHOTO_QUERY_LIMITS = { textMax: 120, dateMax: 32, limitDefault: 25, limitMax: 100, offsetMax: 10000 } as const;

/** /ask and the ask tool. */
export const ASK_LIMITS = { topKDefault: 10, topKMax: 50, prevMax: 10 } as const;

/** /around/changes.json and the change_radar tool. */
export const CHANGE_RADAR_LIMITS = { limitDefault: 50, limitMax: 100 } as const;

/** The read budget every documented endpoint without a budget of its own
 *  shares, per caller per minute (lib/api-contract.ts). Sized so a person or
 *  an agent paging the photo archive never meets it; it exists so the API
 *  can say what it tolerates (RateLimit-Policy) and mean it. */
export const API_READ_BUDGET = { binding: "API_RL", max: 120 } as const;

/** How long /lens/fetch waits on the target before answering 502. */
export const LENS_FETCH_TIMEOUT_MS = 8000;

/** `Math.min(max, Math.max(min, Number(raw) || fallback))`, the clamp every
 *  endpoint above applies to a numeric query parameter. */
export function clampParam(raw: unknown, fallback: number, max: number, min = 1): number {
  return Math.min(max, Math.max(min, Number(raw) || fallback));
}
