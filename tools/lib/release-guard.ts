// release-guard.mjs — may this process move production traffic?
//
// Extracted from deploy-promote.mjs so it can be tested. The script itself
// cannot be imported by a test: it runs the ramp at module scope, so importing
// it to check one condition would deploy.
//
// ── what this used to say, and why it changed ──────────────────────────────
// The guard was a flat `if (process.env.CI) die(...)`, on the rule that GitHub
// must never hold a Cloudflare token that can write. That rule was retired on
// 2026-08-06: the owner is fine with a write token in Actions, scoped narrowly
// and held as an ENVIRONMENT secret behind required reviewers, because the risk
// a public repo actually carries is a workflow that runs untrusted input, not
// the existence of the secret.
//
// A blanket CI ban is now the wrong shape. It refuses the case it was built to
// protect (a ramp with a real token, gated by a human) while doing nothing about
// the case that actually breaks: a ramp starting with no way to authenticate,
// which surfaces as a wrangler auth error somewhere mid-sequence — possibly
// AFTER traffic has already moved to 10%.
//
// So the question is no longer "is this CI" but "can this process authenticate".
export function releaseCredentialError(env = process.env) {
  // Interactively, wrangler's stored OAuth login is the credential and no
  // environment variable is expected. Requiring a token here would break every
  // workstation ramp this repo has ever done.
  if (!env.CI) return null;

  if (!env.CLOUDFLARE_API_TOKEN) {
    return "deploy:promote needs CLOUDFLARE_API_TOKEN in CI: there is no interactive wrangler login "
      + "to fall back on, so without it the ramp fails partway with an auth error instead of here. "
      + "Scope it to Workers Scripts:Edit + D1:Edit and hold it as an ENVIRONMENT secret, never a repo secret.";
  }
  // Measured repeatedly on 2026-08-06: this account has two logins, so every
  // non-interactive wrangler call dies with "More than one account available
  // but unable to select one in non-interactive mode" — a failure that reads
  // like a broken credential and is a missing one line of config.
  if (!env.CLOUDFLARE_ACCOUNT_ID) {
    return "deploy:promote needs CLOUDFLARE_ACCOUNT_ID in CI. This login can see more than one account, "
      + "and wrangler cannot pick one non-interactively — it fails with \"More than one account available\", "
      + "which reads like a bad token and is not.";
  }
  return null;
}
