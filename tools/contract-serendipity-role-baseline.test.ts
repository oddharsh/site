// ── Serendipity roster ranking reads the bio (serendipity.ts attendeeScore) ──
// The seniority tiers read only the enriched role until 2026-09-23, which 15 of
// 19,733 people had, so the roster sorted on "has a Twitter handle" for nearly
// everyone. These pin that the bio is read, that an enriched role still wins, and
// that the tier order (first match wins) survived being turned into a table.
import { assert, test } from "./contract-shared.ts";
import { ROLE_TIERS, attendeeScore, roleTier } from "../serendipity/serendipity.ts";
import { LABELS, confidenceQuantiles, scoreClef, scoreTiers, tierRecallOnTierable } from "./serendipity-role-baseline.ts";
import { ROLE_CRITERIA, ROLE_MODEL, buildRoleRequest, parseRoleAnswer } from "../serendipity/roles.ts";

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

// ── the Clef role classifier (serendipity/roles.ts) ──────────────────────────
test("the classifier's options are the label vocabulary every label file uses", () => {
  // Pinned by value: a renamed option would silently score every old label as a miss.
  assert.deepEqual([...LABELS], ["founder", "investor", "operator", "engineer", "researcher", "student", "creator", "other", "not_stated"]);
  assert.deepEqual(Object.keys(ROLE_CRITERIA), [...LABELS]);
});

test("one bio per request, a model the binding accepts, and a bounded state", () => {
  const req = buildRoleRequest("  Growth   @ Corgi \n ".concat("x".repeat(5000)));
  assert.match(ROLE_MODEL, /^(clef|clef-flash)$/);
  assert.equal(req.model, ROLE_MODEL);
  assert.deepEqual(Object.keys(req.state), ["bio"]);
  assert.ok(req.state.bio.startsWith("Growth @ Corgi x"), "whitespace collapsed");
  assert.ok(req.state.bio.length <= 1000);
  assert.deepEqual(Object.keys(req.questions), ["role"]);
  assert.equal(req.questions.role.type, "choice");
});

test("an answer outside the labels, or without a confidence, is no answer", () => {
  const ok = { answers: { role: { type: "choice", choice: "operator", confidence: 0.8, probabilities: { operator: 0.8, founder: 0.2 } } } };
  assert.deepEqual(parseRoleAnswer(ok), { role: "operator", confidence: 0.8, probabilities: { operator: 0.8, founder: 0.2 } });
  assert.equal(parseRoleAnswer({ answers: { role: { ...ok.answers.role, choice: "ceo" } } }), null);
  assert.equal(parseRoleAnswer({ answers: { role: { ...ok.answers.role, confidence: undefined } } }), null);
  assert.equal(parseRoleAnswer(null), null);
});

test("Clef is scored like the regex: abstentions cost recall, never precision", () => {
  const bios = ["a", "b", "c", "d", "e", "f"].map((id) => ({ id, bio: id === "a" ? "Founder of X" : "Growth at Corgi" }));
  const labels = { a: "founder", b: "operator", c: "operator", d: "creator", e: "not_stated", f: "investor" };
  const p = (role, confidence) => ({ role, confidence, probabilities: {} });
  const predictions = {
    a: p("founder", 0.95),   // claimed, right
    b: p("operator", 0.6),   // claimed at 0, abstains at 0.7
    c: p("founder", 0.9),    // claimed, wrong
    d: p("creator", 0.9),    // right, on a label no tier can fit
    e: p("not_stated", 0.99), // an abstention whatever its confidence
    f: null,                 // the call failed
  };
  const at0 = scoreClef(bios, labels, predictions, 0);
  assert.deepEqual(
    { matched: at0.matched, right: at0.right, stated: at0.stated, found: at0.found, tierable: at0.tierable, tierFound: at0.tierFound, failed: at0.failed },
    { matched: 4, right: 3, stated: 5, found: 3, tierable: 4, tierFound: 2, failed: 1 },
  );
  const at7 = scoreClef(bios, labels, predictions, 0.7);
  assert.equal(at7.matched, 3);
  assert.equal(at7.found, 2, "a below-threshold right answer is a miss, not a hit");
  assert.deepEqual(at7.missed, { operator: 2, investor: 1 });
  assert.throws(() => scoreClef(bios, { a: "ceo" }, predictions), /not one of/);
  // The regex's like-for-like recall: founder hit, operators missed, creator excluded.
  assert.deepEqual(tierRecallOnTierable(bios, labels), { tierable: 4, found: 1 });
});

test("the sweep's thresholds come from the confidence Clef actually returned", () => {
  const p = (role, confidence) => ({ role, confidence, probabilities: {} });
  const predictions = { a: p("founder", 0.2), b: p("founder", 0.4), c: null, d: p("founder", 0.6), e: p("founder", 0.8) };
  assert.deepEqual(confidenceQuantiles(predictions, [0, 0.5, 0.99]), [0.2, 0.6, 0.8], "a failed call is not a confidence of zero");
  assert.deepEqual(confidenceQuantiles({ x: null }, [0.5]), [null]);
});
