import { outputTail } from "../lib/output-tail.ts";
import { assert, test } from "./contract-shared.ts";

// wrangler 4.167.0's `deploy --dry-run` against @cloudflare/config 0.32.1,
// captured 2026-11-24 (the ERROR line's colour codes kept, the long Expected
// list cut). The banner on stdout is what every red canary reported until
// output-tail.ts (gotcha 119).
const WRANGLER_RED = {
  stderr: [
    "\x1b[31m✘ \x1b[41;31m[\x1b[41;97mERROR\x1b[41;31m]\x1b[0m \x1b[1mInvalid `cloudflare.config.ts`:\x1b[0m",
    "",
    "  ✖ Invalid discriminator value. Expected 'kv' | 'analytics-sql'",
    "    → at worker.env.ANALYTICS.type",
    "",
    "",
    '🪵  Logs were written to "/x.log"',
    "",
  ].join("\n"),
  stdout: ["", " ⛅️ wrangler 4.167.0 (main)", "──────────────────────────────────────────────────────", ""].join("\n"),
};

test("a failed gate reports wrangler's error, not its banner", () => {
  assert.equal(
    outputTail(WRANGLER_RED, 4),
    "✘ [ERROR] Invalid `cloudflare.config.ts`: ✖ Invalid discriminator value. Expected 'kv' | 'analytics-sql' → at worker.env.ANALYTICS.type 🪵  Logs were written to \"/x.log\"",
  );
  assert.doesNotMatch(outputTail(WRANGLER_RED, 4), /⛅️/);
});

test("a command that writes nothing to stderr reports its stdout", () => {
  const tsc = { stderr: "", stdout: "src/a.ts(1,7): error TS2322: Type 'string' is not assignable to type 'number'.\n\nFound 1 error in src/a.ts:1\n" };
  assert.equal(outputTail(tsc, 4), "src/a.ts(1,7): error TS2322: Type 'string' is not assignable to type 'number'. Found 1 error in src/a.ts:1");
  assert.equal(outputTail({ stderr: null, stdout: "only line\n" }, 4), "only line");
});

test("the line budget counts visible lines and keeps the last ones", () => {
  assert.equal(outputTail(WRANGLER_RED, 1), '🪵  Logs were written to "/x.log"');
  assert.equal(outputTail({ stderr: "a\n\n\nb\nc\n", stdout: "" }, 2), "b c");
  assert.equal(outputTail({ stderr: "a\n\n\nb\nc\n", stdout: "" }, 3), "a b c");
  assert.equal(outputTail({ stderr: "\n\x1b[0m\n", stdout: "\n" }, 4), "");
});
