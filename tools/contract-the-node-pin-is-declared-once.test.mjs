// ── the node pin is declared once ────────────────────────────────────────────
// Shared imports live in contract-shared.mjs.
import { ROOT, assert, readFile, readdir, test } from "./contract-shared.ts";

// The tree tier of `node:pin`. It lives here rather than in that script so
// `validate` already runs it, and because none of it needs the network: these
// are facts about this repository, while the support window is a fact about
// node and is fetched.

test(".node-version holds a bare major, which is why there is no bumper", async () => {
  const raw = await readFile(new URL(".node-version", ROOT), "utf8");
  assert.match(raw, /^\d+\n$/, `.node-version is ${JSON.stringify(raw)}; it must be a bare major and a newline`);

  // A BARE MAJOR IS THE WHOLE REASON THIS NEEDS NO UPDATER, so it is asserted
  // rather than left as a habit. `actions/setup-node` resolves the newest
  // release of whatever this names, so a major keeps every patch and minor
  // current on its own. Pin `26.7.0` here and that stops being true silently:
  // CI would install one exact node forever, security patches included, and
  // nothing would report it, because a pinned version is not a broken one.
  assert.doesNotMatch(raw, /\./, ".node-version names a minor or patch, which freezes the runtime at one release");
});

test("the engines floor sits between the zstd floor and the pin", async () => {
  const raw = await readFile(new URL(".node-version", ROOT), "utf8");
  const pinned = Number(raw.trim());
  const pkg = JSON.parse(await readFile(new URL("package.json", ROOT), "utf8"));
  const floorMatch = /(\d+)/.exec(pkg.engines.node);
  assert.ok(floorMatch, `engines.node is ${pkg.engines.node}, which names no version`);
  const floor = Number(floorMatch[1]);

  // TWO FLOORS, and welding them into one is what this test used to do wrong.
  // Until 2026-08-31 it asserted that build.ts's zstd tripwire named the
  // engines.node floor, on the reasoning that the zstd `dictionary` option was
  // what set the repository's floor. That was true when it was written and
  // stopped being true silently, because a floor is the MAXIMUM of every
  // constraint and nothing stops a newer one arriving. One had:
  // Map.prototype.getOrInsertComputed reached node in 26 and is used in three
  // Worker modules, so package.json claimed 24 while the suite could not run
  // below 26. Measured 2026-08-31: `typeof Map.prototype.getOrInsertComputed`
  // is undefined on v24.20.0 and v25.4.0, and a function on v26.8.1.
  //
  //   zstd floor      the lowest node that HONOURS zlib's dictionary option
  //   engines.node    the highest node any constraint here demands
  //   .node-version   what CI actually installs
  //
  // They are ordered, never equal by rule, and each moves for its own reason.
  const build = await readFile(new URL("tools/build.ts", ROOT), "utf8");
  const zstdMatch = /ZSTD_DICTIONARY_NODE_FLOOR = (\d+)/.exec(build);
  assert.ok(zstdMatch, "tools/build.ts declares no ZSTD_DICTIONARY_NODE_FLOOR");
  const zstdFloor = Number(zstdMatch[1]);

  assert.ok(zstdFloor <= floor,
    `engines.node floors at ${floor}, below the zstd dictionary floor of ${zstdFloor}; the build would throw on a runtime this repo says it supports`);
  assert.ok(floor <= pinned,
    `engines.node floors at ${floor} while .node-version pins ${pinned}`);

  // The tripwire must INTERPOLATE its own constant rather than repeat the
  // number. A literal is how the old weld failed in the first place: two copies
  // of one fact, and only a test standing between them. With the constant
  // interpolated there is one copy, and this assertion is what stops somebody
  // hardcoding it back.
  assert.match(build, /Node \$\{ZSTD_DICTIONARY_NODE_FLOOR\}\+ is required/,
    "build.ts's zstd tripwire hardcodes a version instead of interpolating ZSTD_DICTIONARY_NODE_FLOOR");
});

test("every workflow reads .node-version rather than naming a version", async () => {
  // Same rule as setup-bun, and the same reason: a second declaration drifts
  // from the first, and node here runs wrangler on the path that publishes
  // production. Nothing self-switches, so a workflow on another major runs the
  // deploy tooling under a runtime nobody declared.
  const dir = new URL(".github/workflows/", ROOT);
  const files = (await readdir(dir)).filter((n) => n.endsWith(".yml"));
  assert.ok(files.length >= 5, `expected the workflow set, found ${files.length}`);

  let checked = 0;
  for (const file of files) {
    const body = await readFile(new URL(file, dir), "utf8");
    if (!/uses: actions\/setup-node@/.test(body)) continue;
    assert.match(body, /node-version-file: \.node-version/,
      `.github/workflows/${file} sets up node without reading .node-version`);
    assert.ok(!/^\s*node-version: *['"]?\d/m.test(body),
      `.github/workflows/${file} names a node version inline instead of reading .node-version`);
    checked++;
  }
  // A FLOOR, because a scanner that matched nothing would report a pass. Same
  // reason tools:check carries one for each of its guard scanners.
  assert.ok(checked >= 5, `expected several setup-node steps, matched ${checked}`);
});

test("node:pin refuses to double as a bumper", async () => {
  const body = await readFile(new URL("tools/check-node-pin.ts", ROOT), "utf8");

  // It must never WRITE the pin. A major move is a policy call (node ships one
  // every April and October and half of them never reach LTS), so the tool's
  // job ends at saying a decision is due. This is the assertion that stops
  // somebody adding `--write` by analogy with bun:pin, whose pin is an exact
  // version that nothing else updates.
  assert.ok(!/writeFileSync|--write/.test(body), "check-node-pin.ts writes something; it must only report");

  // The move it names must be an ACTIVE LTS major rather than the newest one.
  // Reaching for the newest is how a repository ends up on the Current line by
  // accident, which is a shorter support tail and breaking changes twice a year.
  assert.match(body, /phaseOf\(v\) === "active-lts"/, "the suggested move must be filtered to Active LTS");

  // The schedule is fetched from nodejs/Release rather than copied in here. A
  // local copy of a table of dates is the exact staleness this check exists to
  // catch, one level up.
  assert.match(body, /nodejs\/Release\/main\/schedule\.json/, "the dates must come from node's own schedule");
});
