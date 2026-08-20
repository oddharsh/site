// ── the Luma session jar ────────────────────────────────────────────
// Split from contract-tests.test.mjs; shared imports live in contract-shared.mjs.
import {
  ROOT,
  SERENDIPITY_SYNC_LIMITS,
  assert,
  cookieJar,
  parseCookies,
  readFile,
  staleGuestIds,
  test,
} from "./contract-shared.mjs";

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

test("serendipity hides collapsed description chrome and uses the Luna scrollbar", async () => {
  const serendipity = await readFile(new URL("serendipity/serendipity.js", ROOT), "utf8");
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
