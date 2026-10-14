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
} from "./contract-shared.ts";

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
    "aadhar-sh.workers.dev.evil.example",
    "notworkers.dev",
    "workers.dev",
    undefined,
  ]) {
    assert.equal(isPreviewHost(host), false, `${host} is NOT a preview host`);
  }
});

test("previews refuse every unsafe method, and the GET-shaped writes too", async () => {
  const { previewDenial } = await import("../src/worker/lib/preview.ts");

  for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS", "post"]) {
    for (const path of ["/book", "/webmention", "/search", "/serendipity/sync", "/a-route-invented-tomorrow"]) {
      const denied = previewDenial(path, method);
      assert.ok(denied, `${method} ${path} must be refused on a preview`);
      assert.equal(denied.status, 403);
      assert.equal(denied.headers.get("cache-control"), "no-store", "a refusal must never be cached");
      assert.equal(denied.headers.get("x-robots-tag"), "noindex, nofollow");
    }
  }

  assert.equal(previewDenial("/mcp", "POST"), null, "JSON-RPC survives the method rule");

  const { PREVIEW_GET_WRITES } = await import("../src/worker/lib/preview.ts");
  assert.ok(PREVIEW_GET_WRITES.size >= 6, "the GET-write list must not quietly collapse");
  for (const path of PREVIEW_GET_WRITES) {
    const denied = previewDenial(path, "GET");
    assert.ok(denied, `GET ${path} mutates production state and must be refused`);
    assert.equal(denied.status, 403);
  }

  for (const path of ["/", "/garage/encoding", "/whoareyou.json", "/photos", "/lens/fetch", "/lens/shot", "/coffee", "/slots"]) {
    for (const method of ["GET", "HEAD"]) {
      assert.equal(previewDenial(path, method), null, `${method} ${path} must still serve on a preview`);
    }
  }
});

// The site's routes come from routes.ts, the data-only route list (it was
// index.ts's source text until 2026-10-02). cal's are still read as TEXT: cal's
// Worker imports "cloudflare:workers" through its Workflow (gotcha 16).
test("every preview-guarded GET write names a path the site really routes", async () => {
  const { PREVIEW_GET_WRITES } = await import("../src/worker/lib/preview.ts");
  const { EXACT_PATHS, PREFIX_ROUTES } = await import("../src/worker/routes.ts");
  const cal = readFileSync(new URL("./cal/src/index.ts", ROOT), "utf8");

  const routed = new Set();
  for (const path of EXACT_PATHS) routed.add(path);
  assert.ok(routed.has("/hit") && routed.has("/webmention/approve"), "the route list must actually carry routes");
  const coffeePrefixed = PREFIX_ROUTES.some((r) => r.label === "/coffee/<path>" && r.match("/coffee/approve"));
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

test("MCP tools that write are refused on a preview host, and reads still run", async () => {
  const { handleMcp: handleSerendipityMcp, MCP_TOOLS: SERENDIPITY_TOOLS } = await import("../serendipity/serendipity.ts");
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

      const live = await (await call("aadhar.sh", tool.name)).json();
      const liveText = live.result?.content?.[0]?.text || "";
      assert.ok(!/disabled on preview URLs/.test(liveText), `${tool.name} must run normally on production`);
    }

    const read = server.tools.find((t) => t.annotations.readOnlyHint !== false);
    const readBody = await (await call("v1-aadhar-sh.workers.dev", read.name)).json();
    const readText = readBody.result?.content?.[0]?.text || "";
    assert.ok(!/disabled on preview URLs/.test(readText), `${server.what} ${read.name} reads and must still run on a preview`);
  }

  assert.equal(writesChecked, 2, "expected exactly the two representation-vault writers");
});

test("preview noindex reaches the responses the security wrapper otherwise skips", async () => {
  const { withSecurityHeaders } = await import("../src/worker/lib/security.ts");

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

  for (const [what, response] of makeCases()) {
    const plain = withSecurityHeaders(response, "/photos");
    assert.equal(plain.headers.get("x-robots-tag"), null, `${what} must NOT be noindexed off a preview`);
  }

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

test("every /access device previews a cost, and the clause order its parser depends on holds", async () => {
  const html = await readFile(new URL("src/pages/access/index.html", ROOT), "utf8");
  const rows = [...html.matchAll(/<tr data-id="([^"]+)"([^>]*)>([\s\S]*?)<\/tr>/g)];
  assert.ok(rows.length >= 60, `expected the full device table, saw ${rows.length} rows`);

  const ids = new Set(rows.map(([, id]) => id));
  let withCost = 0, withBet = 0, rivalEnds = 0;

  for (const [, id, attrs, body] of rows) {
    const status = (attrs.match(/data-status="([^"]+)"/) || [])[1];
    const beforeEx = body.split('<td class="ex">')[0];
    const cells = [...beforeEx.matchAll(/<td>([\s\S]*?)<\/td>/g)];
    const prose = cells.length ? cells[cells.length - 1][1] : "";
    assert.ok(prose.length > 40, `${id}: no prose cell found`);

    const cost = /<b>Costs:<\/b>/.test(prose);
    const blocker = /<b>(In the way|Passed over because):<\/b>/.test(prose);
    assert.ok(cost || blocker, `${id}: previews no downside (needs Costs, In the way, or Passed over because)`);
    if (cost) withCost++;

    if (status !== "shipped") {
      assert.match(prose, /<b>Bet:<\/b>/, `${id}: ${status} but carries no Bet`);
      withBet++;
    }

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
