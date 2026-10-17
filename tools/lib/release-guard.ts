// release-guard.ts: may this process move production traffic?
//
// Extracted from deploy-promote.ts so it can be tested. The script itself
// cannot be imported by a test: it runs the ramp at module scope, so importing
// it to check one condition would deploy.
//
// The guard asks whether this process can authenticate. Until 2026-08-06 it
// was a flat `if (process.env.CI) die(...)`, and a blanket CI ban is the wrong
// shape: it refuses a ramp with a real token, gated by a human, while doing
// nothing about the case that actually breaks. A ramp that starts with no way
// to authenticate surfaces as an auth error somewhere mid-sequence, possibly
// AFTER traffic has already moved to 10%.
export function releaseCredentialError(env = process.env) {
  // Interactively, the stored `cf auth login` is the credential (wrangler's
  // login until 2026-10-06, when the ramp moved to tools/lib/cf.ts) and no
  // environment variable is expected. Requiring a token here would break every
  // workstation ramp this repo has ever done.
  if (!env.CI) return null;

  if (!env.CLOUDFLARE_API_TOKEN) {
    return "deploy:promote needs CLOUDFLARE_API_TOKEN in CI: there is no interactive cf login "
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
