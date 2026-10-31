// ── Serendipity company pass (extractCompanies in serendipity/serendipity.ts) ──
// Clairic's answer per bio is stored beside its request hash and read by every
// people query. These pin what the pass asks, what it writes, and that a
// database the pass has not reached yet still serves the roster.
import { readFileSync } from "node:fs";
import { assert, test } from "./contract-shared.ts";
import { ATTENDEE_COMPANIES_DDL, askClairic, buildCompanyRequest, companyInputHash } from "../../serendipity/companies.ts";
import { dispatchCompanies, extractCompanies, withCompanies } from "../../serendipity/serendipity.ts";

const answer = (guess: string | null, pNull: number) => ({
  answers: { company: { type: "text", p_null: pNull, confidence: 0.9, guess, value: pNull <= 0.5 ? guess : null } },
});

test("the runtime DDL is migration 0004's statement, on one line", () => {
  const migration = readFileSync(new URL("../../serendipity/migrations/0004_attendee_companies.sql", import.meta.url), "utf8");
  const stmt = migration
    .split("\n")
    .filter((l) => l.trim() && !l.startsWith("--"))
    .join(" ")
    .replace(/;\s*$/, "");
  assert.equal(stmt, ATTENDEE_COMPANIES_DDL);
  assert.ok(!ATTENDEE_COMPANIES_DDL.includes("\n"));
});

test("askClairic calls the clairic model through the gateway and names failures by cause", async () => {
  const calls: any[] = [];
  const AI = {
    async run(model, input, options) {
      calls.push({ model, options, state: input.state });
      return answer("Paradigm", 0.02);
    },
  };
  const r = await askClairic(buildCompanyRequest("Partner at Paradigm"), { AI, AI_GATEWAY: "default" });
  assert.deepEqual(r, { prediction: { company: "Paradigm", guess: "Paradigm", pNull: 0.02, confidence: 0.9 } });
  assert.deepEqual(calls, [{ model: "@cf/cloudflare/clairic", options: { gateway: { id: "default", skipCache: true } }, state: "Partner at Paradigm" }]);
  const busy = {
    run: async () => {
      throw new Error("3040: Capacity temporarily exceeded");
    },
  };
  assert.deepEqual(await askClairic(buildCompanyRequest("x"), { AI: busy }), { error: "ai 3040" });
  assert.deepEqual(await askClairic(buildCompanyRequest("x"), { AI: { run: async () => ({ answers: {} }) } }), { error: "unparseable" });
});

// A D1 just deep enough for the pass: the scan returns `rows`, and each
// INSERT's bound args are recorded. The scan's ORDER BY was run against real
// SQLite with migrations 0001-0004 applied on 2026-10-31: never-asked bios,
// upcoming ones first, then the oldest answer.
function fakeDb(rows) {
  const writes: any[] = [];
  let ddl = 0;
  return {
    writes,
    ddl: () => ddl,
    raw: { prepare: () => ({ run: async () => void ddl++ }) },
    stmt: (sql, ...args: any[]) => ({ sql, args }),
    async batch(stmts) {
      writes.push(...stmts.map((s) => s.args));
    },
    prepare: () => ({ all: async () => rows }),
  };
}

test("extractCompanies asks only stale bios and stores the guess with its chance of none", async () => {
  const fresh = await companyInputHash(buildCompanyRequest("Partner at Paradigm"));
  const d = fakeDb([
    { id: "a1", bio_short: "Growth @ Corgi", input_hash: null },
    { id: "a2", bio_short: "Partner at Paradigm", input_hash: fresh },
    { id: "a3", bio_short: "coffee, climbing, NYC", input_hash: "stale" },
    { id: "a4", bio_short: "Gateway says no", input_hash: null },
  ]);
  const asked: string[] = [];
  const AI = {
    async run(_model, input) {
      asked.push(input.state);
      if (input.state === "Gateway says no") throw new Error("2001: Please configure AI Gateway");
      return input.state === "Growth @ Corgi" ? answer("Corgi", 0.03) : answer("NYC", 0.985);
    },
  };
  const r = await extractCompanies(d, { AI }, 10);
  assert.deepEqual(asked, ["Growth @ Corgi", "coffee, climbing, NYC", "Gateway says no"]);
  assert.deepEqual(r, { scanned: 4, asked: 3, extracted: 2, named: 1, failed: { "ai 2001": 1 }, remaining: 1 });
  assert.equal(d.ddl(), 1);
  assert.deepEqual(d.writes, [
    ["a1", "Corgi", 0.03, 0.9, "clairic", await companyInputHash(buildCompanyRequest("Growth @ Corgi"))],
    ["a3", "NYC", 0.985, 0.9, "clairic", await companyInputHash(buildCompanyRequest("coffee, climbing, NYC"))],
  ]);
});

test("extractCompanies asks at most `limit` bios a run", async () => {
  const d = fakeDb(Array.from({ length: 12 }, (_, i) => ({ id: `a${i}`, bio_short: `bio ${i}`, input_hash: null })));
  const r = await extractCompanies(d, { AI: { run: async () => answer(null, 0.9) } }, 9);
  assert.deepEqual(r, { scanned: 12, asked: 9, extracted: 9, named: 0, failed: {}, remaining: 3 });
});

test("without the AI binding the company pass skips before touching D1", async () => {
  const d = fakeDb([{ id: "a1", bio_short: "x", input_hash: null }]);
  assert.deepEqual(await extractCompanies(d, {}, 10), { skipped: "no AI binding" });
  assert.equal(d.ddl(), 0);
});

test("a people read falls back to enrichment only while attendee_companies is missing", async () => {
  const seen: string[] = [];
  const rows = await withCompanies(async (c) => {
    seen.push(c.company);
    if (c.join.includes("attendee_companies")) throw new Error("D1_ERROR: no such table: attendee_companies: SQLITE_ERROR");
    return [{ company: null }];
  });
  assert.deepEqual(rows, [{ company: null }]);
  assert.deepEqual(seen, ["COALESCE(en.company, CASE WHEN ac.p_null <= 0.1 THEN ac.company END) AS company", "en.company"]);
  await assert.rejects(
    withCompanies(async () => {
      throw new Error("D1_ERROR: no such table: attendees: SQLITE_ERROR");
    }),
    /no such table: attendees/,
  );
});

test("the cron's company dispatch reports counts and skips without a loopback", async () => {
  const env = { SYNC_SECRET: "s", AI: {} };
  assert.deepEqual(await dispatchCompanies(env, null), { skipped: "no loopback binding" });
  assert.deepEqual(await dispatchCompanies({ SYNC_SECRET: "s" }, null), { skipped: "no AI binding" });
  const posted: any[] = [];
  const ok = await dispatchCompanies(env, async (url, init) => {
    posted.push({ url, key: init?.headers?.["x-sync-key"] });
    return { ok: true, json: async () => ({ ok: true, scanned: 300, asked: 40, extracted: 40, named: 22, failed: {}, remaining: 260 }) };
  });
  assert.deepEqual(ok, { asked: 40, named: 22, failed: {}, remaining: 260 });
  assert.deepEqual(posted, [{ url: "https://aadhar.sh/serendipity/companies", key: "s" }]);
  assert.deepEqual(await dispatchCompanies(env, async () => ({ ok: false, status: 503, json: async () => ({}) })), { error: "companies 503" });
});
