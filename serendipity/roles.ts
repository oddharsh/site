// What a person does, read from their Luma bio by Clef.
//
// The roster ranks people by ROLE_TIERS (serendipity.ts), a seniority regex
// that tools/serendipity-role-baseline.ts measured on 2026-09-23 at 64% recall
// and about 90% precision on a held-out hand-labelled sample. Of its 15
// held-out misses, 9 were job functions no tier names (growth, BD, sales, GTM).
// A regex grows one phrasing at a time; a decision model reads "Growth @ Corgi"
// and "runs GTM for a wallet" as the same kind of work without being told
// either string. This module is the request and the parser. Whether it replaces
// the regex is the baseline tool's call, scored on the same labels: on
// 2026-10-31 it got 96% precision and 92% recall on the held-out half, where
// the regex got 83% and 52% (the table is in the tool's header).
//
// The options ARE the baseline's labels, in its order, so a prediction and a
// hand label are compared as equals rather than through a mapping table. They
// name a kind of work rather than a seniority, which is the difference from
// the tiers: the baseline's TIER_FITS has to say which labels each tier is
// right for, and the classifier is simply right or wrong.
//
// Pure apart from askRole's binding call, and node-safe (gotcha 16). The
// baseline tool posts to the Workers AI REST API from a workstation; the
// cron's role pass (classifyRoles in serendipity.ts) uses env.AI through
// askRole and stores one answer per bio, which attendeeScore ranks by.

import { readChoice } from "./event-tags.ts";
import { runClef, type ClefEnv, type ClefModel } from "../src/worker/lib/clef.ts";

// "clef" for the reason event-tags.ts gives: classification quality over
// latency, and this runs on a cron. A bio is short enough that flash's speed
// buys nothing a person would notice either way.
export const ROLE_MODEL: ClefModel = "clef";

// Criteria describe the work, not the words, and each one names the cases the
// regex reads wrong so the model is told where the boundary is. The second
// sentences were tuned on sample positions 0-59 on 2026-10-31, from what Clef
// read wrong there: a company name or a title taken as founding, a fund's
// research partner taken as a researcher, and a banker taken as an investor.
export const ROLE_CRITERIA = Object.freeze({
  founder:
    "Says they started or co-founded a company or project and run it now: founder, cofounder, or building their own company (building @x, building x.com). A title at a company, or a company name alone, is not evidence of founding.",
  investor:
    "Invests as their job: VC, angel, fund GP or partner, or any role at a fund, research partner and analyst included. A founder who also angel invests is a founder; an investment banker or trader is other.",
  operator:
    "Holds a business role at a company without saying they founded it: product, growth, sales, business development, marketing, GTM, partnerships, operations, events, ecosystem, community, developer relations, or a CEO, COO or CPO title, at any level. A one-word function such as Events or Community counts.",
  engineer: "Builds software, hardware or protocols as their job: engineer, developer, engineering manager, designer, CTO, smart contract or ML engineer.",
  researcher: "Does research as their job: academic, ML, cryptography, economics or applied research, including PhD candidates.",
  student: "Is currently a student: undergraduate, master's, or bootcamp, with no other role stated as their main one.",
  creator: "Makes media or culture as their work: writer, podcaster, artist, musician, photographer, filmmaker, content creator or influencer.",
  other:
    "States what they do, and it is none of the roles above: a profession such as law or banking, an account for an event series or a company, or a mission with no role in it.",
  not_stated: "Says nothing about what they do for work: interests, hobbies, a quote, a location, links, or a company or project name with no role.",
});

export type RoleLabel = keyof typeof ROLE_CRITERIA;
export const ROLE_LABELS = Object.freeze(Object.keys(ROLE_CRITERIA)) as readonly RoleLabel[];

// bio_short is short by name, but nothing enforces it. The cap is the event
// tagger's argument (distraction, not room) at a bio's scale.
const BIO_CHARS = 1000;

/** ONE bio per request, for the same reason event-tags.ts gives for one event:
 *  every other bio in the state would be a distractor for this one's question. */
export function buildRoleRequest(bio: string) {
  return {
    model: ROLE_MODEL,
    state: {
      bio: String(bio || "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, BIO_CHARS),
    },
    questions: {
      role: {
        type: "choice",
        instructions:
          "What is this person's main job, judged from their own `bio`? If they name several roles, choose the one they lead with or that reads as their main work, not a side project.",
        criteria: ROLE_CRITERIA,
      },
    },
  };
}

export type RolePrediction = { role: RoleLabel; confidence: number; probabilities: Record<string, number> };

/** A prediction, or null for any response this parser does not understand. */
export function parseRoleAnswer(body: any): RolePrediction | null {
  const r = readChoice(body?.answers?.role, ROLE_LABELS);
  return r ? { role: r.choice, confidence: r.confidence, probabilities: r.probabilities } : null;
}

// Clef's published p95 is 239 ms; the deadline is the tag pass's, for its
// reason: a slow answer is asked again next tick, never waited on.
const ROLE_TIMEOUT_MS = 5000;

/** One call through the shared transport. Never throws, so the pass can count
 *  outcomes by cause. */
export async function askRole(request: ReturnType<typeof buildRoleRequest>, env: ClefEnv): Promise<{ prediction: RolePrediction } | { error: string }> {
  const r = await runClef(env, ROLE_MODEL, request, ROLE_TIMEOUT_MS);
  if ("error" in r) return r;
  const prediction = parseRoleAnswer(r.body);
  return prediction ? { prediction } : { error: "unparseable" };
}

// Created on first use as well as by migration 0005, for EVENT_TAGS_DDL's
// reason, and on one line for the same one. The probabilities are kept so a
// threshold, if one ever earns its place, applies without asking again; on
// 2026-10-31 the best one was none.
export const ATTENDEE_ROLES_DDL =
  "CREATE TABLE IF NOT EXISTS attendee_roles (attendee_id TEXT PRIMARY KEY REFERENCES attendees(id), role TEXT NOT NULL, confidence REAL NOT NULL, probabilities TEXT, model TEXT NOT NULL, input_hash TEXT NOT NULL, classified_at TEXT NOT NULL DEFAULT (datetime('now')))";
