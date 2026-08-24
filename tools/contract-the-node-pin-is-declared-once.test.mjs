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

test("the engines floor agrees with the pin and with the build's own tripwire", async () => {
  const raw = await readFile(new URL(".node-version", ROOT), "utf8");
  const pinned = Number(raw.trim());
  const pkg = JSON.parse(await readFile(new URL("package.json", ROOT), "utf8"));
  const floorMatch = /(\d+)/.exec(pkg.engines.node);
  assert.ok(floorMatch, `engines.node is ${pkg.engines.node}, which names no version`);
  const floor = Number(floorMatch[1]);

  assert.ok(floor <= pinned, `engines.node floors at ${floor} while .node-version pins ${pinned}`);

  // THE FLOOR IS A MEASURED NUMBER, not a guess, and it is the zstd
  // `dictionary` option that sets it. Measured 2026-08-24 on darwin-arm64 with
  // one 8800-byte buffer compressed against itself at level 19:
  //
  //   v23.11.1   63 none / 63 dict   ignores it, silently
  //   v24.19.0   63 none / 19 dict   honours it
  //   v26.7.0    63 none / 19 dict   honours it
  //
  // build.ts throws on that collapse failing, and its message names the floor.
  // Both numbers are the same fact, so a change to one must move the other; the
  // failure otherwise is a build that dies quoting a version nobody supports.
  const build = await readFile(new URL("tools/build.ts", ROOT), "utf8");
  assert.match(
    build,
    new RegExp(`Node ${floor}\\+ is required`),
    `build.ts's zstd tripwire does not name Node ${floor}+, which is what engines.node floors at`,
  );
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
