// ── /dict — the registration lint ───────────────────────────────
// Split from contract-tests.test.mjs; shared imports live in contract-shared.mjs.
import {
  assert,
  terminalGet,
  test,
} from "./contract-shared.mjs";

// ── /dict — the registration lint ───────────────────────────────
// The rules ARE the product, and they are asserted as pure functions because
// every external fetch in this repo dies at signing in a test environment.

test("each Chromium veto is caught on its own, and a clean dictionary passes", async () => {
  const { auditDictionary } = await import("../src/worker/dict.ts");
  const base = { "use-as-dictionary": 'match="/a/*"' };

  // must-revalidate and no-cache are the two that surprise people: neither means
  // "do not store" anywhere else in HTTP, and each kills registration outright.
  for (const [cc, expected] of [
    ["public, max-age=600, must-revalidate", "must-revalidate"],
    ["public, max-age=600, no-cache", "no-cache"],
    ["no-store", "no-store"],
  ]) {
    const audit = auditDictionary({ ...base, "cache-control": cc });
    assert.equal(audit.registers, false, `${cc} should not register`);
    assert.ok(audit.vetoes.some((v) => v.id === expected), `${cc} should be vetoed by ${expected}`);
  }

  // Missing the header at all is its own veto, not a pass by omission.
  assert.equal(auditDictionary({ "cache-control": "public, max-age=600" }).registers, false);

  const good = auditDictionary({ ...base, "cache-control": "public, max-age=600, stale-while-revalidate=86400" });
  assert.equal(good.registers, true);
  assert.equal(good.warns.length, 0);
  // Every rule reports, including the ones that passed — a lint that prints only
  // failures leaves you unsure whether it looked.
  assert.equal(good.results.length, 6);
  assert.ok(good.results.every((r) => r.detail));
});

test("the lint knows the dictionary's life is the SWR window, not max-age", async () => {
  // The non-obvious rule, and the one that reads as "it worked yesterday": a
  // dictionary with a year of max-age and no stale-while-revalidate is usable
  // for zero seconds past freshness.
  const { auditDictionary } = await import("../src/worker/dict.ts");
  const noSwr = auditDictionary({ "use-as-dictionary": "match=\"/*\"", "cache-control": "public, max-age=31536000, immutable" });
  assert.equal(noSwr.registers, true, "no SWR is a warning, not a veto");
  assert.ok(noSwr.warns.some((w) => w.id === "lifetime"));

  // s-maxage is a shared-cache directive and buys a browser nothing here.
  const shared = auditDictionary({ "use-as-dictionary": "match=\"/*\"", "cache-control": "public, s-maxage=99999, stale-while-revalidate=600" });
  assert.ok(shared.warns.some((w) => w.id === "s-maxage"));
});

test("a delta served without vary: available-dictionary is flagged as a decode failure", async () => {
  // Not a slow page. A shared cache hands the delta to a client with no
  // dictionary and the navigation dies on ERR_CONTENT_DECODING_FAILED.
  const { auditConsumer } = await import("../src/worker/dict.ts");
  const unsafe = auditConsumer({ "content-encoding": "dcz", vary: "accept-encoding" });
  assert.equal(unsafe.isDelta, true);
  assert.equal(unsafe.variesOnDictionary, false);

  const safe = auditConsumer({ "content-encoding": "dcz", vary: "accept-encoding, available-dictionary" });
  assert.equal(safe.variesOnDictionary, true);
  assert.equal(auditConsumer({ "content-encoding": "br", vary: "accept-encoding" }).isDelta, false);
});

test("dict refuses a private target before fetching, and explains itself with none", async () => {
  const idle = await (await terminalGet("/dict?plain=1")).text();
  assert.match(idle, /fail silently/);
  assert.match(idle, /SILENTLY IGNORES/);   // the node:zlib finding is on the page, not just in source
  const refused = await (await terminalGet("/dict?plain=1&url=http%3A%2F%2F169.254.169.254%2F")).text();
  assert.match(refused, /refused/);
});
