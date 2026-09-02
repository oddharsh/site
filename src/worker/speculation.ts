// speculation.js — did the hand-tuned speculation rules actually pay off?
//
// index.html ships two speculation rules: prerender almost everything at
// `eagerness: moderate` (roughly "the pointer rested on this link"), and
// prefetch /garage/* + /lwe/* eagerly. Both were written by REASONING about
// which link a visitor takes next, and until now nothing checked the reasoning.
// The only evidence they helped was that pages felt fast when I clicked them,
// which is not evidence: I wrote the rules, so I already know where I am going.
//
// A speculation that never activates is bandwidth spent on the visitor's behalf
// for nothing — a whole document plus subresources, fetched, rendered, and
// dropped. Precision (activated / speculated) is the number worth knowing, and
// it needs BOTH halves:
//
//   DENOMINATOR — every speculative request. Chrome has sent `Sec-Purpose:
//     prefetch` (and `prefetch;prerender`) for years, counter.js already reads
//     it to avoid counting a speculative load as a visit, and it arrives at this
//     worker on every worker-first route. This half works TODAY.
//
//   NUMERATOR — the activation. The `on-prefetch-activation` response header
//     names an endpoint the browser HEADs when a speculated document is
//     actually used for a navigation.
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
//
// STATUS, and the reason this ships half-dark on purpose. chromestatus lists
// the beacon as *Proposed* with NO stable milestone, behind an origin trial
// named `PrefetchAndPrerenderActivationBeacon` (desktop_first 151, and
// `origintrial: false` on the record, so the trial may not even be open yet).
// VERIFIED ABSENT in Chrome Canary 153.0.7978.0 on 2026-07-30: a prefetch that
// demonstrably fired and was demonstrably used sent no beacon under any of
// three flag spellings (`--enable-features=PrefetchAndPrerenderActivationBeacon`,
// `--enable-blink-features=` with the same name, and
// `--enable-experimental-web-platform-features` alone). So 151 is a plan rather
// than a shipped state, and the numerator stays at zero until this origin joins
// the trial or the feature reaches stable. The denominator starts recording the
// moment this deploys.
//
// Re-test cheaply: prefetch a URL, navigate to it, and watch for a HEAD to
// /ledger/prefetch. The absence of that HEAD is the whole signal.
//
// That asymmetry is deliberate rather than an oversight. Shipping the receiver
// now means the only remaining step is a trial registration, which is a form
// the owner submits rather than code anyone has to write, and the endpoint is
// real on the day it turns on. What this must NOT do is imply a number it does
// not have: /ledger reports the two halves separately and says so.
//
// Everything here is best-effort. A metric must never break a page.

const SPECULATIVE = /prefetch|prerender/i;

// The serving version, as blob3 on both writes. Speculation is the one ledger
// here that a gradual deployment can genuinely move: prerender depends on the
// speculation-rules block in the served document, so a ramp that changes those
// rules changes the activation rate, and a denominator you cannot split by
// version cannot show it. Appended rather than inserted, so the existing blob1
// (kind) and blob2 (path) SQL keeps reading the same columns. "dev" locally,
// where the binding exists but CF_VERSION_METADATA does not.
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

// DENOMINATOR. Called from the dispatcher next to countCrawlerHit.
export function countSpeculativeLoad(env, request, response, pathname) {
  try {
    if (!env.SPECULATION || response.status >= 400) return;
    const purpose = request.headers.get("sec-purpose") || "";
    if (!SPECULATIVE.test(purpose)) return;
    // "prerender" is the stronger claim and the more expensive one, so when a
    // header says both (`prefetch;prerender`) it counts as a prerender.
    const kind = /prerender/i.test(purpose) ? "prerender" : "prefetch";
    env.SPECULATION.writeDataPoint({
      // blob3 is the serving version (see the note on the activation write).
      blobs: [kind, pathname.slice(0, 96), versionBlob(env)],
      doubles: [1],
      indexes: [kind],
    });
  } catch { /* best-effort; never break a response over a counter */ }
}

// NUMERATOR. The browser HEADs this when a speculated document gets used.
export function handlePrefetchActivation(request, env) {
  // GET is accepted alongside HEAD purely so this is curl-able while the
  // origin trial is pending; the browser itself only ever sends HEAD.
  if (request.method !== "HEAD" && request.method !== "GET") {
    return new Response(null, { status: 405, headers: { allow: "GET, HEAD" } });
  }
  try {
    if (env.SPECULATION) {
      const p = new URL(request.url).searchParams.get("p") || "(unknown)";
      env.SPECULATION.writeDataPoint({
        blobs: ["activated", p.slice(0, 96), versionBlob(env)],
        doubles: [1],
        indexes: ["activated"],
      });
    }
  } catch { /* as above */ }
  // 204 with no body: the browser wants an acknowledgement, not a document.
  return new Response(null, {
    status: 204,
    headers: { "cache-control": "no-store" },
  });
}

// ── the readback: /ledger/speculation.json ─────────────────────────────────────
// Everything above WRITES the ledger; until 2026-09-02 nothing read it, so the
// one question the ledger exists to answer (which speculated documents get
// navigated to, and which are rendered for nobody) was answerable only from
// the dashboard. This is the same SQL read /ledger.json makes over its own
// dataset, grouped per path and kind, folded into one row per path.
//
// `rate` is activations over speculations. It is NOT a conversion rate in the
// strict sense: an activation beacon fires when a speculated document is used,
// while the denominator counts speculations that reached the origin, and a
// prefetch that later upgraded to a prerender counts twice there. Read it as an
// ordering, which is what tools/speculation-report.ts does with it. The report
// is also where any promotion to a more eager rule is decided; this route only
// answers.
import { analyticsSql, text, type AnalyticsRow } from "./ledger.ts";

export const SPECULATION_DATASET = "aadhar_speculation";
export const SPECULATION_WINDOW_DAYS = 30;

export type SpeculationRow = {
  path: string; prefetch: number; prerender: number; activated: number;
  speculated: number; rate: number | null;
};

// Pure over the SQL rows, so the contract test can pin the arithmetic without a
// token. Unknown kinds are ignored rather than counted as anything.
export function summarizeSpeculation(rows: AnalyticsRow[]): SpeculationRow[] {
  const byPath = new Map<string, SpeculationRow>();
  for (const r of rows) {
    const kind = text(r.kind, "");
    if (kind !== "prefetch" && kind !== "prerender" && kind !== "activated") continue;
    const path = text(r.path, "(unknown)");
    const n = Math.round(Number(r.n) || 0);
    if (n <= 0) continue;
    let row = byPath.get(path);
    if (!row) { row = { path, prefetch: 0, prerender: 0, activated: 0, speculated: 0, rate: null }; byPath.set(path, row); }
    row[kind] += n;
  }
  const out = [...byPath.values()];
  for (const row of out) {
    row.speculated = row.prefetch + row.prerender;
    row.rate = row.speculated ? Math.min(1, row.activated / row.speculated) : null;
  }
  return out.sort((a, b) => b.speculated - a.speculated || a.path.localeCompare(b.path));
}

export async function handleSpeculationJson(request, env) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response(null, { status: 405, headers: { allow: "GET, HEAD" } });
  }
  const read = await analyticsSql(env,
    `SELECT blob1 AS kind, blob2 AS path, SUM(_sample_interval * double1) AS n ` +
    `FROM ${SPECULATION_DATASET} WHERE timestamp > NOW() - INTERVAL '${SPECULATION_WINDOW_DAYS}' DAY ` +
    `GROUP BY kind, path FORMAT JSON`);
  const headers = { "content-type": "application/json; charset=utf-8", "cache-control": "public, max-age=300, s-maxage=300" };
  if (!read.ok) {
    return new Response(JSON.stringify({ ok: false, reason: read.reason, window_days: SPECULATION_WINDOW_DAYS }) + "\n",
      { status: read.reason === "unconfigured" ? 200 : 502, headers: { ...headers, "cache-control": "no-store" } });
  }
  const rows = summarizeSpeculation(read.data);
  return new Response(JSON.stringify({
    ok: true, window_days: SPECULATION_WINDOW_DAYS, dataset: SPECULATION_DATASET,
    note: "speculations are Sec-Purpose prefetch/prerender requests that reached the origin; activations are the on-prefetch-activation beacon; rate orders paths and is not a strict conversion rate",
    rows,
  }, null, 2) + "\n", { status: 200, headers });
}
