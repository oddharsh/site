// ── /security is a built document, and its three live values still arrive ────
// The page rendered per request until 2026-09-16 to differ in exactly three
// values (colo, HTTP version, TLS version). build.ts step 5b now renders it once,
// so it earns a q11 twin, a dcz delta and CSP hashes, and the values come from
// /security.json into placeholders. What this pins is the contract between the
// two halves: the render is deterministic (or the bake is a lie), every
// placeholder the script fills exists, the script names the endpoint, and the
// endpoint answers from request.cf alone.
import assert from "node:assert/strict";
import { test } from "node:test";
import { handleSecurityJson, renderSecurityCenter } from "../src/worker/security.ts";

const PLACEHOLDERS = ["colo", "httpProtocol", "tlsVersion"];

test("renderSecurityCenter is deterministic and carries one placeholder per live value", async () => {
  const a = await renderSecurityCenter().text();
  const b = await renderSecurityCenter().text();
  assert.equal(a, b, "two renders differ, so the build would bake whichever it got");
  for (const key of PLACEHOLDERS) {
    const hits = a.split(`data-sc="${key}"`).length - 1;
    assert.ok(hits >= 1, `no placeholder for ${key}`);
  }
  assert.match(a, /fetch\("\/security\.json"/, "the inline script must read /security.json");
  // The no-JS reader is told where the values are rather than shown a blank.
  assert.match(a, /<noscript>[\s\S]*?whoareyou\.json[\s\S]*?<\/noscript>/);
  // Nothing per-request may have leaked into the document: a colo code or a
  // TLS version baked in would be a claim about a connection nobody made.
  assert.doesNotMatch(a, /TLSv1\.[23]|HTTP\/[123]\b/);
});

test("/security.json answers from request.cf and nothing else, uncacheable", async () => {
  const req = Object.assign(new Request("https://aadhar.sh/security.json"), {
    cf: { colo: "EWR", httpProtocol: "HTTP/3", tlsVersion: "TLSv1.3", asn: 1, city: "New York" },
  });
  const res = handleSecurityJson(req);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") || "", /^application\/json/);
  assert.equal(res.headers.get("cache-control"), "no-store, must-revalidate");
  assert.equal(res.headers.get("x-robots-tag"), "noindex");
  const body = await res.json();
  // Exactly the three keys the page has placeholders for: the endpoint is not
  // a second /whoareyou.json, and a key nothing renders is a key nobody reads.
  assert.deepEqual(Object.keys(body).sort(), [...PLACEHOLDERS].sort());
  assert.deepEqual(body, { colo: "EWR", httpProtocol: "HTTP/3", tlsVersion: "TLSv1.3" });

  // An absent cf (local dev, a test harness) degrades to the glyph the page
  // used for a missing value when it rendered live, never to undefined.
  const bare = await handleSecurityJson(new Request("https://aadhar.sh/security.json")).json();
  assert.deepEqual(bare, { colo: "—", httpProtocol: "—", tlsVersion: "—" });
});
