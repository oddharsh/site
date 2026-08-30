// redact.ts — no message this repo's tools print may carry a credential.
//
// WHY IT EXISTS. CodeQL opened two `js/clear-text-logging` alerts on
// check-infra.ts (100 and 101, 2026-08-29), both at the print loops that drain
// the fail/warn/pass funnel, and both tracing back to
// `process.env.CLOUDFLARE_ACCOUNT_ID`. On the VALUE the rule is wrong: that id
// is committed at wrangler.jsonc's `account_id`, repeated in config/infra.json,
// and print-account-id.ts is what sets the variable in CI by reading that same
// committed literal. Its own header says the id is not a secret.
//
// On the SHAPE the rule is right, which is the reason for this module. Those
// three arrays are a funnel roughly 90 call sites feed, in a script that holds
// CLOUDFLARE_API_TOKEN and GITHUB_TOKEN, printing into Actions logs on a PUBLIC
// repository. A CodeQL alert is anchored at its sink, so dismissing one because
// today's source is harmless would leave a dismissal sitting on the line a real
// token would print from. The barrier is what makes that dismissal safe.
//
// DERIVED, NEVER HAND-KEPT. The names are matched by pattern rather than listed,
// on the same reasoning as the tools.json guard scanner: a list of secrets to
// remember is a list somebody forgets, and the failure is silent by
// construction. A credential added tomorrow is covered on the day it is set.
import { asText } from "../../src/worker/lib/parse.ts";

export const CREDENTIAL_NAME = /TOKEN|SECRET|PASSWORD|CREDENTIAL|API_KEY|_KEY$/;

// The shortest value worth substring-matching. Two things need it. An empty
// string would make `replaceAll` insert between every character, and a short one
// invites a coincidental match that would scrub a real word out of a diagnostic.
// Every credential this repo issues is far longer: a Cloudflare API token is 40
// characters, a GitHub token 40 or more, and SIGNING_SECRET is 64 hex.
const FLOOR = 12;

// Longest first, so a value that contains a shorter one is replaced whole
// rather than left with a `[redacted]` embedded in its middle.
export function credentialValues(env = process.env) {
  const seen = new Set<string>();
  for (const [name, raw] of Object.entries(env)) {
    if (!CREDENTIAL_NAME.test(name)) continue;
    // asText is the repo's I/O-boundary parser: an unset or empty variable is
    // not a value, which is exactly the case the floor below cannot express.
    const value = asText(raw);
    if (value !== null && value.length >= FLOOR) seen.add(value);
  }
  return [...seen].sort((a, b) => b.length - a.length);
}

// Call this on the way IN to a message store, not on the way out to the
// terminal. Then the array itself never holds a credential, so a second reader
// added later (a JSON summary, a step summary, an artifact) inherits the
// guarantee instead of needing to remember it.
export function redactCredentials(message: string, env = process.env) {
  let out = message;
  for (const value of credentialValues(env)) out = out.replaceAll(value, "[redacted]");
  return out;
}
