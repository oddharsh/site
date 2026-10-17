// ── /lens Terms: TDMRep reads the reservation, and presence proves nothing ───
// /.well-known/tdmrep.json is an array of rules, and `tdm-reservation` is 1 to
// reserve text and data mining rights or 0 to say they are NOT reserved (W3C
// TDMRep CG Final Report). Until 2026-09-30 the Terms lens counted any 200 at
// that path as a "signaled" opt-out, so a site publishing an explicit grant
// (this one, since the same day) read as having reserved its rights.
import { assert, readFile, test } from "./contract-shared.ts";
import { lensTdmrep, lensTerms } from "../src/worker/lens.ts";

const probe = (rules) => ({ ok: true, status: 200, body: JSON.stringify(rules) });
const terms = (tdmrep, url = "https://example.com/post") =>
  lensTerms({ finalUrl: url, status: 200, headers: {}, body: "", robots: null, tdmrep, metaRobots: null });

test("tdm-reservation 0 reads as not reserved, and keeps the site open", () => {
  const t = terms(probe([{ location: "/", "tdm-reservation": 0 }]));
  assert.equal(t.tdmrep.present, true);
  assert.equal(t.tdmrep.reserved, false);
  assert.equal(t.spectrum.tier, "open");
  assert.ok(t.spectrum.reasons.some((r) => /not reserved/.test(r)), t.spectrum.reasons.join(" | "));
});

test("tdm-reservation 1 reads as reserved and signals, the control for the row above", () => {
  const t = terms(probe([{ location: "/", "tdm-reservation": 1, "tdm-policy": "https://example.com/policy.json" }]));
  assert.equal(t.tdmrep.reserved, true);
  assert.equal(t.tdmrep.policy, "https://example.com/policy.json");
  assert.equal(t.spectrum.tier, "signaled");
});

test("the first matching location wins, matched against the scanned path", () => {
  const rules = [{ location: "/blog/", "tdm-reservation": 1 }, { location: "/", "tdm-reservation": 0 }];
  assert.equal(lensTdmrep(probe(rules), "/blog/post").reserved, true);
  assert.equal(lensTdmrep(probe(rules), "/about").reserved, false);
  const none = lensTdmrep(probe([{ location: "/private/", "tdm-reservation": 1 }]), "/about");
  assert.equal(none.present, true);
  assert.equal(none.reserved, null);
});

test("a 200 that is not a rule array is not a manifest", () => {
  assert.equal(lensTdmrep({ ok: true, body: "<!doctype html><title>app</title>" }, "/").present, false);
  assert.equal(lensTdmrep({ ok: true, body: '{"location":"/"}' }, "/").present, false);
  assert.equal(lensTdmrep({ ok: false, status: 404 }, "/").present, false);
});

test("this origin's own file is the site-wide grant the lens reads as open", async () => {
  const body = await readFile(new URL("../public/.well-known/tdmrep.json", import.meta.url), "utf8");
  const rules = JSON.parse(body);
  assert.deepEqual(rules, [{ location: "/", "tdm-reservation": 0 }]);
  for (const path of ["/", "/writing/some-post", "/garage/horizon"]) {
    assert.equal(lensTdmrep({ ok: true, body }, path).reserved, false, path);
  }
});
