// ── bun.lock resolves what the manifest pins ─────────────────────────────────
// Split-file convention: shared imports live in contract-shared.mjs.
import { assert, test } from "./contract-shared.ts";
import { auditLockfilePins, readLockfilePins, FLOOR_PINS } from "./lib/lockfile-pins.ts";

// ── bun.lock resolves what the manifest pins ─────────────────────────────────
// The install gate has a hole this closes. `bun install --frozen-lockfile`
// compares package.json against the lockfile's DECLARATION MIRROR and never
// against its RESOLUTION, so a lockfile whose `packages` block has run ahead of
// the manifest installs the version the manifest denies, exits 0, and prints
// nothing. tools/lib/lockfile-pins.ts carries the measurement.
//
// It was real here. On PR #880, at 9c1e6adb of the minifiers dependabot branch,
// package.json pinned `oxc-minify` at 0.150.0, the mirror agreed at 0.150.0,
// and `packages` resolved 0.151.0. Every CI job on that PR built with 0.151.0.
// The only thing in the repository that noticed was the prose check over
// docs/DEPENDENCIES.md, and it noticed INDIRECTLY, because the relock bot had
// already written 0.151.0 into the doc. A check that catches a lockfile bug by
// way of a sentence is luck rather than coverage.
//
// Both directions are exercised, because a check that has only ever agreed with
// a healthy tree is the third kind of decoration this repository has had to
// clean up after (gotcha 24, the Turndown structural test, the Markdown-twin
// test that read the wrong field names).

test("every committed bun.lock resolves what its manifest pins", () => {
  const lockfiles = readLockfilePins();
  const { checked, problems } = auditLockfilePins({ lockfiles });
  assert.deepEqual(problems, [], problems.join("\n"));
  assert.ok(checked.length >= FLOOR_PINS, `only ${checked.length} pins checked, floor is ${FLOOR_PINS}`);
});

// THE ENUMERATOR IS PART OF THE ASSERTION. Both halves of the walk are derived
// rather than listed, so the way this check goes quiet is a walk that stops
// finding things rather than a rule that stops firing. The floor above catches
// a collapse; this catches the narrower case where one lockfile or one
// workspace drops out while the rest keep the count over the floor.
/** The root lockfile and its root manifest, already narrowed.
 *
 *  A bare `.find()` can miss, which would make every assertion below silently
 *  conditional on a lookup. These throw instead, so a walk that stops returning
 *  the root fails here by name rather than by passing vacuously.
 *
 *  @param {ReturnType<typeof readLockfilePins>} lockfiles
 */
function rootOf(lockfiles) {
  const lock = lockfiles.find((l) => l.lock === "bun.lock");
  if (!lock) throw new Error("the walk returned no bun.lock");
  const manifest = lock.manifests.find((m) => m.wsKey === "");
  if (!manifest) throw new Error("bun.lock declares no root workspace");
  return {
    lock,
    packages: /** @type {Record<string, unknown[]>} */ (lock.parsed.packages),
    devDependencies: /** @type {Record<string, string>} */ (manifest.pkg.devDependencies),
  };
}

test("the walk finds every committed lockfile and every workspace each one governs", () => {
  const lockfiles = readLockfilePins();
  const locks = lockfiles.map((l) => l.lock);
  assert.deepEqual(locks, ["bun.lock", "lens-reader/bun.lock"], "a lockfile joined or left the tree");

  const { lock: root } = rootOf(lockfiles);
  assert.deepEqual(
    root.manifests.map((m) => m.manifest).sort(),
    ["cal/package.json", "cf-garage/package.json", "lwe-ask/package.json", "package.json", "serendipity/package.json"],
    "the root lockfile's workspace set moved; the manifests come from the lockfile itself, so this is a real change",
  );
  // lwe-ask and serendipity are dependency-free today and are NOT in
  // SUB_MANIFEST_POLICY, which is the reason this walk reads the lockfile's own
  // workspaces rather than that list: the day either grows a pin, it is covered.
  for (const { manifests } of lockfiles) {
    for (const m of manifests) assert.ok(m.pkg && typeof m.pkg === "object", `${m.manifest} did not parse`);
  }
});

// The live wiring, not just the pure function: perturb ONE resolution in the
// real lockfiles and confirm the same call that reports a clean tree above goes
// red. Without this, every negative case below is a statement about fixtures.
//
// BOTH HALVES OF THE PERTURBATION ARE DERIVED, and the version half is the one
// that cost a red build. This named `oxc-minify` and hardcoded 0.151.0, the
// real 9c1e6adb drift. #880 merged that exact bump into `main` hours later; CI
// builds a merge commit, so the pin BECAME 0.151.0, the "perturbation" became
// the correct resolution, and the audit reported nothing. A fixture whose value
// is owned by the outside world has an expiry date, and dependabot owns this
// one. The package is derived for the milder version of the same reason: naming
// a dependency makes this test fail the day that dependency leaves.
//
// There WAS a guard for this (`assert.notEqual(pin, "0.151.0")`), and it sat
// after the assertion it existed to explain, so the build failed on a bare
// `0 !== 1` instead. A guard that runs after the thing it guards is a comment.
test("perturbing one real resolution turns the live check red", () => {
  const lockfiles = readLockfilePins();
  const { packages, devDependencies } = rootOf(lockfiles);

  const target = auditLockfilePins({ lockfiles }).checked
    .find((c) => c.lock === "bun.lock" && c.field === "devDependencies");
  if (!target) throw new Error("the walk checked no root devDependency");
  const entry = packages[target.name];
  if (!Array.isArray(entry)) throw new Error(`bun.lock resolves nothing for ${target.name}`);

  const pin = devDependencies[target.name];
  // Different from the pin whatever the pin becomes, and obviously synthetic.
  const moved = pin === "9.9.9" ? "8.8.8" : "9.9.9";
  // the 9c1e6adb shape: mirror untouched, resolution moved.
  packages[target.name] = [`${target.name}@${moved}`, ...entry.slice(1)];

  const { problems } = auditLockfilePins({ lockfiles });
  assert.equal(problems.length, 1, problems.join("\n"));
  assert.ok(
    problems[0].includes(`pins ${target.name} at ${pin} and bun.lock RESOLVES ${moved}`),
    problems[0],
  );
});

// ── the negative battery ─────────────────────────────────────────────────────
// One dependency, one workspace: enough to exercise every rule, small enough to
// read. `floor: 0` throughout, so a one-pin fixture does not trip the tripwire
// that exists for the real walk.
const resolutionEntry = (name, version) => [`${name}@${version}`, "", {}, "sha512-fixture"];

/** @param {{ pin: string, mirror?: string, resolution?: string, head?: unknown[],
 *            overrides?: Record<string, string>, lockOverrides?: Record<string, string>,
 *            resolutions?: Record<string, string>, name?: string }} spec */
function fixture({ pin, mirror, resolution, head, overrides, lockOverrides, resolutions, name = "widget" }) {
  const pkg = { devDependencies: { [name]: pin } };
  if (overrides) pkg.overrides = overrides;
  const ws = { name: "fixture" };
  if (mirror !== undefined) ws.devDependencies = { [name]: mirror };
  const packages = {};
  // An override resolves at its declared version unless a case says otherwise,
  // so a fixture exercising the override MIRROR is not also failing on a
  // resolution it never meant to test.
  for (const [k, v] of Object.entries(resolutions ?? overrides ?? {})) packages[k] = resolutionEntry(k, v);
  if (head !== undefined) packages[name] = head;
  else if (resolution !== undefined) packages[name] = resolutionEntry(name, resolution);
  const parsed = { workspaces: { "": ws }, packages };
  if (lockOverrides) parsed.overrides = lockOverrides;
  return { lockfiles: [{ lock: "bun.lock", parsed, manifests: [{ manifest: "package.json", wsKey: "", pkg }] }], floor: 0 };
}
const audit = (opts) => auditLockfilePins(fixture(opts));

test("the lockfile-pin check catches every drift it exists for", () => {
  // 0. the control: a healthy lockfile passes, so every red below is the rule
  //    under test rather than the fixture being malformed.
  assert.deepEqual(audit({ pin: "1.2.3", mirror: "1.2.3", resolution: "1.2.3" }).problems, []);

  // 1. THE BUG. The mirror agrees with the manifest and the resolution does not,
  //    which is the one state a frozen install reports as healthy.
  const ahead = audit({ pin: "0.150.0", mirror: "0.150.0", resolution: "0.151.0" }).problems;
  assert.equal(ahead.length, 1, ahead.join("\n"));
  assert.match(ahead[0], /pins widget at 0\.150\.0 and bun\.lock RESOLVES 0\.151\.0/);
  assert.match(ahead[0], /bun update widget/, "the message must name the one command that repairs it");

  // 2. The mirror drifting is caught too, isolated here so this asserts one
  //    rule: the resolution agrees with the MANIFEST and only the mirror is
  //    stale. Bun catches this class itself, so the value is narrower — it
  //    names the package where bun says "lockfile had changes", and it fires
  //    without anyone having run an install.
  const mirrored = audit({ pin: "0.150.0", mirror: "0.151.0", resolution: "0.150.0" }).problems;
  assert.equal(mirrored.length, 1, mirrored.join("\n"));
  assert.match(mirrored[0], /mirrors "0\.151\.0"/);

  // 2b. Both records wrong is two problems, not one. They are two independent
  //     facts about the lockfile and a reader fixing only the loud one would
  //     leave the silent one in place.
  const bothWrong = audit({ pin: "0.150.0", mirror: "0.151.0", resolution: "0.151.0" }).problems;
  assert.equal(bothWrong.length, 2, bothWrong.join("\n"));
  assert.ok(bothWrong.some((p) => /mirrors "0\.151\.0"/.test(p)));
  assert.ok(bothWrong.some((p) => /RESOLVES 0\.151\.0/.test(p)));

  // 3. A pin the mirror does not record at all.
  const unmirrored = audit({ pin: "1.2.3", resolution: "1.2.3" }).problems;
  assert.equal(unmirrored.length, 1, unmirrored.join("\n"));
  assert.match(unmirrored[0], /does not record it/);

  // 4. FAIL CLOSED on a pin with no resolution. Reading absence as consent is
  //    how this check would come to pass over a lockfile it no longer parses.
  const unresolved = audit({ pin: "1.2.3", mirror: "1.2.3" }).problems;
  assert.equal(unresolved.length, 1, unresolved.join("\n"));
  assert.match(unresolved[0], /resolves no package by that name/);

  // 5. A resolution whose head is not `<name>@<version>` is reported rather
  //    than parsed past, for the same reason.
  const weird = audit({ pin: "1.2.3", mirror: "1.2.3", head: ["something-else@1.2.3", "", {}, "sha512-x"] }).problems;
  assert.equal(weird.length, 1, weird.join("\n"));
  assert.match(weird[0], /not a `widget@<version>` entry/);

  // 6. A RANGE is not judged, and is not silently counted as checked either. A
  //    checker that compared "^1.0.0" against 2.0.0 would report a satisfied
  //    range as drift; one that counted it would inflate the floor with pins it
  //    never actually verified.
  const ranged = audit({ pin: "^1.0.0", mirror: "^1.0.0", resolution: "2.0.0" });
  assert.deepEqual(ranged.problems, []);
  assert.equal(ranged.checked.length, 0);

  // 7. A URL or git spec is a range's cousin here: wrangler and timbrado are
  //    both pinned that way in this repo and neither has a number to compare.
  const url = audit({ pin: "https://pkg.pr.new/cloudflare/workers-sdk/wrangler@b168333", mirror: "x", resolution: "1.0.0" });
  assert.deepEqual(url.problems, []);
  assert.equal(url.checked.length, 0);

  // 8. `overrides` is a pin too, and its drift is silent in exactly the same
  //    way. bun records it at the lockfile's TOP LEVEL rather than per
  //    workspace, so it needs its own mirror lookup and gets its own cases.
  const over = audit({
    pin: "1.2.3", mirror: "1.2.3", resolution: "1.2.3",
    overrides: { sharp: "0.35.4" }, lockOverrides: { sharp: "0.35.4" },
  });
  assert.deepEqual(over.problems, [], over.problems.join("\n"));
  assert.equal(over.checked.length, 2, "the override must be counted as a checked pin");

  // 8b. the override's MIRROR alone is stale.
  const overMirror = audit({
    pin: "1.2.3", mirror: "1.2.3", resolution: "1.2.3",
    overrides: { sharp: "0.35.4" }, lockOverrides: { sharp: "0.35.5" }, resolutions: { sharp: "0.35.4" },
  }).problems;
  assert.equal(overMirror.length, 1, overMirror.join("\n"));
  assert.match(overMirror[0], /overrides\.sharp at 0\.35\.4 but bun\.lock overrides mirrors "0\.35\.5"/);

  // 8c. the override's RESOLUTION alone is ahead — the silent half, on the one
  //     declaration that reaches every transitive consumer of the package.
  const overResolved = audit({
    pin: "1.2.3", mirror: "1.2.3", resolution: "1.2.3",
    overrides: { sharp: "0.35.4" }, lockOverrides: { sharp: "0.35.4" }, resolutions: { sharp: "0.35.5" },
  }).problems;
  assert.equal(overResolved.length, 1, overResolved.join("\n"));
  assert.match(overResolved[0], /pins sharp at 0\.35\.4 and bun\.lock RESOLVES 0\.35\.5/);

  // 9. One resolution is one fact. htmlparser2 is both a dependency and an
  //    override in lens-reader, and reporting its drift twice would read as two
  //    problems where there is one.
  const twice = audit({
    name: "htmlparser2", pin: "12.0.0", mirror: "12.0.0", resolution: "11.0.0",
    overrides: { htmlparser2: "12.0.0" }, lockOverrides: { htmlparser2: "12.0.0" },
  }).problems;
  assert.equal(twice.length, 1, twice.join("\n"));
  assert.match(twice[0], /RESOLVES 11\.0\.0/);

  // 10. The floor is a scanner-broke tripwire and must fire on its own.
  const floored = auditLockfilePins({ ...fixture({ pin: "1.2.3", mirror: "1.2.3", resolution: "1.2.3" }), floor: 5 });
  assert.equal(floored.problems.length, 1, floored.problems.join("\n"));
  assert.match(floored.problems[0], /below the floor of 5/);
});
