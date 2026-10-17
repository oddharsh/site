// ── /whoareyou is a built document, and lib/island.ts is how its values arrive ─
// The page rendered per request until 2026-09-25. build.ts step 5b now renders it
// once, so it earns a q11 twin, a dcz delta and CSP hashes, and the per-request
// half is an island fetched from /whoareyou/values.html. What this pins:
//   - the island helper's contract (marker, preload shape, a constant script);
//   - the shell is deterministic and carries no per-request value;
//   - the placeholder and the live fragment come from ONE renderer, so the rows
//     a browser visitor normally has are already standing before the swap;
//   - the fragment is this request's and never cached;
//   - the referrer row is left to the browser, since the fragment's own Referer
//     is the page and reporting it would be a false claim about the visitor.
import assert from "node:assert/strict";
import { test } from "node:test";
import { ISLAND_MARKER, islandMount, islandPreload, islandResponse, islandScript } from "../src/worker/lib/island.ts";
import { html } from "../src/worker/lib/html.ts";
import { handleWhoareyouValues, renderWhoareyouPage, renderWhoareyouValues, VALUES_URL } from "../src/worker/whoareyou.ts";

test("the island loader is one constant script that checks the marker the response sends", () => {
  const a = islandScript().html;
  assert.equal(a, islandScript().html);
  // The script is a constant on purpose (one CSP hash site-wide, nothing
  // interpolated), so the marker is spelled twice. This is what holds them.
  assert.ok(a.includes(`r.headers.get("${ISLAND_MARKER}")!=="1"`), "the loader must require the response's marker");
  assert.equal(islandResponse(html`x`).headers.get(ISLAND_MARKER), "1");
  assert.match(a, /querySelectorAll\("\[data-island\]"\)/);
  assert.match(a, /data-state","failed"/, "a failed fetch must leave the placeholder and say so");
  // Without crossorigin the preload is no-cors and cannot satisfy the cors fetch.
  assert.equal(islandPreload("/x.html").html, '<link rel="preload" as="fetch" href="/x.html" crossorigin>');
  assert.match(islandMount("m", "/x.html", html`<i>p</i>`, html`n`).html,
    /^<div id="m" data-island="\/x\.html" data-state="pending"><i>p<\/i><noscript>n<\/noscript><\/div>$/);
});

test("islandResponse is never cached and never indexed", async () => {
  const res = islandResponse(html`<p>one request</p>`, { "x-extra": "1" });
  assert.equal(res.headers.get("cache-control"), "no-store, must-revalidate");
  assert.equal(res.headers.get("x-robots-tag"), "noindex");
  assert.match(res.headers.get("content-type") || "", /^text\/html/);
  assert.equal(res.headers.get("x-extra"), "1");
  assert.equal(await res.text(), "<p>one request</p>");
});

test("renderWhoareyouPage is deterministic, carries its island, and bakes nothing per-request", async () => {
  const a = await renderWhoareyouPage().text();
  const b = await renderWhoareyouPage().text();
  assert.equal(a, b, "two renders differ, so the build would bake whichever it got");
  assert.ok(a.includes(`data-island="${VALUES_URL}"`));
  assert.ok(a.includes(islandPreload(VALUES_URL).html), "the fragment must be preloaded from <head>");
  assert.ok(a.includes(islandScript().html));
  assert.match(a, /<noscript>[\s\S]*?whoareyou\.json[\s\S]*?<\/noscript>/, "a no-JS reader is told where the values are");
  assert.doesNotMatch(a, /TLSv1\.[23]|\d{4}-\d\d-\d\dT\d\d:/);
  // The claims two other contracts pin to this module's text still hold.
  assert.match(a, /none of it is stored/);
  assert.match(a, /\/webmcp\.js/);
});

test("the placeholder and the live values share one renderer and one row set for a browser visitor", () => {
  const data = {
    host: "aadhar.sh", scheme: "https", ray: "8c1-EWR", ip: "203.0.113.7", asn: 64500, asOrg: "Example Net",
    country: "US", continent: "NA", isEU: false, region: "New York", city: "New York", postalCode: "10001",
    latitude: "40.7", longitude: "-74.0", timezone: "America/New_York", colo: "EWR",
    clientTcpRtt: 8, clientQuicRtt: null, deliveryRate: 123456, requestPriority: "weight=16",
    httpProtocol: "HTTP/2", tlsVersion: "TLSv1.3", tlsCipher: "AEAD-AES128-GCM-SHA256", tlsExtensions: "abc",
    acceptEncoding: "gzip, br", userAgent: "<script>x</script>", acceptLanguage: "en", dnt: "not set",
    referer: "https://elsewhere.example/", cookies: "none", botScore: null, verifiedBot: false,
    detectionIds: null, corporateProxy: null, ja3Hash: null, ja4: null, when: "2026-09-25T12:00:00.000Z",
  };
  const live = renderWhoareyouValues(data, { browser: "Chrome", os: "macOS", device: "" }, null).html;
  const page = renderWhoareyouPage();
  return page.text().then((shell) => {
    const island = shell.slice(shell.indexOf('data-island='), shell.indexOf("<noscript>", shell.indexOf('data-island=')));
    const rows = (s) => (s.match(/<dt>/g) || []).length;
    assert.equal(rows(island), rows(live), "the swap would add or remove rows, which is a layout shift");
    // Values are escaped by construction.
    assert.ok(live.includes("&lt;script&gt;x&lt;/script&gt;"));
    assert.ok(!live.includes("<script>x"));
    // The referrer is the browser's to fill: the fragment's own Referer is the page.
    assert.ok(!live.includes("elsewhere.example"), "the fragment must not report a referrer it cannot know");
    assert.match(live, /<span data-referrer>…<\/span>/);
  });
});

test("/whoareyou/values.html answers with this request's values and the island marker", async () => {
  const req = Object.assign(new Request("https://aadhar.sh" + VALUES_URL, { headers: { "user-agent": "curl/8.7.1" } }), {
    cf: { colo: "EWR", httpProtocol: "HTTP/2", tlsVersion: "TLSv1.3", clientTcpRtt: 8, clientQuicRtt: 0 },
  });
  const res = await handleWhoareyouValues(req, {}, { waitUntil() {} });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get(ISLAND_MARKER), "1");
  assert.equal(res.headers.get("cache-control"), "no-store, must-revalidate");
  const body = await res.text();
  assert.match(body, /TLSv1\.3/);
  assert.match(body, /TCP round-trip<\/dt><dd>8 ms/);
  // The QUIC field reads 0 rather than absent on TCP (measured 2026-09-25), so
  // the transport decides; before the fix both rows rendered on HTTP/2.
  assert.doesNotMatch(body, /QUIC round-trip/);
  assert.doesNotMatch(body, /<html|<head/i, "a fragment, never a document");
});
