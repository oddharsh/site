// Pure apart from the runClef call, and node-safe (gotcha 16).

import { runClef, type ClefEnv, type ClefModel } from "./lib/clef.ts";

export const ASK_MODEL: ClefModel = "clef";
export const ASK_DEADLINE_MS = 2500;
// Clef's limit on options for one choice question.
export const MAX_OPTIONS = 255;
export const ASK_FLOOR = 0.02;
export const ASK_BUDGET = { binding: "ASK_RL", max: 20 };

export type RankableRecord = { url: string, title?: string, description?: string };

function option(record: RankableRecord) {
  return {
    title: String(record.title || "").replace(/^aadhar\.sh\//, ""),
    url: record.url,
    about: String(record.description || "").replace(/\s+/g, " ").trim().slice(0, 200),
  };
}

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
