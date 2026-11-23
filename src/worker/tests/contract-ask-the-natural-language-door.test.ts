// ── /ask — the natural-language door ────────────────────────────
import { MODERN_META, assert, context, mcpPost, readFileSync, test } from "../../../tools/tests/contract-shared.ts";
import { DATA_TOOLS } from "../lib/tools.ts";
import { handleSiteMcp } from "../mcp.ts";
import { terminalEnv } from "../../../tools/tests/contract-terminal.ts";

// Every test here runs the ROUTER path (no AI binding), which is the mode CI
// and local dev get. That is deliberate rather than a limitation: the router is
// the fallback the whole route rests on when the model is unavailable, and it
// is the only half that can be asserted deterministically.

test("the ask loop and the MCP server call ONE tool registry", async () => {
  // src/worker/lib/tools.ts exists so a tool description cannot be reworded in
  // one door and not the other. If either side grows a private list, this fails.
  const env = terminalEnv();
  const listed = new Set(
    (await (await handleSiteMcp(mcpPost({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { ...MODERN_META } }), env, context())).json()).result.tools.map(
      (t) => t.name,
    ),
  );
  for (const tool of DATA_TOOLS) {
    assert.ok(listed.has(tool.name), `${tool.name} is in the ask catalog but not in tools/list`);
    assert.ok(tool.description && tool.inputSchema, `${tool.name} must carry a description and a schema for function calling`);
  }
  const src = readFileSync("src/worker/mcp.ts", "utf8");
  assert.match(src, /from "\.\/lib\/tools\.(js|ts)"/, "mcp.js must import the shared registry");
  assert.ok(!/name: "search_site"/.test(src), "mcp.js re-declares a data tool instead of importing it");
});
