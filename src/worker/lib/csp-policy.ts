// lib/csp-policy.ts — the Content-Security-Policy strings, and nothing else.

const CSP_SCRIPT_SRC_LOOSE = "'self' 'unsafe-inline'";

// It shipped behind an ENFORCE_PAGE_HASHES rollout flag, pinned TRUE from
// 2026-08-16 and deleted 2026-08-23, so for a week the false arm was dead code
// that still cost a second header name, a second tail constant, and a `tail`
// parameter threaded through both policy builders to feed it. The rollout story
// is worth keeping and is not worth keeping HERE: what the DevTools sweep found
// on /garage/horizon, and why the enforcing half had never actually been applied
// to a single document, are gotcha 17 in CLAUDE.md. Rolling back is `git revert`
// rather than a flag, which is the honest cost given nothing flipped it in
// either direction after the day it went true.
const CSP_TAIL =
  "style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'; worker-src 'self'; manifest-src 'self'; upgrade-insecure-requests";

const cspWith = (scriptSrc: string) =>
  `default-src 'self'; script-src ${scriptSrc}; ${CSP_TAIL}`;

export const CSP_LOOSE = cspWith(CSP_SCRIPT_SRC_LOOSE);

// 'self' stays alongside the hashes: it covers the EXTERNAL scripts (/a/nav.js,
// /tooltip.js, /hoist.js) and the dynamic import()s the homepage
// makes. Deliberately no 'strict-dynamic', which would make 'self' inert for
// scripts and break exactly those loads.
export const cspHashed = (hashes: readonly string[]) =>
  cspWith(["'self'", ...hashes.map((h) => `'sha256-${h}'`)].join(" "));
