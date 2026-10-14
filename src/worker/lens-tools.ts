import { foreignMcpTools } from "./lib/doors.ts";
import { defineLens } from "./lens-pipeline.ts";

const TOOLS_CACHE_SECONDS = 3600;

const LENS_TOOLS = defineLens({
  span: "lens.tools",
  budget: "tools",
  targets: (params: URLSearchParams) => params.get("url") || "",
  cache: { prefix: "lens:tools:", ttl: TOOLS_CACHE_SECONDS, key: (url) => new URL(url).origin },
  run: async ({ target, env, span: s }) => {
    const origin = new URL(target).origin;
    const host = new URL(origin).hostname;
    const probe = await foreignMcpTools(origin, env, { schemas: true });

    if (!probe.ok) {
      s.setAttribute("lens.detail", probe.detail);
      return {
        ok: false, status: 200, outcome: probe.unreadable ? "unreadable" : "shut",
        payload: {
          ok: false, origin, host,
          unreadable: !!probe.unreadable,
          error: probe.detail || "the MCP door did not answer",
        },
      };
    }

    const withSchema = probe.tools.filter((t) => t.inputSchema && t.inputSchema.properties).length;
    s.setAttribute("lens.tool_count", probe.count);
    s.setAttribute("lens.tools_with_schema", withSchema);
    return {
      ok: true, outcome: "read",
      value: {
        ok: true,
        origin,
        host,
        endpoint: origin.replace(/\/+$/, "") + "/mcp",
        count: probe.count,
        shown: probe.tools.length,
        withSchema,
        tools: probe.tools,
      },
    };
  },
});

export function handleLensTools(request, env, ctx?) {
  return LENS_TOOLS.handle(request, env, ctx);
}
