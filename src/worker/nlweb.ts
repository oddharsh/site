// nlweb.ts — /ask, NLWeb's REST endpoint, and the `ask` tool behind it.
//
// NLWeb is a thin convention rather than a framework: a site answers natural
// language at /ask, returns schema.org objects, and exposes the same thing over
// MCP. This origin already had the second half (a dual-era /mcp server, and a
// search index over its own corpus), so what was missing was the endpoint, its
// parameter contract, and a schema.org projection of the search records.
//
// Two request dialects reach this handler, and the difference is not cosmetic —
// it selects the STREAMING FORMAT, which is the one place a client can be
// broken by guessing:
//
//   legacy  GET /ask?query=...          -> unnamed SSE frames carrying message_type
//   v0.55   POST {query:{text},prefer}  -> NAMED SSE events (start / result / complete)
//
// The reference implementation picks between them exactly this way: a `query`
// that arrives as an OBJECT flags the structured request and sets the protocol
// version to 0.55. Nothing else does. So a header, an Accept, or a query
// parameter cannot select v0.55, and a server that emits named events to a
// legacy GET is talking to nobody.
//
// STREAMING DEFAULTS TO TRUE. A bare GET /ask?query=x is an event stream, not a
// JSON body, which reads as a bug the first time you curl it. `streaming=0`
// (or `false`) is the documented off switch and is what the JSON path wants.
//
// WHAT THIS SERVER WILL NOT PRETEND TO DO. NLWeb's `mode` has three values and
// two of them need an LLM: `summarize` writes a summary of the list, `generate`
// is RAG. This Worker has no AI binding, deliberately, so both are refused by
// name with the supported set attached rather than quietly served as `list`.
// The same rule governs `prev`: decontextualizing a follow-up ("what about the
// other one?") is a model's job, so a caller who sends `prev` without
// `decontextualized_query` gets their raw query searched AND a field saying so.
// Answering a different question than the one asked, silently, is the failure
// this endpoint exists to avoid, and it is the failure a compliance checklist
// cannot see.
//
// `description` is EXTRACTIVE here. The spec annotates that field "(generated
// by an llm)" and ours is the query-relevant snippet the search pass already
// cut. Same reasoning as the photo pipeline's nullable fields: report the thing
// you have, name what it is, never fabricate the thing you do not.
import { CANONICAL_HOST } from "./lib/const.ts";
import { jsonResponse } from "./lib/http.ts";
import { asRecord } from "./lib/parse.ts";
import { span } from "./lib/trace.ts";
import { SEARCH_TERM_MAX, searchSiteRanked } from "./search.ts";

export const NLWEB_VERSION = "0.55";
export const NLWEB_SITE = CANONICAL_HOST;
// `all` is NLWeb's wildcard across a multi-site backend. This origin is one
// site, so both spellings resolve here and anything else is a real mistake
// worth naming rather than silently answering from the only corpus we have.
const SITE_TOKENS = new Set(["", "all", CANONICAL_HOST, "aadhar.sh", "https://aadhar.sh"]);
export const NLWEB_MODES = { supported: ["list"], known: ["list", "summarize", "generate"] };
const MAX_RESULTS = 50;
const DEFAULT_RESULTS = 10;

// The site's own search records carry a `kind`; these are the schema.org types
// those kinds actually are. A `schema_object` is the whole point of NLWeb's
// result contract — it is what makes the answer machine-usable rather than a
// link with prose attached — so a wrong @type here is worse than none.
const SCHEMA_TYPE = { page: "WebPage", writing: "BlogPosting", document: "DigitalDocument", utility: "WebAPI" };
// Declared once in the homepage's JSON-LD graph. Referenced by @id rather than
// re-described, so a crawler that has read the homepage joins the two.
const WEBSITE_NODE = { "@type": "WebSite", "@id": `https://${CANONICAL_HOST}/#website`, name: CANONICAL_HOST, url: `https://${CANONICAL_HOST}/` };

function absolute(path) {
  try { return new URL(String(path || "/"), `https://${CANONICAL_HOST}/`).toString(); }
  catch { return `https://${CANONICAL_HOST}/`; }
}

export function askSchemaObject(record) {
  const url = absolute(record.url);
  return {
    "@context": "https://schema.org",
    "@type": SCHEMA_TYPE[record.kind] || "WebPage",
    "@id": url,
    url,
    name: String(record.title || ""),
    description: String(record.description || "").slice(0, 300),
    isPartOf: WEBSITE_NODE,
  };
}

/**
 * NLWeb scores are a 0-100 relevance. Ours is lexical and additive (8 for a
 * term in the title, 4 in the description, 1 in the body), so the raw number
 * means nothing on its own — it rises with the term COUNT, and a one-word query
 * could never reach what a five-word query scores.
 *
 * Normalising against the set's own top score would be the easy move and is the
 * dishonest one: it hands every query a 100 and makes the number comparable
 * only within one response. This divides by what the query could have scored,
 * so a 100 means every term hit every field and a 15 means the same thing in
 * every response on this origin.
 */
export function askRelevance(raw, termCount) {
  const ceiling = Math.max(1, termCount) * SEARCH_TERM_MAX;
  return Math.max(1, Math.min(100, Math.round((raw / ceiling) * 100)));
}

/**
 * Read the NLWeb parameter set out of whichever dialect arrived.
 */
export function parseAskRequest(url, body): { ok: true, params: any } | { ok: false, status: number, error: any } {
  const q = url.searchParams;
  const flat = asRecord(body) || {};
  let structured = false;

  // v0.55: `query` is an object. Flattened exactly as the reference server
  // flattens it, including `prefer` and `context`, so the two dialects converge
  // on one parameter set before anything here has to reason about them.
  let query = flat.query ?? q.get("query");
  let site = flat.site ?? q.get("site");
  let prev = flat.prev ?? q.get("prev");
  let mode = flat.mode ?? q.get("mode");
  let streamingRaw = flat.streaming ?? q.get("streaming");
  let queryId = flat.query_id ?? q.get("query_id");
  let decontextualized = flat.decontextualized_query ?? q.get("decontextualized_query");

  // The v0.55 signal is `query` arriving as a RECORD rather than a string, and
  // asRecord is the boundary parser that answers exactly that (arrays and null
  // are not records, which both matter here: `query=[...]` is malformed, not
  // structured).
  const structuredQuery = asRecord(query);
  if (structuredQuery) {
    structured = true;
    const inner = structuredQuery;
    query = inner.text ?? "";
    if (inner.site != null) site = inner.site;
    const context = asRecord(flat.context);
    if (context && context.prev != null) prev = context.prev;
    const prefer = asRecord(flat.prefer);
    if (prefer) {
      if (prefer.streaming != null) streamingRaw = prefer.streaming;
      if (prefer.mode != null) mode = prefer.mode;
    }
  }

  const text = String(query ?? "").trim();
  if (!text) {
    return { ok: false, status: 400, error: { error: "query is required", parameter: "query", endpoint: "/ask" } };
  }

  const siteToken = String(site ?? "").trim().toLowerCase().replace(/\/+$/, "");
  if (!SITE_TOKENS.has(siteToken)) {
    return { ok: false, status: 400, error: { error: `unknown site token "${siteToken}"`, parameter: "site", available_sites: [CANONICAL_HOST, "all"] } };
  }

  const modeToken = String(mode ?? "list").trim().toLowerCase() || "list";
  if (!NLWEB_MODES.supported.includes(modeToken)) {
    const known = NLWEB_MODES.known.includes(modeToken);
    return {
      ok: false,
      status: known ? 501 : 400,
      error: {
        error: known
          ? `mode "${modeToken}" needs a language model and this origin runs none. It is refused rather than answered as "list", because a summary you did not get is worse than a summary you were told you cannot have.`
          : `unknown mode "${modeToken}"`,
        parameter: "mode",
        supported_modes: NLWEB_MODES.supported,
        known_modes: NLWEB_MODES.known,
      },
    };
  }

  // Spec: "defaults to true. To turn off streaming, specify a value of 0 or
  // false". Anything else, including nonsense, is therefore streaming.
  const streaming = !["0", "false", "no", "off"].includes(String(streamingRaw ?? "").trim().toLowerCase());

  // `prev` is a comma-separated list in the legacy dialect and an array in the
  // structured one.
  const prevList = (Array.isArray(prev) ? prev : String(prev ?? "").split(","))
    .map((s) => String(s).trim()).filter(Boolean).slice(0, 10);

  const searched = String(decontextualized ?? "").trim() || text;
  const limitRaw = Number(flat.top_k ?? q.get("top_k") ?? q.get("limit"));
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(MAX_RESULTS, Math.trunc(limitRaw)) : DEFAULT_RESULTS;

  return {
    ok: true,
    params: {
      query: text,
      searched,
      // Did the CALLER hand us a decontextualized query, or are we searching
      // their raw text? The answer changes what the results mean and is the one
      // thing a follow-up query can get silently wrong.
      decontextualized: Boolean(String(decontextualized ?? "").trim()),
      prev: prevList,
      site: siteToken && siteToken !== "all" ? CANONICAL_HOST : (siteToken || CANONICAL_HOST),
      mode: modeToken,
      streaming,
      structured,
      limit,
      queryId: String(queryId ?? "").trim() || crypto.randomUUID(),
    },
  };
}

/**
 * The answer itself, in NLWeb's result shape. Shared by /ask and the `ask` MCP
 * tool, so the two doors cannot describe this origin differently.
 */
export async function nlwebAsk(env, params) {
  const ranked = await searchSiteRanked(env, params.searched, params.limit);
  const results = ranked.results.map((record) => ({
    url: absolute(record.url),
    name: String(record.title || ""),
    site: NLWEB_SITE,
    score: askRelevance(record.score, ranked.terms.length),
    description: String(record.snippet || record.description || ""),
    schema_object: askSchemaObject(record),
  }));

  // The revision this SERVER speaks, and separately the dialect this REQUEST
  // was read as. `decontextualization` is absent unless it is true of this
  // response, so it is explicitly optional rather than widening the whole
  // payload after inference.
  const responseMeta: {
    version: string;
    dialect: string;
    retrieval: string;
    description: string;
    score: string;
    modes_supported: string[];
    decontextualization?: string;
  } = {
    version: NLWEB_VERSION,
    dialect: params.structured ? "0.55" : "legacy",
    retrieval: "lexical",
    description: "extractive",
    score: `0-100, relevance as a percentage of the maximum a ${ranked.terms.length}-term query could score`,
    modes_supported: NLWEB_MODES.supported,
  };
  const payload = {
    query_id: params.queryId,
    query: params.query,
    site: NLWEB_SITE,
    mode: params.mode,
    // The searched string is reported ALWAYS, and `decontextualized` says who
    // produced it. A caller comparing the two can see when their follow-up was
    // taken literally.
    decontextualized_query: params.searched,
    total: ranked.total,
    results,
    _meta: responseMeta,
  };

  // Only ever present when it is TRUE of this response: a caller who sent no
  // follow-up context should not read a line about follow-up context.
  if (params.prev.length && !params.decontextualized) {
    payload._meta.decontextualization = "none — `prev` was received and ignored. This origin runs no language model, so the query was searched verbatim. Send `decontextualized_query` to resolve a follow-up yourself.";
  }
  return payload;
}

function sseHeaders() {
  return {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-store",
    // Named for the same reason the reference server names it: an intermediary
    // that buffers a stream turns every event into one delivery at the end,
    // which is indistinguishable from a server that never streamed.
    "x-accel-buffering": "no",
    "x-robots-tag": "noindex",
  };
}

/**
 * The two streaming dialects, written out rather than abstracted, because they
 * are two wire formats and the shared structure between them is a coincidence.
 */
function streamAnswer(payload, structured) {
  const encoder = new TextEncoder();
  const frames = [];
  const named = (event, data) => frames.push(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  const plain = (data) => frames.push(`data: ${JSON.stringify(data)}\n\n`);

  if (structured) {
    named("start", { _meta: { version: NLWEB_VERSION, response_type: "answer", mode: payload.mode, site: payload.site }, streaming: true });
    payload.results.forEach((item, index) => named("result", { index, item }));
    named("complete", { _meta: { version: NLWEB_VERSION } });
  } else {
    plain({ message_type: "begin-nlweb-response", conversation_id: payload.query_id, query: payload.query, timestamp: Date.now() });
    if (payload.results.length) plain({ message_type: "result", query_id: payload.query_id, content: payload.results });
    plain({ message_type: "end-nlweb-response", conversation_id: payload.query_id, timestamp: Date.now() });
  }

  // The whole answer is in hand before the first byte: the corpus is a bundled
  // index and the ranking is synchronous, so there is no phase that could
  // arrive later. Streaming is served because the protocol asks for it, and
  // pretending it bought latency here would be theatre.
  return new Response(new ReadableStream({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(frame));
      controller.close();
    },
  }), { status: 200, headers: sseHeaders() });
}

export async function handleAsk(request, env) {
  const url = new URL(request.url);
  if (!["GET", "POST", "HEAD"].includes(request.method)) {
    return jsonResponse({ error: "method not allowed", allow: ["GET", "POST"] }, 405, { allow: "GET, POST, HEAD" });
  }

  let body = null;
  if (request.method === "POST") {
    try { body = await request.json(); }
    catch { return jsonResponse({ error: "POST body must be JSON" }, 400); }
  }

  const parsed = parseAskRequest(url, body);
  if (!parsed.ok) {
    // An SSE client asking a malformed question still gets JSON: the error is
    // about the request never becoming a query, so there is no stream to open.
    return jsonResponse({ ...parsed.error, query_id: null, results: [] }, parsed.status, { "x-robots-tag": "noindex" });
  }

  return span("nlweb.ask", async (s) => {
    const params = parsed.params;
    s.setAttribute("nlweb.mode", params.mode);
    s.setAttribute("nlweb.streaming", params.streaming);
    s.setAttribute("nlweb.dialect", params.structured ? "v0.55" : "legacy");
    if (params.prev.length) s.setAttribute("nlweb.prev_count", params.prev.length);

    const payload = await nlwebAsk(env, params);
    s.setAttribute("nlweb.results", payload.results.length);
    s.setAttribute("nlweb.total", payload.total);

    // A HEAD never negotiates a body, and answering one with an open stream
    // leaves the caller holding a connection for frames that cannot arrive.
    if (request.method === "HEAD") return new Response(null, { status: 200, headers: params.streaming ? sseHeaders() : { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
    if (params.streaming) return streamAnswer(payload, params.structured);
    return jsonResponse(payload, 200, { "x-robots-tag": "noindex" });
  });
}
