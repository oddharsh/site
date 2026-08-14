// lens-tools.js — the Tools lens: a foreign MCP server's catalogue, WITH the
// argument schemas, so the pane can draw a form per tool.
//
// The idea is a block explorer's contract page. Etherscan hands you a verified
// contract's ABI and builds a form from it, and the form is what turns "this
// address has code" into something you can actually reason about. `tools/list`
// hands out the same thing under a different name: `inputSchema` IS the ABI.
//
// Where the analogy STOPS is the whole reason this route reads and never calls.
// Etherscan can preview a call because the EVM is a deterministic machine whose
// entire state is public and forkable, so `eth_call` at a block height is
// reproducible by anyone. An MCP server is an opaque RPC into somebody's private
// database. There is no fork, no state override, no revert, and the protocol has
// no dry-run primitive — no `dryRun` flag, no simulate method, nothing in
// `_meta`. So "what would send_invoice do" is unanswerable without the server
// volunteering an answer, and none of them do.
//
// What IS answerable is the exact frame a call would carry. The pane renders
// that and hands the visitor a curl. Execution moving to the visitor's own
// machine is not a consolation prize: it is what keeps a public button from
// being an open proxy that fires strangers' tools from this account's IP and
// under AadharshBot's signature, which is the same argument lens-recipes.js
// makes for refusing a `js=` parameter.
//
// Everything reaches the network through foreignMcpTools in lib/doors.js, so
// this route adds no new way out. It inherits that module's SSRF guards, its
// 8s timeout, its byte caps and its bot signature, and it inherits the wire
// rules (framing, headers, protocol revision) rather than restating them.
import { validateLensTarget } from "./lib/crawl.js";
import { jsonResponse } from "./lib/http.js";
import { span } from "./lib/trace.js";
import { foreignMcpTools } from "./lib/doors.js";
import { LENS_BUDGETS, lensSha256Hex, overLensBudget } from "./lens.js";

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
