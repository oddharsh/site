import { foreignMcpTools } from "./lib/doors.ts";
import { defineLens } from "./lens-pipeline.ts";

// A catalogue read is one POST that a foreign server answers from memory, so
// this is cached to be POLITE rather than to be fast. A public button pointed at
// somebody else's endpoint should not re-ask them the same question every time a
// visitor clicks a tab.
const TOOLS_CACHE_SECONDS = 3600;

// Keyed on the ORIGIN: an MCP catalogue belongs to the origin, so every page on
// it shares one entry. Validation, the cache, the budget and the span are the
// pipeline's (lens-pipeline.ts); what is here is the read itself.
const LENS_TOOLS = defineLens({
  span: "lens.tools",
  budget: "tools",
  targets: (params: URLSearchParams) => params.get("url") || "",
  cache: { prefix: "lens:tools:", ttl: TOOLS_CACHE_SECONDS, key: (url) => new URL(url).origin },
  run: async ({ target, env, span: s }) => {
    const origin = new URL(target).origin;
    const host = new URL(origin).hostname;
    const probe = await foreignMcpTools(origin, env, { schemas: true });

    // SHUT and UNREADABLE stay different answers here for the same reason
    // classifyDoor keeps them apart: a 404 means this origin serves no MCP, and
    // a transport failure means we never got to look. Collapsing them would have
    // the pane announce that a live server has no tools. Neither is cached.
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
