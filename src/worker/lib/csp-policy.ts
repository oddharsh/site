// lib/csp-policy.ts — the Content-Security-Policy strings, and nothing else.
//
// A LEAF module on purpose. lib/security.ts applies these to every response, and
// lib/chrome.ts (lunaPage) now composes a hashed policy for the page it renders
// (lib/inline-csp.ts). chrome.ts cannot import security.ts: security.ts imports
// speculation.ts, which imports ledger.ts, which imports chrome.ts. So the
// strings live here, imported by both, with no imports of their own.

const CSP_SCRIPT_SRC_LOOSE = "'self' 'unsafe-inline'";

// The hashed policy is ENFORCED, and there is no report-only twin. The
// ENFORCE_PAGE_HASHES rollout flag was pinned TRUE from 2026-08-16 and deleted
// 2026-08-23, so rolling back is `git revert` rather than a flag. Gotcha 17
// holds the rule and its checks.

// Everything after script-src, held once so the loose and hashed policies cannot
// drift apart. img-src is 'self' data: per #186 — do NOT let a rebase quietly
// restore the two spotifycdn hosts that landed here before it.
//
// `upgrade-insecure-requests` is a NAVIGATION directive, so a browser ignores it
// in a report-only policy (Chrome logged a security issue on every page load for
// it, 2026-08-07, #249). Keep the general rule if a report-only policy ever
// returns: a directive the spec ignores in report-only (`sandbox` is the other)
// belongs in the enforcing policy alone, never behind a suppression.
const CSP_TAIL =
  "style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'; worker-src 'self'; manifest-src 'self'; upgrade-insecure-requests";

const cspWith = (scriptSrc: string) =>
  `default-src 'self'; script-src ${scriptSrc}; ${CSP_TAIL}`;

export const CSP_LOOSE = cspWith(CSP_SCRIPT_SRC_LOOSE);

// 'self' stays alongside the hashes: it covers the EXTERNAL scripts (/a/nav.js,
// /tooltip.js, /hoist.js) and the dynamic import()s the homepage
// makes. Deliberately no 'strict-dynamic', which would make 'self' inert for
// scripts and break exactly those loads.
// An EMPTY hash list is meaningful and is the best case: a document with no inline
// script at all gets a bare `script-src 'self'`, which is the strictest this policy
// can be. Do not confuse it with "no entry", which means the build could not speak
// for this document and falls back to the loose policy.
export const cspHashed = (hashes: readonly string[]) =>
  cspWith(["'self'", ...hashes.map((h) => `'sha256-${h}'`)].join(" "));
