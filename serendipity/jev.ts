// Event tags for the Serendipity pool, decided by TypeSafe's Jev.
//
// Jev takes a state and typed questions and returns typed answers with
// calibrated probabilities. It can never answer outside the options below, so
// there is no string to parse and no label to validate against a list the model
// might have ignored. It is NOT promised to be deterministic: TypeSafe says it
// "returns similar answers for similar inputs", and a pinned model version is
// as far as that goes. So the determinism lives here rather than in the model.
// A tag is decided ONCE, stored in D1 beside the hash of the exact request that
// produced it, and asked again only when that hash moves: the event text
// changed, the taxonomy below changed, or JEV_MODEL did. Every read serves the
// stored answer, so two readers of one event can never see two tags.
//
// Pure except for askJev's fetch, and node-safe, because the contract suite
// imports it outside workerd (gotcha 16).

import { asNumber, asText } from "../src/worker/lib/parse.ts";

// PINNED rather than `jev-latest`: TypeSafe's models page warns that an alias
// moves when a release ships, "so the answers behind it can change without a
// change on your side". Moving this string is a deliberate re-tag of the whole
// pool, since it is part of every input hash.
export const JEV_MODEL = "jev-1.13.0";

// The custom-provider slug registered in AI Gateway. TypeSafe is not a native
// gateway provider, so the account carries a custom provider with this slug and
// base_url https://api.typesafe.ai, and the gateway prefixes it `custom-`.
// That provider is ACCOUNT STATE this repo cannot create (no path here mints
// Cloudflare resources), and a missing one answers 404, which tagEvents reports
// by status rather than reading as "no tags".
export const TYPESAFE_GATEWAY_SLUG = "typesafe";
const TYPESAFE_DIRECT = "https://api.typesafe.ai/v1/systemone";

/** Gateway when both halves of its URL are configured, TypeSafe directly
 *  otherwise. An empty AI_GATEWAY is the off-switch, the same one cf-garage's
 *  caption demo uses (gotcha 23). */
export function jevEndpoint(env: { AI_GATEWAY?: string, CF_ACCOUNT_ID?: string } | null | undefined): string {
  const gw = env?.AI_GATEWAY?.trim();
  const acct = env?.CF_ACCOUNT_ID?.trim();
  if (!gw || !acct) return TYPESAFE_DIRECT;
  return `https://gateway.ai.cloudflare.com/v1/${encodeURIComponent(acct)}/${encodeURIComponent(gw)}/custom-${TYPESAFE_GATEWAY_SLUG}/v1/systemone`;
}

// ── the taxonomy ─────────────────────────────────────────────────────────────
// Two Choice questions, both objective, both with a no-match option so the
// model can say nothing fits instead of forcing the nearest wrong label.
// Topic is what the event is ABOUT and format is what you would be DOING there,
// which keeps the two independent: a crypto dinner is topic crypto, format meal.
// Criteria describe situations rather than keywords, because Jev reads
// literally and an event that says "AI" once in a sponsor line is not an AI event.
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
// Jev was unsure about is reported as untagged rather than as the wrong topic.
// Choice confidence is derived from the probability spread, so 0.5 means the
// model put real weight elsewhere. A first guess, and the stored probabilities
// are there to tune it against.
export const TAG_MIN_CONFIDENCE = 0.5;

// Jev's accuracy falls as the state fills with detail unrelated to the question
// (its 1.13 jaggedness notes, "Large state full of irrelevant detail"), and Luma
// descriptions run to sponsor lists and logistics. The opening of a description
// is where an event says what it is.
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
    model: JEV_MODEL,
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
    model: asText(body.model) || JEV_MODEL,
    probabilities: { topic: topic.probabilities, format: format.probabilities },
  };
}

type JevFetch = (url: string, init?: any) => Promise<{ ok: boolean, status: number, json: () => Promise<any> }>;
const JEV_TIMEOUT_MS = 5000;

/** One call. Never throws: the caller counts outcomes by status, because "the
 *  gateway has no custom-typesafe provider" (404) and "TypeSafe is rate-limiting
 *  us" (429) need different fixes and must not blur into one "failed". */
export async function askJev(request: ReturnType<typeof buildTagRequest>, env: { TYPESAFE_API_KEY?: string, AI_GATEWAY?: string, CF_ACCOUNT_ID?: string }, fetchImpl: JevFetch = fetch):
  Promise<{ tag: EventTag } | { error: string }> {
  try {
    const res = await fetchImpl(jevEndpoint(env), {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.TYPESAFE_API_KEY}`,
        "content-type": "application/json",
        // No gateway cache. The stored tag is the memo, and a cache hit would
        // make the gateway's log disagree with what this run actually asked.
        "cf-aig-skip-cache": "true",
      },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(JEV_TIMEOUT_MS),
    });
    if (!res.ok) return { error: `http ${res.status}` };
    const tag = parseTagAnswers(await res.json());
    return tag ? { tag } : { error: "unparseable" };
  } catch (err) {
    return { error: err instanceof Error && err.name === "TimeoutError" ? "timeout" : "network" };
  }
}

// The table is created on first use as well as by migration 0003, because the
// tag pass must not depend on someone having remembered to apply a migration to
// a database this repo has no automated migration step for. ONE LINE on
// purpose: D1's exec() splits on newlines (contract-d1-exec-takes-one-line-
// statements), and a contract test holds this string equal to the migration.
export const EVENT_TAGS_DDL = "CREATE TABLE IF NOT EXISTS event_tags (event_id TEXT PRIMARY KEY REFERENCES events(id), topic TEXT NOT NULL, topic_confidence REAL NOT NULL, format TEXT NOT NULL, format_confidence REAL NOT NULL, model TEXT NOT NULL, input_hash TEXT NOT NULL, probabilities TEXT, tagged_at TEXT NOT NULL DEFAULT (datetime('now')))";
