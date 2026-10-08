// ── a fragment runs no inline script ────────────────────────────────────────
// Every island fragment (/ledger/lines.html, /inbox/mail.html, /coffee/slots.html
// and the rest) answers `script-src 'self'`, with no hash and no
// 'unsafe-inline'. Until 2026-10-08 they all fell to the loose default, because
// none is a built document and none comes through lunaPage. lib/island.ts has
// the reasoning: the page injects a fragment with innerHTML, where a script
// never runs, so the header only governs a reader who opens the URL directly,
// and a fixed policy (rather than a hash of what was sent) allows no script
// that outside data might have carried in.
import { readFileSync } from "node:fs";
import {
  assert,
  ROOT,
  test,
} from "./contract-shared.ts";

const { FRAGMENT_CSP, ISLAND_MARKER, islandResponse } = await import("../src/worker/lib/island.ts");
const { withSecurityHeaders } = await import("../src/worker/lib/security.ts");
const { CSP_LOOSE } = await import("../src/worker/lib/csp-policy.ts");
const { unsafeHtml } = await import("../src/worker/lib/html.ts");

const scriptSrc = (policy) => policy?.match(/script-src ([^;]*)/)?.[1];

test("a fragment's policy is script-src 'self' and survives the security headers", () => {
  assert.equal(scriptSrc(FRAGMENT_CSP), "'self'");
  const out = withSecurityHeaders(islandResponse(unsafeHtml("<li>a row</li>")), "/ledger/lines.html");
  assert.equal(out.headers.get("content-security-policy"), FRAGMENT_CSP);
  assert.equal(out.headers.get(ISLAND_MARKER), "1");
  // the control: an HTML response with no policy of its own and no build hash
  // still gets the loose default, so the assertion above can tell them apart
  const plain = withSecurityHeaders(new Response("<p>x</p>", { headers: { "content-type": "text/html" } }), "/no-such-built-page.html");
  assert.equal(plain.headers.get("content-security-policy"), CSP_LOOSE);
  assert.match(scriptSrc(CSP_LOOSE), /'unsafe-inline'/);
});

test("every response built by hand with the island marker sets the fragment policy too", () => {
  // islandResponse covers the Worker's fragments. A module that assembles its
  // own fragment headers (cal's /coffee/slots.html caches its response, so it
  // builds the headers itself) has to name FRAGMENT_CSP beside the marker, or
  // its fragment quietly goes back to the loose default.
  const handBuilt = ["cal/src/index.ts"];
  for (const rel of handBuilt) {
    const src = readFileSync(new URL(rel, ROOT), "utf8");
    assert.match(src, /\[ISLAND_MARKER\]:/, `${rel} still builds a fragment by hand (drop it from this list if not)`);
    assert.match(src, /"content-security-policy":\s*FRAGMENT_CSP/, `${rel} builds a fragment without FRAGMENT_CSP`);
  }
});
