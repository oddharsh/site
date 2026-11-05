// vitals.ts — the receiver for field Core Web Vitals, on /garage/horizon only.
//
// Until 2026-11-05 every performance number here came from a lab: Lighthouse,
// the PERF_PROBE cron, perf-snapshot's byte diff. The homepage's 0.116 CLS
// (fixed in #1528) was a lab catch; a visitor on iOS Safari, where Tahoma
// falls back, would have reported it on the first visit. So one page now
// reports what its real visitors see.
//
// Why one page. The owner's condition was that only /garage/horizon pays for
// it: the observer script is inline on that page alone, and this route rides
// the existing /ledger/* claim, so no other page gains a byte and the
// run_worker_first allowlist gains no row. Horizon is the page that
// test-drives upcoming platform features, so it is also the page most likely
// to shift or stall in a browser the lab never ran.
//
// Shape: one data point per metric per page view, so a missing INP (nobody
// interacted) is a missing row rather than a sentinel in a column.
// blob1 metric, blob2 path, blob3 serving version; double1 value; index the
// metric, so a percentile is a GROUP BY. LCP and INP are milliseconds, CLS is
// unitless. Read it back with the SQL in docs/MAINTENANCE.md.
//
// A metric must never break a page, so every failure answers 204.
import type { Env } from "./lib/env.ts";
import { asNumber, asRecord, asText } from "./lib/parse.ts";

/** The pages whose inline observer posts here. Anything else is dropped. */
export const VITALS_PATHS: ReadonlySet<string> = new Set(["/garage/horizon"]);

// Upper bounds a real view can't pass. A tab left open for an hour before
// its first click can, and that view is noise, so it is dropped.
const CEILING = { LCP: 60_000, CLS: 10, INP: 60_000 } as const;
type Metric = keyof typeof CEILING;
const METRICS = Object.keys(CEILING) as Metric[];

// sendBeacon's body is about 60 bytes; this is ten times that.
const MAX_BODY = 600;

export type VitalsReport = { path: string; values: Partial<Record<Metric, number>> };

/** Parse a beacon body once, at the boundary. null when it is not one of ours. */
export function parseVitals(body: string): VitalsReport | null {
  if (body.length > MAX_BODY) return null;
  let record: Record<string, unknown> | null;
  try {
    record = asRecord(JSON.parse(body));
  } catch {
    return null;
  }
  const path = asText(record?.p);
  if (!record || !path || !VITALS_PATHS.has(path)) return null;
  const values: Partial<Record<Metric, number>> = {};
  for (const metric of METRICS) {
    const value = asNumber(record[metric.toLowerCase()]);
    if (value !== null && value >= 0 && value <= CEILING[metric]) values[metric] = value;
  }
  return { path, values };
}

export async function handleVitals(request: Request, env: Pick<Env, "VITALS" | "CF_VERSION_METADATA">): Promise<Response> {
  if (request.method !== "POST") return new Response(null, { status: 405, headers: { allow: "POST" } });
  try {
    const report = parseVitals(await request.text());
    if (report) {
      const version = env.CF_VERSION_METADATA?.id?.slice(0, 8) || "dev";
      for (const metric of METRICS) {
        const value = report.values[metric];
        if (value === undefined) continue;
        env.VITALS.writeDataPoint({ blobs: [metric, report.path, version], doubles: [value], indexes: [metric] });
      }
    }
  } catch {
    // a metric must never break a page; the browser ignores the answer anyway
  }
  return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
}
