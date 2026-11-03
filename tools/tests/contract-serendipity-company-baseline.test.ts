// ── Serendipity company extraction (serendipity/companies.ts) ──
// Clairic answers with a span or null, and the baseline tool scores it against
// a regex control on hand labels. These pin the request the model is sent, the
// parser that reads its answer, and the scorer that decides whether it ships.
import { assert, test } from "./contract-shared.ts";
import { COMPANY_INSTRUCTIONS, buildCompanyRequest, companyAt, parseCompanyAnswer } from "../../serendipity/companies.ts";
import { companyByRegex, companyMatches, parseCompanyLabel, scoreCompanies } from "../serendipity-company-baseline.ts";

test("a company request keeps the bio's line breaks and caps its length", () => {
  const req = buildCompanyRequest("  building @Macroscope \n\n Creative   technologist ");
  assert.equal(req.model, "clairic");
  assert.equal(req.state, "building @Macroscope\nCreative technologist");
  assert.equal(buildCompanyRequest("x".repeat(2000)).state.length, 1000);
  assert.deepEqual(req.fields, { company: { type: "text", instructions: COMPANY_INSTRUCTIONS } });
});

// The answer Clairic gave "coffee, climbing, NYC" on 2026-10-30: null value,
// a guess kept anyway.
const NONE = { answers: { company: { type: "text", p_null: 0.985, span: [18, 21], guess: "NYC", confidence: 0.602, value: null } } };
const NAMED = { answers: { company: { type: "text", p_null: 0.026, span: [11, 19], guess: "Paradigm", confidence: 0.9999, value: "Paradigm" } } };

test("a Clairic answer parses to its value, guess and chance of none", () => {
  assert.deepEqual(parseCompanyAnswer(NAMED), { company: "Paradigm", guess: "Paradigm", pNull: 0.026, confidence: 0.9999 });
  assert.deepEqual(parseCompanyAnswer(NONE), { company: null, guess: "NYC", pNull: 0.985, confidence: 0.602 });
  assert.equal(parseCompanyAnswer({ answers: { company: { ...NAMED.answers.company, type: "choice" } } }), null);
  assert.equal(parseCompanyAnswer({ answers: { company: { ...NAMED.answers.company, p_null: 1.5 } } }), null);
  assert.equal(parseCompanyAnswer(null), null);
});

test("a stricter threshold drops a guess the default kept", () => {
  const p = { company: "Crypto Hedge fund", guess: "Crypto Hedge fund", pNull: 0.32, confidence: 0.7 };
  assert.equal(companyAt(p, 0.5), "Crypto Hedge fund");
  assert.equal(companyAt(p, 0.1), null);
});

test("the regex control reads @ before at before of", () => {
  assert.equal(companyByRegex("Head of Strategic Partnerships & Ventures at MoonPay"), "MoonPay");
  assert.equal(companyByRegex("Research Partner @ Maven 11"), "Maven 11");
  assert.equal(companyByRegex("Founder/Producer, Mother Tongue Media"), null);
  assert.equal(companyByRegex("building @Macroscope\nCreative technologist"), "Macroscope");
  assert.equal(companyByRegex("Building raycast.com"), "raycast.com");
  assert.equal(companyByRegex("Co-Founder of EasyA"), "EasyA");
});

test("a match ignores case, @ and trailing punctuation, and nothing else", () => {
  assert.equal(companyMatches(["Kelp Dao"], "@kelp dao."), true);
  assert.equal(companyMatches(["Monad", "Monad DeFi"], "Monad DeFi"), true);
  assert.equal(companyMatches(["Share"], "Building Share"), false);
  assert.equal(companyMatches(null, "Gmonad"), false);
  assert.equal(companyMatches(["Droyd"], null), false);
});

test("precision counts answers given, recall counts bios that name one", () => {
  const labels = { a: ["Corgi"], b: null, c: ["Tempo"], d: ["TRON DAO", "TRON DAO Events"] };
  const predicted: Record<string, string | null> = { a: "Corgi", b: "KOL", c: null, d: "TRON DAO" };
  assert.deepEqual(
    scoreCompanies(["a", "b", "c", "d", "unlabelled"], labels, (id) => predicted[id] ?? null),
    { claimed: 3, right: 2, named: 3, found: 2 },
  );
});

test("a hand-typed label parses to a list of names or null", () => {
  assert.deepEqual(parseCompanyLabel("Corgi"), ["Corgi"]);
  assert.deepEqual(parseCompanyLabel(["Monad", "Monad DeFi"]), ["Monad", "Monad DeFi"]);
  assert.equal(parseCompanyLabel(null), null);
  assert.throws(() => parseCompanyLabel(""), /a company label is a name/);
  assert.throws(() => parseCompanyLabel([]), /a company label is a name/);
});
