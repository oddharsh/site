// ── webmention moderation lifecycle (src/worker/webmention.ts) ──────────────
// A mention moves pending -> approved or pending -> declined, and nothing else.
// These pin the edges a bare UPDATE/DELETE got wrong: a decline is remembered,
// so a re-send stays declined and mails nobody; a decision link only acts on a
// pending mention and says so honestly when it doesn't; and a decline link
// never takes down a mention that is already live.
import {
  assert,
  context,
  deferredContext,
  fakeD1,
  handleInboxMail,
  handleWebmention,
  handleWebmentionDecision,
  sign,
  test,
  testGlobals,
  WM_SECRET,
  wmEnv,
  wmPost,
} from "./contract-shared.ts";

const TARGET = "https://aadhar.sh/writing/in-flux";
const SOURCE = "https://spam.example/links";
const PAGE = `<html><head><title>Cheap links here</title></head><body><p><a href="${TARGET}">in flux</a></p></body></html>`;

function mailEnv() {
  const db = fakeD1();
  return { db, env: { ...wmEnv(db), RESEND_API_KEY: "re_test", HOST_EMAIL: "host@example.com" } };
}

/** Sends one webmention end to end; returns how many host emails it caused. */
async function send(env, page = PAGE): Promise<number> {
  const realFetch = globalThis.fetch;
  let mails = 0;
  testGlobals.fetch = async (input) => {
    if (String(input?.url ?? input).startsWith("https://api.resend.com/")) {
      mails++;
      return Response.json({ id: "m1" });
    }
    return new Response(page, { headers: { "content-type": "text/html" } });
  };
  try {
    const ctx = deferredContext();
    assert.equal((await handleWebmention(wmPost(SOURCE, TARGET), env, ctx)).status, 202);
    await ctx.settle();
  } finally {
    testGlobals.fetch = realFetch;
  }
  return mails;
}

async function decide(env, id: string, decision: "approve" | "decline") {
  const url = new URL(`https://aadhar.sh/webmention/${decision}?t=${id}&sig=${await sign(`${id}|${decision}`, WM_SECRET)}`);
  const res = await handleWebmentionDecision(new Request(url), env, context(), url);
  return { status: res.status, body: await res.text() };
}

async function inboxShows(env): Promise<boolean> {
  const res = await handleInboxMail(new Request("https://aadhar.sh/inbox/mail.html"), env, context());
  return (await res.text()).includes("Cheap links here");
}

test("a declined mention stays declined when re-sent, and mails nobody", async () => {
  const { db, env } = mailEnv();
  assert.equal(await send(env), 1, "the first send asks the host");
  const id = db.rows[0].id;

  assert.deepEqual(await decide(env, id, "decline"), { status: 200, body: "Declined. Nothing published, and a re-send stays declined.\n" });
  assert.equal(db.rows[0].status, "declined", "a decline is remembered, not deleted");

  assert.equal(await send(env), 0, "a re-send of a declined mention sends no email");
  assert.equal(db.rows.length, 1);
  assert.equal(db.rows[0].status, "declined");
  assert.equal(await inboxShows(env), false, "a declined mention never renders");
});

test("a declined mention survives its source dropping the link and adding it back", async () => {
  const { db, env } = mailEnv();
  await send(env);
  await decide(env, db.rows[0].id, "decline");

  assert.equal(await send(env, "<html><p>no link</p></html>"), 0);
  assert.equal(db.rows[0]?.status, "declined", "a retraction leaves the decline on record");
  assert.equal(await send(env), 0, "relinking does not reopen moderation");
});

test("an approve link after a decline changes nothing and says so", async () => {
  const { db, env } = mailEnv();
  await send(env);
  const id = db.rows[0].id;
  await decide(env, id, "decline");

  assert.deepEqual(await decide(env, id, "approve"), { status: 409, body: "Already declined. This link changed nothing.\n" });
  assert.equal(db.rows[0].status, "declined");
  assert.equal(await inboxShows(env), false);
});

test("a decline link never takes down a mention that is already live", async () => {
  const { db, env } = mailEnv();
  await send(env);
  const id = db.rows[0].id;
  assert.deepEqual(await decide(env, id, "approve"), { status: 200, body: "Approved. It's live at /inbox.\n" });
  assert.equal(await inboxShows(env), true);

  assert.deepEqual(await decide(env, id, "decline"), { status: 409, body: "Already approved. This link changed nothing.\n" });
  assert.equal(db.rows[0].status, "approved");
  assert.equal(await inboxShows(env), true, "the live mention stays live");
});

test("a decision link for a mention that is gone answers 404", async () => {
  const { db, env } = mailEnv();
  await send(env);
  const id = db.rows[0].id;
  await send(env, "<html><p>no link</p></html>"); // the sender retracts a pending mention
  assert.equal(db.rows.length, 0);

  assert.deepEqual(await decide(env, id, "approve"), { status: 404, body: "No such mention. The sender may have retracted it.\n" });
  assert.equal(db.rows.length, 0, "an approve link cannot conjure a row");
});
