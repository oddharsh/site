// /search — bounded server-side search over the generated public corpus.
// The index is static and loaded only on this route (or by the site MCP tool),
// keeping the homepage critical path free of search bytes and fan-out.
import { cachedRender } from "./lib/cache.ts";
import { lunaPage } from "./lib/chrome.ts";
import { unsafeHtml } from "./lib/html.ts";
import { escAttr, escHtml, jsonResponse, publicJsonHeaders } from "./lib/http.ts";
import { compareCodepoints, queryTerms as queryTermsOf, terms } from "./lib/text.ts";

export type SearchRecord = {
  url: string;
  title: string;
  description: string;
  text: string;
  kind: "page" | "writing" | "document" | "utility";
};

type PreparedRecord = {
  record: SearchRecord;
  // The title and description, lowercased. The body is matched where it is,
  // through bodyMatchers, so it has no lowercase copy.
  fields: string[];
};

let indexCache: PreparedRecord[] | null = null;

// Test seam, never called by the worker, like _resetPhotoCaches in photos.ts.
// The corpus is cached per ISOLATE, which is right in production and becomes
// per-PROCESS under `bun test --no-isolate`: a worker running two files that
// stub different corpora serves the second file the first one's. Found
// 2026-09-29 when /ask's tests read an empty corpus after new test files
// reshuffled which files share a worker.
export function _resetSearchIndex() {
  indexCache = null;
}

async function getSearchIndex(env): Promise<PreparedRecord[]> {
  if (indexCache) return indexCache;
  try {
    const response = await env.ASSETS.fetch("https://assets.local/search-index.json");
    if (!response.ok) return [];
    const payload = await response.json();
    if (!payload || !Array.isArray(payload.records)) return [];
    // The complete corpus is immutable for this Worker version. Normalize its
    // scoring fields once, after the lazy read, rather than allocating and
    // lowercasing every article for every query. Keep only completed data here:
    // an in-flight ASSETS promise belongs to the request that started it.
    //
    // Lowercasing the title and description is the only per-record pass. A
    // whitespace collapse used to run here too, on text the generator already
    // collapsed, and it was the most expensive line on the route: `\s+` matches
    // every single space, so it rebuilt all 590 KB of body text, 5.6-6.9ms of a
    // cold isolate's CPU (2026-10-07). snippet() collapses the 220 characters it
    // returns instead.
    //
    // The body text isn't lowercased either. It's 686 KB of the index's 705 KB
    // (63 records, 2026-10-09), and lowercasing it took 0.87-0.92 ms of a cold
    // isolate's prepare, against 0.21 ms to search it once lowercased. A
    // case-insensitive regex searches the original in about the same time, so
    // the copy only cost the cold request. bodyMatchers builds those per query.
    const prepared: PreparedRecord[] = payload.records.map((record: SearchRecord) => ({
      record,
      fields: [record.title, record.description].map((value) => String(value || "").toLowerCase()),
    }));
    indexCache = prepared;
    return prepared;
  } catch {
    // A transient read/parse failure must not pin an empty corpus to an isolate.
    return [];
  }
}

// One case-insensitive matcher per query term, for the body text. Terms are
// runs of letters and digits (lib/text.ts), so the escape is a guard against a
// tokenizer that someday lets punctuation through, not something today's terms
// need.
const bodyMatchers = (queryTerms: string[]) =>
  queryTerms.map((term) => new RegExp(term.replace(/[.*+?^${}()|[\]\\/-]/g, "\\$&"), "i"));

// The excerpt comes from the body, or the description when a record has none,
// starting near the first query term it contains. The body is searched with
// the query's matchers, so the position is the original text's own.
function snippet({ record, fields }: PreparedRecord, queryTerms: string[], matchers: RegExp[]) {
  const source = record.text || String(record.description || "");
  if (!source) return "";
  const at = record.text
    ? matchers.map((re) => source.search(re))
    : queryTerms.map((term) => fields[1].indexOf(term));
  const first = at.filter((n) => n >= 0).sort((a, b) => a - b)[0] ?? 0;
  const start = Math.max(0, first - 70);
  return (start ? "…" : "") + source.slice(start, start + 220).replace(/\s+/g, " ").trim() + (start + 220 < source.length ? "…" : "");
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
  // Before the index read: a query with no terms answers nothing either way,
  // and reading it first charged an empty MCP search the whole cold prepare.
  if (!queryTerms.length) return { query: q, terms: [], total: 0, returned: 0, results: [] };
  const records = await getSearchIndex(env);
  const matchers = bodyMatchers(queryTerms);
  const results = records.map((entry) => {
    const { record, fields } = entry;
    let score = 0;
    for (let i = 0; i < queryTerms.length; i++) {
      const term = queryTerms[i];
      if (fields[0].includes(term)) score += 8;
      if (fields[1].includes(term)) score += 4;
      if (record.text && matchers[i].test(record.text)) score += 1;
    }
    return score ? { entry, score } : null;
  }).filter((row) => row !== null).sort((a, b) => b.score - a.score || compareCodepoints(a.entry.record.url, b.entry.record.url));
  return {
    query: q,
    terms: queryTerms,
    total: results.length,
    returned: Math.min(max, results.length),
    // Only returned rows need an excerpt. Broad queries can match the whole
    // corpus, while the caller asks for as few as one result.
    results: results.slice(0, max).map(({ entry, score }) => ({
      ...entry.record, score, snippet: snippet(entry, queryTerms, matchers),
    })),
  };
}
/**
 * The whole corpus as excerpt-ready records, for /ask's Clef ranking, which
 * chooses across every page rather than reordering the lexical matches
 * (ask-rank.ts has the measurement). Each record carries the snippet the
 * lexical pass would have shown for this query, so a page Clef found without a
 * matching word still reads the same way in the answer.
 */
export async function searchCorpusFor(env, query: string) {
  const q = String(query || "").trim().slice(0, 160);
  const meaningful = queryTermsOf(q).terms;
  const queryTerms = meaningful.length ? meaningful : terms(q);
  const records = await getSearchIndex(env);
  const matchers = bodyMatchers(queryTerms);
  return records.map((entry) => ({ ...entry.record, snippet: snippet(entry, queryTerms, matchers) }));
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
  if (!query.trim()) return jsonResponse({ ok: false, error: "q is required", results: [] }, 400, { ...publicJsonHeaders(400), "x-robots-tag": "noindex" }, { pretty: false });
  const payload = await searchSite(env, query, url.searchParams.get("limit"));
  return jsonResponse(payload, 200, { ...publicJsonHeaders(200), "x-robots-tag": "noindex" }, { pretty: false });
}

export async function handleSearch(request, env, ctx) {
  const url = new URL(request.url);
  const query = url.searchParams.get("q") || "";
  const results = query.trim() ? await searchSite(env, query, url.searchParams.get("limit")) : { query: "", total: 0, returned: 0, results: [] };
  const render = () => renderSearchPage(query, results);
  // Query-specific HTML must never share the blank/search result cache key.
  return query.trim() ? render() : cachedRender(request, ctx, render, "/search", env);
}

export function renderSearchPage(query = "", results: Awaited<ReturnType<typeof searchSite>> = { query: "", total: 0, returned: 0, results: [] }) {
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
    css: `/*min*/.search-form{display:flex;align-items:end;gap:7px;margin:12px 0}.search-form label{display:grid;gap:3px;flex:1;color:var(--ink-quiet);font-size:var(--text-xs)}.search-form input{font:var(--text-ui) var(--font-ui);padding:5px 7px;border:1px solid oklch(55% .04 250);box-shadow:inset 1px 1px 2px var(--grey-70)}.search-form button{font:var(--text-xs) var(--font-ui);padding:5px 12px}.summary,.hint{color:var(--grey-48);font-size:var(--text-xs)}.results{padding-left:22px}.results li{padding:7px 0;border-bottom:1px solid var(--slate-88)}.results a{color:oklch(40% .13 255);text-decoration:none}.results a:hover{text-decoration:underline}.results small{display:block;color:oklch(55% 0 0);font:var(--text-2xs) var(--font-mono)}.results p{margin:3px 0 0;color:oklch(35% .02 255);font-size:var(--text-xs)}`,
    body: unsafeHtml(body),
  });
}
