// /ask's ranking, decided by Clef over the WHOLE corpus.
//
// /ask answered from searchSiteRanked: an OR of query terms scored title 8,
// description 4, body 1. That ranks a keyword query well and a question badly,
// in two different ways. It orders paraphrases wrongly ("the codec that comes
// after AV1" put /garage/av2 third), and it cannot find a page that shares no
// word with the question at all ("which bots crawled the site recently" never
// reached /ledger, since "crawled" is not "crawler").
//
// A reranker fixes the first and structurally cannot fix the second, because
// it only reorders what the lexical pass already found. The corpus is small
// enough not to need one: it is 64 records, and a Clef choice question takes
// up to 255 options. So the question asked is "which of these pages best
// answers this", with EVERY page an option, and the probability Clef puts on
// each page is the ranking.
//
// Measured 2026-10-01 on 30 natural-language questions, each with the page
// that should answer it (written by the person building this, so read it as a
// strong signal rather than a benchmark):
//
//   lexical, today                         MRR 0.777   hit@1 22/30
//   Clef reranking the lexical top 10      MRR 0.867   hit@1 26/30
//   Clef choosing across all 64 pages      MRR 0.983   hit@1 29/30
//
// Reranking fixed every query whose page lexical search had found and none of
// the four it had not; the whole-corpus question fixed all four. No query got
// worse. Answers were identical across two runs. One call, about 4,800 input
// tokens, median 1.26 s.
//
// The cost of a model on a public endpoint is bounded three ways, and each
// failure lands on today's lexical ranking with `_meta` saying which ran:
// - ASK_RL, 20 per minute per IP, since a query now spends Workers AI.
// - A deadline. Clef's latency on launch day was bimodal (median 0.7 s, p80
//   10.9 s), so waiting longer mostly adds wait time rather than answers.
// - A corpus past 255 records cannot be one choice question, so the option
//   set is capped at the lexical top MAX_OPTIONS.
//
// Pure apart from the runClef call, and node-safe (gotcha 16).

import { runClef, type ClefEnv, type ClefModel } from "./lib/clef.ts";

export const ASK_MODEL: ClefModel = "clef";
export const ASK_DEADLINE_MS = 2500;
// Clef's limit on options for one choice question.
export const MAX_OPTIONS = 255;
// Pages below this probability are left out unless the lexical pass matched
// them, so a confident answer is not padded with 60 near-zero pages.
export const ASK_FLOOR = 0.02;
export const ASK_BUDGET = { binding: "ASK_RL", max: 20 };

export type RankableRecord = { url: string, title?: string, description?: string };

// What Clef reads about each page: its title, path and description, which the
// measurement used. The body text was left out because 64 bodies is far past
// the one call a query should cost.
function option(record: RankableRecord) {
  return {
    title: String(record.title || "").replace(/^aadhar\.sh\//, ""),
    url: record.url,
    about: String(record.description || "").replace(/\s+/g, " ").trim().slice(0, 200),
  };
}

/** One choice question with every record an option, ids in corpus order. */
export function buildAskRequest(query: string, records: readonly RankableRecord[]) {
  const ids = records.slice(0, MAX_OPTIONS).map((_, i) => `p${i}`);
  const criteria = Object.fromEntries(ids.map((id, i) => [id, option(records[i])]));
  return {
    request: {
      model: ASK_MODEL,
      state: { question: String(query || "").slice(0, 500) },
      questions: { best: { type: "choice", instructions: "Which page on this site best answers the visitor's question?", criteria } },
    },
    ids,
  };
}

/** The probability Clef put on each url, or the reason there is none. */
export async function clefRank(env: ClefEnv, query: string, records: readonly RankableRecord[]):
  Promise<{ probabilities: Map<string, number> } | { error: string }> {
  if (records.length < 2) return { error: "fewer than two pages to choose between" };
  const { request, ids } = buildAskRequest(query, records);
  const r = await runClef(env, ASK_MODEL, request, ASK_DEADLINE_MS);
  if ("error" in r) return r;
  const answer = (r.body as any)?.answers?.best;
  if (!answer || answer.type !== "choice" || !answer.probabilities) return { error: "unparseable" };
  const probabilities = new Map<string, number>();
  ids.forEach((id, i) => {
    const p = Number(answer.probabilities[id]);
    if (Number.isFinite(p) && p >= 0 && p <= 1) probabilities.set(records[i].url, p);
  });
  return probabilities.size ? { probabilities } : { error: "unparseable" };
}
