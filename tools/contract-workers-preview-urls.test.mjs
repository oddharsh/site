// ── Workers preview URLs ────────────────────────────────────────────
// Split from contract-tests.test.mjs; shared imports live in contract-shared.mjs.
import {
  MODERN_META,
  ROOT,
  SITE_MCP_TOOLS,
  assert,
  context,
  handleSiteMcp,
  readFile,
  readFileSync,
  test,
} from "./contract-shared.mjs";

// ── Workers preview URLs ────────────────────────────────────────────
// A preview version runs PRODUCTION bindings and secrets (lib/preview.js says
// why at length), so these tests are the difference between a preview URL and
// an unaudited write path into the real site. They are cheap; the failure they
// prevent is a coffee booking emailed to a stranger from a branch.

test("the preview host test matches workers.dev and nothing that merely looks like it", async () => {
  const { isPreviewHost } = await import("../src/worker/lib/preview.ts");

  for (const host of [
    "abc12345-aadhar-sh.oddharsh.workers.dev",
    "AADHAR-SH.ODDHARSH.WORKERS.DEV",          // hostnames are case-insensitive
    "aadhar-sh.workers.dev",
  ]) {
    assert.equal(isPreviewHost(host), true, `${host} is a preview host`);
  }

  for (const host of [
    "aadhar.sh",
    "cal.aadhar.sh",
    "aadhar-sh.workers.dev.evil.example",      // suffix match, not substring
    "notworkers.dev",                          // ".workers.dev" must not match "notworkers.dev"
    "workers.dev",                             // the bare apex is not a subdomain of itself
    undefined,
  ]) {
    assert.equal(isPreviewHost(host), false, `${host} is NOT a preview host`);
  }
});

test("previews refuse every unsafe method, and the GET-shaped writes too", async () => {
  const { previewDenial } = await import("../src/worker/lib/preview.ts");

  // DEFAULT-DENY is the property worth pinning: the guard must not depend on
  // somebody remembering to list a new POST route. Paths here are deliberately
  // ones the guard has never heard of.
  for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS", "post"]) {
    for (const path of ["/book", "/webmention", "/search", "/serendipity/sync", "/a-route-invented-tomorrow"]) {
      const denied = previewDenial(path, method);
      assert.ok(denied, `${method} ${path} must be refused on a preview`);
      assert.equal(denied.status, 403);
      assert.equal(denied.headers.get("cache-control"), "no-store", "a refusal must never be cached");
      assert.equal(denied.headers.get("x-robots-tag"), "noindex, nofollow");
    }
  }

  // /mcp is the one POST exception, and it is admitted so the MCP server can be
  // exercised on a preview, NOT because nothing behind it writes. Two vault
  // tools do; they are refused a layer down, by the next test.
  assert.equal(previewDenial("/mcp", "POST"), null, "JSON-RPC survives the method rule");

  // The other direction: writes that arrive as a plain GET, which the method
  // rule structurally cannot catch. Read the entries off the module rather than
  // restating them — a copy of the list here asserts only that the list equals
  // itself, which is how the stale coffee paths survived. What gives this teeth
  // is the pin in the next test.
  const { PREVIEW_GET_WRITES } = await import("../src/worker/lib/preview.ts");
  assert.ok(PREVIEW_GET_WRITES.size >= 6, "the GET-write list must not quietly collapse");
  for (const path of PREVIEW_GET_WRITES) {
    const denied = previewDenial(path, "GET");
    assert.ok(denied, `GET ${path} mutates production state and must be refused`);
    assert.equal(denied.status, 403);
  }

  // ...and reads pass, or the preview is useless. /lens/* is on this list on
  // purpose: it fetches third parties and costs Browser Run, but it reads
  // only, and a /lens change you cannot exercise is a /lens change you cannot review.
  for (const path of ["/", "/garage/encoding", "/whoareyou.json", "/photos", "/lens/fetch", "/lens/shot", "/coffee", "/slots"]) {
    for (const method of ["GET", "HEAD"]) {
      assert.equal(previewDenial(path, method), null, `${method} ${path} must still serve on a preview`);
    }
  }
});

// The guard's own list is the half a test cannot check by reading the guard. An
// entry that names a path nothing routes reads as protection and protects
// nothing, which is what happened to the coffee pair: it sat here as bare
// /approve and /decline (the retired cal.aadhar.sh spellings) while the live
// routes arrived under /coffee/*, so a signed approve link opened against a
// preview confirmed a real booking and emailed a real person, on production's
// SIGNING_SECRET. So pin every entry against the route tables it claims to guard.
//
// The tables are read as SOURCE TEXT, not imported: index.js is the one module
// allowed to import "cloudflare:workers", and importing it here would kill the
// whole suite at link time (gotcha 16).
test("every preview-guarded GET write names a path the site really routes", async () => {
  const { PREVIEW_GET_WRITES } = await import("../src/worker/lib/preview.ts");
  const dispatcher = readFileSync(new URL("./src/worker/index.ts", ROOT), "utf8");
  const cal = readFileSync(new URL("./cal/src/index.ts", ROOT), "utf8");

  // Exact ROUTES entries in the site dispatcher, plus cal's own matches, which
  // reach the visitor one prefix deeper: index.js hands /coffee/* to cal, and
  // cal strips that prefix before comparing.
  const routed = new Set();
  for (const [, path] of dispatcher.matchAll(/\[\s*"(\/[^"]*)"\s*,\s*[A-Za-z_$]/g)) routed.add(path);
  assert.ok(routed.has("/hit") && routed.has("/webmention/approve"), "the ROUTES scan must actually find routes");
  const coffeePrefixed = /pathname\.startsWith\("\/coffee\/"\)/.test(dispatcher);
  assert.ok(coffeePrefixed, "cal is reached through the /coffee/ prefix; this test's mapping assumes it");
  for (const [, path] of cal.matchAll(/path === "(\/[^"]*)"/g)) routed.add(`/coffee${path === "/" ? "" : path}`);
  assert.ok(routed.has("/coffee/approve"), "the cal scan must actually find cal's routes");

  for (const path of PREVIEW_GET_WRITES) {
    assert.ok(
      routed.has(path),
      `${path} is guarded as a GET-shaped write, but no route table serves it — the guard is protecting a dead path`,
    );
  }
});

// The other stale claim, and the more exposed one: /mcp needs no signature and
// no secret, so for as long as the guard admitted the endpoint on the grounds
// that nothing behind it wrote, any POST to a preview's /mcp could INSERT into
// the production representation vault. The refusal is derived from each tool's
// own readOnlyHint, so a new writing tool is covered on the day it declares
// itself. Swept over BOTH servers on this origin, which is what keeps the
// serendipity call site honest while it still has nothing to refuse.
test("MCP tools that write are refused on a preview host, and reads still run", async () => {
  const { handleMcp: handleSerendipityMcp, MCP_TOOLS: SERENDIPITY_TOOLS } = await import("../serendipity/serendipity.js");
  const servers = [
    { what: "/mcp", handle: (r) => handleSiteMcp(r, {}, context()), tools: SITE_MCP_TOOLS, path: "/mcp" },
    { what: "/serendipity/mcp", handle: (r) => handleSerendipityMcp(r, {}, null), tools: SERENDIPITY_TOOLS, path: "/serendipity/mcp" },
  ];

  let writesChecked = 0;
  for (const server of servers) {
    const call = (host, name) => server.handle(new Request(`https://${host}${server.path}`, {
      method: "POST",
      body: JSON.stringify({ jsonrpc: "2.0", id: "preview", method: "tools/call", params: { name, arguments: {}, ...MODERN_META } }),
      headers: { "content-type": "application/json" },
    }));

    for (const tool of server.tools) {
      if (tool.annotations.readOnlyHint !== false) continue;
      writesChecked += 1;
      const body = await (await call("v1-aadhar-sh.workers.dev", tool.name)).json();
      assert.equal(body.result?.isError, true, `${server.what} ${tool.name} writes and must be refused on a preview`);
      assert.match(body.result.content[0].text, /disabled on preview URLs/, `${tool.name}'s refusal must say why`);

      // ...and the same call off a preview must NOT be refused for this reason.
      // It may still fail on absent bindings here, which is a different answer.
      const live = await (await call("aadhar.sh", tool.name)).json();
      const liveText = live.result?.content?.[0]?.text || "";
      assert.ok(!/disabled on preview URLs/.test(liveText), `${tool.name} must run normally on production`);
    }

    // A read tool has to survive the guard, or the preview loses the surface the
    // /mcp exception exists to preserve.
    const read = server.tools.find((t) => t.annotations.readOnlyHint !== false);
    const readBody = await (await call("v1-aadhar-sh.workers.dev", read.name)).json();
    const readText = readBody.result?.content?.[0]?.text || "";
    assert.ok(!/disabled on preview URLs/.test(readText), `${server.what} ${read.name} reads and must still run on a preview`);
  }

  // The vault tools are the reason this test exists. If the count ever drops to
  // zero the sweep above is asserting nothing, and would say so silently.
  assert.equal(writesChecked, 2, "expected exactly the two representation-vault writers");
});

test("preview noindex reaches the responses the security wrapper otherwise skips", async () => {
  const { withSecurityHeaders } = await import("../src/worker/lib/security.ts");

  // The wrapper bails early on redirects and images, which is correct for CSP
  // and wrong for robots: both are independently indexable, so a preview that
  // marked only its HTML would still publish a duplicate photo corpus.
  // Built fresh per pass, deliberately. `withSecurityHeaders` rebuilds every
  // response as `new Response(response.body, …)`, which per Fetch LOCKS the
  // body it was handed, so reusing one case object across both passes feeds the
  // second one a disturbed stream. Node's undici allows that and bun 1.4 throws
  // `Body object should not be disturbed or locked`, which is the spec-correct
  // read. The assertions here are about headers, so the leniency was never load
  // bearing; it just made the suite depend on which runtime ran it.
  const makeCases = () => [
    ["a redirect",  new Response(null, { status: 301, headers: { location: "https://aadhar.sh/photos" } })],
    ["an image",    new Response("jpegbytes", { headers: { "content-type": "image/jpeg" } })],
    ["a document",  new Response("<!doctype html><title>x</title>", { headers: { "content-type": "text/html; charset=utf-8" } })],
    ["a json feed", new Response("{}", { headers: { "content-type": "application/json" } })],
  ];
  for (const [what, response] of makeCases()) {
    const marked = withSecurityHeaders(response, "/photos", { noindex: true });
    assert.equal(marked.headers.get("x-robots-tag"), "noindex, nofollow", `${what} must carry noindex on a preview`);
  }

  // ...and production is untouched. This is the regression that would matter
  // most: a bug here deindexes the real site.
  for (const [what, response] of makeCases()) {
    const plain = withSecurityHeaders(response, "/photos");
    assert.equal(plain.headers.get("x-robots-tag"), null, `${what} must NOT be noindexed off a preview`);
  }

  // The wrapper is only half of it: what decides `noindex` is the dispatcher, and
  // that used to be `onPreview` alone, which left cal.aadhar.sh publishing
  // /coffee at a second hostname (cal's templates carry no rel=canonical). The
  // dispatcher cannot be imported here, since index.js is the one module allowed
  // to import "cloudflare:workers" (gotcha 16), so pin the decision as source.
  const dispatcher = readFileSync(new URL("./src/worker/index.ts", ROOT), "utf8");
  assert.match(
    dispatcher,
    /noindex:\s*!isCanonicalHost\(url\.hostname\)/,
    "every hostname that is not the canonical site must be noindexed, not just previews",
  );

  // A route that already set its own x-robots-tag keeps it (/whoareyou.json and
  // /updates.json both do), so the guard can't weaken an existing directive.
  const own = new Response("{}", { headers: { "content-type": "application/json", "x-robots-tag": "noindex" } });
  assert.equal(withSecurityHeaders(own, "/whoareyou.json", { noindex: true }).headers.get("x-robots-tag"), "noindex");

  // Null-body statuses. The noindex path REBUILDS the response, and the Response
  // constructor throws if a null-body status is handed a body — so a 304 from
  // notModifiedIfFresh or a 204 from the /hit beacon is exactly the shape that
  // would turn a preview into a 500 on the revalidation path, where a browser
  // hits it constantly and a first look would not.
  for (const status of [204, 304]) {
    const empty = new Response(null, { status, headers: { etag: 'W/"x"' } });
    const marked = withSecurityHeaders(empty, "/", { noindex: true });
    assert.equal(marked.status, status, `${status} must survive the noindex rebuild`);
    assert.equal(marked.headers.get("x-robots-tag"), "noindex, nofollow");
    assert.equal(marked.headers.get("etag"), 'W/"x"', "existing headers survive the rebuild");
  }
});

// /access is a graph rendered from a table in its own bytes, and three of its
// authored invariants were verified once by hand in a browser rather than checked.
// Each one fails silently: a node with no downside still renders, a mis-ordered
// label still parses into something, and a dangling rival just draws no edge.
test("every /access device previews a cost, and the clause order its parser depends on holds", async () => {
  const html = await readFile(new URL("src/pages/access/index.html", ROOT), "utf8");
  const rows = [...html.matchAll(/<tr data-id="([^"]+)"([^>]*)>([\s\S]*?)<\/tr>/g)];
  // A collapsed roster would satisfy every assertion below, so pin the count too.
  assert.ok(rows.length >= 60, `expected the full device table, saw ${rows.length} rows`);

  const ids = new Set(rows.map(([, id]) => id));
  let withCost = 0, withBet = 0, rivalEnds = 0;

  for (const [, id, attrs, body] of rows) {
    const status = (attrs.match(/data-status="([^"]+)"/) || [])[1];
    // the prose cell is the last bare <td> before the examples cell
    const beforeEx = body.split('<td class="ex">')[0];
    const cells = [...beforeEx.matchAll(/<td>([\s\S]*?)<\/td>/g)];
    const prose = cells.length ? cells[cells.length - 1][1] : "";
    assert.ok(prose.length > 40, `${id}: no prose cell found`);

    // 1. no device previews as pure upside. A shipped node needs an authored
    //    Costs clause; an unfinished one falls back to whatever blocks it.
    const cost = /<b>Costs:<\/b>/.test(prose);
    const blocker = /<b>(In the way|Passed over because):<\/b>/.test(prose);
    assert.ok(cost || blocker, `${id}: previews no downside (needs Costs, In the way, or Passed over because)`);
    if (cost) withCost++;

    // 2. the page claims every unfinished device carries a dated bet
    if (status !== "shipped") {
      assert.match(prose, /<b>Bet:<\/b>/, `${id}: ${status} but carries no Bet`);
      withBet++;
    }

    // 3. the parser slices labels off in reverse prose order and takes Costs
    //    FIRST, so Costs must be authored last or `why` keeps a stray clause.
    if (cost) {
      const at = prose.indexOf("<b>Costs:</b>");
      for (const other of ["Bet:", "In the way:", "Passed over because:"]) {
        const o = prose.indexOf(`<b>${other}</b>`);
        assert.ok(o === -1 || o < at, `${id}: <b>${other}</b> is authored after Costs, which mis-slices the parse`);
      }
    }

    for (const r of ((attrs.match(/data-rivals="([^"]*)"/) || [])[1] || "").split(",").filter(Boolean)) {
      assert.ok(ids.has(r), `${id}: rivals "${r}", which is not a device id`);
      rivalEnds++;
    }
  }

  assert.ok(withCost >= 18, `expected an authored Costs clause on every installed device, saw ${withCost}`);
  assert.ok(withBet >= 40, `expected a Bet on every unfinished device, saw ${withBet}`);
  assert.ok(rivalEnds >= 8, `expected the zero-sum pairs to be declared, saw ${rivalEnds}`);
});
