// ── the MCP era is recorded per request ──────────────────────────────
// The legacy half of lib/mcp-protocol.ts exists because pre-2026 clients have
// no fall-forward mechanism, and it can only be retired on evidence that they
// stopped calling. noteEra() is that evidence: it tags each request both MCP
// servers parse, and index.ts's per-request log line carries the tag. These
// assert the classification on BOTH servers, the narrowing that keeps a
// caller-controlled string out of the logs, and that the log line reads it.
import { MODERN_META, assert, context, handleSiteMcp, readFileSync, test } from "./contract-shared.ts";
import { mcpEraOf } from "../src/worker/lib/mcp-protocol.ts";

const serendipity = await import("../serendipity/serendipity.ts");
const database = { prepare: () => ({ all: async () => [] }) };

function post(server, body, headers = {}) {
  const request = new Request(`https://aadhar.sh/${server === "site" ? "mcp" : "serendipity/mcp"}`, {
    method: "POST", headers, body: JSON.stringify(body),
  });
  const response = server === "site"
    ? handleSiteMcp(request, {}, context())
    : serendipity.handleMcp(request, {}, database);
  return { request, response };
}

const discover = { jsonrpc: "2.0", id: 1, method: "server/discover", params: MODERN_META };
const initialize = (clientInfo, protocolVersion = "2025-06-18") => ({
  jsonrpc: "2.0", id: 2, method: "initialize",
  params: { protocolVersion, capabilities: {}, clientInfo },
});

for (const server of ["site", "serendipity"]) {
  test(`${server} MCP records the era of every well-formed request`, async () => {
    let { request, response } = post(server, discover);
    await response;
    assert.deepEqual(mcpEraOf(request), { era: "modern", version: "2026-07-28", client: undefined });

    ({ request, response } = post(server, initialize({ name: "old-client", version: "1.0" })));
    await response;
    assert.deepEqual(mcpEraOf(request), { era: "legacy", version: "2025-06-18", client: "old-client" });

    // After the handshake a legacy client names its revision on the header.
    ({ request, response } = post(server, { jsonrpc: "2.0", id: 3, method: "ping" },
      { "mcp-protocol-version": "2025-03-26" }));
    await response;
    assert.deepEqual(mcpEraOf(request), { era: "legacy", version: "2025-03-26", client: undefined });

    // A batch mixing eras is one request with no single revision.
    ({ request, response } = post(server, [discover, initialize({ name: "old-client" })]));
    await response;
    assert.deepEqual(mcpEraOf(request), { era: "mixed", version: undefined, client: "old-client" });
  });

  test(`${server} MCP narrows caller-controlled era fields before they reach a log`, async () => {
    const hostile = "evil\n{\"s\":500}\u0000" + "x".repeat(200);
    let { request, response } = post(server, initialize({ name: hostile }, "not-a-date\n"));
    await response;
    const era = mcpEraOf(request);
    assert.equal(era?.era, "legacy");
    assert.equal(era?.version, undefined, "a non-date revision is dropped rather than logged");
    const client = era?.client ?? "";
    assert.equal(client.length, 40);
    assert.match(client, /^[\x20-\x7e]+$/, "control characters never reach the log line");

    // A request that fails envelope validation never reached a server, so it
    // records nothing and cannot be counted as either era.
    ({ request, response } = post(server, { jsonrpc: "1.0", method: "ping" }));
    await response;
    assert.equal(mcpEraOf(request), undefined);
  });
}

test("the per-request log line carries the MCP era", () => {
  const source = readFileSync(new URL("../src/worker/index.ts", import.meta.url), "utf8");
  const line = source.slice(source.indexOf("console.log(JSON.stringify({"));
  const body = line.slice(0, line.indexOf("}));"));
  assert.match(source, /const mcpEra = mcpEraOf\(request\);/);
  for (const field of ["mcp: mcpEra?.era", "mv: mcpEra?.version", "mc: mcpEra?.client"]) {
    assert.ok(body.includes(field), `log line is missing ${field}`);
  }
});
