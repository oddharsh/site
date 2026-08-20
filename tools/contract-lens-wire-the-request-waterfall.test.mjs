// ── /lens/wire — the request waterfall ──────────────────────────────────────
// Split from contract-tests.test.mjs; shared imports live in contract-shared.mjs.
import {
  assert,
  readFileSync,
  test,
} from "./contract-shared.mjs";

// ── /lens/wire — the request waterfall ──────────────────────────────────────
// The Wire lens is the only surface here that opens a real CDP browser session,
// so its tests split the way the module does: the summariser is a pure function
// of a CDP event array and gets exercised directly, while everything needing
// workerd is asserted structurally and says so at the assertion.

// Builds the event shapes Chrome actually emits, so these tests are about our
// accounting rather than about a fixture written by whoever wrote the reader.
function wireEvents(specs) {
  const out = [];
  for (const s of specs) {
    out.push({ method: "Network.requestWillBeSent", params: { requestId: s.id, request: { url: s.url, method: "GET" }, type: s.type || "Script", timestamp: s.t ?? 1 } });
    if (s.redirectTo) {
      out.push({ method: "Network.requestWillBeSent", params: { requestId: s.id, request: { url: s.redirectTo }, type: s.type || "Script", timestamp: (s.t ?? 1) + 0.01, redirectResponse: { status: 301 } } });
    }
    if (s.failed) {
      out.push({ method: "Network.loadingFailed", params: { requestId: s.id, errorText: "net::ERR_FAILED", timestamp: (s.t ?? 1) + 0.5 } });
    } else {
      out.push({ method: "Network.responseReceived", params: { requestId: s.id, type: s.type || "Script", response: { status: s.status ?? 200, mimeType: "text/plain", protocol: "h2", encodedDataLength: 120, fromDiskCache: !!s.cached } } });
      out.push({ method: "Network.loadingFinished", params: { requestId: s.id, encodedDataLength: s.bytes ?? 0, timestamp: (s.t ?? 1) + 0.5 } });
    }
  }
  return out;
}

test("the wire lens counts bytes on the wire, not the header preamble", async () => {
  const { summariseWire } = await import("../src/worker/lens-wire.ts");
  // responseReceived carries encodedDataLength for the HEADERS only. Reading it
  // instead of loadingFinished's would report a 400 KB image as 120 bytes, which
  // is the easiest way to get this lens quietly wrong: every number still
  // renders and the page just looks cheap.
  const d = summariseWire(wireEvents([
    { id: "1", url: "https://site.test/", type: "Document", bytes: 4_000 },
    { id: "2", url: "https://site.test/big.jpg", type: "Image", bytes: 400_000 },
  ]), "https://site.test/");
  assert.equal(d.bytes, 404_000, "totals must come from loadingFinished, not responseReceived");
  assert.equal(d.byType.image.bytes, 400_000);
  assert.equal(d.requests, 2);
});

test("a redirect is counted as a hop rather than losing the request", async () => {
  const { summariseWire } = await import("../src/worker/lens-wire.ts");
  // Chrome re-uses the requestId and sends a SECOND requestWillBeSent carrying
  // redirectResponse. Overwriting the row blindly loses the first hop; ignoring
  // the second loses the destination. One row, one hop recorded, final URL kept.
  const d = summariseWire(wireEvents([
    { id: "1", url: "https://site.test/old", redirectTo: "https://site.test/new", bytes: 900 },
  ]), "https://site.test/");
  assert.equal(d.requests, 1);
  assert.equal(d.rows[0].url, "https://site.test/new");
  assert.equal(d.rows[0].redirects, 1);
});

test("the third-party share is the headline and is computed from bytes", async () => {
  const { summariseWire } = await import("../src/worker/lens-wire.ts");
  const d = summariseWire(wireEvents([
    { id: "1", url: "https://news.test/", type: "Document", bytes: 10_000 },
    { id: "2", url: "https://cdn.news.test/app.js", bytes: 10_000 },   // same site, subdomain
    { id: "3", url: "https://ads.example/t.js", bytes: 60_000 },
    { id: "4", url: "https://track.other/p.gif", type: "Image", bytes: 20_000 },
  ]), "https://news.test/");
  assert.equal(d.bytes, 100_000);
  // A subdomain of the page's own site is FIRST party. Getting this wrong
  // inflates the headline on exactly the sites that self-host their assets.
  assert.equal(d.thirdParty.bytes, 80_000);
  assert.equal(d.thirdParty.bytesPct, 80);
  assert.equal(d.thirdParty.hosts, 2);
  assert.equal(d.thirdParty.requests, 2);
  assert.equal(d.hostTotal, 4, "hosts are counted individually even when they group to one site");
});

test("the wire summary never divides by a load that fetched nothing", async () => {
  const { summariseWire } = await import("../src/worker/lens-wire.ts");
  // A navigation that fails outright still reaches the summariser, because the
  // budget was already spent and throwing the observation away would be worse.
  // The percentages must be 0 rather than NaN, which renders as "NaN%".
  const d = summariseWire(wireEvents([{ id: "1", url: "https://dead.test/", failed: true }]), "https://dead.test/");
  assert.equal(d.bytes, 0);
  assert.equal(d.thirdParty.bytesPct, 0);
  assert.equal(d.thirdParty.requestsPct, 0);
  assert.equal(d.failed, 1);
  const empty = summariseWire([], "https://dead.test/");
  assert.equal(empty.requests, 0);
  assert.equal(empty.thirdParty.bytesPct, 0);
});

test("a beacon cancelled after its response is not reported as a failure", async () => {
  const { summariseWire } = await import("../src/worker/lens-wire.ts");
  // MEASURED, not hypothesised. Tracing aadhar.sh's own homepage on 2026-08-11
  // produced `failed: 1`, and the request was /hit?tick=1 — which answered 204
  // and then reported net::ERR_ABORTED, because a fire-and-forget fetch nobody
  // awaits is cancelled at teardown. A lens whose whole claim is honest numbers
  // cannot put "1 failed" on a page where nothing failed.
  const events = [
    { method: "Network.requestWillBeSent", params: { requestId: "1", request: { url: "https://site.test/hit" }, type: "Fetch", timestamp: 1 } },
    { method: "Network.responseReceived", params: { requestId: "1", type: "Fetch", response: { status: 204, mimeType: "text/plain", protocol: "http/1.1" } } },
    { method: "Network.loadingFailed", params: { requestId: "1", errorText: "net::ERR_ABORTED", timestamp: 1.1 } },
  ];
  const d = summariseWire(events, "https://site.test/");
  assert.equal(d.failed, 0, "a 204 that was then cancelled is not a failure");
  assert.equal(d.aborted, 1, "...it is a cancellation, and is still reported");
  assert.equal(d.rows[0].status, 204);

  // A request that never got a response IS a failure, so the discriminator has
  // to be the presence of a status rather than the mere existence of the event.
  const dead = summariseWire([
    { method: "Network.requestWillBeSent", params: { requestId: "2", request: { url: "https://gone.test/x" }, type: "Script", timestamp: 1 } },
    { method: "Network.loadingFailed", params: { requestId: "2", errorText: "net::ERR_NAME_NOT_RESOLVED", timestamp: 1.1 } },
  ], "https://site.test/");
  assert.equal(dead.failed, 1);
  assert.equal(dead.aborted, 0);

  // A CSP or client blocker refusing a tracker is the interesting case, and the
  // reason it names the blockedReason instead of a generic error string.
  const blocked = summariseWire([
    { method: "Network.requestWillBeSent", params: { requestId: "3", request: { url: "https://ads.test/t.js" }, type: "Script", timestamp: 1 } },
    { method: "Network.loadingFailed", params: { requestId: "3", errorText: "net::ERR_BLOCKED_BY_CLIENT", blockedReason: "csp", timestamp: 1.1 } },
  ], "https://site.test/");
  assert.equal(blocked.rows[0].error, "blocked: csp");
});

test("data: URIs are counted but kept out of the host roll call", async () => {
  const { summariseWire } = await import("../src/worker/lens-wire.ts");
  // An inline data: URI is a request in Chrome's event stream and is not a
  // request on the wire. Leaving them in puts a blank host in the list that
  // reads as a tracker; dropping them silently understates the count.
  const d = summariseWire(wireEvents([
    { id: "1", url: "https://site.test/", type: "Document", bytes: 1_000 },
    { id: "2", url: "data:image/svg+xml,%3Csvg%3E", type: "Image", bytes: 0 },
  ]), "https://site.test/");
  assert.equal(d.requests, 1, "a data: URI is not a request on the wire");
  assert.equal(d.dataUris, 1, "...but it is still reported rather than vanishing");
  assert.ok(d.hosts.every((h) => h.host), "no blank host may reach the roll call");
});

test("the KV-hit flag does not collide with the target's own cache count", async () => {
  const { summariseWire } = await import("../src/worker/lens-wire.ts");
  const worker = readFileSync("./src/worker/lens-wire.ts", "utf8");
  const pane = readFileSync("./src/client/lens-wire.js", "utf8");
  // Caught in the browser 2026-08-11, rendering as "true served from cache".
  // The summary owns `cached` — how many of the TARGET's requests came from the
  // browser's own cache — and the KV-hit path was spreading `cached: true` over
  // the same key, replacing a count with a boolean. Two subjects, two keys.
  const d = summariseWire([
    { method: "Network.requestWillBeSent", params: { requestId: "1", request: { url: "https://site.test/a.js" }, type: "Script", timestamp: 1 } },
    { method: "Network.requestServedFromCache", params: { requestId: "1" } },
    { method: "Network.loadingFinished", params: { requestId: "1", encodedDataLength: 10, timestamp: 1.1 } },
  ], "https://site.test/");
  assert.equal(d.cached, 1, "`cached` is a COUNT of the target's cache-served requests");
  assert.equal(typeof d.cached, "number");
  assert.match(worker, /\.\.\.hit, fromCache: true/, "the KV hit must set fromCache, never cached");
  assert.doesNotMatch(worker, /\.\.\.hit, cached: true/);
  assert.match(pane, /d\.fromCache \?/, "the pane must read fromCache for the KV-hit line");
});

test("siteOf groups subdomains without a public-suffix list, and says where it is wrong", async () => {
  const { siteOf } = await import("../src/worker/lens-wire.ts");
  assert.equal(siteOf("cdn.news.test"), "news.test");
  assert.equal(siteOf("news.test"), "news.test");
  assert.equal(siteOf("a.b.c.example.com"), "example.com");
  // The two-level suffixes worth special-casing, because reading bbc.co.uk and
  // itv.co.uk as one site would be visible on the panel people screenshot.
  assert.equal(siteOf("www.bbc.co.uk"), "bbc.co.uk");
  assert.equal(siteOf("shop.example.co.uk"), "example.co.uk");
  // The module must SAY it is a heuristic. This lens is about honest numbers, so
  // an approximation presented as a fact is the failure mode that matters.
  const src = readFileSync("./src/worker/lens-wire.ts", "utf8");
  assert.match(src, /NOT a public-suffix list/, "the heuristic must be labelled as one in the source");
  const pane = readFileSync("./src/client/lens-wire.js", "utf8");
  assert.match(pane, /last two labels of the hostname/, "the pane must disclose the grouping rule to the reader");
});

test("the wire lens shares the SSRF guard and reaches the browser with nothing but the URL", () => {
  const src = readFileSync("./src/worker/lens-wire.ts", "utf8");
  // The rule lens-recipes.js is built around: this route points a real browser
  // at a visitor-supplied address, so the ONLY caller byte that may reach it is
  // the URL, after the shared guard has passed it.
  assert.match(src, /from "\.\/lib\/crawl\.(js|ts)"/, "must import the shared guard, not reimplement it");
  assert.doesNotMatch(src, /function\s+validateLensTarget|function\s+privateHostBlocked/,
    "lens-wire.js redefines a guard it is supposed to be importing");
  // Exactly one searchParams read, and it is the url. A second one is how a
  // `js=` or `selector=` parameter would arrive, which is the hole the recipe
  // allowlist exists to refuse. If a future parameter is genuinely wanted, this
  // is the place to argue for it rather than the place to delete.
  const reads = src.match(/params\.get\(/g) || [];
  assert.equal(reads.length, 1, "lens-wire.js reads more than one query parameter");
  assert.match(src, /params\.get\("url"\)/);
  assert.match(src, /Page\.navigate", \{ url \}/, "the navigation must use the validated URL");
});

test("a CDP session is deleted on every exit path", () => {
  const src = readFileSync("./src/worker/lens-wire.ts", "utf8");
  // Structural, and it has to be: exercising this needs workerd and a real
  // browser binding, so `node --test` can only read the shape. A leaked session
  // holds one of the free plan's three concurrent browsers until it times out,
  // which blacks out /lens/shot and /lens/browser as well as this route.
  const body = src.slice(src.indexOf("async function runWireSession"));
  const finallyAt = body.indexOf("} finally {");
  assert.ok(finallyAt > 0, "runWireSession must clean up in a finally, not on the happy path");
  assert.match(body.slice(finallyAt), /method: "DELETE"/, "the finally block must DELETE the session");
  // The create's own 429 returns BEFORE a session exists, so it must sit outside
  // the try — deleting a session that was never minted is a wasted subrequest on
  // the exact path where the budget is already exhausted.
  assert.ok(body.indexOf("if (created.status === 429)") < body.indexOf("try {"),
    "the budget bail must return before the session is entered");
});

test("the wire lens reports a spent browser budget as ours, not as the target failing", () => {
  const src = readFileSync("./src/worker/lens-wire.ts", "utf8");
  // The correction /lens/shot already made, worth repeating because on the free
  // plan a refused session is the most likely non-success here, and dressing it
  // as a 502 points whoever debugs it at the scanned site instead of at our own
  // allowance. Measured 2026-08-11: a second session opened 20s after the first
  // answered 429 on the create.
  assert.match(src, /browser_budget_spent/, "a refused session needs its own span outcome");
  const budgetBranch = src.slice(src.indexOf("if (out.budget)"), src.indexOf("if (out.error)"));
  assert.match(budgetBranch, /\}, 429\);/, "a spent budget is a 429, never a 502");
  assert.match(budgetBranch, /Every other lens still works/,
    "the message must tell the visitor what they can still do");
});
