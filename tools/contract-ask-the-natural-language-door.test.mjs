// ── /ask — the natural-language door ────────────────────────────
// Split from contract-tests.test.mjs; shared imports live in contract-shared.mjs.
import {
  DATA_TOOLS,
  MODERN_META,
  assert,
  context,
  handleSiteMcp,
  mcpPost,
  readFileSync,
  terminalEnv,
  test,
} from "./contract-shared.ts";

// ── /ask — the natural-language door ────────────────────────────
// Every test here runs the ROUTER path (no AI binding), which is the mode CI
// and local dev get. That is deliberate rather than a limitation: the router is
// the fallback the whole route rests on when the model is unavailable, and it
// is the only half that can be asserted deterministically.






test("the ask loop and the MCP server call ONE tool registry", async () => {
  // lib/tools.js exists so a tool description cannot be reworded in one door and
  // not the other. If either side grows a private list, this fails.
  const env = terminalEnv();
  const listed = (await (await handleSiteMcp(mcpPost({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { ...MODERN_META } }), env, context())).json())
    .result.tools.map((t) => t.name);
  for (const tool of DATA_TOOLS) {
    assert.ok(listed.includes(tool.name), `${tool.name} is in the ask catalog but not in tools/list`);
    assert.ok(tool.description && tool.inputSchema, `${tool.name} must carry a description and a schema for function calling`);
  }
  const src = readFileSync("src/worker/mcp.ts", "utf8");
  assert.match(src, /from "\.\/lib\/tools\.(js|ts)"/, "mcp.js must import the shared registry");
  assert.ok(!/name: "search_site"/.test(src), "mcp.js re-declares a data tool instead of importing it");
});
