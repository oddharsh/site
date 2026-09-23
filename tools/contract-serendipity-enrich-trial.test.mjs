// ── The TinyFish enrichment trial (tools/serendipity-enrich-trial.ts) ────────
// Free search makes price irrelevant and IDENTITY the whole question, so what
// these pin is the rule for accepting a result as a person: their own profile
// URL alone, or their name AND one of their anchors, never a name alone.
import { assert, test } from "./contract-shared.ts";
import {
  assess, bioAnchors, corroborate, handleOf, linkedinTitle, pickCohort, planQuery, search, summarize,
} from "./serendipity-enrich-trial.ts";

const JANE = { id: "p1", name: "Jane Doe", bio: "Co-Founder of EasyA", twitter_handle: "janedoe_" };

test("a profile URL is proof on its own, and a bare name is never enough", () => {
  assert.deepEqual(corroborate(JANE, { url: "https://x.com/janedoe_", title: "(@janedoe_) / X" }), ["handle-url"]);
  assert.deepEqual(corroborate(JANE, { url: "https://x.com/janedoe_/status/1", title: "x" }), ["handle-url"]);
  assert.deepEqual(corroborate(JANE, { url: "https://x.com/janedoe_2", title: "Jane Doe" }), [], "a longer handle is somebody else");
  assert.deepEqual(corroborate(JANE, { url: "https://example.com/team", title: "Jane Doe", snippet: "Jane Doe, designer in Ohio" }), []);
  assert.deepEqual(corroborate(JANE, { url: "https://example.com/team", title: "Team", snippet: "Jane Doe leads growth at EasyA" }), ["bio:EasyA"]);
  assert.deepEqual(corroborate(JANE, { url: "https://example.com", snippet: "Jane Smith of EasyA" }), [], "the anchor without the name is someone else");
});

test("X's own paths are not handles, whatever the column says", () => {
  assert.equal(handleOf({ id: "a", name: "A", twitter_handle: "home" }), "");
  assert.equal(handleOf({ id: "a", name: "A", twitter_handle: "i" }), "");
  assert.equal(handleOf({ id: "a", name: "A", twitter_handle: "https://x.com/Real_Name/" }), "Real_Name");
  assert.equal(handleOf({ id: "a", name: "A", twitter_handle: "@Kevin11hung" }), "Kevin11hung");
  assert.equal(handleOf({ id: "a", name: "A", twitter_handle: "not a handle" }), "");
});

test("bio anchors name where someone works, never what they are or who they are", () => {
  assert.deepEqual(bioAnchors({ id: "a", name: "Jane Doe", bio: "Founder @halldon, prev CEO at Uniswap. Building Exa.ai" }), ["halldon", "Uniswap", "Exa.ai"]);
  assert.deepEqual(bioAnchors({ id: "a", name: "Jane Doe", bio: "Jane Doe, Founder and CEO" }), []);
});

test("each person gets one query, on their strongest anchor", () => {
  assert.deepEqual(planQuery(JANE), { stratum: "bio", query: "\"Jane Doe\" janedoe_", anchor: "handle" });
  assert.equal(planQuery({ id: "b", name: "Al B", linkedin_handle: "https://www.linkedin.com/in/al-b-1/" }).include_domains, "linkedin.com");
  assert.equal(planQuery({ id: "b", name: "Al B", bio: "Engineer at Uniswap" }).query, "\"Al B\" Uniswap");
  assert.equal(planQuery({ id: "b", name: "Al B", twitter_handle: "home" }).stratum, "bare", "a reserved path is no anchor");
});

test("a LinkedIn search title gives the headline and, when present, the company", () => {
  assert.deepEqual(linkedinTitle("Jane Doe - Founder - EasyA | LinkedIn"), { headline: "Founder", company: "EasyA" });
  assert.deepEqual(linkedinTitle("Jane Doe – Partner at Variant | LinkedIn"), { headline: "Partner at Variant", company: null });
  assert.equal(linkedinTitle("Jane Doe (@janedoe_) / X"), null);
});

test("role is read from accepted results only, with the person's own name removed", () => {
  const r = assess({ id: "c", name: "Sam Lead", twitter_handle: "samlead" }, [
    { url: "https://example.com", title: "Sam Lead", snippet: "Sam Lead, CEO of somewhere" },          // name, no anchor: rejected
    { url: "https://x.com/samlead", title: "Sam Lead (@samlead) / X", snippet: "just vibes" },           // accepted, no tier
  ]);
  assert.equal(r.matched, true);
  assert.equal(r.searchTier, "unmatched", "the surname is not a title, and the rejected CEO result is not theirs");
  const li = assess(JANE, [{ url: "https://www.linkedin.com/in/jane", title: "Jane Doe - Partner at Variant - Variant | LinkedIn", snippet: "EasyA" }]);
  assert.equal(li.searchTier, "investor");
  assert.equal(li.linkedin?.company, "Variant");
});

test("the cohort honours its quotas, and the summary counts gains apart from agreements", () => {
  const people = [];
  for (let i = 0; i < 40; i++) people.push({ id: `h${i}`, name: `H ${i}`, twitter_handle: `h_${i}` });
  for (let i = 0; i < 40; i++) people.push({ id: `b${i}`, name: `B ${i}`, bio: "Engineer at X" });
  for (let i = 0; i < 40; i++) people.push({ id: `l${i}`, name: `L ${i}`, linkedin_handle: `l-${i}` });
  const c = pickCohort(people, 20);
  const n = (s) => c.filter((p) => planQuery(p).stratum === s).length;
  assert.deepEqual([n("handle"), n("bio"), n("profile")], [10, 5, 5]);
  const s = summarize([
    { stratum: "bio", matched: true, bioTier: "ic", searchTier: "ic" },
    { stratum: "bio", matched: true, bioTier: "ic", searchTier: "founder" },
    { stratum: "handle", matched: true, bioTier: "none", searchTier: "founder", linkedin: { company: "Acme" } },
    { stratum: "handle", matched: false },
    { stratum: "handle", error: "http 500" },
  ]);
  assert.deepEqual(s.bio, { people: 2, failed: 0, matched: 2, tiered: 2, gain: 0, agree: 1, disagree: 1, company: 0 });
  assert.deepEqual(s.handle, { people: 3, failed: 1, matched: 1, tiered: 1, gain: 1, agree: 0, disagree: 0, company: 1 });
});

test("search sends the key as a header, never the query string, and reports failures by kind", async () => {
  let seen;
  const ok = await search(planQuery(JANE), "k3y", async (url, init) => { seen = { url, init }; return { ok: true, status: 200, json: async () => ({ results: [{ title: "t" }] }) }; });
  assert.deepEqual(ok, { results: [{ title: "t" }] });
  assert.equal(seen.init.headers["X-API-Key"], "k3y");
  assert.ok(!seen.url.includes("k3y"));
  assert.ok(new URL(seen.url).searchParams.get("query")?.includes("janedoe_"));
  assert.deepEqual(await search(planQuery(JANE), "k", async () => ({ ok: false, status: 500, json: async () => ({}) })), { error: "http 500" });
  assert.deepEqual(await search(planQuery(JANE), "k", async () => ({ ok: true, status: 200, json: async () => ({ nope: 1 }) })), { error: "unparseable" });
});
