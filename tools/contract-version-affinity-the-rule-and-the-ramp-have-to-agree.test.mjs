// ── version affinity: the rule and the ramp have to agree ────────────────────
// Split from contract-tests.test.mjs; shared imports live in contract-shared.mjs.
import {
  assert,
  readFile,
  test,
} from "./contract-shared.mjs";

// ── version affinity: the rule and the ramp have to agree ────────────────────
//
// STRUCTURAL, and it has to be: Cloudflare's expression language runs at their
// edge, so nothing here can execute the rule. What can be checked is the seam,
// and the seam is where this breaks.
//
// The contract has two halves in two languages. The Transform Rule declared in
// infra.json derives Cloudflare-Workers-Version-Key from ip.src, and deliberately
// SKIPS any request that already carries that header. deploy-promote.mjs relies
// on that exemption: it sends one key per request so it can still watch a split
// take from a single IP. Take the exemption out and the rule overwrites those
// keys, every sample lands on one version, and each intermediate ramp step reads
// as "the ramp did not take": a false abort on a healthy release, on the one
// path where a confusing failure costs the most.
//
// Neither file can catch that alone, and nothing else reads both.
test("the affinity rule exempts the header the ramp sampler sends", async () => {
  const infra = JSON.parse(await readFile(new URL("../config/infra.json", import.meta.url), "utf8"));
  const declared = infra.zone?.version_affinity;
  assert.ok(declared, "infra.json must declare zone.version_affinity");

  const header = declared.header.toLowerCase();
  assert.equal(header, "cloudflare-workers-version-key", "the affinity header name is fixed by Cloudflare");

  // The rule's own filter has to name the header, which is the only way it can
  // tell "already carries a key" from "does not". A blanket `true` passes a
  // reader's eye and is the exact mistake this test exists for.
  assert.match(
    declared.expression.toLowerCase(),
    new RegExp(header.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    "the rule expression must reference the header, or it cannot exempt a request that already carries one",
  );
  assert.match(
    declared.expression.toLowerCase(),
    /\bnot\b/,
    "the exemption is a negation: the rule applies only when the header is ABSENT",
  );

  // And the ramp has to actually send it. If this line ever goes, the exemption
  // above is exempting nothing and the affinity rule silently governs the
  // sampler again.
  const ramp = await readFile(new URL("./deploy-promote.mjs", import.meta.url), "utf8");
  assert.match(ramp, new RegExp(`"${header}"\\s*:`), "deploy-promote.mjs must send a per-request affinity key");
  assert.match(ramp, /"cloudflare-workers-version-overrides"\s*:/, "deploy-promote.mjs must pin its health probe to one version");

  // The override header is `<worker-name>="<version>"`, and the name comes from
  // the same declaration Workers Builds publishes under. A literal here would be
  // free to drift from the Worker that actually serves.
  assert.match(ramp, /infra\?\.release\?\.worker/, "the worker name in the override header must come from infra.json, not a literal");
  assert.ok(infra.release?.worker, "infra.json must declare release.worker for the override header");
});
