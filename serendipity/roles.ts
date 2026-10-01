// What a person does, read from their Luma bio by Clef.
//
// The roster ranks people by ROLE_TIERS (serendipity.ts), a seniority regex
// that tools/serendipity-role-baseline.ts measured on 2026-09-23 at 64% recall
// and about 90% precision on a held-out hand-labelled sample. Of its 15
// held-out misses, 9 were job functions no tier names (growth, BD, sales, GTM).
// A regex grows one phrasing at a time; a decision model reads "Growth @ Corgi"
// and "runs GTM for a wallet" as the same kind of work without being told
// either string. This module is the request and the parser. Whether it replaces
// the regex is the baseline tool's call, scored on the same labels.
//
// The options ARE the baseline's labels, in its order, so a prediction and a
// hand label are compared as equals rather than through a mapping table. They
// name a kind of work rather than a seniority, which is the difference from
// the tiers: TIER_FITS has to say which labels each tier is right for, and the
// classifier is simply right or wrong.
//
// Pure and node-safe (gotcha 16). The caller supplies the transport: the
// baseline tool posts to the Workers AI REST API from a workstation, and a
// roster pass in the Worker would use env.AI the way event-tags.ts does.

import { readChoice } from "./event-tags.ts";

// "clef" for the reason event-tags.ts gives: classification quality over
// latency, and this runs offline. A bio is short enough that flash's speed
// buys nothing a person would notice either way.
export const ROLE_MODEL = "clef";

// Criteria describe the work, not the words, and each one names the cases the
// regex reads wrong so the model is told where the boundary is.
export const ROLE_CRITERIA = Object.freeze({
  founder: "Started or co-founded a company or project and runs it now: founder, cofounder, or a bio that says they are building their own company.",
  investor: "Invests as their job: VC, angel, fund GP or partner, or an investing role at a fund. A founder who also angel invests is a founder.",
  operator: "Runs a business function at a company they did not found: product, growth, sales, business development, marketing, GTM, partnerships, operations, community or general management, at any level.",
  engineer: "Builds software, hardware or protocols as their job: engineer, developer, designer, smart contract or ML engineer.",
  researcher: "Does research as their job: academic, ML, cryptography, economics or applied research, including PhD candidates.",
  student: "Is currently a student: undergraduate, master's, or bootcamp, with no other role stated as their main one.",
  creator: "Makes media or culture as their work: writer, podcaster, artist, musician, filmmaker, content creator or influencer.",
  other: "States what they do, and it is none of the roles above.",
  not_stated: "Says nothing about what they do for work: interests, hobbies, a quote, a location or links only.",
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
    state: { bio: String(bio || "").replace(/\s+/g, " ").trim().slice(0, BIO_CHARS) },
    questions: {
      role: {
        type: "choice",
        instructions: "What is this person's main job, judged from their own `bio`? If they name several roles, choose the one they lead with or that reads as their main work, not a side project.",
        criteria: ROLE_CRITERIA,
      },
    },
  };
}

export type RolePrediction = { role: RoleLabel, confidence: number, probabilities: Record<string, number> };

/** A prediction, or null for any response this parser does not understand. */
export function parseRoleAnswer(body: any): RolePrediction | null {
  const r = readChoice(body?.answers?.role, ROLE_LABELS);
  return r ? { role: r.choice, confidence: r.confidence, probabilities: r.probabilities } : null;
}
