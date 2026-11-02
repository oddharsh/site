// ── /guestbook: visitors claim, the server observes ─────────────────────────
//
// guestbook.ts publishes a signer's IP address and user agent beside what it
// wrote, unmoderated. These hold the guarantees that make that acceptable: the
// observed half comes from the request and never the body, a browser on another
// site can't sign for its reader, visitor text renders escaped, the one-a-day
// rule and the daily cap refuse without writing, and every surface that asks
// for a signature says the IP goes public.
//
// The SQL runs against real SQLite (node:sqlite, under bun and node both)
// through a thin D1-shaped adapter, because a fake that answers any INSERT
// can't tell a working cap from a broken one.
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { assert, test } from "./contract-shared.ts";

const gb = () => import("../../src/worker/guestbook.ts");

function d1(db = new DatabaseSync(":memory:")) {
  const statement = (sql: string, params: unknown[] = []) => ({
    bind: (...p: unknown[]) => statement(sql, p),
    first: async () => db.prepare(sql).get(...(params as never[])) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...(params as never[])) }),
    run: async () => db.prepare(sql).run(...(params as never[])),
    sql,
  });
  return {
    raw: db,
    prepare: (sql: string) => statement(sql),
    batch: async (stmts: { run: () => Promise<unknown> }[]) => Promise.all(stmts.map((s) => s.run())),
  };
}

// One database for the file: ensureTable remembers per isolate that it ran.
const DB = d1();
const env = { SOCIAL_DB: DB };

function signRequest(
  body: unknown,
  { ip = "203.0.113.7", ua = "ExampleAgent/1.0", headers = {} as Record<string, string>, cf = {} as Record<string, unknown> } = {},
) {
  const req = new Request("https://aadhar.sh/guestbook", {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": ip, "user-agent": ua, ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  Object.defineProperty(req, "cf", { value: { asn: 16509, asOrganization: "Amazon.com", country: "US", ...cf } });
  return req;
}

test("a signature records what the server saw, and ignores what the body claims about it", async () => {
  const { handleGuestbook } = await gb();
  const res = await handleGuestbook(
    signRequest({
      name: "ExampleAgent",
      purpose: "reading the AV2 notes",
      tools: ["web_fetch", "web_fetch", "md twin"],
      ip: "1.1.1.1",
      user_agent: "Mozilla/5.0",
    }),
    env,
  );
  assert.equal(res.status, 201);
  const out = await res.json();
  assert.equal(out.entry.ip, "203.0.113.7", "the IP is cf-connecting-ip, never the body's");
  assert.equal(out.entry.user_agent, "ExampleAgent/1.0");
  assert.equal(out.entry.network, "Amazon.com");
  assert.equal(out.entry.asn, 16509);
  assert.deepEqual(out.entry.tools, ["web_fetch", "md twin"], "tools dedupe");
  assert.deepEqual(out.ignored, ["ip", "user_agent"], "the reply names the fields it ignored");
  assert.match(out.public, /IP address/, "the 201 says the IP is now public");
});

test("one entry per name, address and day; a second name from the same address still signs", async () => {
  const { handleGuestbook } = await gb();
  const again = await handleGuestbook(signRequest({ name: "ExampleAgent", purpose: "back for more" }), env);
  assert.equal(again.status, 409);
  const other = await handleGuestbook(signRequest({ name: "OtherAgent", purpose: "checking robots.txt" }), env);
  assert.equal(other.status, 201);
  const n = DB.raw.prepare("SELECT count(*) AS n FROM guestbook").get() as { n: number };
  assert.equal(n.n, 2, "the refused signature wrote nothing");
});

test("the daily cap refuses inside the INSERT, so a full day writes nothing", async () => {
  const { handleGuestbook, DAILY_SIGN_CAP } = await gb();
  const day = new Date().toISOString().slice(0, 10);
  const fill = DB.raw.prepare(
    "INSERT INTO guestbook (day, at, name, purpose, tools, ip, user_agent, verified_bot) VALUES (?, 0, ?, 'x', '[]', '198.51.100.1', 'x', 0)",
  );
  const have = (DB.raw.prepare("SELECT count(*) AS n FROM guestbook WHERE day = ?").get(day) as { n: number }).n;
  for (let i = have; i < DAILY_SIGN_CAP; i++) fill.run(day, `filler-${i}`);
  const res = await handleGuestbook(signRequest({ name: "LateAgent", purpose: "arrived after the cap" }, { ip: "192.0.2.9" }), env);
  assert.equal(res.status, 503);
  const total = (DB.raw.prepare("SELECT count(*) AS n FROM guestbook WHERE day = ?").get(day) as { n: number }).n;
  assert.equal(total, DAILY_SIGN_CAP);
  DB.raw.exec("DELETE FROM guestbook WHERE name LIKE 'filler-%'");
});

test("the write guards: JSON only, no cross-site browsers, name and purpose required", async () => {
  const { handleGuestbook } = await gb();
  const form = new Request("https://aadhar.sh/guestbook", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "name=x" });
  assert.equal((await handleGuestbook(form, env)).status, 415, "a form post would skip the CORS preflight");
  const cross = await handleGuestbook(signRequest({ name: "x", purpose: "y" }, { headers: { "sec-fetch-site": "cross-site" } }), env);
  assert.equal(cross.status, 403, "another site's page must not sign with its reader's IP");
  assert.equal((await handleGuestbook(signRequest({ name: "NoReason" }), env)).status, 400);
  assert.equal((await handleGuestbook(signRequest({ purpose: "nameless" }), env)).status, 400);
  assert.equal((await handleGuestbook(signRequest({ name: "x", purpose: "y", tools: "curl" }), env)).status, 400);
  assert.equal((await handleGuestbook(signRequest("{nope"), env)).status, 400);
});

test("visitor text is one plain line, and every render escapes it", async () => {
  const { clean, renderGuestbookEntries, rowToEntry } = await gb();
  // Built from code points, so no source line carries the invisible characters themselves.
  const [rlo, bell, lrm] = [0x202e, 0x07, 0x200e].map((c) => String.fromCodePoint(c));
  assert.equal(clean(`evil${rlo}txt.exe${bell}  two\n lines${lrm}`, 80), "evil txt.exe two lines", "bidi controls and C0 controls go");
  assert.equal(clean("👨‍👩‍👧".repeat(3), 2), "👨‍👩‍👧".repeat(2), "the cap counts graphemes, never half an emoji");
  assert.equal(clean("x".repeat(500), 60)?.length, 60);
  assert.equal(clean("   ", 60), null);
  const entry = rowToEntry({
    id: 1,
    at: 0,
    name: "<script>alert(1)</script>",
    purpose: '"><IMG src=x onerror=alert(1)>',
    tools: '["<i>"]',
    note: "</blockquote><a href=javascript:alert(1)>",
    ip: "203.0.113.7",
    user_agent: "<ua>",
    verified_bot: 0,
  });
  const out = String(renderGuestbookEntries([entry], "ok"));
  assert.doesNotMatch(out, /<script|<img|<i>|<a href=javascript|<ua>/i, "a tag in any case reaches the page escaped");
  assert.match(out, /&lt;script&gt;/);
});

test("the read path never creates a table, and an empty database reads as no entries", async () => {
  const { readEntries } = await gb();
  const fresh = d1();
  assert.deepEqual(await readEntries({ SOCIAL_DB: fresh }), { state: "ok", entries: [] });
  const tables = fresh.raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all();
  assert.equal(tables.length, 0);
  assert.equal((await readEntries({})).state, "unbound");
});

test("every surface that asks for a signature says the IP goes public", async () => {
  const { renderGuestbookPage } = await gb();
  const page = await renderGuestbookPage().text();
  assert.match(page, /Signing publishes your IP address and user agent/);
  const twin = readFileSync(new URL("../../src/content/md/guestbook.md", import.meta.url), "utf8");
  assert.match(twin, /Signing publishes your IP address and user agent/);
  const { renderPrivacyPage } = await import("../../src/worker/trust.ts");
  assert.match(await renderPrivacyPage().text(), /\/guestbook<\/a> is the one place the site stores an IP address/);
});
