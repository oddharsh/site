// ── the page dictionary is offered to a visit that continues ────────────────
// Chromium fetches the page dictionary at idle on every document that names
// it, and on the week to 2026-11-22 nearly every cold Chromium view that did so
// was a landing from outside, a one-page visit more often than not.
// offersDictionary (security.ts) names it only to a navigation from this site,
// to a request that already holds a dictionary, and to a client that sends no
// Sec-Fetch-Site. The built Worker's response is checked in the PR that added
// this; the source tree's PAGE_DICTIONARY is empty until the build bakes it.
import { assert, test } from "../../../../tools/tests/contract-shared.ts";
import { offersDictionary } from "../security.ts";

const request = (headers: Record<string, string>) => new Request("https://aadhar.sh/garage", { headers });

test("a second page of a visit is offered the dictionary, and a landing from outside is not", () => {
  assert.equal(offersDictionary(request({ "sec-fetch-site": "same-origin" })), true);
  assert.equal(offersDictionary(request({ "sec-fetch-site": "cross-site" })), false);
  assert.equal(offersDictionary(request({ "sec-fetch-site": "none" })), false);
  assert.equal(offersDictionary(request({ "sec-fetch-site": "same-site" })), false);
});

test("a visitor who holds a dictionary is offered it wherever they land, so a roll reaches them", () => {
  assert.equal(offersDictionary(request({ "sec-fetch-site": "cross-site", "available-dictionary": ":pZGm1Av0IEBKARczz7exkNYsZb8LzaMrV7J32a2fFG4=:" })), true);
  assert.equal(offersDictionary(request({ "sec-fetch-site": "none", "available-dictionary": ":pZGm1Av0IEBKARczz7exkNYsZb8LzaMrV7J32a2fFG4=:" })), true);
});

test("a client that sends no Sec-Fetch-Site keeps being offered it", () => {
  assert.equal(offersDictionary(request({})), true);
});
