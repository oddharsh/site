// ── both MCP servers speak one protocol ─────────────────────────────
// Split from contract-tests.test.mjs; shared imports live in contract-shared.mjs.
import {
  MCP_SUPPORTED_VERSIONS,
  assert,
  readFileSync,
  test,
} from "./contract-shared.ts";

// ── both MCP servers speak one protocol ─────────────────────────────
// This origin publishes TWO MCP servers, /mcp and /serendipity/mcp. They share
// no data and no tools; they DO share the wire rules, via
// src/worker/lib/mcp-protocol.ts. Two servers on one origin speaking
// different dialects is the kind of bug a client author reports to you, so the
// conformance assertions run against both rather than against the site one.

test("the site and serendipity MCP servers agree on the 2026-07-28 wire rules", async () => {
  const { handleMcp } = await import("../serendipity/serendipity.ts");
  const post = (body, headers = {}) => new Request("https://aadhar.sh/serendipity/mcp", {
    method: "POST", body: JSON.stringify(body),
    headers: { "content-type": "application/json", ...headers },
  });
  // The protocol-level methods touch no database, so a null `d` is enough.
  const call = async (body, headers) => (await handleMcp(post(body, headers), {}, null)).json();
  const modern = { _meta: {
    "io.modelcontextprotocol/protocolVersion": "2026-07-28",
    "io.modelcontextprotocol/clientCapabilities": {},
  } };

  // server/discover: MUST exist, and must advertise the same version set as the
  // site server — a client that trusts one origin's answer should not find the
  // second server disagreeing about what the origin speaks.
  const disc = (await call({ jsonrpc: "2.0", id: 1, method: "server/discover", params: { ...modern } })).result;
  assert.equal(disc.resultType, "complete");
  assert.equal(disc._meta["io.modelcontextprotocol/serverInfo"].name, "serendipity");
  assert.deepEqual(disc.supportedVersions, MCP_SUPPORTED_VERSIONS);
  assert.deepEqual(disc.capabilities, { tools: {} }, "serendipity exposes tools only, no resources");

  // The version gate, byte-identical to the site server's because it is the
  // same function.
  const refused = await call({
    jsonrpc: "2.0", id: 2, method: "tools/list",
    params: { _meta: { "io.modelcontextprotocol/protocolVersion": "1900-01-01" } },
  });
  assert.equal(refused.error.code, -32022);
  assert.deepEqual(refused.error.data.supported, MCP_SUPPORTED_VERSIONS);

  // Cache hints and resultType on every list surface.
  for (const method of ["tools/list", "resources/list", "resources/templates/list", "prompts/list"]) {
    const { result } = await call({ jsonrpc: "2.0", id: method, method, params: { ...modern } });
    assert.equal(result.resultType, "complete", `${method} must carry resultType`);
    assert.ok(result.ttlMs > 0, `${method} must carry ttlMs`);
    assert.equal(result.cacheScope, "public");
    assert.equal(result._meta["io.modelcontextprotocol/serverInfo"].name, "serendipity");
  }

  // The legacy door still opens, and still never hands back a modern version.
  for (const [asked, expected] of [["2025-06-18", "2025-06-18"], ["2026-07-28", "2025-06-18"]]) {
    const { result } = await call({ jsonrpc: "2.0", id: 3, method: "initialize", params: { protocolVersion: asked } });
    assert.equal(result.protocolVersion, expected);
    assert.equal(result.serverInfo.name, "serendipity");
  }

  // The required-`_meta` rule, same function and therefore same verdict: a
  // modern request without clientCapabilities is malformed at 400, a legacy one
  // with no `_meta` at all is served at 200.
  const malformed = await handleMcp(post({
    jsonrpc: "2.0", id: 6, method: "tools/list",
    params: { _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" } },
  }), {}, null);
  assert.equal(malformed.status, 400);
  assert.equal((await malformed.json()).error.code, -32602);
  const legacyOk = await handleMcp(post({ jsonrpc: "2.0", id: 7, method: "tools/list" }), {}, null);
  assert.equal(legacyOk.status, 200);
  assert.ok((await legacyOk.json()).result.tools.length > 0);

  // Routing headers: checked when present, never required.
  assert.ok((await call({ jsonrpc: "2.0", id: 4, method: "tools/list", params: { ...modern } })).result);
  const mismatch = await call({ jsonrpc: "2.0", id: 5, method: "tools/list", params: { ...modern } }, { "mcp-method": "tools/call" });
  assert.equal(mismatch.error.code, -32020);
});

test("neither MCP server keeps a private copy of the protocol constants", async () => {
  // The whole point of lib/mcp-protocol.js is that there is ONE answer to "what
  // does this origin speak". A server that re-declares MCP_SUPPORTED locally
  // would pass every test above on the day it was written and drift later.
  for (const file of ["src/worker/mcp.ts", "serendipity/serendipity.ts"]) {
    const src = readFileSync(file, "utf8");
    assert.ok(/from ".*lib\/mcp-protocol\.(js|ts)"/.test(src), `${file} must import the shared protocol module`);
    assert.ok(!/^const MCP_SUPPORTED\s*=/m.test(src), `${file} re-declares MCP_SUPPORTED instead of importing it`);
    assert.ok(!/^const MCP_PROTOCOL\s*=/m.test(src), `${file} re-declares MCP_PROTOCOL instead of importing it`);
  }
});

test("both CSS checks go through the one parser, and it still tolerates the right family", async () => {
  // build.mjs decides what reaches a visitor; check-page-contracts.mjs is a
  // pre-build gate on the same stylesheets. They ran DIFFERENT engines until
  // 2026-08-14 (Lightning CSS and esbuild), which disagree in both directions, so
  // a scaffold could pass the gate and fail the build. One parser, one family.
  for (const file of ["tools/build.ts", "tools/check-page-contracts.ts"]) {
    const src = readFileSync(file, "utf8");
    assert.ok(/from "\.\/lib\/css-parse\.ts"/.test(src), `${file} must import the shared CSS parser`);
    assert.ok(!/from "esbuild"/.test(src), `${file} must not reach for a second CSS engine`);
    assert.ok(!/UNKNOWN_SELECTOR\s*=/.test(src), `${file} re-declares the tolerated warning family instead of importing it`);
  }

  const { parseCss, UNKNOWN_SELECTOR } = await import("../tools/lib/css-parse.ts");

  // The family is tolerated AND preserved verbatim, which is the whole bargain.
  const carousel = "ul::scroll-marker-group{display:flex}li::scroll-marker{content:\"\"}";
  const out = parseCss("probe", carousel, { minify: true });
  assert.match(out, /::scroll-marker-group/, "the tolerated selector must survive");
  assert.match(out, /::scroll-marker/, "the tolerated selector must survive");

  // A warning OUTSIDE the family is still fatal, so tolerance stays narrow.
  assert.throws(() => parseCss("probe", "@nonsense (x) { .a { color: red } }"),
    /emitted warnings/, "an unknown at-rule must not be swept in with the carousel family");

  // And structurally broken CSS still fails rather than being recovered silently.
  assert.throws(() => parseCss("probe", ".a{color:red}}"), /.*/, "broken CSS must throw");

  assert.ok(UNKNOWN_SELECTOR.test("'::scroll-marker' is not recognized as a valid pseudo-element"),
    "the family regex must still match the message Lightning actually emits");
});
