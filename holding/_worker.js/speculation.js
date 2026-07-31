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
//   NUMERATOR — the activation. A speculated document that is never used has no
//     visitor and runs no script, so no client-side beacon can report it; the
//     SERVER is the only party positioned to count. The `on-prefetch-activation`
//     response header names an endpoint the browser HEADs when a speculated
//     document is actually used for a navigation.
//
// STATUS, checked 2026-07-30, and the reason this ships half-dark on purpose:
// chromestatus lists the beacon as *Proposed* with NO stable milestone, behind
// an origin trial named `PrefetchAndPrerenderActivationBeacon` (desktop_first
// 151). So until this origin registers for that trial, or the feature reaches
// stable, NO browser will call the endpoint and the numerator stays at zero.
// The denominator starts recording the moment this deploys.
//
// That asymmetry is deliberate rather than an oversight. Shipping the receiver
// now means the only remaining step is a trial registration, which is a form
// the owner submits rather than code anyone has to write, and the endpoint is
// real on the day it turns on. What this must NOT do is imply a number it does
// not have: /ledger reports the two halves separately and says so.
//
// Everything here is best-effort. A metric must never break a page.

const SPECULATIVE = /prefetch|prerender/i;

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
      blobs: [kind, pathname.slice(0, 96)],
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
        blobs: ["activated", p.slice(0, 96)],
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
