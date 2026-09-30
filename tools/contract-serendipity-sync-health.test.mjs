// ── serendipity sync health ─────────────────────────────────────────
// Shared imports live in contract-shared.ts.
//
// A broken Luma sync and a quiet week wrote the same log line until
// 2026-09-30: syncEvents RETURNS a Luma 401 rather than throwing it, so the
// cron wrapper's span read green on a dead session four times a day, and
// Workers Logs forgets the line after three days. These pin the three halves
// of the fix: a record in `settings` on every path (the throw included), a
// `serendipity.sync` span whose unknowns stay off rather than reading 0, and a
// dashboard line that goes stale after two missed ticks.
import { configText, assert, test, testGlobals } from "./contract-shared.ts";
import { parseJsonc } from "./lib/jsonc.ts";
import { cronJob } from "../src/worker/lib/cron.ts";
import { installTracing } from "../src/worker/lib/trace.ts";
import {
  SYNC_ATTEMPT_KEY,
  SYNC_OK_KEY,
  SYNC_SCHEDULE,
  SYNC_STALE_MS,
  cronSerendipity,
  readSyncHealth,
  scheduleIntervalMs,
  summarizeSync,
  syncHealthLine,
  syncSpanAttrs,
} from "../serendipity/serendipity.ts";

const COOKIES = JSON.stringify({ cookies: [{ name: "luma.auth-session-key", value: "usr-test.secret" }] });

// A D1 double that answers the statements the cron sends. `settings` is the
// record under test; `failOn` makes one statement throw, which is how the
// thrown path is reached without touching the record's own write.
function fakeD1({ sets = [{ user_key: "k1", cookies_json: COOKIES, label: "test" }], pool = [5, 5], failOn = /** @type {string | null} */ (null) } = {}) {
  const settings = new Map();
  const pools = [...pool];
  const answer = (sql, args) => {
    if (failOn && sql.includes(failOn)) throw new Error(`D1 refused: ${failOn}`);
    if (/FROM user_cookies/.test(sql)) return { results: sets };
    if (/^SELECT COUNT\(\*\) AS n FROM events$/.test(sql.trim())) return { results: [{ n: pools.shift() ?? 0 }] };
    if (/COUNT\(\*\) AS n FROM events WHERE/.test(sql)) return { results: [{ n: 0 }] };
    if (/^\s*INSERT INTO settings/.test(sql)) { settings.set(args[0], args[1]); return { results: [] }; }
    if (/FROM settings WHERE key IN/.test(sql)) {
      return { results: args.filter((k) => settings.has(k)).map((key) => ({ key, value: settings.get(key) })) };
    }
    return { results: [] };
  };
  const stmt = (sql, args = []) => ({
    sql, args,
    bind: (...a) => stmt(sql, a),
    first: async () => answer(sql, args).results[0] ?? null,
    all: async () => answer(sql, args),
    run: async () => answer(sql, args),
  });
  return {
    settings,
    SERENDIPITY_DB: {
      prepare: (sql) => stmt(sql),
      batch: async (stmts) => stmts.map((s) => answer(s.sql, s.args)),
    },
  };
}

// A tracer double shaped like the runtime's: records every attribute set.
function recordingTracer() {
  const spans = [];
  return {
    spans,
    enterSpan(name, fn) {
      const attrs = {};
      spans.push({ name, attrs });
      return fn({ setAttribute: (k, v) => { attrs[k] = v; }, end() {}, isTraced: true });
    },
  };
}

async function withLuma(respond, work) {
  const realFetch = globalThis.fetch;
  try {
    testGlobals.fetch = async (url) => respond(String(url));
    return await work();
  } finally {
    testGlobals.fetch = realFetch;
  }
}

const feed = (entries) => () => new Response(JSON.stringify({ entries, has_more: false }), { headers: { "content-type": "application/json" } });
const EMPTY_FEED = feed([]);
// Three events, returned for each of the two periods, so one pass fetches six.
const THREE_EVENTS = feed(["evt-1", "evt-2", "evt-3"].map((api_id) => ({ api_id, event: { name: api_id } })));

test("a successful tick writes both records and a span with no undefined attribute", async () => {
  const db = fakeD1({ pool: [5, 7, 7, 7] });
  const tracer = recordingTracer();
  installTracing(tracer);
  try {
    const record = await withLuma(THREE_EVENTS, () => cronSerendipity(db));
    assert.equal(record.ok, true, `the tick should read ok: ${JSON.stringify(record)}`);
    assert.equal(record.session, "ok");

    const attempt = JSON.parse(db.settings.get(SYNC_ATTEMPT_KEY));
    const lastOk = JSON.parse(db.settings.get(SYNC_OK_KEY));
    assert.equal(attempt.ok, true);
    assert.equal(attempt.at, lastOk.at, "a success writes the attempt and the success from one record");
    assert.equal(attempt.events_fetched, 6);
    assert.equal(attempt.events_new, 2, "new events come from the pool counted before and after the batch");
    assert.equal(attempt.events_updated, 4);
    assert.equal(attempt.sets, 1);
    assert.ok(Number.isFinite(attempt.event_pages) && attempt.event_pages >= 2, "both periods were walked");

    const sync = tracer.spans.find((s) => s.name === "serendipity.sync");
    assert.ok(sync, "the tick opened serendipity.sync");
    assert.equal(sync.attrs["serendipity.ok"], true);
    assert.equal(sync.attrs["serendipity.session"], "ok");
    assert.ok("budget.limit" in sync.attrs && "budget.exhausted" in sync.attrs, "the sweep's ledger rides the span");
    for (const [k, v] of Object.entries(sync.attrs)) {
      assert.notEqual(v, undefined, `${k} was set to undefined; unknowns stay off the span`);
    }
    // The error field is unknown on a clean tick, so it must be absent rather than "".
    assert.ok(!("serendipity.error" in sync.attrs), "a clean tick carries no error attribute");
  } finally {
    installTracing(null);
  }
});

test("a thrown tick still writes the attempt, keeps the last success, and rethrows", async () => {
  const db = fakeD1({ failOn: "FROM user_cookies" });
  db.settings.set(SYNC_OK_KEY, JSON.stringify({ at: "2026-09-29T00:23:00.000Z", ok: true, session: "ok" }));
  const tracer = recordingTracer();
  installTracing(tracer);
  try {
    await assert.rejects(() => withLuma(EMPTY_FEED, () => cronSerendipity(db)), /D1 refused/);
    const attempt = JSON.parse(db.settings.get(SYNC_ATTEMPT_KEY));
    assert.equal(attempt.ok, false);
    assert.match(attempt.error, /D1 refused/);
    assert.equal(JSON.parse(db.settings.get(SYNC_OK_KEY)).at, "2026-09-29T00:23:00.000Z",
      "a failure must never overwrite the last success, or staleness could not be read");

    const sync = tracer.spans.find((s) => s.name === "serendipity.sync");
    assert.equal(sync.attrs["serendipity.ok"], false);
    assert.match(sync.attrs["serendipity.error"], /D1 refused/);
    // Nothing was fetched, so the counts are unknown rather than zero.
    for (const k of ["serendipity.events_fetched", "serendipity.events_new", "serendipity.guest_events", "serendipity.fetches", "budget.spent"]) {
      assert.ok(!(k in sync.attrs), `${k} was set on a tick that never measured it`);
    }
  } finally {
    installTracing(null);
  }
});

test("a rejected session is a failed tick even though nothing throws", async () => {
  // The state this whole change exists for: Luma answers 401, syncEvents
  // returns it, and the cron completes normally.
  const db = fakeD1();
  const record = await withLuma(() => new Response("unauthorized", { status: 401 }), () => cronSerendipity(db));
  assert.equal(record.ok, false);
  assert.equal(record.session, "rejected");
  assert.match(record.error, /Luma 401/);
  assert.ok(!db.settings.has(SYNC_OK_KEY), "a rejected session is not a success");
  const line = syncHealthLine(await readSyncHealth(dbShim(db)), Date.parse(record.at) + 60_000);
  assert.match(line, /data-sync="stale"/, "no success on record reads as stale");
  assert.match(line, /Luma refused the stored session/);
  assert.doesNotMatch(line, /unauthorized/, "the raw Luma body stays off the public page");
});

test("no enabled cookie set is recorded as a halt rather than skipped silently", async () => {
  const db = fakeD1({ sets: [] });
  const record = await cronSerendipity(db);
  assert.equal(record.ok, false);
  assert.equal(record.session, "none");
  assert.equal(JSON.parse(db.settings.get(SYNC_ATTEMPT_KEY)).error, "no enabled cookie sets");
});

// readSyncHealth takes the module's db() shim; this is its read half.
function dbShim(db) {
  return {
    prepare: (sql) => ({
      all: async (...a) => (await db.SERENDIPITY_DB.prepare(sql).bind(...a).all()).results,
    }),
  };
}

test("the record folds counts it can read and leaves the rest undefined", () => {
  const r = summarizeSync({
    at: "2026-09-30T00:23:00.000Z",
    out: { events: [{ synced: 10, new: 3, pages: 3 }, { error: "Luma 403: nope", pages: 1 }], guests: [], skipped: [], descriptions: { error: "x" } },
    sets: 2, budget: null, thrown: null,
  });
  assert.equal(r.ok, true, "one set syncing refreshes the pool");
  assert.equal(r.session, "rejected", "the worst session state is the one reported");
  assert.equal(r.events_fetched, 10);
  assert.equal(r.events_updated, 7);
  assert.equal(r.event_pages, 4);
  assert.match(r.error ?? "", /^1 of 2 set\(s\) failed: Luma 403/);
  assert.equal(r.descriptions_filled, undefined, "a failed description pass is unknown, not 0 filled");
  assert.equal(r.guest_events, undefined, "no ledger means the roster pass never ran");
  const attrs = syncSpanAttrs(r);
  assert.ok(!("serendipity.at" in attrs), "the timestamp is the span's own, not an attribute");
  assert.equal(attrs["serendipity.events_updated"], 7);
});

test("the dashboard line reads ok, error and stale against two ticks of the declared schedule", () => {
  const now = Date.parse("2026-09-30T12:30:00.000Z");
  /** @type {(at: string, ok: boolean) => import("../serendipity/serendipity.ts").SyncRecord} */
  const rec = (at, ok) => ({ at, ok, session: ok ? "ok" : "error", events_fetched: 42 });
  const fresh = rec("2026-09-30T12:23:00.000Z", true);
  assert.match(syncHealthLine({ attempt: fresh, lastOk: fresh }, now), /data-sync="ok">Last Luma sync 7 min ago: ok, 42 events\./);

  const failed = rec("2026-09-30T12:23:00.000Z", false);
  const okEarlier = rec("2026-09-30T06:23:00.000Z", true);
  assert.match(syncHealthLine({ attempt: failed, lastOk: okEarlier }, now), /data-sync="error".*the sync failed/,
    "one failed tick after a recent success is an error, not yet stale");

  const okOld = rec(new Date(now - SYNC_STALE_MS - 60_000).toISOString(), true);
  assert.match(syncHealthLine({ attempt: failed, lastOk: okOld }, now), /data-sync="stale".*<b>Stale:<\/b> the last good sync was 12h ago/);
  assert.match(syncHealthLine({ attempt: null, lastOk: null }, now), /data-sync="none"/);
});

test("the stale threshold is two ticks of the schedule cloudflare.config.ts declares", async () => {
  const site = parseJsonc(await configText("cloudflare.config.ts"));
  const crons = site.triggers?.crons ?? [];
  assert.ok(crons.length >= 4, `read ${crons.length} crons; the reader stopped matching`);
  assert.ok(crons.includes(SYNC_SCHEDULE), `SYNC_SCHEDULE "${SYNC_SCHEDULE}" is not a declared trigger (${crons.join(", ")})`);
  assert.equal(cronJob(SYNC_SCHEDULE), "serendipity", "the schedule reaches the serendipity job");
  assert.equal(scheduleIntervalMs("23 */6 * * *"), 6 * 3_600_000);
  assert.equal(scheduleIntervalMs("7,37 * * * *"), 3_600_000);
  assert.equal(scheduleIntervalMs("41 5 * * *"), 24 * 3_600_000);
  assert.equal(SYNC_STALE_MS, 2 * scheduleIntervalMs(SYNC_SCHEDULE));
});
