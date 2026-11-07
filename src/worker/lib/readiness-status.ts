// lib/readiness-status.ts: the two status vocabularies /lens checks speak.
//
// The readiness mirror (lensReadiness in lens.ts, agent-execution.ts) grades
// each declaration pass, fail, unknown or neutral, and /openapi.json publishes
// that list as ReadinessCheck.status, derived from the array below. The need
// score (lens-need.ts) grades on a credit scale, so it adds `partial` for a
// check that earned some credit and not all; no mirror check carries it.
//
// Node-safe (gotcha 16): openapi.ts imports this at build time.

export const READINESS_STATUSES = ["pass", "fail", "unknown", "neutral"] as const;
export type ReadinessStatus = (typeof READINESS_STATUSES)[number];
export type NeedStatus = ReadinessStatus | "partial";
