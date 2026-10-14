// Pure apart from the runClef call, and node-safe (gotcha 16).

import { runClef, type ClefEnv, type ClefModel } from "./lib/clef.ts";

export const SORT_MODEL: ClefModel = "clef";
// The sort runs inside the POST's waitUntil, after the source fetch, so nobody
// waits on it. Clef's launch-day latency was bimodal (median 0.7 s, p80
// 10.9 s), and a tail call costs an unsorted email rather than a slow page.
export const SORT_DEADLINE_MS = 6000;

export const SORT_LABELS = ["genuine", "listing", "spam"] as const;
export type SortLabel = typeof SORT_LABELS[number];

export const SORT_CRITERIA: Record<SortLabel, string> = {
  genuine: "A person engaging with the page: a post, reply, comment, like, bookmark, or a newsletter or forum item that says something about it.",
  listing: "A list, directory, webring, feed aggregator or links roundup that includes the page among many with little or no commentary.",
  spam: "Spam: SEO or affiliate filler, scraped or machine-written copy, gambling, pharmacy, crypto promotion, link farms, or comment spam, where the link is incidental.",
};

export type SortInput = { kind?: string, source: string, title?: string, author?: string, excerpt?: string };
export type MentionSort =
  | { verdict: SortLabel, probabilities: Record<SortLabel, number> }
  | { error: string };

function host(source: string): string {
  try { return new URL(source).hostname; } catch { return ""; }
}

export function buildSortRequest(m: SortInput) {
  return {
    model: SORT_MODEL,
    state: {},
    questions: {
      sort: {
        type: "choice",
        instructions: {
          question: "Someone sent a webmention saying this page links to aadhar.sh. Which is it?",
          mention: {
            kind: String(m.kind || "mention"),
            source_host: host(m.source),
            title: String(m.title || "").slice(0, 200),
            author: String(m.author || "").slice(0, 120),
            excerpt: String(m.excerpt || "").slice(0, 400),
          },
        },
        criteria: SORT_CRITERIA,
      },
    },
  };
}

export async function sortMention(env: ClefEnv, m: SortInput): Promise<MentionSort> {
  const r = await runClef(env, SORT_MODEL, buildSortRequest(m), SORT_DEADLINE_MS);
  if ("error" in r) return r;
  const answer = (r.body as any)?.answers?.sort;
  if (!answer || answer.type !== "choice" || !answer.probabilities) return { error: "unparseable" };
  const probabilities = {} as Record<SortLabel, number>;
  for (const label of SORT_LABELS) {
    const p = Number(answer.probabilities[label]);
    if (!Number.isFinite(p) || p < 0 || p > 1) return { error: "unparseable" };
    probabilities[label] = p;
  }
  const verdict = SORT_LABELS.reduce((a, b) => (probabilities[b] > probabilities[a] ? b : a));
  return { verdict, probabilities };
}

export function sortSubjectTag(sort: MentionSort): string {
  if ("error" in sort || sort.verdict === "genuine") return "";
  return sort.verdict === "spam" ? "[likely spam] " : "[listing] ";
}

export function sortLine(sort: MentionSort): string {
  if ("error" in sort) return `Not sorted: Clef answered nothing usable (${sort.error}).`;
  const p = sort.probabilities;
  const rest = SORT_LABELS.filter((l) => l !== sort.verdict).map((l) => `${l} ${p[l].toFixed(2)}`).join(", ");
  return `Clef reads this as ${sort.verdict} (${p[sort.verdict].toFixed(2)}); ${rest}. It only sorts; approving is still yours.`;
}
