// ── WebMCP origin trial: every page that loads webmcp.js carries a live token ──
// Chrome turns document.modelContext on for a visitor only when the document
// carries a valid trial token, and it ignores an expired one without a console
// line, so a lapsed token looks exactly like a site with no tools. This test is
// the watch: it reads the expiry out of the token itself (a date typed beside it
// would survive a trial extension that left the served token stale) and fails
// from 30 days before it, on every PR. It reads the clock on purpose, like
// contract-security-txt-expires-60-days-out.
import { ROOT, assert, readFile, readdir, test } from "../../../../tools/tests/contract-shared.ts";
import { WEBMCP_ORIGIN_TRIAL, withSecurityHeaders } from "../security.ts";

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

test(`the WebMCP token names this origin and expires at least ${LEAD_DAYS} days out`, () => {
  const payload = payloadOf(WEBMCP_ORIGIN_TRIAL);
  assert.equal(payload.origin, "https://aadhar.sh:443");
  assert.equal(payload.feature, "WebMCP");
  assert.equal(payload.isSubdomain, undefined, "registered for aadhar.sh alone");
  assert.equal(payload.isThirdParty, undefined, "a first-party token, served by this origin");
  const days = (payload.expiry * 1000 - Date.now()) / DAY_MS;
  assert.ok(
    days >= LEAD_DAYS,
    `WEBMCP_ORIGIN_TRIAL expires ${new Date(payload.expiry * 1000).toISOString()}, ${Math.floor(days)} day(s) from now. Renew it at developer.chrome.com/origintrials (or drop it if the trial ended) and replace the constant in src/worker/lib/security.ts`,
  );
});

// nav.js imports webmcp.js on idle, so a page loads WebMCP exactly when it loads
// nav.js. Derived from the pages themselves, so a new page is covered on arrival.
async function pagesLoadingWebmcp(): Promise<string[]> {
  const root = new URL("src/pages/", ROOT);
  const files = (await readdir(root, { recursive: true })).filter((f) => f.endsWith(".html"));
  const paths: string[] = [];
  for (const file of files) {
    const html = await readFile(new URL(file, root), "utf8");
    if (!/\/nav(?:\.[0-9a-f]{8})?\.js/.test(html)) continue;
    paths.push("/" + file.replace(/(?:^|\/)index\.html$/, "").replace(/\.html$/, ""));
  }
  return paths.sort();
}

test("every page that loads webmcp.js is served the token, and a JSON response is not", async () => {
  const paths = await pagesLoadingWebmcp();
  assert.ok(paths.includes("/") && paths.includes("/garage/horizon"), `found ${paths.length} pages, including / and /garage/horizon`);
  for (const path of paths) {
    const response = withSecurityHeaders(new Response("<p>hi</p>", { headers: { "content-type": "text/html; charset=utf-8" } }), path);
    assert.equal(response.headers.get("origin-trial"), WEBMCP_ORIGIN_TRIAL, path);
  }
  const json = withSecurityHeaders(new Response("{}", { headers: { "content-type": "application/json" } }), "/rn/tracks");
  assert.equal(json.headers.get("origin-trial"), null, "a non-HTML response never carries it");
});
