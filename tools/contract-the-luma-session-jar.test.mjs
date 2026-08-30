// ── the Luma session jar ────────────────────────────────────────────
// Split from contract-tests.test.mjs; shared imports live in contract-shared.mjs.
import {
  ROOT,
  SERENDIPITY_SYNC_LIMITS,
  adminGated,
  assert,
  cookieJar,
  dispatchEnrich,
  enrichBatchLimit,
  fetchBudget,
  fetchEventGuests,
  guestSweepBudget,
  mayPruneRoster,
  parseCookies,
  parseGuestSyncMark,
  readFile,
  staleGuestIds,
  test,
} from "./contract-shared.ts";

// ── the Luma session jar ────────────────────────────────────────────
// Two failure modes these guard. (1) A whole-domain browser export drags in
// cookies that must never be stored or replayed: __cf_bm is a 30-minute,
// IP-bound Cloudflare bot-management token, and replaying a stale one from
// Worker egress IPs reads as a scraper. (2) Luma rotates luma.* cookies via
// Set-Cookie on api2 responses; a client that drops those ends up presenting
// a key Luma no longer honours, which is how the deployed sync went stale
// where local dev (cookies pasted minutes earlier) never did.

const LUMA_EXPORT = JSON.stringify([
  { name: "__cf_bm", value: "edge-noise", domain: ".luma.com" },
  { name: "luma.auth-session-key", value: "usr-abc123.token0", domain: ".luma.com", expirationDate: 1800000000 },
  { name: "__stripe_mid", value: "stripe-noise", domain: ".luma.com" },
  { name: "luma.did", value: "device-1", domain: ".luma.com" },
]);

test("parseCookies keeps only luma.* cookies and reads the user id off the session key", () => {
  const parsed = parseCookies(LUMA_EXPORT);
  const names = JSON.parse(parsed.cookiesJson).cookies.map((c) => c.name).sort();
  assert.deepEqual(names, ["luma.auth-session-key", "luma.did"]);
  assert.equal(parsed.lumaUserId, "usr-abc123");
});

test("parseCookies filters the header-string form too; a junk-only paste gets the human message", () => {
  const parsed = parseCookies("__cf_bm=noise; luma.auth-session-key=usr-x.y");
  assert.deepEqual(JSON.parse(parsed.cookiesJson).cookies.map((c) => c.name), ["luma.auth-session-key"]);
  assert.throws(() => parseCookies('[{"name":"__cf_bm","value":"noise"}]'), /Missing luma\.auth-session-key/);
});

const setCookieRes = (...lines) => {
  const h = new Headers();
  for (const l of lines) h.append("set-cookie", l);
  return { headers: h };
};

test("cookieJar strips stored junk on load and marks itself dirty so the row heals on the next sync", () => {
  const jar = cookieJar(JSON.stringify({ cookies: [
    { name: "__cf_bm", value: "stale" },
    { name: "luma.auth-session-key", value: "usr-x.token0" },
  ] }));
  assert.equal(jar.header(), "luma.auth-session-key=usr-x.token0");
  assert.equal(jar.dirty, true);
  const healed = cookieJar(jar.json());
  assert.equal(healed.dirty, false, "a healed jar must not rewrite itself every sync");
});

test("cookieJar absorbs a luma.* rotation, ignores edge noise, and turns Max-Age into an absolute expiry", () => {
  const jar = cookieJar(JSON.stringify({ cookies: [{ name: "luma.auth-session-key", value: "usr-x.token0" }] }));
  assert.equal(jar.dirty, false);
  jar.absorb(setCookieRes(
    "__cf_bm=fresh-noise; Path=/; Expires=Thu, 30 Jul 2026 21:41:05 GMT; HttpOnly; Secure",
    "luma.auth-session-key=usr-x.token1; Max-Age=31536000; Path=/; HttpOnly; Secure",
  ));
  assert.equal(jar.dirty, true);
  assert.equal(jar.header(), "luma.auth-session-key=usr-x.token1", "the NEXT request must send what Luma just issued");
  const stored = JSON.parse(jar.json()).cookies;
  assert.equal(stored.length, 1, "__cf_bm from the response must not enter the jar");
  assert.ok(stored[0].expires > Date.now() / 1000, "Max-Age lands as absolute epoch seconds");
});

test("cookieJar treats a same-value re-issue as clean and an explicit deletion as removal", () => {
  const jar = cookieJar(JSON.stringify({ cookies: [
    { name: "luma.auth-session-key", value: "usr-x.token0" },
    { name: "luma.did", value: "device-1" },
  ] }));
  jar.absorb(setCookieRes("luma.auth-session-key=usr-x.token0; Path=/"));
  assert.equal(jar.dirty, false, "a same-value re-issue is not a rotation");
  jar.absorb(setCookieRes("luma.did=; Max-Age=0; Path=/"));
  assert.equal(jar.dirty, true);
  assert.equal(jar.header(), "luma.auth-session-key=usr-x.token0");
});

test("cookieJar learns a brand-new luma.* cookie from a response", () => {
  const jar = cookieJar(JSON.stringify({ cookies: [{ name: "luma.auth-session-key", value: "usr-x.t" }] }));
  jar.absorb(setCookieRes("luma.polyjuice.sign-in-state=abc; Path=/; Secure"));
  assert.equal(jar.dirty, true);
  assert.match(jar.header(), /luma\.polyjuice\.sign-in-state=abc/);
});

test("serendipity keeps historical feed and roster backfills alive", () => {
  assert.equal(SERENDIPITY_SYNC_LIMITS.pastPages, 4,
    "the Worker port must retain the original app's four-page event history");
  assert.ok(SERENDIPITY_SYNC_LIMITS.pastGuestEvents > 0,
    "each scheduled pass must advance the past-event roster backlog");

  const next = [{ id: "still-going" }, { id: "self" }, { id: null }, null];
  assert.deepEqual(
    staleGuestIds(["still-going", "cancelled", "self"], next, "self"),
    ["cancelled", "self"],
    "a fresh roster removes stale links and never retains the contributor as their own attendee",
  );
});


// ── the roster sweep's fetch budget ─────────────────────────────────
// Seven past events sat parked on "Too many subrequests by single Worker
// invocation" (last written 2026-08-21 12:24:07) because fetchEventGuests
// paginated `while (true)` with no cap: one 1,932-person roster costs 20 fetches
// at 100 a page, which is most of a Workers Free invocation on its own. These
// pin the budget, the resume, and above all the prune gate.

test("a budget-limited roster walk stops on the budget and hands back its cursor", async () => {
  const pages = [
    { entries: [{ api_id: "g1", user: {} }], has_more: true, next_cursor: "c1" },
    { entries: [{ api_id: "g2", user: {} }], has_more: true, next_cursor: "c2" },
    { entries: [{ api_id: "g3", user: {} }], has_more: false, next_cursor: null },
  ];
  const seenCursors = [];
  const real = globalThis.fetch;
  globalThis.fetch = /** @type {any} */ (async (/** @type {string} */ url) => {
    const cursor = new URL(url).searchParams.get("pagination_cursor");
    seenCursors.push(cursor);
    const idx = cursor === null ? 0 : Number(String(cursor).slice(1));
    return { ok: true, json: async () => pages[idx] };
  });
  try {
    const budget = fetchBudget(2);
    const first = await fetchEventGuests("evt-x", null, "cookie=1", { budget });
    assert.equal(first.done, false, "a walk that ran out of budget has not finished");
    assert.equal(first.cursor, "c2", "an unfinished walk must return where to resume");
    assert.equal(first.guests.length, 2);
    assert.equal(budget.spent, 2, "it spends exactly the budget it was given");
    assert.equal(budget.left, 0);

    // the resumed pass picks up at the cursor rather than re-buying page one
    const rest = await fetchEventGuests("evt-x", null, "cookie=1", {
      budget: fetchBudget(10), cursor: first.cursor,
    });
    assert.equal(rest.done, true);
    assert.equal(rest.guests.length, 1, "resuming returns the tail, never the whole roster");
    assert.deepEqual(seenCursors, [null, "c1", "c2"], "no page is fetched twice across the two passes");
  } finally { globalThis.fetch = real; }
});

test("an unbudgeted roster walk still finishes, so the manual path is unchanged", async () => {
  const real = globalThis.fetch;
  globalThis.fetch = /** @type {any} */ (async () => ({ ok: true, json: async () => ({ entries: [{ api_id: "g1", user: {} }], has_more: false, next_cursor: null }) }));
  try {
    const out = await fetchEventGuests("evt-x", null, "cookie=1");
    assert.equal(out.done, true);
    assert.equal(out.guests.length, 1);
  } finally { globalThis.fetch = real; }
});

test("a roster is only pruned by a pass that saw all of it in one invocation", () => {
  // THE regression this whole change exists to prevent. syncGuests deletes every
  // stored link absent from the response, so pruning against a partial page (or
  // against a resumed pass, which holds only the tail) would delete the guests
  // the earlier pages already stored: 1,932 rows down to 100 on a real event.
  assert.equal(mayPruneRoster({ done: true }, null), true,
    "a complete walk from the start is the one authoritative case");
  assert.equal(mayPruneRoster({ done: false, cursor: "c1" }, null), false,
    "a budget-limited pass holds one page and must never prune");
  assert.equal(mayPruneRoster({ done: true }, "c1"), false,
    "a RESUMED pass ends done while holding only the tail -- done alone is not enough");
  assert.equal(mayPruneRoster({ done: false }, "c1"), false);
  assert.equal(mayPruneRoster(null, null), false, "no page means nothing was learned");
});

test("a parked cursor round-trips through the guest-sync marker", () => {
  assert.deepEqual(parseGuestSyncMark("partial:250@cur-abc"), { cursor: "cur-abc", seen: 250 });
  // Luma cursors are opaque: splitting on every "@" would truncate one that
  // contains its own separator, so only the first is a separator.
  assert.deepEqual(parseGuestSyncMark("partial:100@cur@with@ats"), { cursor: "cur@with@ats", seen: 100 });
  // everything else starts from the top rather than resuming into nonsense
  for (const v of ["ok:1932", "error:GUEST_LIST_RESTRICTED", "partial:5@", "partial:nope", "", null, undefined]) {
    assert.deepEqual(parseGuestSyncMark(v), { cursor: null, seen: 0 }, `"${v}" must not resume`);
  }
});

test("the sweep budget leaves room for the two passes that bracket it", () => {
  const perSet = SERENDIPITY_SYNC_LIMITS.futurePages + SERENDIPITY_SYNC_LIMITS.pastPages;
  const one = guestSweepBudget(1, 50);
  assert.ok(one > 0, "one contributor must still get a workable sweep budget");
  assert.ok(one + perSet + 10 <= 50, "the sweep may not claim what syncEvents and syncDescriptions will spend");
  assert.ok(guestSweepBudget(2, 50) < one, "a second cookie set costs the sweep its own page allowance");
  assert.equal(guestSweepBudget(99, 50), 0, "an impossible reservation floors at zero rather than going negative");
});


// ── the enrichment tier ─────────────────────────────────────────────────
// Enrichment had never run automatically: it was absent from cronSerendipity
// entirely, and EXA_API_KEY was unset, so 86 of 16,839 attendees carried a
// profile and the newest was 2026-05-31. These pin the automatic tier.

test("the admin gate takes the secret from a header as well as the query string", () => {
  const env = { SYNC_SECRET: "s3cret" };
  const req = (url, headers) => new Request(url, { headers: headers || {} });
  assert.equal(adminGated(req("https://x/serendipity/enrich?key=s3cret"), env), true, "query form still works");
  assert.equal(adminGated(req("https://x/serendipity/enrich", { "x-sync-key": "s3cret" }), env), true, "header form works");
  assert.equal(adminGated(req("https://x/serendipity/enrich?key=nope"), env), false);
  assert.equal(adminGated(req("https://x/serendipity/enrich", { "x-sync-key": "nope" }), env), false);
  assert.equal(adminGated(req("https://x/serendipity/enrich"), env), false, "no secret at all is refused");
  // an unset SYNC_SECRET must never make the gate permissive
  assert.equal(adminGated(req("https://x/serendipity/enrich?key=undefined"), {}), false);
  assert.equal(adminGated(req("https://x/serendipity/enrich"), {}), false);
});

test("the enrich batch limit clamps, defaults, and refuses garbage", () => {
  assert.equal(enrichBatchLimit("3"), 3);
  assert.equal(enrichBatchLimit("50"), 10, "the manual ceiling is 10, ~41 ops of a 50-subrequest invocation");
  assert.equal(enrichBatchLimit(null), 6, "the cron default is 6, ~25 ops");
  for (const junk of ["", "abc", "0", "-4", undefined]) {
    assert.equal(enrichBatchLimit(junk), 6, `"${junk}" falls back rather than sending 0 or a negative LIMIT`);
  }
});

test("the cron enrich dispatch never puts the secret in the URL", async () => {
  // A query-string secret lands in request logs. The whole reason adminGated
  // grew a header arm is this one call, so the property is worth pinning.
  let seen = null;
  await dispatchEnrich(
    { SYNC_SECRET: "s3cret", EXA_API_KEY: "k", HOST_PUBLIC_URL: "https://aadhar.sh" },
    async (url, init) => { seen = { url, init }; return { ok: true, json: async () => ({ enriched: [] }) }; },
  );
  assert.ok(seen, "it dispatched");
  assert.ok(!seen.url.includes("s3cret"), `the secret must not appear in the URL: ${seen.url}`);
  assert.equal(seen.init.headers["x-sync-key"], "s3cret", "it travels as a header instead");
  assert.equal(seen.init.method, "POST");
  assert.match(seen.url, /\/serendipity\/enrich\?upcoming=1&limit=6$/, "it asks for the upcoming tier at the cron batch size");
});

test("the cron enrich dispatch skips cleanly when it is not configured", async () => {
  // This is production's state until EXA_API_KEY is set, so the skip has to be
  // quiet and self-describing rather than an error on every tick.
  let called = false;
  const spy = async () => { called = true; return { ok: true, json: async () => ({}) }; };
  assert.deepEqual(await dispatchEnrich({ SYNC_SECRET: "s" }, spy), { skipped: "EXA_API_KEY not set" });
  assert.deepEqual(await dispatchEnrich({ EXA_API_KEY: "k" }, spy), { skipped: "no SYNC_SECRET" });
  assert.equal(called, false, "an unconfigured dispatch must not spend a subrequest");
});

test("the cron enrich dispatch reports outcomes and swallows its own failures", async () => {
  const env = { SYNC_SECRET: "s", EXA_API_KEY: "k" };
  const ok = await dispatchEnrich(env, async () => ({
    ok: true,
    json: async () => ({ enriched: [{ outcome: "success" }, { outcome: "success" }, { outcome: "not_found" }] }),
  }));
  assert.deepEqual(ok, { attempted: 3, outcomes: { success: 2, not_found: 1 } });

  // enrichment is the lower-priority half: it may never redden a tick whose
  // roster sweep succeeded, so every failure shape returns rather than throws.
  assert.deepEqual(await dispatchEnrich(env, async () => ({ ok: false, status: 500, json: async () => ({}) })), { error: "enrich 500" });
  assert.deepEqual(await dispatchEnrich(env, async () => { throw new Error("boom"); }), { error: "boom" });
  const weird = await dispatchEnrich(env, async () => ({ ok: true, json: async () => ({}) }));
  assert.deepEqual(weird, { attempted: 0, outcomes: {} }, "a body with no enriched array is 0 attempted, not a crash");
});

test("the contribute page reads its complete summary in one D1 call", async () => {
  const { handleSerendipity } = await import("../serendipity/serendipity.ts");
  let calls = 0;
  const SERENDIPITY_DB = { prepare(sql) {
    return { bind(uid) {
      return { async first() {
        calls++;
        await new Promise((resolve) => setTimeout(resolve, 10));
        if (!sql.includes("AS active_count") || !sql.includes("AS event_count")) throw new Error(`unexpected contribute query: ${sql}`);
        return uid === "abc"
          ? { active_count: 2, user_key: "abc", label: "mine", enabled: 1, event_count: 7 }
          : { active_count: 2, user_key: null, label: null, enabled: null, event_count: 0 };
      } };
    } };
  } };

  const response = await handleSerendipity(
    new Request("https://aadhar.sh/serendipity/contribute", { headers: { cookie: "serendipity-uid=abc" } }),
    { SERENDIPITY_DB },
    { waitUntil() {} },
  );
  assert.equal(response.status, 200);
  const body = await response.text();
  assert.match(body, /2 active contributors/);
  assert.match(body, /7 events from your feed/);

  const anonymous = await handleSerendipity(
    new Request("https://aadhar.sh/serendipity/contribute"),
    { SERENDIPITY_DB },
    { waitUntil() {} },
  );
  assert.doesNotMatch(await anonymous.text(), /events from your feed/);
  assert.equal(calls, 2, "connected and anonymous renders should spend one D1 subrequest apiece");
});

test("serendipity hides collapsed description chrome and uses the Luna scrollbar", async () => {
  const serendipity = await readFile(new URL("serendipity/serendipity.ts", ROOT), "utf8");
  const luna = await readFile(new URL("src/styles/luna.css", ROOT), "utf8");

  assert.match(
    serendipity,
    /\.evdesc\[hidden="until-found"\]\{margin:0;padding:0;border:0\}/,
    "hidden-until-found must not leave the description panel's padding and border visible",
  );
  assert.match(
    luna,
    /\.window>\.body>\.content[^{}]*\{scrollbar-color:auto\}/,
    "the nested Serendipity scroller must reset the inherited standard color for Chromium",
  );
  for (const part of ["", "-track", "-thumb", "-thumb:hover", "-button:single-button", "-corner"]) {
    assert.match(
      luna,
      new RegExp(`\\.window>\\.body>\\.content::\\-webkit-scrollbar${part}`),
      `the nested Serendipity scroller must carry the Luna ${part || "bar"} rule`,
    );
  }
});
