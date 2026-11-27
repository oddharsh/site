// ── Origin trials: every token is live, and they merge instead of colliding ──
// Chrome turns document.modelContext on for a visitor only when the document
// carries a valid trial token, and it ignores an expired one without a console
// line, so a lapsed token looks exactly like a site with no tools. This test is
// the watch: it reads each expiry out of the token itself (a date typed beside it
// would survive a trial extension that left the served token stale) and fails
// from 30 days before it, on every PR. It reads the clock on purpose, like
// contract-security-txt-expires-60-days-out. That every nav.js page is SERVED the
// tokens is routes:check's job (verify-routes.ts, ORIGIN_TRIAL_ROWS), because only
// the real router can show a route that skips withSecurityHeaders.
import { ROOT, assert, test } from "../../../../tools/tests/contract-shared.ts";
import { pagesLoadingWebmcp } from "../../../../tools/lib/webmcp-pages.ts";
import { ORIGIN_TRIALS, WEBMCP_ORIGIN_TRIAL, withSecurityHeaders } from "../security.ts";

const DAY_MS = 86_400_000;
const LEAD_DAYS = 30;

// A Chrome origin trial token: 1 version byte (2, or 3 for third-party use), a
// 64-byte Ed25519 signature, a 4-byte big-endian payload length, then JSON.
function payloadOf(token: string): { origin: string; feature: string; expiry: number; isSubdomain?: boolean; isThirdParty?: boolean } {
  const bytes = Buffer.from(token, "base64");
  assert.ok(bytes[0] === 2 || bytes[0] === 3, `token format version ${bytes[0]}`);
  const length = bytes.readUInt32BE(65);
  assert.equal(bytes.length, 69 + length, "payload length matches the token");
  return JSON.parse(bytes.subarray(69).toString("utf8"));
}

test(`every origin trial token names this origin and expires at least ${LEAD_DAYS} days out`, () => {
  assert.ok(ORIGIN_TRIALS.includes(WEBMCP_ORIGIN_TRIAL), "the WebMCP token is served");
  for (const token of ORIGIN_TRIALS) {
    const payload = payloadOf(token);
    assert.equal(payload.origin, "https://aadhar.sh:443", payload.feature);
    const days = (payload.expiry * 1000 - Date.now()) / DAY_MS;
    assert.ok(
      days >= LEAD_DAYS,
      `the ${payload.feature} origin trial token expires ${new Date(payload.expiry * 1000).toISOString()}, ${Math.floor(days)} day(s) from now. Renew it at developer.chrome.com/origintrials (or drop it if the trial ended) and replace it in ORIGIN_TRIALS in src/worker/lib/security.ts`,
    );
  }
  const webmcp = payloadOf(WEBMCP_ORIGIN_TRIAL);
  assert.equal(webmcp.feature, "WebMCP");
  assert.equal(webmcp.isSubdomain, undefined, "registered for aadhar.sh alone");
  assert.equal(webmcp.isThirdParty, undefined, "a first-party token, served by this origin");
});

const html = (headers: Record<string, string> = {}) => new Response("<p>hi</p>", { headers: { "content-type": "text/html; charset=utf-8", ...headers } });

test("HTML carries every token, merged into a token a route already set, and JSON carries none", () => {
  assert.equal(withSecurityHeaders(html(), "/").headers.get("origin-trial"), ORIGIN_TRIALS.join(", "));
  const other = "AnotherTrialToken==";
  assert.equal(withSecurityHeaders(html({ "origin-trial": other }), "/").headers.get("origin-trial"), [other, ...ORIGIN_TRIALS].join(", "));
  // Already present: no second copy.
  assert.equal(
    withSecurityHeaders(html({ "origin-trial": `${WEBMCP_ORIGIN_TRIAL}, ${other}` }), "/").headers.get("origin-trial"),
    `${WEBMCP_ORIGIN_TRIAL}, ${other}`,
  );
  const json = withSecurityHeaders(new Response("{}", { headers: { "content-type": "application/json" } }), "/rn/tracks");
  assert.equal(json.headers.get("origin-trial"), null, "a non-HTML response never carries it");
});

test("the WebMCP page list routes:check sweeps finds the shell pages", () => {
  const paths = pagesLoadingWebmcp(ROOT);
  assert.ok(paths.length >= 40, `found ${paths.length} pages`);
  assert.ok(paths.includes("/"), "/");
  assert.ok(paths.includes("/garage/horizon"), "/garage/horizon");
});
