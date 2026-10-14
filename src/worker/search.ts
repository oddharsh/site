import { cachedRender } from "./lib/cache.ts";
import { SEARCH_LIMITS, clampParam } from "./lib/api-limits.ts";
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
  fields: string[];
};

let indexCache: PreparedRecord[] | null = null;

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
    const prepared: PreparedRecord[] = payload.records.map((record: SearchRecord) => ({
      record,
      fields: [record.title, record.description].map((value) => String(value || "").toLowerCase()),
    }));
    indexCache = prepared;
    return prepared;
  } catch {
    return [];
  }
}

const bodyMatchers = (queryTerms: string[]) =>
  queryTerms.map((term) => new RegExp(term.replace(/[.*+?^${}()|[\]\\/-]/g, "\\$&"), "i"));

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

export const SEARCH_TERM_MAX = 13;

export async function searchSiteRanked(env, query: string, limit: string | number | null = SEARCH_LIMITS.limitDefault) {
  const q = String(query || "").trim().slice(0, SEARCH_LIMITS.queryMax);
  const meaningful = queryTermsOf(q).terms;
  const queryTerms = meaningful.length ? meaningful : terms(q);
  const max = clampParam(limit, SEARCH_LIMITS.limitDefault, SEARCH_LIMITS.limitMax);
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
    results: results.slice(0, max).map(({ entry, score }) => ({
      ...entry.record, score, snippet: snippet(entry, queryTerms, matchers),
    })),
  };
}
export async function searchCorpusFor(env, query: string) {
  const q = String(query || "").trim().slice(0, SEARCH_LIMITS.queryMax);
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
