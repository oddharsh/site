// ── /ask ranked by Clef over the whole corpus (src/worker/ask-rank.ts) ───────
// Lexical retrieval cannot find a page that shares no word with the question,
// and a reranker over its results cannot either, so Clef chooses across every
// page. These pin what that promises: a page with no matching word can win,
// the score says what it means, one call per question, and every way the call
// can fail lands on the lexical ranking with `_meta.ranking` naming why.
import { assert, test } from "./contract-shared.ts";
import { _resetSearchIndex } from "../src/worker/search.ts";
import { ASK_BUDGET, ASK_FLOOR, ASK_MODEL, MAX_OPTIONS, buildAskRequest } from "../src/worker/ask-rank.ts";

// "crawled" is not "crawler": the lexical pass finds /writing/bots-log and
// never /ledger, which is the measured recall miss this change exists for.
const RECORDS = [
  { url: "/ledger", title: "Crawl ledger", description: "A commentary ledger of identified AI-crawler visits.", text: "crawler visits priced", kind: "utility" },
  { url: "/writing/bots-log", title: "A note", description: "Which bots I saw", text: "bots recently", kind: "writing" },
  { url: "/coffee", title: "Coffee", description: "Book a coffee in NYC.", text: "coffee slots", kind: "utility" },
];
const QUERY = "which bots crawled the site recently";

/** @returns {any} */
function env(extra = {}) {
  _resetSearchIndex();
  return { ASSETS: { fetch: async () => new Response(JSON.stringify({ version: 1, records: RECORDS })) }, ...extra };
}

/** A Workers AI binding answering the choice with `probs` by url, counting calls. */
function ai(probs, calls = []) {
  return {
    calls,
    async run(model, input, options) {
      calls.push({ model, input, options });
      const criteria = input.questions.best.criteria;
      const probabilities = Object.fromEntries(Object.entries(criteria).map(([id, opt]) => [id, probs[/** @type {any} */ (opt).url] ?? 0]));
      return { answers: { best: { type: "choice", choice: "p0", confidence: 0.9, probabilities } } };
    },
  };
}

async function ask(e, query = QUERY, request = new Request("https://aadhar.sh/ask")) {
  const { nlwebAsk, parseAskRequest } = await import("../src/worker/nlweb.ts");
  const parsed = parseAskRequest(new URL("https://aadhar.sh/ask"), { query, streaming: false });
  assert.ok(parsed.ok);
  return nlwebAsk(e, /** @type {any} */ (parsed).params, request);
}

test("one choice question, every page an option, capped at Clef's ceiling", () => {
  const { request, ids } = buildAskRequest(QUERY, RECORDS);
  assert.equal(request.model, ASK_MODEL);
  assert.match(ASK_MODEL, /^(clef|clef-flash)$/);
  assert.deepEqual(Object.keys(request.questions), ["best"]);
  assert.equal(request.questions.best.type, "choice");
  assert.deepEqual(ids, ["p0", "p1", "p2"]);
  assert.deepEqual(Object.values(request.questions.best.criteria).map((o) => /** @type {any} */ (o).url), RECORDS.map((r) => r.url));
  const many = Array.from({ length: 300 }, (_, i) => ({ url: `/p/${i}`, title: `p${i}` }));
  assert.equal(buildAskRequest("q", many).ids.length, MAX_OPTIONS);
});

test("a page that shares no word with the question can win, scored as Clef's probability", async () => {
  const binding = ai({ "/ledger": 0.91, "/writing/bots-log": 0.08, "/coffee": 0.01 });
  const out = await ask(env({ AI: binding, AI_GATEWAY: "default" }));
  assert.equal(binding.calls.length, 1, "one call per question");
  assert.equal(binding.calls[0].model, `@cf/cloudflare/${ASK_MODEL}`);
  assert.deepEqual(binding.calls[0].options, { gateway: { id: "default", skipCache: true } });
  assert.equal(out._meta.ranking, "clef");
  assert.deepEqual(out.results.map((r) => r.url), ["https://aadhar.sh/ledger", "https://aadhar.sh/writing/bots-log"]);
  assert.deepEqual(out.results.map((r) => r.score), [91, 8]);
  assert.match(out._meta.score, /probability Clef puts/);
  assert.equal(out.total, 2, "a page under the floor that lexical search did not match is left out");
  assert.ok(0.01 < ASK_FLOOR);
});

test("every page the lexical pass matched stays in the answer, however low Clef puts it", async () => {
  const out = await ask(env({ AI: ai({ "/ledger": 0.99, "/writing/bots-log": 0.0, "/coffee": 0.01 }) }));
  assert.deepEqual(out.results.map((r) => r.url), ["https://aadhar.sh/ledger", "https://aadhar.sh/writing/bots-log"]);
});

test("every failure lands on the lexical ranking and says why", async () => {
  const lexicalOnly = ["https://aadhar.sh/writing/bots-log"];

  const none = await ask(env());
  assert.match(none._meta.ranking, /^lexical: no Workers AI binding/);
  assert.deepEqual(none.results.map((r) => r.url), lexicalOnly);
  assert.match(none._meta.score, /percentage of the maximum/);

  const capacity = { async run() { throw new Error("AiError: Capacity temporarily exceeded, please try again. (3040)"); } };
  const busy = await ask(env({ AI: capacity }));
  assert.match(busy._meta.ranking, /^lexical: Clef answered nothing usable \(ai 3040\)/);
  assert.deepEqual(busy.results.map((r) => r.url), lexicalOnly);

  const odd = await ask(env({ AI: { async run() { return { answers: { best: { type: "noul", noul: 1 } } }; } } }));
  assert.match(odd._meta.ranking, /unparseable/);

  const binding = ai({ "/ledger": 0.9 });
  const limited = await ask(env({ AI: binding, ASK_RL: { async limit() { return { success: false }; } } }));
  assert.match(limited._meta.ranking, new RegExp(`passed ${ASK_BUDGET.max} Clef-ranked questions`));
  assert.equal(binding.calls.length, 0, "a caller over budget spends no Workers AI");
});

test("the ask MCP tool and /ask carry the same Clef ranking", async () => {
  const { callDataTool } = await import("../src/worker/lib/tools.ts");
  const { handleAsk } = await import("../src/worker/nlweb.ts");
  const probs = { "/ledger": 0.91, "/writing/bots-log": 0.08 };
  const req = new Request("https://aadhar.sh/mcp");
  const viaTool = await callDataTool("ask", { query: QUERY }, req, env({ AI: ai(probs) }), undefined);
  const viaRoute = await (await handleAsk(new Request(`https://aadhar.sh/ask?query=${encodeURIComponent(QUERY)}&streaming=0`), env({ AI: ai(probs) }))).json();
  assert.equal(viaTool._meta.ranking, "clef");
  assert.deepEqual(viaTool.results, viaRoute.results);
});
