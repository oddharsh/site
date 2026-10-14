// ── the infra check cannot print a credential ────────────────────────────────
// Split-file suite; shared imports live in contract-shared.ts.
import { ROOT, assert, readFile, test } from "./contract-shared.ts";
import { CREDENTIAL_NAME, credentialValues, redactCredentials } from "./lib/redact.ts";
import { createReport } from "./lib/infra-report.ts";

const TOKEN = "abcd1234abcd1234abcd1234abcd1234abcd1234";
const ACCOUNT = "1c99acdb6141579023fb97d24261ea58";

test("a credential-shaped env value never survives into a message", () => {
  const env = { CLOUDFLARE_API_TOKEN: TOKEN, CLOUDFLARE_ACCOUNT_ID: ACCOUNT };
  const out = redactCredentials(`GET /accounts/${ACCOUNT}/tokens failed with ${TOKEN}`, env);

  assert.equal(out.includes(TOKEN), false, "the token must not survive");
  assert.equal(out.includes("[redacted]"), true, "and must be replaced rather than dropped silently");

  assert.equal(out.includes(ACCOUNT), true, "a public account id must still print");
});

test("the name pattern reads the names this repo actually issues", () => {
  for (const name of ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_API_TOKEN_WRITE", "CLOUDFLARE_API_TOKEN_RAMP",
    "GITHUB_TOKEN", "SIGNING_SECRET", "RESEND_API_KEY", "BROWSER_RUN_TOKEN", "ANALYTICS_READ_TOKEN"]) {
    assert.equal(CREDENTIAL_NAME.test(name), true, `${name} must be treated as a credential`);
  }
  for (const name of ["CLOUDFLARE_ACCOUNT_ID", "CI"]) {
    assert.equal(CREDENTIAL_NAME.test(name), false, `${name} must stay printable`);
  }
});

test("a short or empty value is ignored rather than corrupting the message", () => {
  const message = "edge tier could not run";
  assert.equal(redactCredentials(message, { CLOUDFLARE_API_TOKEN: "" }), message);
  assert.equal(redactCredentials(message, { SOME_TOKEN: "run" }), message, "a 3-char value must not scrub a word");
  assert.deepEqual(credentialValues({ A_TOKEN: "", B_SECRET: "short" }), [], "neither clears the floor");
});

test("overlapping values are replaced whole, longest first", () => {
  const inner = "abcd1234abcd";
  const outer = `xx${inner}yyzzzzzzzz`;
  const out = redactCredentials(`saw ${outer}`, { A_TOKEN: inner, B_TOKEN: outer });
  assert.equal(out, "saw [redacted]", "the longer value must be consumed before the shorter one");
});

test("check-infra routes every message through the barrier", async () => {
  const report = createReport({ CLOUDFLARE_API_TOKEN: TOKEN });
  report.fail(`drift ${TOKEN}`);
  report.warn(`note ${TOKEN}`);
  report.pass(`ok ${TOKEN}`);
  for (const [name, store] of [["fail", report.hard], ["warn", report.advisory], ["pass", report.ok]]) {
    assert.equal(store.length, 1, `${name}() must store its message`);
    assert.equal(store[0].includes(TOKEN), false, `${name}() must redact before it stores`);
  }

  const src = await readFile(new URL("tools/check-infra.ts", ROOT), "utf8");

  assert.equal(/const \{ hard, fail, warn, pass \} = report;/.test(src), true,
    "check-infra.ts must take fail/warn/pass from the redacting report");
  assert.equal(/\b(hard|advisory|ok)\.push\(/.test(src), false,
    "check-infra.ts must not push to a store directly; that skips the barrier");

  const consoles = src.match(/console\.(log|error|warn)\(/g) || [];
  assert.equal(consoles.length, 2,
    "check-infra.ts grew or lost a console call. Confirm the new one prints only what report.render() returned, then move this floor");
  assert.equal(/for \(const line of rendered\.stdout\) console\.log\(line\);\nfor \(const line of rendered\.stderr\) console\.error\(line\);/.test(src), true,
    "the two console calls must print the report's rendered lines and nothing else");

  for (const lib of ["tools/lib/infra-compare.ts", "tools/lib/infra-ports.ts"]) {
    const text = await readFile(new URL(lib, ROOT), "utf8");
    assert.equal(/console\.|process\.std(out|err)/.test(text), false, `${lib} must not print`);
  }
});
