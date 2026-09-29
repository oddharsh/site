// ── Serendipity roster ranking reads the bio (serendipity.ts attendeeScore) ──
// The seniority tiers read only the enriched role until 2026-09-23, which 15 of
// 19,733 people had, so the roster sorted on "has a Twitter handle" for nearly
// everyone. These pin that the bio is read, that an enriched role still wins, and
// that the tier order (first match wins) survived being turned into a table.
import { assert, test } from "./contract-shared.ts";
import { ROLE_TIERS, attendeeScore, roleTier } from "../serendipity/serendipity.ts";
import { LABELS, scoreTiers } from "./serendipity-role-baseline.ts";

test("a person with only a Luma bio is ranked by it", () => {
  assert.equal(attendeeScore({ bio_short: "Co-Founder of EasyA" }), 100);
  assert.equal(attendeeScore({ bio_short: "Engineer at Uniswap" }), 20);
  assert.ok(attendeeScore({ bio_short: "CTO of Sogni.ai" }) > attendeeScore({ bio_short: "Engineering Manager at Google" }));
});

test("an enriched role outranks the bio it was derived from", () => {
  assert.equal(roleTier("VP Engineering").tier, "vp");
  assert.equal(attendeeScore({ role: "VP Engineering", bio_short: "founder of three things" }), 70);
});

test("first tier wins, investor sitting after the job titles", () => {
  assert.deepEqual(ROLE_TIERS.map(([t]) => t), ["founder", "c-level", "investor", "president", "vp", "director", "lead", "senior", "ic", "junior"]);
  assert.equal(roleTier("co-founder and CTO at AEON").tier, "founder");
  assert.equal(roleTier("Senior Community Lead").tier, "lead");
  assert.equal(roleTier("CTO & angel investor").tier, "c-level", "the job outranks the side portfolio");
});

test("founders are read the way they write a bio", () => {
  for (const bio of ["Cofounder @ Colosseum", "cofounder of strobe", "Co founder of Kaleidoscope", "building @halldon", "Building Exa.ai", "Building Doorman | Ex-Ramp"]) {
    assert.equal(roleTier(bio).tier, "founder", bio);
  }
  // The "Building <Name>" rule reads the capital, and only at the start.
  assert.equal(roleTier("building software for fun").tier, "unmatched");
  assert.equal(roleTier("Love traveling and Building Things").tier, "unmatched");
});

test("investors have a tier, and partnerships do not count as one", () => {
  for (const bio of ["Investor @ Archetype", "Investing at Slow Ventures", "GP @ Further.ae", "Managing Partner, Amino Capital", "Partner @ Variant", "pre-seed VC"]) {
    assert.equal(roleTier(bio).tier, "investor", bio);
  }
  assert.equal(roleTier("Partnerships at Acme").tier, "unmatched");
  assert.equal(roleTier("Head of Partnerships & Ventures at MoonPay").tier, "director");
  assert.equal(attendeeScore({ bio_short: "Partner @ 1kx" }), 90);
});

test("saying nothing and saying something untiered are different", () => {
  assert.deepEqual(roleTier(null), { tier: "none", points: 0 });
  assert.deepEqual(roleTier("   "), { tier: "none", points: 0 });
  assert.deepEqual(roleTier("Musician + Technologist"), { tier: "unmatched", points: 15 });
  assert.equal(attendeeScore({}), 0);
});

test("the baseline scores precision over matches and recall over stated roles", () => {
  const bios = [
    { id: "a", bio: "Founder of X" },            // matched, right
    { id: "b", bio: "aspiring product manager" }, // matched, wrong
    { id: "c", bio: "Growth at Corgi" },          // stated, missed
    { id: "d", bio: "espresso and tennis" },      // not stated, ignored by recall
    { id: "e", bio: "Engineer at Z" },            // unlabelled, ignored entirely
  ];
  const s = scoreTiers(bios, { a: "founder", b: "other", c: "operator", d: "not_stated" });
  assert.deepEqual({ matched: s.matched, right: s.right, stated: s.stated, found: s.found }, { matched: 2, right: 1, stated: 3, found: 1 });
  assert.deepEqual(s.missed, { other: 1, operator: 1 });
  assert.ok(LABELS.includes("investor") && LABELS.includes("not_stated"));
  assert.throws(() => scoreTiers(bios, { a: "ceo" }), /not one of/);
});
