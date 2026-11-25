// ── user-bytes: a visit is priced by what the visitor holds ──
import { assert, test } from "./contract-shared.ts";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { aggregate, bootstrapDelta, classifyRequest, compare, criticalMs, pageLoads, priceVisit, readTree, rowsQuery, total } from "../lib/user-bytes.ts";
import type { LogRow, Views } from "../lib/user-bytes.ts";

// tools/user-bytes.ts weighs two built trees by last week's Workers Logs.
// These fixtures stand in for both halves: log rows shaped like the SQL the
// CLI sends, and trees with the file names build.ts writes, sized so every
// price below is a sum a reader can check by hand.

const CHROME = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/158.0.0.0 Safari/537.36";
const SAFARI = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.1 Safari/605.1.15";
const row = (over: Partial<LogRow>): LogRow => ({
  path: "/",
  ua: CHROME,
  ae: "gzip, deflate, br",
  dict: null,
  chua: '"Chromium";v="158"',
  site: "none",
  ref: null,
  vbot: null,
  asorg: "Comcast Cable Communications",
  rtt: 20,
  status: 200,
  method: "GET",
  si: 10,
  ...over,
});
// Available-Dictionary for a dictionary whose first 8 digest bytes are 0..7.
const HELD = `:${Buffer.from(Array.from({ length: 32 }, (_, i) => i)).toString("base64")}:`;

test("user-bytes: the log query reads the client's Accept-Encoding, not the edge's rewrite (gotcha 114)", () => {
  const sql = rowsQuery(7);
  assert.equal(sql.includes("attributes['$workers.event.request.cf.clientAcceptEncoding'] AS ae"), true);
  assert.equal(sql.includes("headers.accept-encoding"), false);
  assert.equal(sql.includes("INTERVAL '7' DAY"), true);
});

test("user-bytes: a dcz offer with Available-Dictionary is a returning Chromium visitor", () => {
  assert.deepEqual(classifyRequest(row({ ae: "gzip, deflate, br, dcb, dcz", dict: HELD }), "strict"), {
    kind: "person",
    chromium: true,
    tag: "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f",
    warm: true,
  });
  // The same header without dcz in the client's Accept-Encoding holds nothing usable.
  assert.deepEqual(classifyRequest(row({ dict: HELD }), "strict"), { kind: "person", chromium: true, tag: null, warm: false });
  assert.deepEqual(classifyRequest(row({ ua: SAFARI, chua: null, site: "same-origin" }), "strict"), { kind: "person", chromium: false, tag: null, warm: true });
});

test("user-bytes: the ledger's crawlers and this repo's own tools are bots under either rule", () => {
  const gptbot = row({ ua: "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; GPTBot/1.1; +https://openai.com/gptbot" });
  assert.deepEqual(classifyRequest(gptbot, "loose"), { kind: "bot", reason: "ledger" });
  const check = row({ ua: `${CHROME.replace("Chrome/", "HeadlessChrome/")} aadhar-sh-browser-check/1.0 (+https://aadhar.sh/bot)` });
  assert.deepEqual(classifyRequest(check, "loose"), { kind: "bot", reason: "ua-token" });
  assert.deepEqual(classifyRequest(row({}), "loose"), { kind: "person", chromium: true, tag: null, warm: false });
});

test("user-bytes: the inferred bot rules apply under strict and not under loose", () => {
  const spoofed = row({ chua: null });
  assert.deepEqual(classifyRequest(spoofed, "strict"), { kind: "bot", reason: "no-client-hints" });
  assert.deepEqual(classifyRequest(spoofed, "loose"), { kind: "person", chromium: true, tag: null, warm: false });
  assert.deepEqual(classifyRequest(row({ ref: "https://aadhar.sh" }), "strict"), { kind: "bot", reason: "header-mismatch" });
  assert.deepEqual(classifyRequest(row({ asorg: "Tencent Cloud Computing (Beijing) Co., Ltd" }), "strict"), { kind: "bot", reason: "datacenter" });
});

test("user-bytes: a HEAD or a 304 downloads no page and is skipped", () => {
  assert.deepEqual(classifyRequest(row({ method: "HEAD" }), "loose"), { kind: "skip", reason: "method" });
  assert.deepEqual(classifyRequest(row({ status: 304 }), "loose"), { kind: "skip", reason: "status" });
});

test("user-bytes: aggregate weighs each row by its sample interval and folds /garage/ into /garage", () => {
  const t = aggregate([row({ path: "/garage/" }), row({ path: "/garage", si: 1 }), row({ ua: "", si: 10 })], 7, "loose");
  assert.deepEqual(t.views, [{ path: "/garage", chromium: true, tag: null, warm: false, views: 11 }]);
  assert.deepEqual(t.bots, { "no-ua": 10 });
  assert.equal(t.rttMs, 20);
});

test("user-bytes: only the head's sheets and classic scripts block, and <noscript> is not read", () => {
  const html = [
    "<!doctype html><html><head>",
    "<link href=/a/luna.aaaaaaaa.css rel=stylesheet>",
    "<link href=/a/print.aaaaaaaa.css media=print rel=stylesheet>",
    "<noscript><link href=/a/fallback.aaaaaaaa.css rel=stylesheet></noscript>",
    "<script src=/a/sync.aaaaaaaa.js></script><script defer src=/a/nav.bbbbbbbb.js></script>",
    '<script type=application/ld+json>{"x":"/a/data.aaaaaaaa.json"}</script>',
    "<script>import(`/a/md.cccccccc.js`);fetch(`/a/manifest.ffffffff.json`)</script>",
    "</head><body><link href=/a/quiz.dddddddd.css rel=stylesheet><img src=/a/icons.eeeeeeee.svg#pin>",
  ].join("");
  assert.deepEqual(pageLoads(html), [
    { url: "/a/luna.aaaaaaaa.css", blocking: true },
    { url: "/a/print.aaaaaaaa.css", blocking: false },
    { url: "/a/sync.aaaaaaaa.js", blocking: true },
    { url: "/a/nav.bbbbbbbb.js", blocking: false },
    { url: "/a/quiz.dddddddd.css", blocking: false },
    { url: "/a/icons.eeeeeeee.svg", blocking: false },
    { url: "/a/md.cccccccc.js", blocking: false },
    { url: "/a/manifest.ffffffff.json", blocking: false },
  ]);
});

test("user-bytes: one byte past the initial window costs one more round trip", () => {
  const link = { mbps: 50, rttMs: 20 }; // 6,250 B per ms; the link fills at 125,000 B in flight
  assert.equal(criticalMs(14_600, 0, link), 22.336); // 20 + 14,600 / 6,250
  assert.equal(criticalMs(14_601, 0, link), 40.00016); // 20 + 20 + 1 / 6,250
  // A blocking sheet is a second request round on the window the page left.
  assert.equal(criticalMs(1000, 1000, link), 40.32); // (20 + 1,000 / 6,250) twice
});

// ── trees ────────────────────────────────────────────────────────────────────

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const LUNA = "p{color:red}";
const NAV_A = "console.log('a')";
const NAV_B = "console.log('b')";
const FAMILY_A = "family dictionary a";
const FAMILY_C = "family dictionary c";
const PAGE = "<!doctype html><head><link href=/a/luna.aaaaaaaa.css rel=stylesheet><script defer src=/a/NAV></script></head><body>hi";

function tree(files: Record<string, string | number>): string {
  const root = mkdtempSync(join(tmpdir(), "user-bytes-"));
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), typeof body === "number" ? "x".repeat(body) : body);
  }
  return root;
}
// A: the deployed build, with a nav.css that sorts ahead of nav.js and is
// not nav.js's predecessor. B: nav.js re-minted, a delta against A's nav,
// the page 10 B smaller. C: B with the family dictionary rolled, so C has page
// deltas only against its own family.
const A = tree({
  "index.html": PAGE.replace("NAV", "nav.bbbbbbbb.js"),
  "index.html.br": 1000,
  "a/luna.aaaaaaaa.css": LUNA,
  "a/luna.aaaaaaaa.css.br": 300,
  "a/nav.bbbbbbbb.js": NAV_A,
  "a/nav.bbbbbbbb.js.br": 200,
  "a/nav.aaaaaaaa.css": "nav{}",
  "a/page-family.cccccccc.dict": FAMILY_A,
  "a/page-family.cccccccc.dict.br": 500,
  [`pd/index.${sha256(FAMILY_A)}.dcz`]: 100,
});
const B = tree({
  "index.html": PAGE.replace("NAV", "nav.dddddddd.js"),
  "index.html.br": 990,
  "a/luna.aaaaaaaa.css": LUNA,
  "a/luna.aaaaaaaa.css.br": 300,
  "a/nav.dddddddd.js": NAV_B,
  "a/nav.dddddddd.js.br": 210,
  [`ad/nav.dddddddd.${sha256(NAV_A)}.dcz`]: 40,
  "a/page-family.cccccccc.dict": FAMILY_A,
  "a/page-family.cccccccc.dict.br": 500,
  [`pd/index.${sha256(FAMILY_A)}.dcz`]: 95,
});
const C = tree({
  "index.html": PAGE.replace("NAV", "nav.dddddddd.js"),
  "index.html.br": 990,
  "a/luna.aaaaaaaa.css": LUNA,
  "a/luna.aaaaaaaa.css.br": 300,
  "a/nav.dddddddd.js": NAV_B,
  "a/nav.dddddddd.js.br": 210,
  "a/page-family.eeeeeeee.dict": FAMILY_C,
  "a/page-family.eeeeeeee.dict.br": 520,
  [`pd/index.${sha256(FAMILY_C)}.dcz`]: 90,
});
const a = readTree(A, ["/", "/serendipity/event/x"]);
const b = readTree(B, ["/"]);
const c = readTree(C, ["/"]);
const view = (over: Partial<Views>): Views => ({ path: "/", chromium: true, tag: null, warm: false, views: 1, ...over });
const holder = view({ tag: "held", warm: true });

test("user-bytes: a cold Chromium visit pays brotli for every file plus the family dictionary", () => {
  assert.deepEqual(priceVisit(view({}), a), { html: 1000, blocking: 300, deferred: 200, dictionary: 500 });
  assert.deepEqual(priceVisit(view({ chromium: false }), a), { html: 1000, blocking: 300, deferred: 200, dictionary: 0 });
});

test("user-bytes: a settled dictionary holder pays the family delta and nothing else", () => {
  assert.deepEqual(priceVisit(holder, a), { html: 100, blocking: 0, deferred: 0, dictionary: 0 });
});

test("user-bytes: older build snapshots still price their short-named deltas", () => {
  const legacy = tree({
    "index.html": "<html><head></head><body>hi",
    "index.html.br": 1000,
    "a/page-family.cccccccc.dict": FAMILY_A,
    "a/page-family.cccccccc.dict.br": 500,
    [`pd/index.${sha256(FAMILY_A).slice(0, 16)}.dcz`]: 100,
  });
  assert.equal(priceVisit(holder, readTree(legacy, ["/"]))?.html, 100);
});

test("user-bytes: the first visit after a re-mint takes the shell delta against the file the visitor holds", () => {
  assert.deepEqual(priceVisit(holder, b, a), { html: 95, blocking: 0, deferred: 40, dictionary: 0 });
  // Safari holds the same files but can't take a delta, so the new nav is brotli.
  assert.deepEqual(priceVisit(view({ chromium: false, warm: true }), b, a), { html: 990, blocking: 0, deferred: 210, dictionary: 0 });
});

test("user-bytes: a rolled family costs a holder brotli for the page once, plus the new dictionary", () => {
  assert.deepEqual(priceVisit(holder, c, a), { html: 990, blocking: 0, deferred: 210, dictionary: 520 });
  assert.equal(total(priceVisit(holder, c)!), 90);
});

test("user-bytes: a Worker-rendered page is in neither tree and is reported, never priced", () => {
  assert.equal(priceVisit(view({ path: "/serendipity/event/x" }), a), null);
  const cmp = compare([view({ views: 3 }), holder, view({ path: "/serendipity/event/x", views: 5 })], a, b, { mbps: 50, rttMs: 20 });
  assert.equal(cmp.priced, 4);
  assert.equal(cmp.unpriced, 5);
  // 3 cold views at 2000 -> 2000 (luna and the family unchanged, nav 200 -> 210, page 1000 -> 990), 1 holder at 100 -> 95.
  assert.deepEqual(cmp.steady.a.bytes, (3 * 2000 + 100) / 4);
  assert.deepEqual(cmp.steady.b.bytes, (3 * 2000 + 95) / 4);
  assert.deepEqual(cmp.remint, {
    returning: 1,
    first: { bytes: 135, ms: criticalMs(95, 0, { mbps: 50, rttMs: 20 }) },
    settled: { bytes: 95, ms: criticalMs(95, 0, { mbps: 50, rttMs: 20 }) },
  });
});

test("user-bytes: the bootstrap replays from its seed, and a zero delta has a zero interval", () => {
  const rows = [view({}), view({ chromium: false }), holder];
  assert.deepEqual(bootstrapDelta(rows, a, b, 200, 7), bootstrapDelta(rows, a, b, 200, 7));
  assert.deepEqual(bootstrapDelta(rows, a, a, 200, 7), { lo: 0, hi: 0 });
  const ci = bootstrapDelta([view({})], a, b, 200, 7);
  assert.deepEqual(ci, { lo: 0, hi: 0 }); // 1000 + 200 -> 990 + 210: the cold total moves 0 B
});
