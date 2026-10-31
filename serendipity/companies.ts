// Where a person works, read from their Luma bio by Cloudflare's Clairic.
//
// The enrichments table has a `company` column that 15 of 19,733 people had
// filled on 2026-09-23, while 5,116 had a bio, and most bios that name a
// company name it outright ("Growth @ Corgi", "CTO of Sogni.ai"). Clairic is an
// extraction model: it answers a typed field with a SPAN of the text it was
// given, or null when the text does not say, so an answer is the bio's own
// spelling or nothing. That replaces the "unknown"/"n/a" filtering that
// parseStructured needs for a generated reply.
//
// The question is the same kind roles.ts asks Clef, so it follows the same
// rules: one bio per request, the transport supplied by the caller, and the
// decision whether this goes into the Worker left to the baseline tool
// (tools/serendipity-company-baseline.ts), scored on hand labels.
//
// The answer keeps `guess` and `p_null` beside `value`. Clairic nulls a value
// when p_null passes null_threshold (0.5 by default), and keeping both lets
// one run be scored at every threshold instead of one run per threshold.
//
// Pure and node-safe (gotcha 16).

import { asNumber, asText } from "../src/worker/lib/parse.ts";

export const COMPANY_MODEL = "clairic";

// The instructions name the cases the first pass on sample positions 0-59 read
// wrong, so the model is told where the boundary is: a title or a verb glued to
// the name ("Growth @ Corgi", "Building Share" came back whole), and a past
// employer chosen over the current one ("Votre | ex Coinbase" gave Coinbase).
// That pass also kept bios' line breaks: collapsing them fused "building
// @Macroscope" with the next line into "Macroscope Creative".
export const COMPANY_INSTRUCTIONS =
  "The name of the company, fund, project, DAO, school or other organization this person works at, runs or studies at now. Only the name, as written: no job title, no @, no leading verb such as building, and no description after it. If they name several current ones, the first. Never a past one marked ex-, prev or formerly. Null when the bio names no current organization.";

// The cap roles.ts gives a bio, for its reason: distraction, not room.
const BIO_CHARS = 1000;

/** ONE bio per request, as in roles.ts. */
export function buildCompanyRequest(bio: string) {
  return {
    model: COMPANY_MODEL,
    state: String(bio || "")
      .replace(/[ \t]+/g, " ")
      .replace(/\s*\n\s*/g, "\n")
      .trim()
      .slice(0, BIO_CHARS),
    fields: { company: { type: "text", instructions: COMPANY_INSTRUCTIONS } },
  };
}

export type CompanyPrediction = { company: string | null; guess: string | null; pNull: number; confidence: number };

/** A prediction, or null for any response this parser does not understand.
 *  `company` is Clairic's own null-thresholded value; `guess` is the span it
 *  would have given, which companyAt() reads at other thresholds. */
export function parseCompanyAnswer(body: any): CompanyPrediction | null {
  const a = body?.answers?.company;
  if (!a || a.type !== "text") return null;
  const pNull = asNumber(a.p_null);
  const confidence = asNumber(a.confidence);
  if (pNull === null || pNull < 0 || pNull > 1 || confidence === null) return null;
  return { company: asText(a.value), guess: asText(a.guess), pNull, confidence };
}

/** The company at a stricter or looser null threshold than the one the call
 *  used: the guess when the chance of "none" is at or below `threshold`. */
export function companyAt(p: CompanyPrediction, threshold: number): string | null {
  return p.pNull <= threshold ? p.guess : null;
}
