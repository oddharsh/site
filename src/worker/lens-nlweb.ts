// lens-nlweb.js — the NLWeb lens: what a foreign origin ANSWERS, not whether it
// has a door to answer through.
//
// /lens has knocked on /ask since the doors tier was built, and a knock is all
// it was: a status code and a content-type, from a request carrying no query.
// That probe is deliberately conservative and its own comment says why — "we
// never send one, so nothing runs on their side" — and it is also the reason
// four of six origins in a 46-site survey were promoted to Agent-Native by a
// /ask that answered 410, 412, 429 or 401. A door that opens onto nothing still
// reads as a door from outside.
//
// This walks through it. One real question, one real answer, graded against the
// contract the protocol actually specifies.
//
// WHAT IT REPORTS IS SHAPE, NOT CONTENT. The pane does show the results, because
// hiding them would make the grade unfalsifiable, but the finding is the
// per-field coverage: NLWeb names six fields per result and `schema_object` is
// the one that makes an answer machine-usable rather than a link with prose
// attached. A server can return an immaculate paragraph and no schema at all,
// and an agent pointed at it has a paragraph where structured data was promised.
// That gap is invisible to a knock and invisible to a human reading the JSON.
//
// COST, WHICH IS WHY THIS IS OPT-IN AND CACHED. The Tools lens asks a server to
// describe itself and that is nearly free for them. This asks a retrieval
// endpoint a QUESTION: on a real NLWeb instance that is a vector search, and in
// `generate` mode it is an LLM call somebody is paying for. So the request
// pins `mode=list` explicitly rather than trusting their default, the answer is
// cached for an hour per origin and query, and the tab never fires on its own.
// Same reasoning as the Reader lens, one step stronger, because a second fetch
// of a page costs the origin bandwidth and a second /ask costs them compute.
import { validateLensTarget } from "./lib/crawl.ts";
import { foreignNlwebAsk } from "./lib/doors.ts";
import { jsonResponse } from "./lib/http.ts";
import { span } from "./lib/trace.ts";
import { LENS_BUDGETS, lensSha256Hex, overLensBudget } from "./lens.ts";

const NLWEB_CACHE_SECONDS = 3600;
// The visitor may ask their own question, because "what does this endpoint
// answer" is not a thing one fixed string can show. It is bounded and it is
// DATA rather than code: it reaches the target as a search query, which is what
// the endpoint exists to receive. That is the line lens-recipes.js draws too —
// a URL is fine, a `js=` parameter is not — and the reason a query is on the
// safe side of it is that no allowlist could make executable input safe, while
// a search string needs none.
const MAX_QUERY = 200;
const DEFAULT_QUERY = "what is this site about";

export async function handleLensNlweb(request, env) {
  const params = new URL(request.url).searchParams;

  const v = validateLensTarget(params.get("url") || "");
  if (!v.ok) return jsonResponse({ ok: false, error: v.error }, 400);

  const origin = new URL(v.url).origin;
  const query = String(params.get("q") || "").trim().slice(0, MAX_QUERY) || DEFAULT_QUERY;
  // Keyed on the QUERY as well as the origin. Keying on origin alone would show
  // one visitor's answer to another visitor's question, which on a surface whose
  // whole claim is "this is what the machine actually got" is the exact lie it
  // exists to prevent.
  const cacheKey = "lens:nlweb:" + (await lensSha256Hex(origin + "\n" + query));

  if (env.RN_KV) {
    const hit = await env.RN_KV.get(cacheKey, "json");
    if (hit) {
      return span("lens.nlweb", (s) => {
        s.setAttribute("lens.target_host", hit.host);
        s.setAttribute("lens.cache", "hit");
        return jsonResponse({ ...hit, fromCache: true });
      });
    }
  }

  if (await overLensBudget(LENS_BUDGETS.nlweb, request, env)) {
    return jsonResponse({ ok: false, error: `NLWeb reads are rate-limited to ${LENS_BUDGETS.nlweb.max}/min, because each one asks somebody else's server a real question. Hang on a moment.` }, 429);
  }

  return span("lens.nlweb", async (s) => {
    const host = (() => { try { return new URL(origin).hostname; } catch { return undefined; } })();
    s.setAttribute("lens.target_host", host);
    s.setAttribute("lens.cache", "miss");

    const probe = await foreignNlwebAsk(origin, env, { query });

    if (!probe.ok) {
      // SHUT and UNREADABLE stay apart, same as the catalogue read: "this origin
      // serves no /ask" and "we never got an answer" are different findings, and
      // merging them would have the pane announce that a live endpoint is absent.
      s.setAttribute("lens.outcome", probe.unreadable ? "unreadable" : "shut");
      s.setAttribute("lens.detail", probe.detail);
      return jsonResponse({
        ok: false, origin, host, query,
        endpoint: origin.replace(/\/+$/, "") + "/ask",
        unreadable: !!probe.unreadable,
        gated: !!probe.gated,
        error: probe.detail || "the /ask door did not answer",
      });
    }

    s.setAttribute("lens.nlweb_results", probe.total);
    s.setAttribute("lens.nlweb_framing", probe.framing);
    s.setAttribute("lens.nlweb_dialect", probe.dialect);
    s.setAttribute("lens.nlweb_schemas", probe.coverage.schema_object);
    s.setAttribute("lens.outcome", "read");

    const payload = { ok: true, origin, host, ...probe };
    if (env.RN_KV) {
      await env.RN_KV.put(cacheKey, JSON.stringify(payload), { expirationTtl: NLWEB_CACHE_SECONDS })
        .catch(() => { /* a cache write is never worth failing the read for */ });
    }
    return jsonResponse(payload);
  });
}
