import { validateLensTarget } from "./lib/crawl.ts";
import { jsonResponse } from "./lib/http.ts";
import { span } from "./lib/trace.ts";
import { foreignMcpTools } from "./lib/doors.ts";
import { LENS_BUDGETS, lensSha256Hex, overLensBudget } from "./lens.ts";

// A catalogue read is one POST that a foreign server answers from memory, so
// this is cached to be POLITE rather than to be fast. A public button pointed at
// somebody else's endpoint should not re-ask them the same question every time a
// visitor clicks a tab.
const TOOLS_CACHE_SECONDS = 3600;

export async function handleLensTools(request, env) {
  const params = new URL(request.url).searchParams;

  const v = validateLensTarget(params.get("url") || "");
  if (!v.ok) return jsonResponse({ ok: false, error: v.error }, 400);

  const origin = new URL(v.url).origin;
  const cacheKey = "lens:tools:" + (await lensSha256Hex(origin));
  if (env.RN_KV) {
    const hit = await env.RN_KV.get(cacheKey, "json");
    // One span name for hit and miss, differing on lens.cache, so the hit rate
    // is a group-by rather than a join. Same convention as lens.shot.
    if (hit) {
      return span("lens.tools", (s) => {
        s.setAttribute("lens.target_host", hit.host);
        s.setAttribute("lens.cache", "hit");
        return jsonResponse({ ...hit, fromCache: true });
      });
    }
  }

  if (await overLensBudget(LENS_BUDGETS.tools, request, env)) {
    return jsonResponse({ ok: false, error: `Catalogue reads are rate-limited to ${LENS_BUDGETS.tools.max}/min. Hang on a moment.` }, 429);
  }

  return span("lens.tools", async (s) => {
    const host = (() => { try { return new URL(origin).hostname; } catch { return undefined; } })();
    s.setAttribute("lens.target_host", host);
    s.setAttribute("lens.cache", "miss");

    const probe = await foreignMcpTools(origin, env, { schemas: true });

    // SHUT and UNREADABLE stay different answers here for the same reason
    // classifyDoor keeps them apart: a 404 means this origin serves no MCP, and
    // a transport failure means we never got to look. Collapsing them would have
    // the pane announce that a live server has no tools.
    if (!probe.ok) {
      s.setAttribute("lens.outcome", probe.unreadable ? "unreadable" : "shut");
      s.setAttribute("lens.detail", probe.detail);
      return jsonResponse({
        ok: false, origin, host,
        unreadable: !!probe.unreadable,
        error: probe.detail || "the MCP door did not answer",
      });
    }

    const withSchema = probe.tools.filter((t) => t.inputSchema && t.inputSchema.properties).length;
    s.setAttribute("lens.tool_count", probe.count);
    s.setAttribute("lens.tools_with_schema", withSchema);
    s.setAttribute("lens.outcome", "read");

    const payload = {
      ok: true,
      origin,
      host,
      endpoint: origin.replace(/\/+$/, "") + "/mcp",
      count: probe.count,
      shown: probe.tools.length,
      withSchema,
      tools: probe.tools,
    };
    if (env.RN_KV) {
      await env.RN_KV.put(cacheKey, JSON.stringify(payload), { expirationTtl: TOOLS_CACHE_SECONDS })
        .catch(() => { /* a cache write is never worth failing the read for */ });
    }
    return jsonResponse(payload);
  });
}
