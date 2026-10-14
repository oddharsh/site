import { foreignNlwebAsk } from "./lib/doors.ts";
import { defineLens } from "./lens-pipeline.ts";

const NLWEB_CACHE_SECONDS = 3600;
const MAX_QUERY = 200;
const DEFAULT_QUERY = "what is this site about";

const LENS_NLWEB = defineLens({
  span: "lens.nlweb",
  budget: "nlweb",
  targets: (params: URLSearchParams) => params.get("url") || "",
  args: (params) => ({ query: String(params.get("q") || "").trim().slice(0, MAX_QUERY) || DEFAULT_QUERY }),
  cache: { prefix: "lens:nlweb:", ttl: NLWEB_CACHE_SECONDS, key: (url, { query }) => new URL(url).origin + "\n" + query },
  run: async ({ target, args: { query }, env, span: s }) => {
    const origin = new URL(target).origin;
    const host = new URL(origin).hostname;
    const probe = await foreignNlwebAsk(origin, env, { query });

    if (!probe.ok) {
      s.setAttribute("lens.detail", probe.detail);
      return {
        ok: false, status: 200, outcome: probe.unreadable ? "unreadable" : "shut",
        payload: {
          ok: false, origin, host, query,
          endpoint: origin.replace(/\/+$/, "") + "/ask",
          unreadable: !!probe.unreadable,
          gated: !!probe.gated,
          error: probe.detail || "the /ask door did not answer",
        },
      };
    }

    s.setAttribute("lens.nlweb_results", probe.total);
    s.setAttribute("lens.nlweb_framing", probe.framing);
    s.setAttribute("lens.nlweb_dialect", probe.dialect);
    s.setAttribute("lens.nlweb_schemas", probe.coverage.schema_object);
    return { ok: true, outcome: "read", value: { ok: true, origin, host, ...probe } };
  },
});

export function handleLensNlweb(request, env, ctx?) {
  return LENS_NLWEB.handle(request, env, ctx);
}
