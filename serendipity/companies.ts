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
// rules: one bio per request, and the decision whether it goes into the Worker
// left to the baseline tool (tools/serendipity-company-baseline.ts), scored on
// hand labels. It earned that on 2026-10-30, so the cron's company pass
// (extractCompanies in serendipity.ts) stores one answer per bio, the way
// event-tags.ts stores one tag per event, and the roster reads it.
//
// The answer keeps `guess` and `p_null` beside `value`. Clairic nulls a value
// when p_null passes null_threshold (0.5 by default), and keeping both lets
// one run be scored at every threshold instead of one run per threshold.
//
// Pure apart from askClairic's binding call, and node-safe (gotcha 16).

import { asNumber, asText } from "../src/worker/lib/parse.ts";
import { runClef, type ClefEnv, type ClefModel } from "../src/worker/lib/clef.ts";
import { tagInputHash } from "./event-tags.ts";

export const COMPANY_MODEL: ClefModel = "clairic";

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

// The roster shows a company only when Clairic put the chance of "none" at or
// under this. Measured 2026-10-30 on the held-out 60 bios: 0.1 gave 90%
// precision and 85% recall, 0.3 gave 86% and 90%. A wrong company printed under
// a named person costs more than a blank, so the stricter one. Every answer is
// stored with its p_null, so moving this re-reads no bio.
export const COMPANY_MAX_P_NULL = 0.1;

/** sha256 over the whole request, as tagInputHash does for tags: the bio, the
 *  instructions and the model all invalidate a stored answer. */
export const companyInputHash = (request: ReturnType<typeof buildCompanyRequest>) => tagInputHash(request);

// Clairic's measured median was 313 ms; the deadline is CLEF_TIMEOUT_MS's, for
// its reason: a slow answer is asked again next tick, never waited on.
const CLAIRIC_TIMEOUT_MS = 5000;

/** One call through the shared transport. Never throws, so the pass can count
 *  outcomes by cause. */
export async function askClairic(
  request: ReturnType<typeof buildCompanyRequest>,
  env: ClefEnv,
): Promise<{ prediction: CompanyPrediction } | { error: string }> {
  const r = await runClef(env, COMPANY_MODEL, request, CLAIRIC_TIMEOUT_MS);
  if ("error" in r) return r;
  const prediction = parseCompanyAnswer(r.body);
  return prediction ? { prediction } : { error: "unparseable" };
}

// Created on first use as well as by migration 0004, for EVENT_TAGS_DDL's
// reason, and on one line for the same one. `company` is Clairic's guess even
// when p_null is high, so a new threshold applies without asking again.
export const ATTENDEE_COMPANIES_DDL =
  "CREATE TABLE IF NOT EXISTS attendee_companies (attendee_id TEXT PRIMARY KEY REFERENCES attendees(id), company TEXT, p_null REAL NOT NULL, confidence REAL NOT NULL, model TEXT NOT NULL, input_hash TEXT NOT NULL, extracted_at TEXT NOT NULL DEFAULT (datetime('now')))";
