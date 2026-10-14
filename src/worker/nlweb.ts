// The reference implementation picks between them exactly this way: a `query`
// that arrives as an OBJECT flags the structured request and sets the protocol
// version to 0.55. Nothing else does. So a header, an Accept, or a query
// parameter cannot select v0.55, and a server that emits named events to a
// legacy GET is talking to nobody. Read at microsoft/NLWeb b423f15d
// (2026-06-10), where the same function also defaults streaming to "True":
// https://github.com/microsoft/NLWeb/blob/b423f15d9aeaa023ce75993ac9deed2354597043/AskAgent/python/webserver/routes/api.py#L49-L82
import { CANONICAL_HOST } from "./lib/const.ts";
import { ASK_LIMITS } from "./lib/api-limits.ts";
import { jsonResponse } from "./lib/http.ts";
import { asRecord } from "./lib/parse.ts";
import { span } from "./lib/trace.ts";
import { SEARCH_TERM_MAX, searchCorpusFor, searchSiteRanked } from "./search.ts";
import { ASK_BUDGET, ASK_DEADLINE_MS, ASK_FLOOR, MAX_OPTIONS, clefRank } from "./ask-rank.ts";
import { overBudget } from "./lib/ratelimit.ts";

export const NLWEB_VERSION = "0.55";
export const NLWEB_SITE = CANONICAL_HOST;
const SITE_TOKENS = new Set(["", "all", CANONICAL_HOST, "aadhar.sh", "https://aadhar.sh"]);
export const NLWEB_MODES = { supported: ["list"], known: ["list", "summarize", "generate"] };
const MAX_RESULTS = ASK_LIMITS.topKMax;
const DEFAULT_RESULTS = ASK_LIMITS.topKDefault;

const SCHEMA_TYPE = { page: "WebPage", writing: "BlogPosting", document: "DigitalDocument", utility: "WebAPI" };
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

export function askRelevance(raw, termCount) {
  const ceiling = Math.max(1, termCount) * SEARCH_TERM_MAX;
  return Math.max(1, Math.min(100, Math.round((raw / ceiling) * 100)));
}

export function parseAskRequest(url, body): { ok: true, params: any } | { ok: false, status: number, error: any } {
  const q = url.searchParams;
  const flat = asRecord(body) || {};
  let structured = false;

  let query = flat.query ?? q.get("query");
  let site = flat.site ?? q.get("site");
  let prev = flat.prev ?? q.get("prev");
  let mode = flat.mode ?? q.get("mode");
  let streamingRaw = flat.streaming ?? q.get("streaming");
  let queryId = flat.query_id ?? q.get("query_id");
  let decontextualized = flat.decontextualized_query ?? q.get("decontextualized_query");

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
          ? `mode "${modeToken}" needs a generative model and this origin runs none (Clef, which ranks the list, can only choose, never write). It is refused rather than answered as "list", because a summary you did not get is worse than a summary you were told you cannot have.`
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

  const prevList = (Array.isArray(prev) ? prev : String(prev ?? "").split(","))
    .map((s) => String(s).trim()).filter(Boolean).slice(0, ASK_LIMITS.prevMax);

  const searched = String(decontextualized ?? "").trim() || text;
  const limitRaw = Number(flat.top_k ?? q.get("top_k") ?? q.get("limit"));
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(MAX_RESULTS, Math.trunc(limitRaw)) : DEFAULT_RESULTS;

  return {
    ok: true,
    params: {
      query: text,
      searched,
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

const FALLBACK = {
  "no AI binding": "lexical: no Workers AI binding here",
  "rate limited": `lexical: this caller passed ${ASK_BUDGET.max} Clef-ranked questions in the last minute`,
  timeout: `lexical: Clef did not answer within ${ASK_DEADLINE_MS / 1000} s`,
};

type CorpusRow = Awaited<ReturnType<typeof searchCorpusFor>>[number];
type ClefRanking = { kept: CorpusRow[], p: (url: string) => number } | { fallback: string };

async function clefRanked(env, params, request, lexical): Promise<ClefRanking> {
  if (!env?.AI) return { fallback: "no AI binding" };
  if (request && await overBudget(ASK_BUDGET, request, env)) return { fallback: "rate limited" };
  const lexRank = new Map<string, number>(lexical.results.map((r, i) => [r.url, i]));
  const lexAt = (url: string) => lexRank.get(url) ?? Infinity;
  let corpus = await searchCorpusFor(env, params.searched);
  if (corpus.length > MAX_OPTIONS) corpus = [...corpus].sort((a, b) => lexAt(a.url) - lexAt(b.url)).slice(0, MAX_OPTIONS);
  const ranked = await clefRank(env, params.searched, corpus);
  if ("error" in ranked) return { fallback: ranked.error };
  const p = (url: string) => ranked.probabilities.get(url) ?? 0;
  const kept = corpus
    .filter((r) => p(r.url) >= ASK_FLOOR || lexRank.has(r.url))
    .sort((a, b) => p(b.url) - p(a.url) || lexAt(a.url) - lexAt(b.url));
  return { kept, p };
}

export async function nlwebAsk(env, params, request: Request | null = null) {
  const limit = Math.min(50, Math.max(1, Number(params.limit) || 20));
  const lexical = await searchSiteRanked(env, params.searched, 50);
  const clef = await clefRanked(env, params, request, lexical);
  const byClef = "kept" in clef;
  const nlwebResult = (record, score: number) => ({
    url: absolute(record.url),
    name: String(record.title || ""),
    site: NLWEB_SITE,
    score,
    description: String(record.snippet || record.description || ""),
    schema_object: askSchemaObject(record),
  });
  const results = "kept" in clef
    ? clef.kept.slice(0, limit).map((record) => nlwebResult(record, Math.round(clef.p(record.url) * 100)))
    : lexical.results.slice(0, limit).map((record) => nlwebResult(record, askRelevance(record.score, lexical.terms.length)));
  const total = "kept" in clef ? clef.kept.length : lexical.total;
  const ranking = "kept" in clef ? "clef" : (FALLBACK[clef.fallback] || `lexical: Clef answered nothing usable (${clef.fallback})`);

  const responseMeta: {
    version: string;
    dialect: string;
    retrieval: string;
    ranking: string;
    description: string;
    score: string;
    modes_supported: string[];
    decontextualization?: string;
  } = {
    version: NLWEB_VERSION,
    dialect: params.structured ? "0.55" : "legacy",
    retrieval: byClef ? "every page, chosen by Clef" : "lexical",
    ranking,
    description: "extractive",
    score: byClef
      ? "0-100, the probability Clef puts on this page being the best answer, as a percentage; the results sum to at most 100"
      : `0-100, relevance as a percentage of the maximum a ${lexical.terms.length}-term query could score`,
    modes_supported: NLWEB_MODES.supported,
  };
  const payload = {
    query_id: params.queryId,
    query: params.query,
    site: NLWEB_SITE,
    mode: params.mode,
    decontextualized_query: params.searched,
    total,
    results,
    _meta: responseMeta,
  };

  if (params.prev.length && !params.decontextualized) {
    payload._meta.decontextualization = "none — `prev` was received and ignored. This origin runs no generative model, so the query was searched verbatim. Send `decontextualized_query` to resolve a follow-up yourself.";
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
    return jsonResponse({ ...parsed.error, query_id: null, results: [] }, parsed.status, { "x-robots-tag": "noindex" });
  }

  return span("nlweb.ask", async (s) => {
    const params = parsed.params;
    s.setAttribute("nlweb.mode", params.mode);
    s.setAttribute("nlweb.streaming", params.streaming);
    s.setAttribute("nlweb.dialect", params.structured ? "v0.55" : "legacy");
    if (params.prev.length) s.setAttribute("nlweb.prev_count", params.prev.length);

    const payload = await nlwebAsk(env, params, request);
    s.setAttribute("nlweb.ranking", payload._meta.ranking);
    s.setAttribute("nlweb.results", payload.results.length);
    s.setAttribute("nlweb.total", payload.total);

    if (request.method === "HEAD") return new Response(null, { status: 200, headers: params.streaming ? sseHeaders() : { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
    if (params.streaming) return streamAnswer(payload, params.structured);
    return jsonResponse(payload, 200, { "x-robots-tag": "noindex" });
  });
}
