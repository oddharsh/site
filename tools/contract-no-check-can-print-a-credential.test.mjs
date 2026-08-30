// ── the infra check cannot print a credential ────────────────────────────────
// Split-file suite; shared imports live in contract-shared.ts.
import { ROOT, assert, readFile, test } from "./contract-shared.ts";
import { CREDENTIAL_NAME, credentialValues, redactCredentials } from "./lib/redact.ts";

// WHAT THIS PINS, and why it is a barrier rather than a dismissal. CodeQL
// alerts 100 and 101 (js/clear-text-logging, 2026-08-29) land on the two print
// loops at the bottom of check-infra.ts. Both trace to
// process.env.CLOUDFLARE_ACCOUNT_ID, which is not a secret: it is committed in
// wrangler.jsonc, and print-account-id.ts sets the CI variable by reading that
// literal. So the alerts are false positives on the value.
//
// They are not false positives on the SHAPE. An alert is anchored at its sink,
// so dismissing one leaves the dismissal sitting on the line that a real token
// would print from, and the funnel underneath it is ~90 call sites wide in a
// script holding CLOUDFLARE_API_TOKEN and GITHUB_TOKEN against a public repo's
// Actions logs. These assertions are what make the dismissal safe.

const TOKEN = "abcd1234abcd1234abcd1234abcd1234abcd1234"; // 40, a Cloudflare token's length
const ACCOUNT = "1c99acdb6141579023fb97d24261ea58"; // the committed, public id

test("a credential-shaped env value never survives into a message", () => {
  const env = { CLOUDFLARE_API_TOKEN: TOKEN, CLOUDFLARE_ACCOUNT_ID: ACCOUNT };
  const out = redactCredentials(`GET /accounts/${ACCOUNT}/tokens failed with ${TOKEN}`, env);

  assert.equal(out.includes(TOKEN), false, "the token must not survive");
  assert.equal(out.includes("[redacted]"), true, "and must be replaced rather than dropped silently");

  // The account id is the whole reason this is a barrier and not a blanket ban
  // on interpolation: it is public, it names which account the tier checked,
  // and a diagnostic that hides it is worse than one that prints it.
  assert.equal(out.includes(ACCOUNT), true, "a public account id must still print");
});

test("the name pattern reads the names this repo actually issues", () => {
  for (const name of ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_API_TOKEN_WRITE", "CLOUDFLARE_API_TOKEN_RAMP",
    "GITHUB_TOKEN", "SIGNING_SECRET", "RESEND_API_KEY", "BROWSER_RUN_TOKEN", "ANALYTICS_READ_TOKEN"]) {
    assert.equal(CREDENTIAL_NAME.test(name), true, `${name} must be treated as a credential`);
  }
  // Read this pair as the point of the whole module. Neither is a secret and
  // both are load-bearing diagnostics, so a pattern that swept them up would
  // make every account-tier message unreadable.
  for (const name of ["CLOUDFLARE_ACCOUNT_ID", "CI"]) {
    assert.equal(CREDENTIAL_NAME.test(name), false, `${name} must stay printable`);
  }
});

test("a short or empty value is ignored rather than corrupting the message", () => {
  // replaceAll("") inserts between every character, so an unset-but-present
  // secret would turn a one-line advisory into per-character noise. That is the
  // failure this floor exists for; a coincidental short match is the other.
  const message = "edge tier could not run";
  assert.equal(redactCredentials(message, { CLOUDFLARE_API_TOKEN: "" }), message);
  assert.equal(redactCredentials(message, { SOME_TOKEN: "run" }), message, "a 3-char value must not scrub a word");
  assert.deepEqual(credentialValues({ A_TOKEN: "", B_SECRET: "short" }), [], "neither clears the floor");
});

test("overlapping values are replaced whole, longest first", () => {
  // A refresh token that CONTAINS the access token is the real shape here: a
  // shortest-first pass would leave `[redacted]` embedded in the longer value,
  // publishing both halves of it.
  const inner = "abcd1234abcd";
  const outer = `xx${inner}yyzzzzzzzz`;
  const out = redactCredentials(`saw ${outer}`, { A_TOKEN: inner, B_TOKEN: outer });
  assert.equal(out, "saw [redacted]", "the longer value must be consumed before the shorter one");
});

test("check-infra routes every message through the barrier", async () => {
  const src = await readFile(new URL("tools/check-infra.ts", ROOT), "utf8");

  // The funnel is the only thing that prints a string in that file, so this
  // pair of assertions is the whole coverage argument. Guarding it at PUSH time
  // rather than at print time is deliberate: the arrays then never hold a
  // credential, so a second reader added later inherits the guarantee.
  for (const [name, store] of [["fail", "hard"], ["warn", "advisory"], ["pass", "ok"]]) {
    // assert.equal on the boolean rather than assert.match, because a failed
    // match prints the whole 60KB file and buries its own message.
    const wired = new RegExp(`const ${name} = \\(m: string\\) => ${store}\\.push\\(redactCredentials\\(m\\)\\)`).test(src);
    assert.equal(wired, true, `${name}() must redact before it stores`);
  }

  // A new console call that interpolates something other than the three stores
  // or a count would route around all of it. This is the tripwire for that, and
  // it fails loudly rather than silently widening: the count is the floor.
  const consoles = src.match(/console\.(log|error|warn)\(/g) || [];
  assert.equal(consoles.length, 6,
    "check-infra.ts grew or lost a console call. Confirm the new one prints only funnel output or a count, then move this floor");
});
