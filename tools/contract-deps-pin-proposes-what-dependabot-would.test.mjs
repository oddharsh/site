// `bun run deps:pin` replaced Dependabot's npm blocks on 2026-10-06, after
// dependabot-core#16220 made the npm updater refuse a bun.lock tree. These pin
// the policy it carried over (age window, prereleases, deprecations, the named
// groups) against a synthetic registry, so no test here touches the network.
//
// THE CONTROL IS THE FIRST TEST: a registry with a newer, old-enough release
// must produce a bump. Every other test asserts an absence, and a planner that
// proposed nothing at all would pass every one of those.
import test from "node:test";
import assert from "node:assert/strict";

import {
  CATCH_ALL,
  branchFor,
  compareSemver,
  groupFor,
  newestEligible,
  planBumps,
  rewriteManifest,
} from "./lib/deps-plan.ts";

const DAY = 86400;
const NOW = Date.parse("2026-10-06T12:00:00Z");
const ago = (hours) => new Date(NOW - hours * 3600e3).toISOString();

/** A registry document from [version, hoursAgo, deprecated?] triples. */
function doc(...entries) {
  const versions = {};
  const time = {};
  for (const [v, hours, deprecated] of entries) {
    versions[v] = deprecated ? { deprecated } : {};
    time[v] = ago(hours);
  }
  return { versions, time };
}

const manifest = (path, devDependencies) => ({ path, json: { devDependencies } });

test("control: an old-enough newer release is proposed", () => {
  const bumps = planBumps({
    manifests: [manifest("package.json", { "oxc-minify": "0.151.0" })],
    registry: new Map([["oxc-minify", doc(["0.151.0", 400], ["0.152.0", 200], ["0.153.0", 32])]]),
    nowMs: NOW,
    minAgeSeconds: DAY,
  });
  assert.deepEqual(bumps, [
    { pkg: "oxc-minify", from: "0.151.0", to: "0.153.0", type: "minor", group: "minifiers", manifests: ["package.json"] },
  ]);
});

test("a release younger than the window is invisible, and the next-newest wins", () => {
  // bun refuses to resolve an exact pin younger than minimumReleaseAge, so a
  // PR naming 0.153.0 at 7 hours old could not be installed by anyone.
  assert.equal(newestEligible(doc(["0.151.0", 400], ["0.152.0", 200], ["0.153.0", 7]), "0.151.0", NOW, DAY), "0.152.0");
  assert.equal(newestEligible(doc(["0.151.0", 400], ["0.153.0", 7]), "0.151.0", NOW, DAY), null);
});

test("a version with no publish time is treated as too young", () => {
  const d = doc(["1.0.0", 400]);
  d.versions["1.1.0"] = {};
  assert.equal(newestEligible(d, "1.0.0", NOW, DAY), null);
});

test("prereleases are skipped from a release pin, and followed from a prerelease pin", () => {
  const d = doc(["7.0.0", 400], ["7.1.0-beta.1", 100], ["7.0.1", 100]);
  assert.equal(newestEligible(d, "7.0.0", NOW, DAY), "7.0.1");
  assert.equal(newestEligible(d, "7.1.0-beta.0", NOW, DAY), "7.1.0-beta.1");
});

test("deprecated versions are skipped", () => {
  assert.equal(newestEligible(doc(["1.0.0", 400], ["1.0.1", 100, "broken publish"]), "1.0.0", NOW, DAY), null);
});

test("only exact pins are planned", () => {
  const bumps = planBumps({
    manifests: [manifest("package.json", {
      wrangler: "https://pkg.pr.new/cloudflare/workers-sdk/wrangler@425662b",
      timbrado: "github:oddharsh/timbrado#c110b30",
      ranged: "^1.0.0",
    })],
    registry: new Map([["wrangler", doc(["4.200.0", 400])], ["ranged", doc(["1.0.0", 400], ["1.2.0", 100])]]),
    nowMs: NOW,
    minAgeSeconds: DAY,
  });
  assert.deepEqual(bumps, []);
});

test("one package pinned in two manifests moves as one bump", () => {
  const [b, ...rest] = planBumps({
    manifests: [manifest("package.json", { typescript: "7.0.2" }), manifest("cal/package.json", { typescript: "7.0.2" })],
    registry: new Map([["typescript", doc(["7.0.2", 400], ["7.0.3", 100])]]),
    nowMs: NOW,
    minAgeSeconds: DAY,
  });
  assert.equal(rest.length, 0);
  assert.deepEqual(b.manifests, ["package.json", "cal/package.json"]);
});

test("named groups take majors; the rest split into minor-and-patch and one PR per major", () => {
  assert.equal(groupFor("oxlint", "major"), "oxlint");
  assert.equal(groupFor("@cloudflare/config", "minor"), "cloudflare-toolchain");
  assert.equal(groupFor("smol-toml", "patch"), CATCH_ALL);
  assert.equal(groupFor("smol-toml", "major"), "smol-toml");
  assert.equal(branchFor("@types/bun"), "chore/deps-types-bun");
});

test("semver precedence orders releases above their prereleases", () => {
  const sorted = ["1.0.0", "1.0.0-rc.1", "1.0.0-beta.11", "1.0.0-beta.2", "0.9.9", "1.0.1"].sort(compareSemver);
  assert.deepEqual(sorted, ["0.9.9", "1.0.0-beta.2", "1.0.0-beta.11", "1.0.0-rc.1", "1.0.0", "1.0.1"]);
});

test("a manifest rewrite moves the pin and its override, and nothing else", () => {
  const text = `{
  "dependencies": {
    "htmlparser2": "12.0.0",
    "linkedom": "0.18.13"
  },
  "overrides": {
    "htmlparser2": "12.0.0"
  }
}
`;
  const out = rewriteManifest(text, "htmlparser2", "12.0.0", "12.1.0");
  assert.equal(out, text.replaceAll(`"htmlparser2": "12.0.0"`, `"htmlparser2": "12.1.0"`));
  // A different version of the same name is someone else's pin.
  assert.equal(rewriteManifest(text, "htmlparser2", "11.0.0", "12.1.0"), text);
});
