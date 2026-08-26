// /search — bounded server-side search over the generated public corpus.
// The index is static and loaded only on this route (or by the site MCP tool),
// keeping the homepage critical path free of search bytes and fan-out.
import { cachedRender } from "./lib/cache.ts";
import { lunaPage } from "./lib/chrome.ts";
import { unsafeHtml } from "./lib/html.ts";
import { escAttr, escHtml, jsonResp } from "./lib/http.ts";
import { queryTerms as queryTermsOf, terms } from "./lib/text.ts";

let indexCache = null;

async function getSearchIndex(env) {
  if (indexCache) return indexCache;
  try {
    const response = await env.ASSETS.fetch("https://assets.local/search-index.json");
    if (!response.ok) return { records: [] };
    const payload = await response.json();
    indexCache = payload && Array.isArray(payload.records) ? payload : { records: [] };
  } catch {
    indexCache = { records: [] };
  }
  return indexCache;
}

function snippet(text, queryTerms) {
  const source = String(text || "").replace(/\s+/g, " ").trim();
  if (!source) return "";
  const first = queryTerms.map((term) => source.toLowerCase().indexOf(term)).filter((n) => n >= 0).sort((a, b) => a - b)[0] ?? 0;
  const start = Math.max(0, first - 70);
  return (start ? "…" : "") + source.slice(start, start + 220).trim() + (start + 220 < source.length ? "…" : "");
}

// The per-term ceiling: a term that hits the title, the description AND the
// body scores 8 + 4 + 1. Exported because a raw additive score is meaningless
// without it — /ask reports NLWeb's `score` as a percentage of what the query
// could possibly have scored, and that denominator is terms x this.
export const SEARCH_TERM_MAX = 13;

/**
 * The ranking pass, with the score and the terms it was scored against still
 * attached. searchSite drops both, correctly: its two callers render a list for
 * a human, and "39" tells a reader nothing. /ask cannot drop them, because
 * NLWeb's result contract carries a `score` and a relevance number is only
 * honest when you can say what its ceiling was.
 *
 */
export async function searchSiteRanked(env, query: string, limit: string | number | null = 20) {
  const q = String(query || "").trim().slice(0, 160);
  // Agents ask this in sentences ("what does he think about agents"), and every
  // stopword in one scores against the body text of nearly every page at +1.
  // Enough of them and the ranking is decided by which page is longest. Terms
  // survive if dropping them would leave nothing to search on.
  const meaningful = queryTermsOf(q).terms;
  const queryTerms = meaningful.length ? meaningful : terms(q);
  const max = Math.min(50, Math.max(1, Number(limit) || 20));
  const records = (await getSearchIndex(env)).records || [];
  if (!queryTerms.length) return { query: q, terms: [], total: 0, returned: 0, results: [] };
  const results = records.map((record) => {
    const title = String(record.title || "");
    const description = String(record.description || "");
    const text = String(record.text || "");
    const fields = [title, description, text].map((value) => value.toLowerCase());
    let score = 0;
    for (const term of queryTerms) {
      if (fields[0].includes(term)) score += 8;
      if (fields[1].includes(term)) score += 4;
      if (fields[2].includes(term)) score += 1;
    }
    return score ? { ...record, score, snippet: snippet(text || description, queryTerms) } : null;
  }).filter(Boolean).sort((a, b) => b.score - a.score || a.url.localeCompare(b.url));
  return {
    query: q,
    terms: queryTerms,
    total: results.length,
    returned: Math.min(max, results.length),
    results: results.slice(0, max),
  };
}
export async function searchSite(env, query: string, limit: string | number | null = 20) {
  const ranked = await searchSiteRanked(env, query, limit);
  return {
    query: ranked.query,
    total: ranked.total,
    returned: ranked.returned,
    results: ranked.results.map(({ url, title, description, kind, snippet: excerpt }) => ({ url, title, description, kind, snippet: excerpt })),
  };
}

export async function handleSearchJson(request, env) {
  const url = new URL(request.url);
  const query = url.searchParams.get("q") || "";
  if (!query.trim()) return jsonResp({ ok: false, error: "q is required", results: [] }, 400);
  const payload = await searchSite(env, query, url.searchParams.get("limit"));
  const response = jsonResp(payload);
  response.headers.set("x-robots-tag", "noindex");
  return response;
}

export async function handleSearch(request, env, ctx) {
  const url = new URL(request.url);
  const query = url.searchParams.get("q") || "";
  const results = query.trim() ? await searchSite(env, query, url.searchParams.get("limit")) : { query: "", total: 0, returned: 0, results: [] };
  const render = () => renderSearchPage(query, results);
  // Query-specific HTML must never share the blank/search result cache key.
  return query.trim() ? render() : cachedRender(request, ctx, render, "/search", env);
}

export function renderSearchPage(query = "", results = { query: "", total: 0, returned: 0, results: [] }) {
  const rows = results.results.map((result) => `<li><a href="${escAttr(result.url)}"><b>${escHtml(result.title)}</b></a><small>${escHtml(result.kind)} · ${escHtml(result.url)}</small><p>${escHtml(result.snippet || result.description)}</p></li>`).join("\n");
  const body = `<h1>Search aadhar.sh</h1>
<form method="get" action="/search" class="search-form"><label for="search-q">Find something</label><input id="search-q" name="q" value="${escAttr(query)}" maxlength="160" autofocus title="Titles and body text across every public page here. One word usually beats a sentence."><button type="submit">Search</button></form>
${query.trim() ? `<p class="summary">${results.total} result${results.total === 1 ? "" : "s"} for <b>${escHtml(query)}</b>.</p>${rows ? `<ol class="results">${rows}</ol>` : "<p>No matching public page.</p>"}` : "<p class=\"hint\">Search the public pages, writing, garage notes, and utility descriptions.</p>"}`;
  return lunaPage({
    title: "aadhar.sh/search",
    path: "aadhar.sh/search",
    route: "/search",
    width: 760,
    description: "Search the public pages and writing on aadhar.sh.",
    robots: "noindex",
    css: `.search-form{display:flex;align-items:end;gap:7px;margin:12px 0}.search-form label{display:grid;gap:3px;flex:1;color:oklch(43% 0 0);font-size:9pt}.search-form input{font:10pt Tahoma,Verdana,sans-serif;padding:5px 7px;border:1px solid oklch(55% .04 250);box-shadow:inset 1px 1px 2px #999}.search-form button{font:9pt Tahoma,Verdana,sans-serif;padding:5px 12px}.summary,.hint{color:oklch(47% 0 0);font-size:9pt}.results{padding-left:22px}.results li{padding:7px 0;border-bottom:1px solid oklch(88% .02 250)}.results a{color:oklch(40% .13 255);text-decoration:none}.results a:hover{text-decoration:underline}.results small{display:block;color:oklch(55% 0 0);font:8pt "Courier New",monospace}.results p{margin:3px 0 0;color:oklch(35% .02 255);font-size:9pt}`,
    body: unsafeHtml(body),
  });
}
