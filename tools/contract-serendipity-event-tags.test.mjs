// ── Serendipity event tags (serendipity/jev.ts) ──────────────────────────────
// Jev is not promised to be deterministic, so the pool's tags are made stable
// by STORAGE: one decision per event, keyed by the hash of the exact request.
// These pin the three things that promise rests on: the hash moves exactly when
// the request does, a failure writes nothing (so absence reads as unread rather
// than as "no topic"), and a failure says which kind it was.
import { readFileSync } from "node:fs";
import { assert, test } from "./contract-shared.ts";
import {
  EVENT_TAGS_DDL, EVENT_TOPICS, FORMAT_CRITERIA, JEV_MODEL, TOPIC_CRITERIA,
  buildTagRequest, jevEndpoint, parseTagAnswers, tagInputHash,
} from "../serendipity/jev.ts";
import { tagEvents } from "../serendipity/serendipity.ts";

const EV = { name: "Onchain Credit Dinner", description: "A small dinner on stablecoin lending.", location: "New York" };

function answer(topic, format, conf = 0.9) {
  const dist = (keys, pick) => Object.fromEntries(keys.map((k) => [k, k === pick ? conf : (1 - conf) / (keys.length - 1)]));
  return {
    model: JEV_MODEL,
    answers: {
      topic: { type: "choice", choice: topic, confidence: conf, probabilities: dist(Object.keys(TOPIC_CRITERIA), topic) },
      format: { type: "choice", choice: format, confidence: conf, probabilities: dist(Object.keys(FORMAT_CRITERIA), format) },
    },
    usage: { input_tokens: 400, output_tokens: 20 },
  };
}

test("one event per request, with the pinned model and a bounded description", () => {
  const req = buildTagRequest({ ...EV, description: "x ".repeat(5000) });
  assert.equal(req.model, JEV_MODEL);
  assert.notEqual(JEV_MODEL, "jev-latest", "an alias moves under you; the pin is the point");
  assert.deepEqual(Object.keys(req.state), ["name", "description", "location"]);
  assert.ok(req.state.description.length <= 2000);
  assert.deepEqual(Object.keys(req.questions), ["topic", "format"]);
  assert.ok("other" in req.questions.topic.criteria && "other" in req.questions.format.criteria,
    "both questions need a no-match option or Jev is forced onto the nearest wrong label");
});

test("the input hash moves when the event, the taxonomy or the model moves, and only then", async () => {
  const base = await tagInputHash(buildTagRequest(EV));
  assert.equal(await tagInputHash(buildTagRequest({ ...EV })), base, "same event, same hash");
  assert.notEqual(await tagInputHash(buildTagRequest({ ...EV, description: EV.description + " Now with talks." })), base);
  const req = buildTagRequest(EV);
  assert.notEqual(await tagInputHash({ ...req, model: "jev-1.14.0" }), base, "a model bump re-tags");
  const retaxed = { ...req, questions: { ...req.questions, topic: { ...req.questions.topic, criteria: { ...TOPIC_CRITERIA, gaming: "Games." } } } };
  assert.notEqual(await tagInputHash(retaxed), base, "a taxonomy edit re-tags, with no version to remember to bump");
});

test("an answer outside the declared options, or without a confidence, is no answer", () => {
  assert.equal(parseTagAnswers(answer("crypto", "meal"))?.topic, "crypto");
  assert.equal(parseTagAnswers(answer("astrology", "meal")), null);
  const good = answer("crypto", "meal");
  const noConf = { ...good, answers: { topic: good.answers.topic, format: { type: "choice", choice: "meal", probabilities: good.answers.format.probabilities } } };
  assert.equal(parseTagAnswers(noConf), null);
  assert.equal(parseTagAnswers({}), null);
});

test("the gateway URL names the custom provider, and an empty gateway is the off-switch", () => {
  assert.equal(
    jevEndpoint({ AI_GATEWAY: "default", CF_ACCOUNT_ID: "acct" }),
    "https://gateway.ai.cloudflare.com/v1/acct/default/custom-typesafe/v1/systemone",
  );
  assert.equal(jevEndpoint({ AI_GATEWAY: "", CF_ACCOUNT_ID: "acct" }), "https://api.typesafe.ai/v1/systemone");
});

test("the runtime DDL is the migration's statement, on one line", () => {
  const migration = readFileSync(new URL("../serendipity/migrations/0003_event_tags.sql", import.meta.url), "utf8");
  const stmt = migration.split("\n").filter((l) => l.trim() && !l.startsWith("--")).join(" ").replace(/;\s*$/, "");
  assert.equal(stmt, EVENT_TAGS_DDL);
  assert.ok(!EVENT_TAGS_DDL.includes("\n"));
});

// A D1 just deep enough for tagEvents: the scan returns `rows`, and every
// INSERT's bound args are recorded. The SQL itself is exercised against real
// SQLite by hand, since a regex fake cannot hold an ORDER BY to account.
async function fakeTagDb(rows) {
  const writes = [];
  const stmt = (sql, ...args) => ({ sql, args });
  const raw = { prepare: () => ({ run: async () => ({}) }) };
  return {
    writes,
    raw,
    stmt,
    async batch(stmts) { writes.push(...stmts.map((s) => s.args)); },
    prepare: () => ({ all: async () => rows }),
  };
}

test("tagEvents asks only for events whose stored hash is stale, and writes only what came back", async () => {
  const fresh = await tagInputHash(buildTagRequest({ name: "Already tagged" }));
  const d = await fakeTagDb([
    { id: "e1", name: EV.name, description: EV.description, location: EV.location, input_hash: null },
    { id: "e2", name: "Already tagged", description: null, location: null, input_hash: fresh },
    { id: "e3", name: "Gateway says no", description: "x", location: null, input_hash: "stale" },
  ]);
  const asked = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    asked.push(body.state.name);
    if (body.state.name === "Gateway says no") return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => answer("crypto", "meal") };
  };
  const env = { TYPESAFE_API_KEY: "k", AI_GATEWAY: "default", CF_ACCOUNT_ID: "acct" };
  const r = await tagEvents(d, env, 10, fetchImpl);
  assert.deepEqual(asked.sort(), [EV.name, "Gateway says no"].sort(), "an event whose hash matches is never re-asked");
  assert.equal(r.tagged, 1);
  assert.deepEqual(r.failed, { "http 404": 1 }, "a missing custom provider is named by status, not folded into zero tags");
  assert.equal(r.remaining, 1);
  assert.equal(d.writes.length, 1, "a failure writes no row, so the event stays unread rather than tagged 'other'");
  assert.equal(d.writes[0][0], "e1");
  assert.equal(d.writes[0][1], "crypto");
  assert.equal(d.writes[0][6], await tagInputHash(buildTagRequest(EV)));
});

test("without a key the pass skips before touching D1 or the network", async () => {
  let touched = false;
  const d = { raw: { prepare: () => { touched = true; } }, prepare: () => { touched = true; } };
  const r = await tagEvents(d, {}, 10, async () => { touched = true; return { ok: false, status: 0, json: async () => ({}) }; });
  assert.deepEqual(r, { skipped: "TYPESAFE_API_KEY not set" });
  assert.equal(touched, false);
  assert.ok(EVENT_TOPICS.length > 5);
});
