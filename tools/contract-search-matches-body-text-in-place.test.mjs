// ── search matches body text in place ────────────────────────────────────────
// src/worker/search.ts used to lowercase every record's body text once per
// isolate and search the copy with includes() and indexOf(). It now searches
// the original with one case-insensitive regex per term, which saved 0.9 ms of
// a cold isolate's prepare. Visitors must not be able to tell: this runs the
// old algorithm beside the real one over the built index and asks for the same
// matches, scores, order and snippets, for a sample of every word the corpus
// contains and for the whole-corpus excerpts /ask's Clef ranking reads.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { _resetSearchIndex, searchCorpusFor, searchSiteRanked, SEARCH_TERM_MAX } from "../src/worker/search.ts";
import { compareCodepoints, queryTerms as queryTermsOf, terms } from "../src/worker/lib/text.ts";

const INDEX = ".build/public/search-index.json";
const built = existsSync(INDEX);

// The algorithm as it stood before 2026-10-09, kept here as the oracle.
function oldPrepare(records) {
  return records.map((record) => ({ record, fields: [record.title, record.description, record.text].map((v) => String(v || "").toLowerCase()) }));
}
function oldSnippet({ record, fields }, queryTerms) {
  const [source, lower] = record.text ? [record.text, fields[2]] : [String(record.description || ""), fields[1]];
  if (!source) return "";
  const first = queryTerms.map((term) => lower.indexOf(term)).filter((n) => n >= 0).sort((a, b) => a - b)[0] ?? 0;
  const start = Math.max(0, first - 70);
  return (start ? "…" : "") + source.slice(start, start + 220).replace(/\s+/g, " ").trim() + (start + 220 < source.length ? "…" : "");
}
const termsFor = (query) => {
  const q = String(query || "").trim().slice(0, 160);
  const meaningful = queryTermsOf(q).terms;
  return meaningful.length ? meaningful : terms(q);
};
function oldRanked(prepared, query) {
  const queryTerms = termsFor(query);
  if (!queryTerms.length) return [];
  return prepared.map((entry) => {
    let score = 0;
    for (const term of queryTerms) {
      if (entry.fields[0].includes(term)) score += 8;
      if (entry.fields[1].includes(term)) score += 4;
      if (entry.fields[2].includes(term)) score += 1;
    }
    return score ? { entry, score } : null;
  }).filter((row) => row !== null).sort((a, b) => b.score - a.score || compareCodepoints(a.entry.record.url, b.entry.record.url))
    .slice(0, 50).map(({ entry, score }) => ({ url: entry.record.url, score, snippet: oldSnippet(entry, queryTerms) }));
}

function setup() {
  const bytes = readFileSync(INDEX);
  const records = JSON.parse(bytes.toString("utf8")).records;
  _resetSearchIndex();
  return { env: { ASSETS: { fetch: async () => new Response(bytes) } }, records, prepared: oldPrepare(records) };
}

// Every 5th distinct word of the corpus (so both cases and every script it
// holds), plus phrases that mix cases, stopwords and several terms.
function queries(records) {
  // terms() reads only a query's first 160 characters, so split the text here.
  const words = [...new Set(records.flatMap((r) => `${r.title} ${r.description} ${r.text}`.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 1)))].sort();
  return [
    ...words.filter((_, i) => i % 5 === 0),
    "Brotli Dictionary", "what does he think about agents", "WebMCP", "zstd brotli dcz", "Classic Chrome bridge", "LWE", "the",
  ];
}

test("search finds the same pages, in the same order, with the same snippets", { skip: !built && "needs a build" }, async () => {
  const { env, records, prepared } = setup();
  const qs = queries(records);
  assert.ok(qs.length > 1000, `only ${qs.length} queries`);
  let compared = 0;
  for (const q of qs) {
    const now = (await searchSiteRanked(env, q, 50)).results.map(({ url, score, snippet }) => ({ url, score, snippet }));
    assert.deepEqual(now, oldRanked(prepared, q), `results differ for ${JSON.stringify(q)}`);
    compared += now.length;
  }
  assert.ok(compared > 5000, `only ${compared} results compared`);
  assert.ok(SEARCH_TERM_MAX === 13);
});

test("/ask's whole-corpus excerpts are the same", { skip: !built && "needs a build" }, async () => {
  const { env, records, prepared } = setup();
  for (const q of queries(records).filter((_, i) => i % 40 === 0)) {
    const queryTerms = termsFor(q);
    const now = (await searchCorpusFor(env, q)).map((r) => r.snippet);
    assert.deepEqual(now, prepared.map((entry) => oldSnippet(entry, queryTerms)), `excerpts differ for ${JSON.stringify(q)}`);
  }
});
