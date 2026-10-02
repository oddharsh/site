import { jsonResponse } from "./lib/http.ts";
import { foreignMcpTools } from "./lib/doors.ts";
import { guardedRead } from "./lens-guard.ts";

// A catalogue read is one POST that a foreign server answers from memory, so
// this is cached to be POLITE rather than to be fast. A public button pointed at
// somebody else's endpoint should not re-ask them the same question every time a
// visitor clicks a tab.
const TOOLS_CACHE_SECONDS = 3600;

export function handleLensTools(request, env) {
  const params = new URL(request.url).searchParams;

  // The shell (validate, cache before budget, the 429, the hit/miss span, the
  // cache write) is lens-guard's. No `ctx` is handed over, so the write is
  // awaited, as it always was on this route.
  return guardedRead(request, env, undefined, {
    span: "lens.tools",
    url: params.get("url") || "",
    budget: "tools",
    limited: (max) => `Catalogue reads are rate-limited to ${max}/min. Hang on a moment.`,
    cache: { tab: "tools", identity: (url) => new URL(url).origin, ttl: TOOLS_CACHE_SECONDS },
    run: async (url, s) => {
    const origin = new URL(url).origin;
    const host = (() => { try { return new URL(origin).hostname; } catch { return undefined; } })();

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
    s.setAttribute("lens.outcome", "read");

    return {
      ok: true,
      origin,
      host,
      endpoint: origin.replace(/\/+$/, "") + "/mcp",
      count: probe.count,
      shown: probe.tools.length,
      withSchema,
      tools: probe.tools,
    };
    },
  });
}
