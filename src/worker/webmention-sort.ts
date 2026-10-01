// A pre-sort for the webmention moderation email, decided by Cloudflare's Clef.
//
// Verification proves a source really links here. It cannot say whether the
// page doing the linking is a person writing about this site, a list that
// includes it among hundreds, or spam whose link is incidental, and that is the
// call the approve/decline email asks the host to make. So the email now
// arrives already sorted: one Clef `choice` over those three, its probabilities
// in the body, and a subject tag when the top choice is not "genuine".
//
// It LABELS and never decides. Approval stays a signed link only the host can
// follow, nothing is declined or withheld on Clef's word, and a failed sort
// sends the same email with a line saying it was not sorted.
//
// Measured 2026-10-01 before building, because the production table held no
// mentions yet: 20 source pages written to resemble the traffic this endpoint
// will see (8 genuine, from a blog post and a Bridgy reply to a bare Bridgy
// like; 4 listings; 8 spam, from casino SEO to a scraped copy of this site),
// each run through the real parseSource so Clef read exactly these fields.
//
//   excerpt + metadata (shipped)     3-way 19/20, spam at 0.5: 7 of 8, 0 false
//   + the first 600 chars of page    18/20, same spam count, 35% more tokens
//   without the source host          19/20, spam 6 of 8
//
// No genuine mention was called spam in any of those three, which is the costly
// direction. The one consistent miss is a scraped copy of this site's own
// prose: an excerpt of my words reads like someone discussing them, and Clef
// cannot see that the page around it is a content farm. The verdicts were
// identical across two runs, median 0.69 s, about 330 input tokens.
// `bun run webmention:eval` is that measurement, committed.
//
// The host matters, and only one way. Swapping a casino page's host for
// github.com left it spam at 0.97, while giving a real blog post a casino's
// host pulled it to 0.87 spam (`bun run webmention:eval -- --swap`). A
// suspicious domain can push a verdict toward spam and a respectable one cannot
// launder spam, which is the argument for a label a person reads rather than an
// action a person never sees.
//
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

/** The fields parseSource already produced, plus the source's host. The page
 *  body is left out on purpose: the measurement above found it bought nothing. */
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
  // The top probability rather than `answer.choice`, so the verdict and the
  // numbers printed beside it can never disagree.
  const verdict = SORT_LABELS.reduce((a, b) => (probabilities[b] > probabilities[a] ? b : a));
  return { verdict, probabilities };
}

/** A prefix for the email subject, empty for a genuine mention so the common
 *  case reads exactly as it did before. */
export function sortSubjectTag(sort: MentionSort): string {
  if ("error" in sort || sort.verdict === "genuine") return "";
  return sort.verdict === "spam" ? "[likely spam] " : "[listing] ";
}

/** One sentence for the email body. A failure says so, rather than reading as a
 *  clean bill of health. */
export function sortLine(sort: MentionSort): string {
  if ("error" in sort) return `Not sorted: Clef answered nothing usable (${sort.error}).`;
  const p = sort.probabilities;
  const rest = SORT_LABELS.filter((l) => l !== sort.verdict).map((l) => `${l} ${p[l].toFixed(2)}`).join(", ");
  return `Clef reads this as ${sort.verdict} (${p[sort.verdict].toFixed(2)}); ${rest}. It only sorts; approving is still yours.`;
}
