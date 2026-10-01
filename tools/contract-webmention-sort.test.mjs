// ── the webmention moderation email, pre-sorted by Clef (src/worker/webmention-sort.ts)
// Verification proves a source links here; Clef adds whether it reads as a
// person, a list or spam. These pin what that promises: the sort labels the
// email and decides nothing, every failure still sends the email and says it
// was not sorted, and Workers AI is spent only when an email will go out.
import { assert, test, testGlobals, deferredContext, fakeD1, handleWebmention, wmEnv, wmPost } from "./contract-shared.ts";
import {
  SORT_CRITERIA, SORT_LABELS, SORT_MODEL, buildSortRequest, sortLine, sortMention, sortSubjectTag,
} from "../src/worker/webmention-sort.ts";

const TARGET = "https://aadhar.sh/writing/in-flux";
const SOURCE = "https://best-slots-review.click/top-10";
const PAGE = `<html><head><title>Top 10 Online Casinos</title></head>
  <body><p>Claim 500 free spins. Partners: <a href="${TARGET}">aadhar sh</a> <a href="https://x.example">payday loans</a></p></body></html>`;

/** A Workers AI binding answering the sort with `probs`, counting calls. */
function ai(probs, calls = []) {
  return {
    calls,
    async run(model, input, options) {
      calls.push({ model, input, options });
      return { answers: { sort: { type: "choice", choice: "spam", confidence: 0.9, probabilities: probs } } };
    },
  };
}

/** Runs one webmention end to end and returns the email Resend was asked to send, or null. */
async function send(env) {
  const realFetch = globalThis.fetch;
  const mails = [];
  testGlobals.fetch = async (input, init) => {
    const url = String(input?.url ?? input);
    if (url.startsWith("https://api.resend.com/")) {
      mails.push(JSON.parse(init.body));
      return Response.json({ id: "m1" });
    }
    return new Response(PAGE, { headers: { "content-type": "text/html" } });
  };
  try {
    const ctx = deferredContext();
    const res = await handleWebmention(wmPost(SOURCE, TARGET), env, ctx);
    assert.equal(res.status, 202);
    await ctx.settle();
  } finally { testGlobals.fetch = realFetch; }
  assert.ok(mails.length <= 1, "one mention sends at most one email");
  return mails[0] ?? null;
}

/** The stored mention's moderation status. @returns {string} */
const statusOf = (/** @type {any} */ db) => db.rows[0]?.status;

function mailEnv(extra = {}) {
  const db = fakeD1();
  return { db, env: { ...wmEnv(db), RESEND_API_KEY: "re_test", HOST_EMAIL: "host@example.com", ...extra } };
}

test("one choice question over three labels, fed only what parseSource produced", () => {
  const { model, questions } = buildSortRequest({ kind: "mention", source: SOURCE, title: "T", author: "A", excerpt: "E" });
  assert.equal(model, SORT_MODEL);
  assert.match(SORT_MODEL, /^(clef|clef-flash)$/);
  assert.deepEqual(Object.keys(questions), ["sort"]);
  assert.equal(questions.sort.type, "choice");
  assert.deepEqual(Object.keys(questions.sort.criteria), [...SORT_LABELS]);
  assert.deepEqual(questions.sort.criteria, SORT_CRITERIA);
  assert.deepEqual(Object.keys(questions.sort.instructions.mention), ["kind", "source_host", "title", "author", "excerpt"],
    "the page body stays out: measured, it bought nothing and cost 35% more tokens");
  assert.equal(questions.sort.instructions.mention.source_host, "best-slots-review.click");
});

test("the verdict is the top probability, and a malformed answer is not a verdict", async () => {
  const sorted = await sortMention({ AI: ai({ genuine: 0.02, listing: 0.01, spam: 0.97 }) }, { source: SOURCE });
  assert.deepEqual(sorted, { verdict: "spam", probabilities: { genuine: 0.02, listing: 0.01, spam: 0.97 } });
  assert.equal(sortSubjectTag(sorted), "[likely spam] ");
  assert.match(sortLine(sorted), /^Clef reads this as spam \(0\.97\); genuine 0\.02, listing 0\.01\. It only sorts/);

  assert.equal(sortSubjectTag({ verdict: "genuine", probabilities: { genuine: 0.9, listing: 0.05, spam: 0.05 } }), "",
    "a genuine mention's subject reads exactly as it did before");
  assert.equal(sortSubjectTag({ verdict: "listing", probabilities: { genuine: 0.1, listing: 0.85, spam: 0.05 } }), "[listing] ");

  const noul = { AI: { async run() { return { answers: { sort: { type: "noul", noul: 1 } } }; } } };
  assert.deepEqual(await sortMention(noul, { source: SOURCE }), { error: "unparseable" });
  const partial = { AI: ai({ genuine: 0.5, spam: 0.5 }) };
  assert.deepEqual(await sortMention(partial, { source: SOURCE }), { error: "unparseable" }, "a missing label is not read as zero");
});

test("the email arrives labelled, and the mention still waits for the host", async () => {
  const binding = ai({ genuine: 0.02, listing: 0.01, spam: 0.97 });
  const { db, env } = mailEnv({ AI: binding, AI_GATEWAY: "default" });
  const mail = await send(env);
  assert.equal(binding.calls.length, 1, "one Clef call per mention");
  assert.equal(binding.calls[0].model, `@cf/cloudflare/${SORT_MODEL}`);
  assert.deepEqual(binding.calls[0].options, { gateway: { id: "default", skipCache: true } });
  assert.equal(binding.calls[0].input.questions.sort.instructions.mention.title, "Top 10 Online Casinos");
  assert.ok(mail, "the email still goes out");
  assert.match(mail.subject, /^\[likely spam\] ✉ /);
  assert.match(mail.html, /Clef reads this as spam \(0\.97\)/);
  assert.match(mail.html, /\/webmention\/approve\?t=/, "approval is still a link the host follows");
  assert.match(mail.html, /\/webmention\/decline\?t=/);
  assert.equal(statusOf(db), "pending", "a spam verdict declines nothing");
});

test("every sort failure still sends the email and says it was not sorted", async () => {
  const capacity = { async run() { throw new Error("AiError: Capacity temporarily exceeded, please try again. (3040)"); } };
  for (const { AI, why } of [{ AI: capacity, why: /ai 3040/ }, { AI: undefined, why: /no AI binding/ }]) {
    const { db, env } = mailEnv(AI ? { AI } : {});
    const mail = await send(env);
    assert.ok(mail, "a failed sort must not cost the host the email");
    assert.match(mail.subject, /^✉ /, "an unsorted mention carries no tag");
    assert.match(mail.html, /Not sorted: Clef answered nothing usable/);
    assert.match(mail.html, why);
    assert.equal(statusOf(db), "pending");
  }
});

test("no email, no Workers AI: an unconfigured host spends nothing on the sort", async () => {
  const binding = ai({ genuine: 0.9, listing: 0.05, spam: 0.05 });
  const db = fakeD1();
  const mail = await send({ ...wmEnv(db), AI: binding });
  assert.equal(mail, null);
  assert.equal(binding.calls.length, 0);
  assert.equal(statusOf(db), "pending", "the mention is still stored for /inbox moderation");
});
