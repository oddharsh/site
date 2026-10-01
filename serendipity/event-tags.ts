// Event tags for the Serendipity pool, decided by Cloudflare's Clef.
//
// Clef is a decision model: it takes a state and typed questions and returns
// typed answers with calibrated probabilities. It can never answer outside the
// options below, so there is no string to parse and no label to validate
// against a list the model might have ignored. It speaks TypeSafe's System One
// API byte for byte, which is why this file was TypeSafe's Jev until
// 2026-10-01: the request and the answers did not change, only the door. Clef
// runs on Workers AI through the AI binding, so the TYPESAFE_API_KEY secret
// and the gateway's `custom-typesafe` provider both left with Jev.
//
// It is NOT promised to be deterministic, and it is also NOT pinnable: Workers
// AI names the model `@cf/cloudflare/clef` with no version, where Jev offered
// `jev-1.13.0`. So the determinism lives here rather than in the model. A tag
// is decided ONCE, stored in D1 beside the hash of the exact request that
// produced it, and asked again only when that hash moves: the event text
// changed, the taxonomy below changed, or TAG_MODEL did. Every read serves the
// stored answer, so two readers of one event can never see two tags. What the
// missing pin costs is narrower than it sounds: a weight update Cloudflare
// ships changes the answers for events asked AFTER it, and leaves every stored
// tag alone. The row keeps the `model` string the answer came back with, which
// is where a version would show if Workers AI ever reports one.
//
// Pure except for askClef's binding call, and node-safe, because the contract
// suite imports it outside workerd (gotcha 16).

import { asNumber, asText } from "../src/worker/lib/parse.ts";
import { runClef, type ClefEnv, type ClefModel } from "../src/worker/lib/clef.ts";

// "clef" rather than "clef-flash", on the benchmarks closest to this job.
// Topic and format are intent classification over short text, and on the two
// intent sets Cloudflare published Clef scores 94.2 and 97.4 macro-F1 where
// flash scores 90.9 and 66.8 (BANKING77, CLINC150+OOS; the second is the one
// with an out-of-scope class, which is what `other` is here). Flash's win is
// latency, 39ms median against 209ms, and this runs on a cron where nobody
// waits. Moving this string re-tags the whole pool, since it is part of every
// input hash; the move from `jev-1.13.0` did exactly that, once.
export const TAG_MODEL: ClefModel = "clef";

// ── the taxonomy ─────────────────────────────────────────────────────────────
// Two Choice questions, both objective, both with a no-match option so the
// model can say nothing fits instead of forcing the nearest wrong label.
// Topic is what the event is ABOUT and format is what you would be DOING there,
// which keeps the two independent: a crypto dinner is topic crypto, format meal.
// Criteria describe situations rather than keywords, because a decision model
// reads literally and an event that says "AI" once in a sponsor line is not an
// AI event.
export const TOPIC_CRITERIA = Object.freeze({
  crypto: "Crypto, blockchains, web3, DeFi, stablecoins, tokens, onchain apps, or the people and funds building them.",
  ai: "Artificial intelligence as the main subject: models, agents, ML research, AI products or AI infrastructure.",
  fintech: "Financial technology that is not primarily crypto: payments, banking, lending, insurance, trading platforms.",
  devtools: "Software engineering as the subject: developer tools, programming languages, open source, cloud and infrastructure.",
  bio: "Biotech, life sciences, healthcare, medicine or health technology.",
  climate: "Climate, energy, sustainability or clean technology.",
  hardware: "Hardware, robotics, devices, manufacturing, aerospace or defense technology.",
  consumer: "Consumer products, media, creators, gaming, commerce or social apps.",
  startups: "Startups, founders, fundraising or venture capital in general, with no single sector above as the focus.",
  culture: "Not about technology or business: arts, music, fitness, food, sports, community or purely social gatherings.",
  other: "None of the other topics describes what this event is about.",
});

export const FORMAT_CRITERIA = Object.freeze({
  talks: "Attendees mostly listen: talks, a panel, a fireside chat, a lecture or a single presentation.",
  conference: "A multi-session conference, summit or festival with several talks, tracks or stages.",
  hackathon: "A hackathon or build sprint where attendees make projects, often judged.",
  demo: "A demo day or pitch event where companies or projects present to an audience or judges.",
  workshop: "A hands-on workshop, class or tutorial where attendees work through material themselves.",
  meal: "A seated meal: dinner, lunch, brunch or breakfast, usually small and by invitation.",
  social: "A happy hour, party, mixer or other standing social gathering with no program.",
  meetup: "A recurring or community meetup mixing short talks with open socializing.",
  other: "None of the other formats describes this event.",
});

export type EventTopic = keyof typeof TOPIC_CRITERIA;
export type EventFormat = keyof typeof FORMAT_CRITERIA;
export const EVENT_TOPICS = Object.freeze(Object.keys(TOPIC_CRITERIA)) as readonly EventTopic[];
export const EVENT_FORMATS = Object.freeze(Object.keys(FORMAT_CRITERIA)) as readonly EventFormat[];

// Below this, a stored tag is kept but does not satisfy a filter, so an event
// the model was unsure about is reported as untagged rather than as the wrong
// topic. Choice confidence is derived from the probability spread, so 0.5 means
// the model put real weight elsewhere. A first guess, and the stored
// probabilities are there to tune it against.
export const TAG_MIN_CONFIDENCE = 0.5;

// Decision-model accuracy falls as the state fills with detail unrelated to the
// question (Jev 1.13's jaggedness notes, "Large state full of irrelevant
// detail"), and Luma descriptions run to sponsor lists and logistics. Clef's
// window is 64k tokens against Jev's 32k, and that does not change this: the
// cut is about distraction, not room. The opening of a description is where an
// event says what it is.
const DESCRIPTION_CHARS = 2000;

export type TagInput = { name: string, description?: string | null, location?: string | null };

/** ONE event per request. Batching several events into one state would save
 *  subrequests and put every other event in front of each question as exactly
 *  the distractor the jaggedness notes warn about, so the batching happens one
 *  level up, as concurrent calls. */
export function buildTagRequest(ev: TagInput) {
  const state: Record<string, string> = { name: String(ev.name || "").trim() };
  const desc = ev.description ? String(ev.description).replace(/\s+/g, " ").trim().slice(0, DESCRIPTION_CHARS) : "";
  if (desc) state.description = desc;
  const loc = ev.location ? String(ev.location).trim() : "";
  if (loc) state.location = loc;
  return {
    model: TAG_MODEL,
    state,
    questions: {
      topic: {
        type: "choice",
        instructions: "What is this event mainly about? Judge the event's own subject from its `name` and `description`, not sponsors, venues or passing mentions.",
        criteria: TOPIC_CRITERIA,
      },
      format: {
        type: "choice",
        instructions: "What kind of event is this, judged by what attendees will spend their time doing?",
        criteria: FORMAT_CRITERIA,
      },
    },
  };
}

/** sha256 over the whole request, so the model, the taxonomy and the event text
 *  all invalidate a stored tag with no version number to remember to bump.
 *  JSON.stringify is stable here because buildTagRequest builds every object in
 *  one fixed key order. */
export async function tagInputHash(request: ReturnType<typeof buildTagRequest>): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(request));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return new Uint8Array(digest).toHex();
}

export type EventTag = {
  topic: EventTopic, topic_confidence: number,
  format: EventFormat, format_confidence: number,
  model: string, probabilities: { topic: Record<string, number>, format: Record<string, number> },
};

function readChoice<K extends string>(answer: any, valid: readonly K[]) {
  if (!answer || answer.type !== "choice" || !valid.includes(answer.choice)) return null;
  const confidence = Number(answer.confidence);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) return null;
  const probabilities: Record<string, number> = {};
  for (const k of valid) {
    const p = asNumber(answer.probabilities?.[k]);
    if (p !== null) probabilities[k] = p;
  }
  return { choice: answer.choice as K, confidence, probabilities };
}

/** A tag, or null for any response shape this parser does not understand. Null
 *  leaves the event untagged and retried next run, which is the honest outcome:
 *  a malformed answer is not evidence the event has no topic. */
export function parseTagAnswers(body: any): EventTag | null {
  const topic = readChoice(body?.answers?.topic, EVENT_TOPICS);
  const format = readChoice(body?.answers?.format, EVENT_FORMATS);
  if (!topic || !format) return null;
  return {
    topic: topic.choice, topic_confidence: topic.confidence,
    format: format.choice, format_confidence: format.confidence,
    model: asText(body.model) || TAG_MODEL,
    probabilities: { topic: topic.probabilities, format: format.probabilities },
  };
}

// Clef's published p95 is 239ms. Five seconds is for a cold isolate or a slow
// gateway, and an answer later than that is retried next tick rather than
// waited on inside a cron invocation.
const CLEF_TIMEOUT_MS = 5000;

export type TagEnv = ClefEnv;

/** One call. Never throws: the caller counts outcomes by cause. The transport
 *  (gateway, deadline, error codes) is src/worker/lib/clef.ts, shared with the
 *  /lens wall check. */
export async function askClef(request: ReturnType<typeof buildTagRequest>, env: TagEnv):
  Promise<{ tag: EventTag } | { error: string }> {
  const r = await runClef(env, TAG_MODEL, request, CLEF_TIMEOUT_MS);
  if ("error" in r) return r;
  const tag = parseTagAnswers(r.body);
  return tag ? { tag } : { error: "unparseable" };
}

// The table is created on first use as well as by migration 0003, because the
// tag pass must not depend on someone having remembered to apply a migration to
// a database this repo has no automated migration step for. ONE LINE on
// purpose: D1's exec() splits on newlines (contract-d1-exec-takes-one-line-
// statements), and a contract test holds this string equal to the migration.
export const EVENT_TAGS_DDL = "CREATE TABLE IF NOT EXISTS event_tags (event_id TEXT PRIMARY KEY REFERENCES events(id), topic TEXT NOT NULL, topic_confidence REAL NOT NULL, format TEXT NOT NULL, format_confidence REAL NOT NULL, model TEXT NOT NULL, input_hash TEXT NOT NULL, probabilities TEXT, tagged_at TEXT NOT NULL DEFAULT (datetime('now')))";
