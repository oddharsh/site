// release-guard.mjs — may this process move production traffic?
export function releaseCredentialError(env = process.env) {
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
