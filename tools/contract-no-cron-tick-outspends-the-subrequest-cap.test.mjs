// ── no cron tick outspends the 50-subrequest cap ─────────────────────────────
// Workers Free refuses an invocation's 51st subrequest. From 2026-08-14 to
// 2026-10-14 the /around crawl (about 40 on its own) and webmention-send (a
// budget of 40) shared the 41 5 tick, so that one invocation hit the ceiling
// every day. Where the refusal landed on a robots gate, the gate rethrew it,
// the whole crawl rejected, and around_crawl_history went without a row: 25 of
// the 28 days before the split. The analytics showed one scriptThrewException a
// day at exactly 50 subrequests, and nothing else did, because both jobs were
// written to be quiet.
//
// Three pins, from cheapest to most direct:
//   1. Every configured cron reaches a job, and each outbound job's declared
//      ceiling fits one invocation. The per-tick SUM over what index.ts actually
//      dispatches is pinned in contract-every-cron-fires-in-workerd, which sees
//      the cron spans each tick opens; index.ts cannot load outside workerd.
//   2. cronAround against a network that redirects without end on half the
//      neighbors: no more requests than its ledger allows, no rejection, and the
//      history batch still runs.
//   3. cronSendWebmentions against the same kind of network: no more than its
//      budget, and a target the ledger refused is never recorded as probed.
//
// THE CONTROLS, run before this was committed, each one red and then green on
// restore. Mapping "53 5" back onto the around job in lib/cron.ts fails pin 1
// (around reached by two ticks). Moving the robots gate in around.ts back
// outside its try fails pin 2 (cronAround rejects with the ledger's refusal).
// Dropping the transport from discoverEndpoint's redirect follower fails pin 3:
// the hops reach the no-network preload instead, discovery swallows that as
// "no endpoint", and no target is left unrecorded.
import { parseJsonc } from "./lib/jsonc.ts";
import { assert, configText, test } from "./contract-shared.ts";
import { cronJob } from "../src/worker/lib/cron.ts";
import { SUBREQUEST_CAP_FREE } from "../src/worker/lib/budget.ts";
import { withBotPolicyCache } from "../src/worker/lib/botauth.ts";
import { AROUND_SUBREQUEST_LIMIT, AROUND_SUBREQUEST_RESERVE, NEIGHBORS, cronAround } from "../src/worker/around.ts";
import { SUBREQUEST_BUDGET, cronSendWebmentions } from "../src/worker/webmention-send.ts";

// What one invocation of each outbound job can spend at most. The crawl's
// ledger meters third-party hops, and its reserve covers the snapshot put and
// the history batch. The sender's budget already counts its internal calls.
const OUTBOUND_CEILING = {
  around: AROUND_SUBREQUEST_LIMIT + AROUND_SUBREQUEST_RESERVE,
  webmention_send: SUBREQUEST_BUDGET,
};

test("each outbound job has a tick of its own and fits one invocation", async () => {
  const site = parseJsonc(await configText("cloudflare.config.ts"));
  const crons = site.triggers?.crons ?? [];
  assert.ok(crons.length >= 5, `read ${crons.length} crons from cloudflare.config.ts; the reader has stopped matching`);
  const reachedBy = new Map();
  for (const cron of crons) {
    const job = cronJob(cron);
    assert.ok(job, `${cron} matches no job in lib/cron.ts`);
    reachedBy.set(job, [...(reachedBy.get(job) ?? []), cron]);
  }
  for (const [job, ceiling] of Object.entries(OUTBOUND_CEILING)) {
    assert.equal(reachedBy.get(job)?.length, 1, `${job} should run on exactly one configured tick, got ${reachedBy.get(job) ?? "none"}`);
    assert.ok(ceiling <= SUBREQUEST_CAP_FREE, `${job} can spend ${ceiling} subrequests, over Workers Free's ${SUBREQUEST_CAP_FREE}`);
  }
  // The arithmetic the shared tick failed, kept as a number a reader can check.
  assert.ok(OUTBOUND_CEILING.around + OUTBOUND_CEILING.webmention_send > SUBREQUEST_CAP_FREE,
    "if the two ever fit one invocation together, this file's premise has changed");
});

async function signingKey() {
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  return JSON.stringify(await crypto.subtle.exportKey("jwk", pair.privateKey));
}

// A network that allows every robots.txt and answers each page either at once
// or with a redirect to a fresh path on the same host, forever. Every request
// it sees is counted, and nothing reaches the real fetch (the suite's
// no-network preload stays armed underneath).
function endlessRedirects(redirects) {
  const seen = [];
  const transport = async (url, init) => {
    seen.push({ url, method: init.method ?? "GET" });
    const u = new URL(url);
    if (u.pathname === "/robots.txt") return new Response("User-agent: *\nAllow: /\n", { headers: { "content-type": "text/plain" } });
    if (redirects(u)) return new Response(null, { status: 301, headers: { location: `/hop-${seen.length}` } });
    return new Response("<!doctype html><title>ok</title>", { headers: { "content-type": "text/html" } });
  };
  return { seen, transport };
}

test("the /around crawl stays inside its ledger and still writes its history", async () => {
  // Odd neighbors redirect without end. Unmetered, each costs 1 robots read plus
  // 21 page hops before the follower gives up, so the run would ask for
  // hundreds of requests. Even neighbors answer at once, so a run that
  // budgets well still has something to publish.
  const odd = new Set(NEIGHBORS.filter((_, i) => i % 2 === 1).map((n) => new URL(n.url).hostname));
  const net = endlessRedirects((u) => odd.has(u.hostname));
  const kv = new Map();
  const batches = [];
  const statement = (sql) => ({ sql, bind: (...args) => ({ sql, args }) });
  const env = withBotPolicyCache({
    RN_SIGNING_KEY_JWK: await signingKey(),
    OUTBOUND_TRANSPORT: net.transport,
    RN_KV: { get: async () => null, put: async (k, v) => { kv.set(k, v); } },
    RESTORE_DB: { prepare: statement, batch: async (stmts) => { batches.push(stmts); return []; } },
  });

  await cronAround(env); // resolving at all is half the point: it used to reject

  assert.ok(net.seen.length <= AROUND_SUBREQUEST_LIMIT,
    `the crawl made ${net.seen.length} requests against a ledger of ${AROUND_SUBREQUEST_LIMIT}`);
  // The control: this network really does ask for more than the ledger holds,
  // so a pass above is the ledger refusing rather than the fixture being cheap.
  assert.equal(net.seen.length, AROUND_SUBREQUEST_LIMIT, "the endless redirects should spend the whole ledger");

  // The same namespace holds botauth's robots cache, so read the snapshot by
  // its key (around.ts AROUND_KEY, not exported).
  const report = JSON.parse(kv.get("around:report") ?? "null");
  assert.ok(report, "the snapshot was not published, though some neighbors answered at once");
  assert.equal(report.results.length, NEIGHBORS.length, "every neighbor gets a row, refused or not");
  assert.ok(report.results.some((r) => r.error === "subrequest budget spent, not crawled"),
    "a neighbor the ledger refused should say so on its row");
  assert.ok(report.results.some((r) => !r.error && !r.skipped), "no neighbor was crawled");

  assert.equal(batches.length, 1, "the history batch did not run");
  const inserts = batches[0].filter((s) => /^\s*INSERT/i.test(s.sql));
  assert.equal(inserts.length, NEIGHBORS.length, "the history batch should carry one row per neighbor");
});

// Enough of `webmentions_sent` for the send loop: the bulk read and the upsert.
function sentTable() {
  const rows = [];
  const exec = (sql, args) => {
    if (/^\s*SELECT/i.test(sql)) return { results: rows.map((r) => ({ ...r })) };
    if (/^\s*INSERT/i.test(sql)) {
      const [source, target, endpoint, status, last_sent_at] = args;
      const found = rows.find((r) => r.source === source && r.target === target);
      if (found) Object.assign(found, { endpoint, status, last_sent_at });
      else rows.push({ source, target, endpoint, status, last_sent_at });
    }
    return { results: [], meta: { changes: 0 } };
  };
  return {
    rows,
    prepare(sql) {
      let bound = [];
      const api = { bind: (...a) => { bound = a; return api; }, run: async () => exec(sql, bound), all: async () => exec(sql, bound) };
      return api;
    },
  };
}

test("webmention-send stays inside its budget and never records a refused probe", async () => {
  // Every own page cites thirty targets, and every target redirects without
  // end, so one discovery costs 21 requests before the follower gives up and a
  // run could never finish its first page.
  const targets = Array.from({ length: 30 }, (_, i) => `https://cited-${i}.example/post`);
  const page = `<html><body>${targets.map((t) => `<a href="${t}">x</a>`).join(" ")}</body></html>`;
  const net = endlessRedirects(() => true);
  const db = sentTable();
  const env = {
    SOCIAL_DB: db,
    OUTBOUND_TRANSPORT: net.transport,
    SELF_FETCH: async () => new Response(page, { headers: { "content-type": "text/html" } }),
    ASSETS: { fetch: async () => Response.json([]) },
  };

  const out = await cronSendWebmentions(env, "https://aadhar.sh");

  assert.ok(out.spent <= SUBREQUEST_BUDGET, `the run spent ${out.spent} against a budget of ${SUBREQUEST_BUDGET}`);
  assert.ok(net.seen.length < out.spent, "the third-party requests are part of what the ledger counted");
  const probed = new Set(db.rows.filter((r) => r.source !== r.target).map((r) => r.target));
  // The control: the second target's discovery was cut off mid-chain. Before
  // the ledger it came back null and was stored as "no endpoint" for a week.
  const asked = new Set(net.seen.map((s) => `${new URL(s.url).origin}/post`));
  const refused = [...asked].filter((t) => !probed.has(t));
  assert.equal(refused.length, 1, `expected exactly one refused target, got ${refused.join(", ") || "none"}`);
  assert.equal(db.rows.filter((r) => r.source === r.target).length, 0,
    "a page the ledger cut off mid-way must stay unmarked so tomorrow's run starts there");
});
