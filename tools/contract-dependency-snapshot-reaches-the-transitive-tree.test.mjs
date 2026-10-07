// ── the dependency snapshot reaches the transitive tree ──────────────────────
// Split-file convention: shared imports live in contract-shared.mjs.
import { readFileSync } from "node:fs";
import { assert, test } from "./contract-shared.ts";
import { buildSnapshot, keySegments, npmPurl, resolveKey, snapshotResolved } from "./lib/dependency-snapshot.ts";
import { parseJsonc } from "./lib/jsonc.ts";

// GitHub's dependency graph reads package.json and not bun.lock, so Dependabot
// alerts saw 18 direct pins and none of the ~150 packages under them (the
// sharp 0.35.4 high under miniflare raised nothing). dependency-snapshot.yml
// posts this snapshot to close that. tools/lib/dependency-snapshot.ts has the
// measurement.
//
// THE CONTROL IS THE FIRST TEST: a package two hops down, under a dependency
// whose own head is a URL, must appear. That is the exact shape of sharp, and a
// walker that only listed direct pins would pass every absence test below.

const entry = (head, meta = {}) => [head, "", meta, "sha512-x"];

test("control: a transitive package under a URL-headed dependency is snapshotted", () => {
  const { resolved, declined } = snapshotResolved({
    workspaces: { "": { devDependencies: { wrangler: "https://pkg.pr.new/wrangler@1" } } },
    packages: {
      wrangler: ["wrangler@https://pkg.pr.new/wrangler@1", { dependencies: { miniflare: "https://pkg.pr.new/miniflare@1" } }, "sha512-x"],
      miniflare: ["miniflare@https://pkg.pr.new/miniflare@1", { dependencies: { sharp: "0.35.4" } }, "sha512-x"],
      sharp: entry("sharp@0.35.4", { optionalDependencies: { "@img/sharp-linux-x64": "0.35.4" } }),
      "@img/sharp-linux-x64": entry("@img/sharp-linux-x64@0.35.4"),
    },
  });
  assert.deepEqual(resolved["pkg:npm/sharp@0.35.4"], {
    package_url: "pkg:npm/sharp@0.35.4",
    relationship: "indirect",
    scope: "development",
    dependencies: ["pkg:npm/%40img/sharp-linux-x64@0.35.4"],
  });
  assert.ok(resolved["pkg:npm/%40img/sharp-linux-x64@0.35.4"], "an optional platform build is a real package");
  assert.deepEqual(declined.sort(), ["miniflare@https://pkg.pr.new/miniflare@1", "wrangler@https://pkg.pr.new/wrangler@1"]);
});

test("a package reached from `dependencies` anywhere is runtime, even if a dev path reaches it first", () => {
  const { resolved } = snapshotResolved({
    workspaces: { "": { devDependencies: { a: "1.0.0" }, dependencies: { b: "1.0.0" } } },
    packages: {
      a: entry("a@1.0.0", { dependencies: { shared: "1.0.0" } }),
      b: entry("b@1.0.0", { dependencies: { shared: "1.0.0" } }),
      shared: entry("shared@1.0.0"),
    },
  });
  assert.equal(resolved["pkg:npm/a@1.0.0"].scope, "development");
  assert.equal(resolved["pkg:npm/b@1.0.0"].scope, "runtime");
  assert.equal(resolved["pkg:npm/shared@1.0.0"].scope, "runtime");
  assert.equal(resolved["pkg:npm/a@1.0.0"].relationship, "direct");
  assert.equal(resolved["pkg:npm/shared@1.0.0"].relationship, "indirect");
});

test("a nested copy wins over the hoisted one, the way node resolves it", () => {
  const packages = { entities: entry("entities@8.1.0"), "dom-serializer/entities": entry("entities@8.0.0"), "dom-serializer": entry("dom-serializer@3.1.1") };
  assert.equal(resolveKey(packages, "dom-serializer", "entities"), "dom-serializer/entities");
  assert.equal(resolveKey(packages, "htmlparser2", "entities"), "entities");
  assert.equal(resolveKey(packages, "", "missing"), null);
  assert.deepEqual(keySegments("@img/sharp/@img/colour"), ["@img/sharp", "@img/colour"]);
  assert.equal(npmPurl("@cloudflare/config", "0.23.0"), "pkg:npm/%40cloudflare/config@0.23.0");
});

test("workspace and git heads are declined, never given a versionless purl", () => {
  const { resolved, declined } = snapshotResolved({
    workspaces: { "": {} },
    packages: { cal: ["cal-aadhar-sh@workspace:cal"], timbrado: ["timbrado@github:oddharsh/timbrado#c110b30", {}, "x"] },
  });
  assert.deepEqual(resolved, {});
  assert.equal(declined.length, 2);
});

test("the committed lockfiles snapshot sharp, and both manifests are present", () => {
  const lockfiles = ["bun.lock", "lens-reader/bun.lock"].map((p) => ({ path: p, parsed: parseJsonc(readFileSync(p, "utf8")) }));
  const { snapshot } = buildSnapshot({ lockfiles, sha: "0".repeat(40), ref: "refs/heads/main", runId: "1", scanned: "2026-10-07T00:00:00Z", repoUrl: "https://github.com/oddharsh/site" });
  const root = Object.values(snapshot.manifests["bun.lock"].resolved);
  // 161 on 2026-10-07. A floor well under it catches a walker that has
  // quietly stopped matching, without tripping on a dependency removed on purpose.
  assert.ok(root.length >= 100, `only ${root.length} packages in the bun.lock snapshot`);
  assert.ok(root.some((r) => r.package_url.startsWith("pkg:npm/sharp@")), "sharp, the package that motivated this, is missing");
  assert.ok(Object.values(snapshot.manifests["lens-reader/bun.lock"].resolved).some((r) => r.scope === "runtime"));
  for (const r of root) assert.match(r.package_url, /^pkg:npm\/(%40[^/]+\/)?[^@/]+@\d/);
});
