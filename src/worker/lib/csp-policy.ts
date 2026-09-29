// lib/csp-policy.ts — the Content-Security-Policy strings, and nothing else.
//
// A LEAF module on purpose. lib/security.ts applies these to every response, and
// lib/chrome.ts (lunaPage) now composes a hashed policy for the page it renders
// (lib/inline-csp.ts). chrome.ts cannot import security.ts: security.ts imports
// speculation.ts, which imports ledger.ts, which imports chrome.ts. So the
// strings live here, imported by both, with no imports of their own.
//
// The long notes below moved here from security.ts with the constants they
// describe, unchanged.
const CSP_SCRIPT_SRC_LOOSE = "'self' 'unsafe-inline'";

// The hashed policy is ENFORCED, and there is no report-only twin.
//
// It shipped behind an ENFORCE_PAGE_HASHES rollout flag, pinned TRUE from
// 2026-08-16 and deleted 2026-08-23, so for a week the false arm was dead code
// that still cost a second header name, a second tail constant, and a `tail`
// parameter threaded through both policy builders to feed it. The rollout story
// is worth keeping and is not worth keeping HERE: what the DevTools sweep found
// on /garage/horizon, and why the enforcing half had never actually been applied
// to a single document, are gotcha 17 in CLAUDE.md. Rolling back is `git revert`
// rather than a flag, which is the honest cost given nothing flipped it in
// either direction after the day it went true.

// Everything after script-src, held once so the loose and hashed policies cannot
// drift apart. img-src is 'self' data: per #186 — do NOT let a rebase quietly
// restore the two spotifycdn hosts that landed here before it.
//
// `upgrade-insecure-requests` sits at the END, and that position used to matter:
// it is a NAVIGATION directive, so a browser ignores it in a report-only policy
// and Chrome logged a security issue on every page load until #249 built the
// twin without it (DevTools → Security violations, 2026-08-07). #249 COMPOSED
// the short tail rather than subtracting the directive with an end-anchored
// replace, because appending one more directive would have made that replace
// match nothing and silently hand the twin its directive back. With the twin
// gone there is nothing to subtract and one constant says it all. Keep the
// general rule: a directive the spec ignores in report-only (`sandbox` is the
// other) belongs in the enforcing policy alone, never behind a suppression.
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
