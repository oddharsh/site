// ── MCP data tools share their REST twins' schemas ───────────────────────────
import { TRACKS, assert, context, kvForTracks, schemaViolations, staticAssets, test } from "../../../tools/tests/contract-shared.ts";
import { _resetSearchIndex } from "../search.ts";

// A data tool that runs the same function as a REST operation declares that
// operation's 200 schema as its outputSchema (lib/tools.ts). The oracle here is
// the tool's real result: each mapped tool runs, and its structuredContent must
// satisfy the schema it publishes, so a declared schema can't describe a shape
// the tool doesn't return.

// Two observations of one target, the fixture the Change Radar test reads.
const changeDb = () => ({
  prepare: () => ({
    all: async () => ({
      results: [
        { target: "https://example.com/", name: "Example", observed_at: 2000, status: 503, title: null, body_hash: null, robots: "allow" },
        { target: "https://example.com/", name: "Example", observed_at: 1000, status: 200, title: "Example", body_hash: "a", robots: "allow" },
      ],
    }),
  }),
});

const searchEnv = () => (
  _resetSearchIndex(),
  {
    ASSETS: staticAssets({
      "/search-index.json": {
        version: 1,
        records: [{ url: "/writing/agents", title: "Agents", description: "Notes on agents", text: "Cloudflare agents and tools", kind: "writing" }],
      },
    }),
  }
);

test("each mapped tool's real result satisfies the outputSchema it declares", async () => {
  const { DATA_TOOLS, callDataTool } = await import("../lib/tools.ts");
  const req = new Request("https://aadhar.sh/mcp");
  const calls = [
    { name: "ask", args: { query: "cloudflare agents" }, env: searchEnv() },
    { name: "search_site", args: { q: "cloudflare" }, env: searchEnv() },
    { name: "photo_query", args: { q: "bridge", limit: 3 }, env: {} },
    { name: "now_playing", args: {}, env: { RN_KV: kvForTracks() } },
    { name: "change_radar", args: {}, env: { RESTORE_DB: changeDb() } },
    { name: "change_radar", args: {}, env: {} },
  ];
  for (const { name, args, env } of calls) {
    const tool = DATA_TOOLS.find((t) => t.name === name);
    assert.ok(tool, name);
    assert.ok(Object.keys(tool.outputSchema.properties ?? {}).length > 0, `${name} declares its fields`);
    const result = await callDataTool(name, args, req, env, context());
    assert.equal(result._error, undefined, `${name} ran: ${String(result._error)}`);
    assert.deepEqual(schemaViolations(tool.outputSchema, result), [], `${name} returned a shape its outputSchema doesn't describe`);
  }
  // The fixtures were read, so the checks above ran on real data rather than
  // on a fallback shape: the playlist is the fixture, and the radar found a change.
  assert.deepEqual(await callDataTool("now_playing", {}, req, { RN_KV: kvForTracks() }, context()), TRACKS);
  assert.equal((await callDataTool("change_radar", {}, req, { RESTORE_DB: changeDb() }, context())).available, true);

  // CONTROL. The checker refuses a wrong type, a missing required field and a
  // value outside an enum, or every pass above proves nothing.
  const probe = { type: "object", properties: { n: { type: "integer" }, mode: { enum: ["list"] } }, required: ["n"] };
  assert.deepEqual(schemaViolations(probe, { n: 1, mode: "list" }), []);
  assert.equal(schemaViolations(probe, { n: "1" }).length, 1);
  assert.equal(schemaViolations(probe, {}).length, 1);
  assert.equal(schemaViolations(probe, { n: 1, mode: "summarize" }).length, 1);
});

test("a mapped tool's schemas are its REST operation's, and the Lens summaries keep their own", async () => {
  const { DATA_TOOLS } = await import("../lib/tools.ts");
  const { OPERATIONS } = await import("../lib/public-api.ts");
  const byName = new Map(DATA_TOOLS.map((t) => [t.name, t]));
  const searchOp = OPERATIONS.find((o) => o.operationId === "searchSite")!;

  // A parameter the tool left undescribed takes the operation's words.
  assert.equal(byName.get("search_site")!.inputSchema.properties.limit.description, searchOp.parameters!.find((p) => p.name === "limit")!.description);
  // A description the tool wrote itself wins.
  assert.equal(byName.get("search_site")!.inputSchema.properties.q.description, "case-insensitive search query");
  // No $ref survives, since an MCP client has no components to resolve it in.
  for (const tool of DATA_TOOLS) assert.ok(!JSON.stringify(tool.outputSchema).includes("$ref"), `${tool.name} carries a $ref`);
  // The Lens tools return lensObservationSummary, a different shape from
  // /lens/fetch, so they take parameter descriptions and keep the open schema.
  assert.deepEqual(byName.get("lens_inspect")!.outputSchema, { type: "object", additionalProperties: true });
  assert.ok(byName.get("lens_inspect")!.inputSchema.properties.url.description);
});

test("the live tools/list carries the derived schemas", async () => {
  const { handleSiteMcp } = await import("../mcp.ts");
  const res = await handleSiteMcp(
    new Request("https://aadhar.sh/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    }),
    {},
    context(),
  );
  const tools = (await res.json()).result.tools;
  const search = tools.find((t) => t.name === "search_site");
  assert.ok(Object.keys(search.outputSchema.properties).length > 0, "tools/list serves the typed schema, not the open one");
});

test("the API catalog lists every API it describes as an item, under the RFC 9727 profile", async () => {
  const { readFile } = await import("node:fs/promises");
  const { ROOT } = await import("../../../tools/tests/contract-shared.ts");
  const catalog = JSON.parse(await readFile(new URL("public/.well-known/api-catalog", ROOT), "utf8"));
  const [self, ...apis] = catalog.linkset;
  assert.equal(self.anchor, "https://aadhar.sh/.well-known/api-catalog", "the first entry is the catalog's own");
  // Every API entry below is an item of the catalog, and nothing else is: the
  // site root describes the docs, not an API.
  const described = apis.map((e) => e.anchor).filter((a) => a !== "https://aadhar.sh/");
  assert.deepEqual(
    self.item.map((i) => i.href),
    described,
  );
  const profile = 'application/linkset+json; profile="https://www.rfc-editor.org/info/rfc9727"';
  const headers = await readFile(new URL("public/_headers", ROOT), "utf8");
  assert.ok(headers.includes(`/.well-known/api-catalog\n  Content-Type: ${profile}\n`), "_headers names the profile");
  assert.ok((await readFile(new URL("src/worker/index.ts", ROOT), "utf8")).includes(profile), "the Worker, which serves the file, names the same profile");
});
