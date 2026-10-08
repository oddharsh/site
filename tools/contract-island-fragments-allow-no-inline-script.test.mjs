// ── island fragments allow no inline script ─────────────────────────────────
// A per-request fragment (/ledger/lines.html, /inbox/mail.html and the rest)
// went out with the loose `script-src 'self' 'unsafe-inline'`, because build
// step 7c only hashes staged documents. The loader injects a fragment with
// innerHTML, where a <script> never runs, so a fragment needs no inline script,
// and lib/island.ts now stamps every one with `script-src 'self'` and no hashes.
// What this pins:
//   - islandResponse sends that policy, and a caller's other headers don't drop it;
//   - withSecurityHeaders keeps it instead of stamping the loose default;
//   - cal's slot list sends the same constant;
//   - real fragments, rendered by their own renderers, hold nothing the policy
//     would block: no inline script, no handler, no javascript: URL. That
//     includes the inbox rendered from a hostile webmention, the one fragment
//     whose text comes from other sites.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { CSP_LOOSE, cspHashed } from "../src/worker/lib/csp-policy.ts";
import { inlineScriptHashes } from "../src/worker/lib/inline-csp.ts";
import { ISLAND_CSP, islandResponse } from "../src/worker/lib/island.ts";
import { html } from "../src/worker/lib/html.ts";
import { withSecurityHeaders } from "../src/worker/lib/security.ts";

const scriptSrc = (policy) => policy.split("; ").find((d) => d.startsWith("script-src "));

test("a fragment's policy allows no inline script", () => {
  assert.equal(ISLAND_CSP, cspHashed([]));
  assert.equal(scriptSrc(ISLAND_CSP), "script-src 'self'");
  const res = islandResponse(html`<p>x</p>`, { "cache-control": "public, max-age=60" });
  assert.equal(res.headers.get("content-security-policy"), ISLAND_CSP);
  assert.equal(res.headers.get("cache-control"), "public, max-age=60", "a caller's header still lands");
});

test("withSecurityHeaders keeps the fragment's policy", () => {
  const out = withSecurityHeaders(islandResponse(html`<p>x</p>`), "/ledger/lines.html");
  assert.equal(out.headers.get("content-security-policy"), ISLAND_CSP);
  assert.notEqual(out.headers.get("content-security-policy"), CSP_LOOSE);
  // the control: an HTML response with no policy of its own still gets the loose stamp
  const bare = withSecurityHeaders(new Response("<p>x</p>", { headers: { "content-type": "text/html" } }), "/not-built");
  assert.equal(bare.headers.get("content-security-policy"), CSP_LOOSE);
});

test("cal's slot list sends the same policy", () => {
  const src = readFileSync(new URL("../cal/src/index.ts", import.meta.url), "utf8");
  assert.match(src, /import \{ ISLAND_CSP, ISLAND_MARKER \}\s+from "\.\.\/\.\.\/src\/worker\/lib\/island\.ts";/);
  const route = src.slice(src.indexOf("async function route_slots_html"));
  assert.match(route.slice(0, route.indexOf("\n}\n")), /"content-security-policy": ISLAND_CSP,/);
});

test("real fragments hold nothing the policy would block", async () => {
  const { renderAroundSnapshot } = await import("../src/worker/around.ts");
  const { renderDynoPulls } = await import("../src/worker/dyno.ts");
  const { renderInboxMail } = await import("../src/worker/inbox.ts");
  const { renderLedgerLines } = await import("../src/worker/ledger.ts");
  const { renderReadingList } = await import("../src/worker/reading.ts");
  const { renderTrackListHtml } = await import("../src/worker/rn.ts");
  const { renderWhoareyouValues } = await import("../src/worker/whoareyou.ts");
  const hostile = {
    source: "https://evil.example/<script>alert(1)</script>",
    target: "https://aadhar.sh/writing/in-flux",
    author: "<img src=x onerror=alert(1)>",
    content: "<script>alert(2)</script> <a href=\"javascript:alert(3)\">x</a>",
    published: "2026-10-08T00:00:00Z",
    approved: true,
  };
  const pending = /** @type {{ readonly pending: true }} */ ({ pending: true });
  // The census table is left out: its renderer needs a grouped report, and its
  // empty state is an identity check on a module-private placeholder.
  const fragments = {
    "/around/snapshot.html": renderAroundSnapshot(null),
    "/garage/dyno/pulls.html": renderDynoPulls([]),
    "/inbox/mail.html (empty)": renderInboxMail([], "ok", "https://aadhar.sh"),
    "/inbox/mail.html (hostile mention)": renderInboxMail([hostile], "ok", "https://aadhar.sh"),
    "/ledger/lines.html": renderLedgerLines(pending, pending),
    "/reading/list.html": renderReadingList({ items: [] }, {}),
    "/rn/tracks.html": renderTrackListHtml({ tracks: [] }),
    "/whoareyou/values.html": renderWhoareyouValues({}, "<script>ua()</script>", null),
  };
  for (const [name, fragment] of Object.entries(fragments)) {
    const body = typeof fragment === "string" ? fragment : fragment.html;
    assert.ok(body.length > 0, `${name} rendered something`);
    // [] means no inline script; null would mean a handler or javascript: URL
    assert.deepEqual(inlineScriptHashes(body), [], `${name} carries script the policy would block`);
  }
});
