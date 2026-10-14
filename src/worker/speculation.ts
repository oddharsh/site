// speculation.ts — did the hand-tuned speculation rules actually pay off?
//
// WHY THE NUMERATOR CANNOT JUST BE COUNTED SERVER-SIDE, measured rather than
// argued (Canary 153, local worker, 2026-07-30). Inject a URL-list prefetch of
// /garage/horizon, then navigate to it. The browser makes two requests:
//
//     GET /garage/horizon  [sec-purpose: prefetch]     <- speculation
//     GET /garage/horizon  [normal navigation]         <- activation
//
// but the WORKER LOG for that run holds exactly one line, the prefetch. The
// activation was served out of the prefetch cache and never crossed the
// network. So the server sees every speculation and is structurally blind to
// every payoff, which is the whole reason the numerator has to come back as a
// beacon instead of a log line.

const SPECULATIVE = /prefetch|prerender/i;

function versionBlob(env) {
  return env.CF_VERSION_METADATA?.id?.slice(0, 8) || "dev";
}

// The endpoint the browser is told to HEAD. Relative per the explainer, with
// the speculated path carried in the query because the beacon is credentialless
// (no cookies, and no Referer worth trusting), so the request itself is the only
// place that can say WHICH page's speculation paid off. Our own pathname, never
// anything the visitor typed.
export function prefetchActivationHeader(pathname) {
  return `/ledger/prefetch?p=${encodeURIComponent(pathname)}`;
}

export function countSpeculativeLoad(env, request, response, pathname) {
  try {
    if (!env.SPECULATION || response.status >= 400) return;
    const purpose = request.headers.get("sec-purpose") || "";
    if (!SPECULATIVE.test(purpose)) return;
    // Documents only. A prerendered page fetches its own scripts, styles and
    // fragments with the same Sec-Purpose, and those were counted as prerenders
    // of /a/notepad.<hash>.js or /photos/grid.html until 2026-09-29, a
    // denominator no navigation could ever answer. An absent header is kept,
    // since a client that sends Sec-Purpose without Sec-Fetch-Dest is rare and
    // dropping it would hide real speculations.
    const dest = request.headers.get("sec-fetch-dest");
    if (dest && dest !== "document") return;
    const kind = /prerender/i.test(purpose) ? "prerender" : "prefetch";
    env.SPECULATION.writeDataPoint({
      blobs: [kind, pathname.slice(0, 96), versionBlob(env)],
      doubles: [1],
      indexes: [kind],
    });
  } catch {}
}

export function handlePrefetchActivation(request, env) {
  if (request.method !== "HEAD" && request.method !== "GET") {
    return new Response(null, { status: 405, headers: { allow: "GET, HEAD" } });
  }
  try {
    if (env.SPECULATION) {
      const params = new URL(request.url).searchParams;
      const p = params.get("p") || "(unknown)";
      const kind = params.get("via") === "client" ? "activated-client" : "activated";
      env.SPECULATION.writeDataPoint({
        blobs: [kind, p.slice(0, 96), versionBlob(env)],
        doubles: [1],
        indexes: [kind],
      });
    }
  } catch {}
  return new Response(null, {
    status: 204,
    headers: { "cache-control": "no-store" },
  });
}

import { analyticsReadError, analyticsSql, text, type AnalyticsRow } from "./ledger.ts";
import { jsonResponse } from "./lib/http.ts";

export const SPECULATION_DATASET = "aadhar_speculation";
export const SPECULATION_WINDOW_DAYS = 30;

export type SpeculationRow = {
  path: string; prefetch: number; prerender: number; activated: number;
  speculated: number; rate: number | null;
};

const HEADER = "activated", CLIENT = "activated-client";

export function summarizeSpeculation(rows: AnalyticsRow[]): SpeculationRow[] {
  const byPath = new Map<string, SpeculationRow>();
  const sources = new Map<string, { header: number; client: number }>();
  for (const r of rows) {
    const kind = text(r.kind, "");
    if (kind !== "prefetch" && kind !== "prerender" && kind !== HEADER && kind !== CLIENT) continue;
    const path = text(r.path, "(unknown)");
    const n = Math.round(Number(r.n) || 0);
    if (n <= 0) continue;
    const row = byPath.getOrInsertComputed(path, () => ({ path, prefetch: 0, prerender: 0, activated: 0, speculated: 0, rate: null }));
    if (kind === HEADER || kind === CLIENT) {
      const src = sources.getOrInsertComputed(path, () => ({ header: 0, client: 0 }));
      src[kind === HEADER ? "header" : "client"] += n;
    } else row[kind] += n;
  }
  const out = [...byPath.values()];
  for (const row of out) {
    const src = sources.get(row.path);
    row.activated = src ? Math.max(src.header, src.client) : 0;
    row.speculated = row.prefetch + row.prerender;
    row.rate = row.speculated ? Math.min(1, row.activated / row.speculated) : null;
  }
  return out.sort((a, b) => b.speculated - a.speculated || a.path.localeCompare(b.path));
}

export async function handleSpeculationJson(request, env) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return jsonResponse({ ok: false, error: "method not allowed", code: "method_not_allowed", allow: ["GET", "HEAD"] }, 405, { allow: "GET, HEAD" });
  }
  const read = await analyticsSql(env, SPECULATION_DATASET, (from, sum) =>
    `SELECT blob1 AS kind, blob2 AS path, ${sum("double1")} AS n ` +
    `FROM ${from} WHERE timestamp > NOW() - INTERVAL '${SPECULATION_WINDOW_DAYS}' DAY ` +
    `GROUP BY kind, path`);
  if (!read.ok) {
    const { status, error, code } = analyticsReadError(read.reason);
    return jsonResponse({ ok: false, error, code, reason: read.reason, binding_fallback: read.binding_fallback, window_days: SPECULATION_WINDOW_DAYS }, status);
  }
  const rows = summarizeSpeculation(read.data);
  return jsonResponse({
    ok: true, via: read.via, binding_fallback: read.binding_fallback, window_days: SPECULATION_WINDOW_DAYS, dataset: SPECULATION_DATASET,
    note: "speculations are Sec-Purpose prefetch/prerender DOCUMENT requests that reached the origin (sub-resources excluded since 2026-09-29); activations are the larger of the on-prefetch-activation beacon and nav.js's prerenderingchange beacon (recorded since 2026-09-29; before that the numerator had no working instrument); rate orders paths and is not a strict conversion rate",
    rows,
  }, 200, { "cache-control": "public, max-age=300, s-maxage=300" });
}
