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

/** @param {ReturnType<typeof readLockfilePins>} lockfiles */
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
    ["cal/package.json", "cf-garage/package.json", "config/dev/package.json", "lwe-ask/package.json", "package.json", "serendipity/package.json"],
    "the root lockfile's workspace set moved; the manifests come from the lockfile itself, so this is a real change",
  );
  for (const { manifests } of lockfiles) {
    for (const m of manifests) assert.ok(m.pkg && typeof m.pkg === "object", `${m.manifest} did not parse`);
  }
});

test("perturbing one real resolution turns the live check red", () => {
  const lockfiles = readLockfilePins();
  const { packages, devDependencies } = rootOf(lockfiles);

  const target = auditLockfilePins({ lockfiles }).checked
    .find((c) => c.lock === "bun.lock" && c.field === "devDependencies");
  if (!target) throw new Error("the walk checked no root devDependency");
  const entry = packages[target.name];
  if (!Array.isArray(entry)) throw new Error(`bun.lock resolves nothing for ${target.name}`);

  const pin = devDependencies[target.name];
  const moved = pin === "9.9.9" ? "8.8.8" : "9.9.9";
  packages[target.name] = [`${target.name}@${moved}`, ...entry.slice(1)];

  const { problems } = auditLockfilePins({ lockfiles });
  assert.equal(problems.length, 1, problems.join("\n"));
  assert.ok(
    problems[0].includes(`pins ${target.name} at ${pin} and bun.lock RESOLVES ${moved}`),
    problems[0],
  );
});

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
  for (const [k, v] of Object.entries(resolutions ?? overrides ?? {})) packages[k] = resolutionEntry(k, v);
  if (head !== undefined) packages[name] = head;
  else if (resolution !== undefined) packages[name] = resolutionEntry(name, resolution);
  const parsed = { workspaces: { "": ws }, packages };
  if (lockOverrides) parsed.overrides = lockOverrides;
  return { lockfiles: [{ lock: "bun.lock", parsed, manifests: [{ manifest: "package.json", wsKey: "", pkg }] }], floor: 0 };
}
const audit = (opts) => auditLockfilePins(fixture(opts));

test("the lockfile-pin check catches every drift it exists for", () => {
  assert.deepEqual(audit({ pin: "1.2.3", mirror: "1.2.3", resolution: "1.2.3" }).problems, []);

  const ahead = audit({ pin: "0.150.0", mirror: "0.150.0", resolution: "0.151.0" }).problems;
  assert.equal(ahead.length, 1, ahead.join("\n"));
  assert.match(ahead[0], /pins widget at 0\.150\.0 and bun\.lock RESOLVES 0\.151\.0/);
  assert.match(ahead[0], /bun update widget/, "the message must name the one command that repairs it");

  const mirrored = audit({ pin: "0.150.0", mirror: "0.151.0", resolution: "0.150.0" }).problems;
  assert.equal(mirrored.length, 1, mirrored.join("\n"));
  assert.match(mirrored[0], /mirrors "0\.151\.0"/);

  const bothWrong = audit({ pin: "0.150.0", mirror: "0.151.0", resolution: "0.151.0" }).problems;
  assert.equal(bothWrong.length, 2, bothWrong.join("\n"));
  assert.ok(bothWrong.some((p) => /mirrors "0\.151\.0"/.test(p)));
  assert.ok(bothWrong.some((p) => /RESOLVES 0\.151\.0/.test(p)));

  const unmirrored = audit({ pin: "1.2.3", resolution: "1.2.3" }).problems;
  assert.equal(unmirrored.length, 1, unmirrored.join("\n"));
  assert.match(unmirrored[0], /does not record it/);

  const unresolved = audit({ pin: "1.2.3", mirror: "1.2.3" }).problems;
  assert.equal(unresolved.length, 1, unresolved.join("\n"));
  assert.match(unresolved[0], /resolves no package by that name/);

  const weird = audit({ pin: "1.2.3", mirror: "1.2.3", head: ["something-else@1.2.3", "", {}, "sha512-x"] }).problems;
  assert.equal(weird.length, 1, weird.join("\n"));
  assert.match(weird[0], /not a `widget@<version>` entry/);

  const ranged = audit({ pin: "^1.0.0", mirror: "^1.0.0", resolution: "2.0.0" });
  assert.deepEqual(ranged.problems, []);
  assert.equal(ranged.checked.length, 0);

  const url = audit({ pin: "https://pkg.pr.new/cloudflare/workers-sdk/wrangler@b168333", mirror: "x", resolution: "1.0.0" });
  assert.deepEqual(url.problems, []);
  assert.equal(url.checked.length, 0);

  const over = audit({
    pin: "1.2.3", mirror: "1.2.3", resolution: "1.2.3",
    overrides: { sharp: "0.35.4" }, lockOverrides: { sharp: "0.35.4" },
  });
  assert.deepEqual(over.problems, [], over.problems.join("\n"));
  assert.equal(over.checked.length, 2, "the override must be counted as a checked pin");

  const overMirror = audit({
    pin: "1.2.3", mirror: "1.2.3", resolution: "1.2.3",
    overrides: { sharp: "0.35.4" }, lockOverrides: { sharp: "0.35.5" }, resolutions: { sharp: "0.35.4" },
  }).problems;
  assert.equal(overMirror.length, 1, overMirror.join("\n"));
  assert.match(overMirror[0], /overrides\.sharp at 0\.35\.4 but bun\.lock overrides mirrors "0\.35\.5"/);

  const overResolved = audit({
    pin: "1.2.3", mirror: "1.2.3", resolution: "1.2.3",
    overrides: { sharp: "0.35.4" }, lockOverrides: { sharp: "0.35.4" }, resolutions: { sharp: "0.35.5" },
  }).problems;
  assert.equal(overResolved.length, 1, overResolved.join("\n"));
  assert.match(overResolved[0], /pins sharp at 0\.35\.4 and bun\.lock RESOLVES 0\.35\.5/);

  const twice = audit({
    name: "htmlparser2", pin: "12.0.0", mirror: "12.0.0", resolution: "11.0.0",
    overrides: { htmlparser2: "12.0.0" }, lockOverrides: { htmlparser2: "12.0.0" },
  }).problems;
  assert.equal(twice.length, 1, twice.join("\n"));
  assert.match(twice[0], /RESOLVES 11\.0\.0/);

  const floored = auditLockfilePins({ ...fixture({ pin: "1.2.3", mirror: "1.2.3", resolution: "1.2.3" }), floor: 5 });
  assert.equal(floored.problems.length, 1, floored.problems.join("\n"));
  assert.match(floored.problems[0], /below the floor of 5/);
});
