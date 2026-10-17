// ── the zone's Shared Dictionaries setting is declared and checked ───────────
// Split-file convention: shared imports live in contract-shared.ts.
import {
  assert,
  readFileSync,
  test,
} from "./contract-shared.ts";

// Cloudflare's docs say `shared_dictionary_mode: disabled` strips the dictionary
// headers and refuses to cache dcb/dcz, which would drop every dcz tier to plain
// brotli with no error anywhere. So the value is declared in infra.json and a
// workstation infra:check reads it back. Both halves are pinned: a declaration
// nothing reads is a comment, and a check with no declaration returns early.
test("infra: shared_dictionary_mode is declared passthrough and checked", () => {
  const infra = JSON.parse(readFileSync("config/infra.json", "utf8"));
  assert.equal(infra.zone?.shared_dictionary?.setting, "shared_dictionary_mode");
  assert.equal(infra.zone?.shared_dictionary?.value, "passthrough", "passthrough is the only value that serves the origin's own deltas");
  // The WIRING, which is all a source read can say: check-infra.ts hands the
  // declared block to the zone-setting comparer and reads the setting it names.
  // What the comparer does with `disabled` is asserted by calling it, in
  // contract-infra-check-compares-declared-against-observed.
  const check = readFileSync("tools/check-infra.ts", "utf8");
  assert.match(check, /const sharedDictionary = infra\.zone\?\.shared_dictionary;\n\s*if \(sharedDictionary\) report\.add\(compareZoneSetting\(SHARED_DICTIONARY_SECTION, sharedDictionary, zone, await readZoneSetting\(cf, zone, sharedDictionary\.setting\)\)\);/, "check-infra.ts must assert the declared shared_dictionary_mode");
});
