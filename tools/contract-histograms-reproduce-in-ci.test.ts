// ── the histogram digest leaves zenc out because CI reproduces the output ────
// Shared imports live in contract-shared.mjs.
import { ROOT, assert, readFile, test } from "./contract-shared.ts";
import { compareIndexes, controlCatchesOneBin, reproduces } from "./photos/check-histograms.ts";

// images/histograms used to hash zenc's histogram.rs, pixels.rs and Cargo.lock,
// so every zenc dependency bump read STALE and was cleared by a hand re-bake and
// --lock (#871, #985, both 258 of 258 identical). Those inputs left the digest
// because `bun run histograms:check` re-bakes the library in CI and compares the
// OUTPUT. The two halves only make sense together: the declaration may drop a
// tool input only while a CI job measures what that tool produces. This test
// fails if either half goes without the other.

const TOOL_INPUTS = ["tools/photos/zenc/src/histogram.rs", "tools/photos/zenc/src/pixels.rs", "tools/photos/zenc/Cargo.lock"];

test("histograms: a declaration without zenc's sources has a CI job reproducing the output", async () => {
  const decl = JSON.parse(await readFile(new URL("config/derivations.json", ROOT), "utf8"));
  const d = decl.derivations.find((x) => x.id === "images/histograms");
  assert.ok(d, "images/histograms is no longer declared");
  assert.ok(d.inputs.paths.includes("public/i"), "public/i left the digest, so a re-encode that skips the bake would pass with no cargo");

  const dropped = TOOL_INPUTS.filter((p) => !d.inputs.paths.includes(p));
  if (!dropped.length) return; // back on the digest: covered the old way, nothing to require

  // photos.yml since 2026-09-28, which runs only when photo code or tiers
  // move. That is exactly when this output can change.
  const job = await readFile(new URL(".github/workflows/photos.yml", ROOT), "utf8");
  assert.match(job, /name: native photo validation/, "could not find the native photo validation job in photos.yml");
  assert.match(job, /- "tools\/photos\/\*\*"/, "photos.yml must run when zenc or its lockfile moves");
  assert.match(job, /run: bun run histograms:check/, `${dropped.join(", ")} left the digest but native photo validation no longer reproduces the histograms`);
  assert.match(job, /uses: \.\/\.github\/actions\/setup-bun/, "the native job runs a bun script without setting up bun");

  const pkg = JSON.parse(await readFile(new URL("package.json", ROOT), "utf8"));
  assert.equal(pkg.scripts["histograms:check"], "bun tools/photos/check-histograms.ts");
});

test("histograms: the comparison names drift in both directions, and its control has teeth", () => {
  const committed = { a: "?".repeat(256), b: "@".repeat(256), c: "A".repeat(256) };

  const same = compareIndexes(committed, { ...committed });
  assert.ok(reproduces(same));
  assert.equal(same.same, 3);

  const moved = compareIndexes(committed, { a: committed.a, b: `${"@".repeat(255)}A`, d: "B".repeat(256) });
  assert.deepEqual(moved.changed, ["b"]);
  assert.deepEqual(moved.missing, ["c"]);
  assert.deepEqual(moved.extra, ["d"]);
  assert.ok(!reproduces(moved));

  // Two empty indexes agree, which is the pass a broken bake would produce. The
  // floor in check-histograms.ts stops the empty COMMITTED side; the control
  // stops a comparator that cannot see a one-level change.
  assert.ok(reproduces(compareIndexes({}, {})), "the control below is what makes this harmless");
  assert.ok(!controlCatchesOneBin({}), "an empty index must fail the control");
  assert.ok(controlCatchesOneBin(committed));
  assert.ok(controlCatchesOneBin({ z: "~".repeat(256) }), "the top of the alphabet must nudge down, not off the end");
});
