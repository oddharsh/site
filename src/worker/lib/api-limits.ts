// lib/api-limits.ts: the caps and defaults of the public JSON endpoints, once.
//
// Node-safe (gotcha 16): no imports.

export const SEARCH_LIMITS = { queryMax: 160, limitDefault: 20, limitMax: 50 } as const;

export const PHOTO_QUERY_LIMITS = { textMax: 120, dateMax: 32, limitDefault: 25, limitMax: 100, offsetMax: 10000 } as const;

export const ASK_LIMITS = { topKDefault: 10, topKMax: 50, prevMax: 10 } as const;

export const CHANGE_RADAR_LIMITS = { limitDefault: 50, limitMax: 100 } as const;

export const API_READ_BUDGET = { binding: "API_RL", max: 120 } as const;

export const LENS_FETCH_TIMEOUT_MS = 8000;

export function clampParam(raw: unknown, fallback: number, max: number, min = 1): number {
  return Math.min(max, Math.max(min, Number(raw) || fallback));
}
