// ── Serendipity role pass (classifyRoles, rolePoints in serendipity/serendipity.ts) ──
// Clef's read of the kind of work in each bio is stored beside its request hash,
// and the roster ranks by it where the pass has read the bio. These pin what the
// pass writes, how a stored role turns into points, and that a database the pass
// has not reached yet still ranks by the tiers.
import { readFileSync } from "node:fs";
import { assert, test } from "./contract-shared.ts";
import { ATTENDEE_ROLES_DDL, askRole, buildRoleRequest } from "../../serendipity/roles.ts";
import { tagInputHash } from "../../serendipity/event-tags.ts";
import { attendeeScore, classifyRoles, dispatchBioPass, rolePoints, withCompanies, withRoles } from "../../serendipity/serendipity.ts";

const answer = (role: string, confidence = 0.4) => ({ answers: { role: { type: "choice", choice: role, confidence, probabilities: { [role]: confidence } } } });

test("the runtime DDL is migration 0005's statement, on one line", () => {
  const migration = readFileSync(new URL("../../serendipity/migrations/0005_attendee_roles.sql", import.meta.url), "utf8");
  const stmt = migration
    .split("\n")
    .filter((l) => l.trim() && !l.startsWith("--"))
    .join(" ")
    .replace(/;\s*$/, "");
  assert.equal(stmt, ATTENDEE_ROLES_DDL);
  assert.ok(!ATTENDEE_ROLES_DDL.includes("\n"));
});

test("askRole calls clef through the gateway and names failures by cause", async () => {
  const calls: any[] = [];
  const AI = {
    async run(model, input, options) {
      calls.push({ model, options, bio: input.state.bio });
      return answer("operator", 0.3);
    },
  };
  assert.deepEqual(await askRole(buildRoleRequest("Growth at Corgi"), { AI, AI_GATEWAY: "default" }), {
    prediction: { role: "operator", confidence: 0.3, probabilities: { operator: 0.3 } },
  });
  assert.deepEqual(calls, [{ model: "@cf/cloudflare/clef", options: { gateway: { id: "default", skipCache: true } }, bio: "Growth at Corgi" }]);
  assert.deepEqual(await askRole(buildRoleRequest("x"), { AI: { run: async () => answer("astronaut") } }), { error: "unparseable" });
  assert.deepEqual(await askRole(buildRoleRequest("x"), {}), { error: "no AI binding" });
});

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

test("classifyRoles asks only stale bios and stores the role with its probabilities", async () => {
  const fresh = await tagInputHash(buildRoleRequest("Co-Founder of EasyA"));
  const d = fakeDb([
    { id: "a1", bio_short: "Growth at Corgi", input_hash: null },
    { id: "a2", bio_short: "Co-Founder of EasyA", input_hash: fresh },
    { id: "a3", bio_short: "Espresso mornings, tennis afternoons", input_hash: "stale" },
    { id: "a4", bio_short: "Capacity says no", input_hash: null },
  ]);
  const asked: string[] = [];
  const AI = {
    async run(_model, input) {
      asked.push(input.state.bio);
      if (input.state.bio === "Capacity says no") throw new Error("3040: Capacity temporarily exceeded");
      return input.state.bio === "Growth at Corgi" ? answer("operator", 0.3) : answer("not_stated", 0.6);
    },
  };
  const r = await classifyRoles(d, { AI }, 10);
  assert.deepEqual(asked, ["Growth at Corgi", "Espresso mornings, tennis afternoons", "Capacity says no"]);
  assert.deepEqual(r, { scanned: 4, asked: 3, classified: 2, stated: 1, failed: { "ai 3040": 1 }, remaining: 1 });
  assert.equal(d.ddl(), 1);
  assert.deepEqual(d.writes, [
    ["a1", "operator", 0.3, '{"operator":0.3}', "clef", await tagInputHash(buildRoleRequest("Growth at Corgi"))],
    ["a3", "not_stated", 0.6, '{"not_stated":0.6}', "clef", await tagInputHash(buildRoleRequest("Espresso mornings, tennis afternoons"))],
  ]);
});

test("without the AI binding the role pass skips before touching D1", async () => {
  const d = fakeDb([{ id: "a1", bio_short: "x", input_hash: null }]);
  assert.deepEqual(await classifyRoles(d, {}, 10), { skipped: "no AI binding" });
  assert.equal(d.ddl(), 0);
});

test("a stored role sets the kind of work, and the bio's title tier its seniority", () => {
  // Bios from the 2026-10-31 sample, each with the role Clef gave it there.
  assert.equal(rolePoints({ bio_short: "Growth at Corgi", clef_role: "operator" }), 20, "operator work with no title: the lowest title tier");
  assert.equal(rolePoints({ bio_short: "Growth at Corgi" }), 15, "the same bio unread: the tiers' unmatched");
  assert.equal(rolePoints({ bio_short: "Head of BD @ Factomind", clef_role: "operator" }), 60);
  assert.equal(rolePoints({ bio_short: "CEO @ Hy.pe", clef_role: "founder" }), 100);
  assert.equal(rolePoints({ bio_short: "CEO @ Hy.pe", clef_role: "operator" }), 90);
  assert.equal(
    rolePoints({ bio_short: "Head of Strearegy @Tria, Founder XBT Labs", clef_role: "operator" }),
    60,
    "a side project's founder line no longer outranks the job",
  );
  assert.equal(rolePoints({ bio_short: "Head of Strearegy @Tria, Founder XBT Labs" }), 100);
  assert.equal(rolePoints({ bio_short: "Research Partner @ Maven 11", clef_role: "investor" }), 90);
  assert.equal(rolePoints({ bio_short: "Building Share - The global bandwidth marketplace", clef_role: "founder" }), 100);
  assert.equal(rolePoints({ bio_short: "Student at UNC Chapel Hill", clef_role: "student" }), 5);
  assert.equal(rolePoints({ bio_short: "Deepmind Research Scientist", clef_role: "researcher" }), 15);
  assert.equal(rolePoints({ bio_short: "Engineer at Uniswap", clef_role: "engineer" }), 20);
  assert.equal(rolePoints({ bio_short: "Staff Product Designer @D3", clef_role: "engineer" }), 30);
});

test("an enriched role and an unknown stored label both rank by the tiers", () => {
  assert.equal(rolePoints({ role: "VP Engineering", bio_short: "Growth at Corgi", clef_role: "operator" }), 70);
  assert.equal(rolePoints({ bio_short: "CTO of Sogni.ai", clef_role: "astronaut" }), 90);
  assert.equal(attendeeScore({ bio_short: "Growth at Corgi", clef_role: "operator", twitter_handle: "x", times_seen: 2 }), 55);
});

test("a missing roles table hides only the roles, and the companies still read", async () => {
  const seen: string[] = [];
  const rows = await withRoles((r) =>
    withCompanies(async (c) => {
      seen.push(`${r.role} | ${c.company.slice(0, 8)}`);
      if (r.join.includes("attendee_roles")) throw new Error("D1_ERROR: no such table: attendee_roles: SQLITE_ERROR");
      return [{ ok: true }];
    }),
  );
  assert.deepEqual(rows, [{ ok: true }]);
  assert.deepEqual(seen, ["ar.role AS clef_role | COALESCE", "NULL AS clef_role | COALESCE"]);
});

test("the cron's role dispatch posts to /roles and reports what moved", async () => {
  const posted: string[] = [];
  const ok = await dispatchBioPass(
    { SYNC_SECRET: "s", AI: {} },
    async (url) => {
      posted.push(url);
      return { ok: true, json: async () => ({ ok: true, scanned: 300, asked: 40, classified: 40, stated: 31, failed: {}, remaining: 260 }) };
    },
    "roles",
  );
  assert.deepEqual(ok, { asked: 40, stated: 31, failed: {}, remaining: 260 });
  assert.deepEqual(posted, ["https://aadhar.sh/serendipity/roles"]);
});
