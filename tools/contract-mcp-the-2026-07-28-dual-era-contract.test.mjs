// ── /mcp: the 2026-07-28 dual-era contract ──────────────────────────────
// Split from contract-tests.test.mjs; shared imports live in contract-shared.mjs.
import {
  MODERN_META,
  assert,
  context,
  handleSiteMcp,
  mcpPost,
  staticAssets,
  test,
} from "./contract-shared.mjs";

// ── /mcp: the 2026-07-28 dual-era contract ──────────────────────────────
// 2026-07-28 deleted the initialize handshake and moved version, identity and
// capabilities into per-request `_meta`. This server answers BOTH eras on one
// endpoint, which the spec sanctions, so the tests have to pin both — and pin
// that neither one leaks into the other.

// A well-formed modern request. BOTH keys are required by 2026-07-28, and the
// server enforces the second one, so a fixture carrying only the version would
// now be testing the refusal path in every test that used it.

test("server/discover answers identity, versions and capabilities in one round trip", async () => {
  const res = await handleSiteMcp(mcpPost({
    jsonrpc: "2.0", id: "d1", method: "server/discover", params: { ...MODERN_META },
  }), {}, context());
  const { result } = await res.json();

  // MUST be implemented as of 2026-07-28 — a client may probe it before
  // sending anything else, and a dual-era client uses it to tell the eras apart.
  assert.equal(result.resultType, "complete");
  assert.ok(result.supportedVersions.includes("2026-07-28"), "must advertise the modern revision");
  assert.ok(result.supportedVersions.includes("2025-06-18"), "must keep advertising the legacy ones it still serves");
  assert.deepEqual(result.capabilities, { tools: {}, resources: {} });
  assert.equal(result._meta["io.modelcontextprotocol/serverInfo"].name, "aadhar.sh");
  assert.ok(result.instructions.length > 20);
  // server/discover is a cacheable result like the list methods.
  assert.equal(typeof result.ttlMs, "number");
  assert.equal(result.cacheScope, "public");
});

test("an unsupported protocol version is refused with the list the client can retry from", async () => {
  const res = await handleSiteMcp(mcpPost({
    jsonrpc: "2.0", id: 7, method: "tools/list",
    params: { _meta: { "io.modelcontextprotocol/protocolVersion": "1900-01-01" } },
  }), {}, context());
  const { error } = await res.json();

  assert.equal(error.code, -32022, "UnsupportedProtocolVersion, from the reserved -32020..-32099 range");
  assert.equal(error.message, "Unsupported protocol version");
  // The data payload is the whole point: without `supported` the client has
  // nothing to retry with, and this error is also how a dual-era client
  // RECOGNISES a modern server, so its shape is load-bearing.
  assert.equal(error.data.requested, "1900-01-01");
  assert.ok(error.data.supported.includes("2026-07-28"));

  // A version we do speak passes the gate.
  const ok = await handleSiteMcp(mcpPost({ jsonrpc: "2.0", id: 8, method: "tools/list", params: { ...MODERN_META } }), {}, context());
  assert.ok((await ok.json()).result.tools.length > 0);
});

test("a modern request without clientCapabilities is malformed, and a legacy one is not", async () => {
  // 2026-07-28 marks `clientCapabilities` required on every modern request and
  // pins the refusal to -32602 + HTTP 400. The interesting half is what must
  // NOT be refused: this server is dual-era, so absence of `_meta` entirely is
  // an era signal rather than a defect, and enforcing the version key the same
  // way would shut the legacy door this server exists to hold open.
  const bare = { "io.modelcontextprotocol/protocolVersion": "2026-07-28" };
  const res = await handleSiteMcp(mcpPost({
    jsonrpc: "2.0", id: 11, method: "tools/list", params: { _meta: bare },
  }), {}, context());
  const { error } = await res.json();
  assert.equal(error.code, -32602, "plain Invalid Params, not a reserved-range code");
  assert.match(error.message, /clientCapabilities/, "must name the field, which client authors have often never heard of");
  assert.deepEqual(error.data.missing, ["io.modelcontextprotocol/clientCapabilities"]);
  assert.equal(res.status, 400, "the spec pins this one to 400 on HTTP");

  // A legacy caller sends no `_meta` at all and MUST still be served at 200.
  const legacy = await handleSiteMcp(mcpPost({ jsonrpc: "2.0", id: 12, method: "tools/list" }), {}, context());
  assert.equal(legacy.status, 200);
  assert.ok((await legacy.json()).result.tools.length > 0, "no _meta is legacy, not malformed");

  // Empty is a valid declaration; a non-object is not. Accepting the key's mere
  // presence would make this a spelling check instead of a contract.
  for (const [caps, ok] of [[{}, true], [{ roots: {} }, true], [true, false], ["none", false], [[], false], [null, false]]) {
    const r = await handleSiteMcp(mcpPost({
      jsonrpc: "2.0", id: 13, method: "tools/list",
      params: { _meta: { ...bare, "io.modelcontextprotocol/clientCapabilities": caps } },
    }), {}, context());
    const body = await r.json();
    assert.equal(!body.error, ok, `clientCapabilities: ${JSON.stringify(caps)} should ${ok ? "pass" : "be refused"}`);
  }

  // Version first: a caller on a version we do not speak is told THAT, not that
  // its `_meta` is malformed under a revision it never claimed to follow.
  const both = await handleSiteMcp(mcpPost({
    jsonrpc: "2.0", id: 14, method: "tools/list",
    params: { _meta: { "io.modelcontextprotocol/protocolVersion": "1900-01-01" } },
  }), {}, context());
  assert.equal((await both.json()).error.code, -32022, "the unsupported version is the actionable refusal");

  // A batch with one bad message is not a bad batch: 200, with the error in the
  // array where JSON-RPC batching puts it.
  const batch = await handleSiteMcp(mcpPost([
    { jsonrpc: "2.0", id: 15, method: "tools/list", params: { ...MODERN_META } },
    { jsonrpc: "2.0", id: 16, method: "tools/list", params: { _meta: bare } },
  ]), {}, context());
  assert.equal(batch.status, 200, "a batch has no single request whose status a 400 could describe");
  const rows = await batch.json();
  assert.ok(rows.find((r) => r.id === 15).result, "the well-formed message is still answered");
  assert.equal(rows.find((r) => r.id === 16).error.code, -32602);
});

test("every result carries resultType and server identity, and lists carry cache hints", async () => {
  // tools/call needs a real binding to reach a tool; the list methods do not.
  const env = { ASSETS: staticAssets({
    "/search-index.json": { records: [{ url: "/writing/agents", title: "Agents", description: "Notes", text: "cloudflare", kind: "writing" }] },
  }) };
  // TUPLES. Inference widens the rows to (string | object | boolean)[], after
  // which `...params` is a spread of something that might be a boolean.
  /** @type {Array<[method: string, params: object, cacheable: boolean]>} */
  const cases = [
    ["tools/list", {}, true],
    ["resources/list", {}, true],
    ["resources/templates/list", {}, true],
    ["prompts/list", {}, true],
    ["tools/call", { name: "search_site", arguments: { q: "cloudflare" } }, false],
  ];
  for (const [method, params, cacheable] of cases) {
    const res = await handleSiteMcp(mcpPost({
      jsonrpc: "2.0", id: method, method, params: { ...params, ...MODERN_META },
    }), env, context());
    const { result } = await res.json();
    assert.equal(result.resultType, "complete", `${method} must carry resultType`);
    assert.equal(result._meta["io.modelcontextprotocol/serverInfo"].name, "aadhar.sh", `${method} must identify the server`);
    if (cacheable) {
      // CacheableResult: a freshness hint so a client can cache instead of poll.
      assert.ok(result.ttlMs > 0, `${method} must carry ttlMs`);
      assert.ok(["public", "private"].includes(result.cacheScope), `${method} must carry cacheScope`);
    }
  }

  // tools/list order is deterministic, which the spec asks for so clients can
  // cache and so an LLM's prompt cache keeps hitting.
  const twice = await Promise.all([0, 1].map(() =>
    handleSiteMcp(mcpPost({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { ...MODERN_META } }), {}, context()).then((r) => r.json())));
  assert.deepEqual(twice[0].result.tools.map((t) => t.name), twice[1].result.tools.map((t) => t.name));
});

test("the legacy initialize handshake still works and never hands back a modern version", async () => {
  // Legacy clients have NO fall-forward mechanism: told 2026-07-28, they would
  // fail on the next request with no way to recover. So initialize answers in
  // the legacy era only, whatever it was asked for.
  for (const [asked, expected] of [
    ["2025-06-18", "2025-06-18"],
    ["2024-11-05", "2024-11-05"],
    ["2026-07-28", "2025-06-18"],   // modern version over the legacy door
    [undefined,    "2025-06-18"],
  ]) {
    const res = await handleSiteMcp(mcpPost({
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: asked ? { protocolVersion: asked } : {},
    }), {}, context());
    const { result } = await res.json();
    assert.equal(result.protocolVersion, expected, `initialize(${asked}) should negotiate ${expected}`);
    assert.equal(result.serverInfo.name, "aadhar.sh");
  }

  // A legacy client sends no _meta and must still be served, not version-gated.
  const legacy = await handleSiteMcp(mcpPost({ jsonrpc: "2.0", id: 2, method: "tools/list" }), {}, context());
  assert.ok((await legacy.json()).result.tools.length > 0, "a request with no _meta is legacy, not invalid");
});

test("the routing headers are checked when present and never required", async () => {
  const body = { jsonrpc: "2.0", id: 3, method: "tools/list", params: { ...MODERN_META } };

  // Absent: fine. Requiring them would reject every legacy client at the
  // transport layer, which is the row of the spec's compatibility matrix this
  // server exists to avoid.
  assert.ok((await (await handleSiteMcp(mcpPost(body), {}, context())).json()).result);
  // Agreeing: fine.
  assert.ok((await (await handleSiteMcp(mcpPost(body, { "mcp-method": "tools/list" }), {}, context())).json()).result);
  // Disagreeing: refused. This is the case the header exists to prevent — an
  // intermediary authorizing tools/list while the body calls a tool.
  const bad = await (await handleSiteMcp(mcpPost(body, { "mcp-method": "tools/call" }), {}, context())).json();
  assert.equal(bad.error.code, -32020, "HeaderMismatch");

  const named = { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "coffee_availability", arguments: {}, ...MODERN_META } };
  const mismatchedName = await (await handleSiteMcp(mcpPost(named, { "mcp-name": "search_site" }), {}, context())).json();
  assert.equal(mismatchedName.error.code, -32020, "Mcp-Name must agree with the tool being called");
});
