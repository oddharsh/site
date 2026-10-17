// ── Serendipity event tags (serendipity/event-tags.ts) ───────────────────────
// Clef is not promised to be deterministic, nor pinnable, so the pool's tags are made stable
// by STORAGE: one decision per event, keyed by the hash of the exact request.
// These pin the three things that promise rests on: the hash moves exactly when
// the request does, a failure writes nothing (so absence reads as unread rather
// than as "no topic"), and a failure says which kind it was.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { assert, test } from "./contract-shared.ts";
import {
  EVENT_TAGS_DDL, EVENT_TOPICS, FORMAT_CRITERIA, TAG_MODEL, TOPIC_CRITERIA,
  askClef, buildTagRequest, parseTagAnswers, tagInputHash,
} from "../serendipity/event-tags.ts";
import { clefRunOptions } from "../src/worker/lib/clef.ts";
import { tagEvents } from "../serendipity/serendipity.ts";

const EV = { name: "Onchain Credit Dinner", description: "A small dinner on stablecoin lending.", location: "New York" };

function answer(topic, format, conf = 0.9) {
  const dist = (keys, pick) => Object.fromEntries(keys.map((k) => [k, k === pick ? conf : (1 - conf) / (keys.length - 1)]));
  return {
    model: TAG_MODEL,
    answers: {
      topic: { type: "choice", choice: topic, confidence: conf, probabilities: dist(Object.keys(TOPIC_CRITERIA), topic) },
      format: { type: "choice", choice: format, confidence: conf, probabilities: dist(Object.keys(FORMAT_CRITERIA), format) },
    },
    usage: { input_tokens: 400, output_tokens: 20 },
  };
}

test("one event per request, naming a model the binding accepts, with a bounded description", () => {
  const req = buildTagRequest({ ...EV, description: "x ".repeat(5000) });
  assert.equal(req.model, TAG_MODEL);
  // The input schema's own pattern for `model`, ^\s*(clef|clef-flash)\s*$. A Jev
  // version string here is refused by Workers AI, which would read as every
  // event failing rather than as a stale constant.
  assert.match(TAG_MODEL, /^(clef|clef-flash)$/);
  assert.deepEqual(Object.keys(req.state), ["name", "description", "location"]);
  assert.ok(req.state.description.length <= 2000);
  assert.deepEqual(Object.keys(req.questions), ["topic", "format"]);
  assert.ok("other" in req.questions.topic.criteria && "other" in req.questions.format.criteria,
    "both questions need a no-match option or the model is forced onto the nearest wrong label");
});

test("the input hash moves when the event, the taxonomy or the model moves, and only then", async () => {
  const base = await tagInputHash(buildTagRequest(EV));
  // lowercase SHA-256 hex of the exact request, checked against node:crypto rather than
  // the Worker's own encoder, so every tag already stored under it keeps its key
  assert.equal(base, createHash("sha256").update(JSON.stringify(buildTagRequest(EV))).digest("hex"));
  assert.equal(await tagInputHash(buildTagRequest({ ...EV })), base, "same event, same hash");
  assert.notEqual(await tagInputHash(buildTagRequest({ ...EV, description: EV.description + " Now with talks." })), base);
  const req = buildTagRequest(EV);
  assert.notEqual(await tagInputHash({ ...req, model: "clef-flash" }), base, "a model change re-tags");
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

test("the gateway rides the binding's third argument, uncached, and an empty gateway is the off-switch", () => {
  assert.deepEqual(clefRunOptions({ AI_GATEWAY: "default" }), { gateway: { id: "default", skipCache: true } });
  assert.deepEqual(clefRunOptions({ AI_GATEWAY: "" }), {});
  assert.deepEqual(clefRunOptions({ AI_GATEWAY: "  " }), {});
  assert.deepEqual(clefRunOptions(undefined), {});
});

test("a throw from the binding is classified by its Workers AI code, never thrown on", async () => {
  // gotcha 23's measured message for a gateway that does not exist
  const missing = { run: async () => { throw new Error("2001: Please configure AI Gateway in the Cloudflare dashboard"); } };
  assert.deepEqual(await askClef(buildTagRequest(EV), { AI: missing }), { error: "ai 2001" });
  const bare = { run: async () => { throw new Error("upstream went away"); } };
  assert.deepEqual(await askClef(buildTagRequest(EV), { AI: bare }), { error: "ai error" });
  const odd = { run: async () => ({ answers: { topic: { type: "noul", noul: 0.9 } } }) };
  assert.deepEqual(await askClef(buildTagRequest(EV), { AI: odd }), { error: "unparseable" });
  assert.deepEqual(await askClef(buildTagRequest(EV), {}), { error: "no AI binding" });
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
  const calls = [];
  const AI = {
    async run(model, input, options) {
      calls.push({ model, options });
      asked.push(input.state.name);
      if (input.state.name === "Gateway says no") throw new Error("2001: Please configure AI Gateway in the Cloudflare dashboard");
      return answer("crypto", "meal");
    },
  };
  const r = await tagEvents(d, { AI, AI_GATEWAY: "default" }, 10);
  assert.deepEqual(asked.sort(), [EV.name, "Gateway says no"].sort(), "an event whose hash matches is never re-asked");
  assert.ok(calls.every((c) => c.model === `@cf/cloudflare/${TAG_MODEL}`), "the Workers AI id is the request's model, under @cf/cloudflare");
  assert.ok(calls.every((c) => c.options?.gateway?.id === "default" && c.options.gateway.skipCache === true));
  assert.equal(r.tagged, 1);
  assert.deepEqual(r.failed, { "ai 2001": 1 }, "a missing gateway is named by its code, not folded into zero tags");
  assert.equal(r.remaining, 1);
  assert.equal(d.writes.length, 1, "a failure writes no row, so the event stays unread rather than tagged 'other'");
  assert.equal(d.writes[0][0], "e1");
  assert.equal(d.writes[0][1], "crypto");
  assert.equal(d.writes[0][6], await tagInputHash(buildTagRequest(EV)));
});

test("without the AI binding the pass skips before touching D1", async () => {
  let touched = false;
  const d = { raw: { prepare: () => { touched = true; } }, prepare: () => { touched = true; } };
  const r = await tagEvents(d, { AI_GATEWAY: "default" }, 10);
  assert.deepEqual(r, { skipped: "no AI binding" });
  assert.equal(touched, false);
  assert.ok(EVENT_TOPICS.length > 5);
});
