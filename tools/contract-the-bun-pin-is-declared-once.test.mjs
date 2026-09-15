// ── the bun pin is declared once ─────────────────────────────────────────────
// Shared imports live in contract-shared.mjs.
import { ROOT, assert, readFile, test } from "./contract-shared.ts";

import { channelOf, compareVersions, interpretZstdProbe, minimumReleaseAgeSeconds, npmPlatform, npmTarballUrl, npmVersion, parseVersion, readPin, releaseAsset, releaseUrl, runningMatchesPin, writePin } from "./lib/bun-pin.ts";
import { fileURLToPath } from "node:url";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = fileURLToPath(ROOT);

// `packageManager` is the one dependency version here that no updater owns, and
// the one that compiles the site: wrangler.jsonc builds with `bun
// tools/build.ts`, so it decides every content-addressed /a/ and /i/ URL. Three
// readers share it and none may carry a copy.

test("the pin lib reads the same string package.json holds", async () => {
  const text = await readFile(new URL("package.json", ROOT), "utf8");
  const pkg = JSON.parse(text);
  const pin = readPin(root);
  assert.equal(pin.raw, pkg.packageManager);
  // A release or a DATED canary, and nothing looser: both are exact and both
  // are immutable on npm, which is what makes either one a pin.
  assert.match(pin.version, /^\d+\.\d+\.\d+(-canary\.\d{8}\.\d+\+[0-9a-f]{7,40})?$/);
  if (channelOf(pin.version) === "canary") assert.ok(parseVersion(pin.version).sha, "a canary pin must carry the build sha the running bun proves itself by");
  assert.ok(["stable", "canary"].includes(channelOf(pin.version)));
});

test("writePin edits one field and reflows nothing else", async () => {
  // A JSON round trip would pass this test's letter and destroy the file: five
  // `comment:` keys in package.json carry paragraphs that re-serializing folds
  // into one line each. So the assertion is on the BYTES either side of the pin
  // rather than on a parsed object.
  //
  // It runs against a COPY, and that is a fix rather than a preference. This used
  // to write the REAL package.json and restore it in a `finally`, which is safe
  // in one process and is not what happens: `node --test` runs test FILES in
  // parallel processes, and `writeFileSync` truncates before it writes. So for
  // the width of two writes, every other file's module resolution could read a
  // half-written package.json, and Node answers that with
  // ERR_INVALID_PACKAGE_CONFIG naming the repo root.
  //
  // It is a RACE, so it passed locally for months and failed in CI under load,
  // on an unrelated test file, while this one reported green. `writePin` already
  // took its root as an argument, so the copy costs nothing.
  const before = await readFile(new URL("package.json", ROOT), "utf8");
  const pin = readPin(root);
  const dir = await mkdtemp(join(tmpdir(), "bun-pin-"));
  try {
    await writeFile(join(dir, "package.json"), before);
    writePin(dir, "9.9.9");
    const after = await readFile(join(dir, "package.json"), "utf8");
    assert.equal(readPin(dir).version, "9.9.9");
    assert.equal(
      after.replace('"packageManager": "bun@9.9.9"', `"packageManager": "${pin.raw}"`),
      before,
      "writePin changed something other than the version",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  // The real file is what the race was about, so assert it was never touched.
  assert.equal(await readFile(new URL("package.json", ROOT), "utf8"), before, "the live package.json was modified");
});

test("the zstd capability probe is declared once", async () => {
  // Two copies of one measurement agree on the day they are written and rot
  // separately after, which is the argument lib/mcp-protocol.ts already won for
  // MCP_SUPPORTED. This probe is worse than most to duplicate, because what it
  // detects is SILENT: a runtime that accepts `dictionary` and ignores it emits
  // plain zstd that still decodes, so a stale copy reports a pass.
  const lib = await readFile(new URL("tools/lib/bun-pin.ts", ROOT), "utf8");
  assert.match(lib, /zstdCompressSync/, "lib/bun-pin.ts is supposed to be the one that holds the probe");

  // ONE consumer today, and the list stays a list. check-bun.ts was the second
  // until it was retired on 2026-08-24, and the next runtime control to want
  // this probe should join this array rather than paste the three compressions.
  for (const file of ["tools/bump-bun-pin.ts"]) {
    const body = await readFile(new URL(file, ROOT), "utf8");
    // CODE, not mention. These files EXPLAIN the probe in prose, and the first
    // draft of this assertion read `zstdCompressSync({ dictionary })` out of a
    // header comment and failed on it. Same shape as the
    // workflow test stripping `echo` lines, and as every other naive scanner
    // this repo has had to sharpen: searching source text for a token finds the
    // paragraph describing it too.
    const code = body.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
    assert.ok(
      !/const\s+PROBE\s*=|zstdCompressSync\(/.test(code),
      `${file} re-declares the zstd probe instead of importing ZSTD_DICTIONARY_PROBE`,
    );
    assert.match(body, /from "\.\/lib\/bun-pin\.ts"/, `${file} must import the shared pin lib`);
  }

  // The teeth: the stripper must not be so eager that it would miss a real
  // re-declaration sitting in code.
  const sample = ['// zstdCompressSync({ dictionary }) in prose', 'const PROBE = zstdCompressSync(x);'].join("\n");
  const stripped = sample.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
  assert.match(stripped, /const\s+PROBE\s*=/, "the comment stripper ate a real declaration");
});

test("the probe reader calls the silent case correctly", async () => {
  // The teeth. A reader that returned `honoured: true` for the collapsed shape
  // would pass every real run and wave through exactly the runtime this exists
  // to refuse, so both shapes are asserted rather than only the good one.
  assert.equal(interpretZstdProbe('{"none":73,"good":24,"wrong":73}').honoured, true);
  assert.equal(interpretZstdProbe('{"none":73,"good":73,"wrong":73}').honoured, false, "the collapse must read as NOT honoured");
  assert.equal(interpretZstdProbe("not json").honoured, null, "a probe that never ran is neither honoured nor refused");
});

test("versions compare numerically, so 1.10 is newer than 1.4, and canaries order by date under their release", () => {
  // The one comparison a string sort gets wrong, and bun will reach 1.10.
  assert.equal(compareVersions("1.10.0", "1.4.0"), 1);
  assert.equal(compareVersions("1.4.0", "1.4.0"), 0);
  assert.equal(compareVersions("1.3.14", "1.4.0"), -1);
  assert.equal(compareVersions("2.0.0", "1.99.99"), 1);
  // npm names the canaries of the unreleased 1.4.3 `1.4.2-canary.<date>`, so a
  // release outranks its own canaries and two canaries compare by date, then build.
  assert.equal(compareVersions("1.4.2-canary.20260914.1", "1.4.2-canary.20260913.1"), 1);
  assert.equal(compareVersions("1.4.2-canary.20260913.2", "1.4.2-canary.20260913.1"), 1);
  assert.equal(compareVersions("1.4.2-canary.20260913.1", "1.4.2-canary.20260913.1"), 0);
  assert.equal(compareVersions("1.4.2-canary.20260914.1", "1.4.2"), -1);
  assert.equal(compareVersions("1.4.3-canary.20260920.1", "1.4.2-canary.20260914.1"), 1);
  assert.throws(() => compareVersions("1.4", "1.4.0"), /not a bun version/);
  assert.throws(() => compareVersions("1.4.2-beta.1", "1.4.2"), /not a bun version/, "only dated canaries are a channel here");
});

test("the channel is the pin's own shape, and the npm tarball names the platform package", () => {
  assert.equal(channelOf("1.4.2"), "stable");
  assert.equal(channelOf("1.4.2-canary.20260913.1"), "canary");
  assert.equal(channelOf("1.4.2-canary.20260913.1+09bb546"), "canary");
  assert.deepEqual(parseVersion("1.4.2-canary.20260913.1").canary, [20260913, 1]);
  assert.equal(parseVersion("1.4.2-canary.20260913.1+09bb546").sha, "09bb546");
  assert.equal(parseVersion("1.4.2").canary, null);
  assert.equal(npmVersion("1.4.2-canary.20260913.1+09bb546"), "1.4.2-canary.20260913.1");
  assert.equal(compareVersions("1.4.2-canary.20260913.1+09bb546", "1.4.2-canary.20260913.1"), 0, "the sha is identity, never order");
  // The baseline guard: a release by version, a canary by revision, because a
  // canary binary reports the NEXT release as its version (1.4.3 for a
  // 1.4.2-canary tarball, measured 2026-09-14).
  assert.equal(runningMatchesPin("1.4.2", { version: "1.4.2", revision: "744846f8" }).ok, true);
  assert.equal(runningMatchesPin("1.4.2", { version: "1.4.3", revision: "09bb5463" }).ok, false);
  assert.equal(runningMatchesPin("1.4.2-canary.20260913.1+09bb546", { version: "1.4.3", revision: "09bb5463058074ef" }).ok, true);
  assert.equal(runningMatchesPin("1.4.2-canary.20260913.1+09bb546", { version: "1.4.3", revision: "5fce36e1" }).ok, false);
  assert.equal(runningMatchesPin("1.4.2-canary.20260913.1", { version: "1.4.3", revision: "09bb5463" }).ok, false, "a canary pin without its sha proves nothing");
  assert.equal(npmPlatform("linux", "x64"), "bun-linux-x64");
  assert.equal(npmPlatform("darwin", "arm64"), "bun-darwin-aarch64");
  assert.equal(
    npmTarballUrl("1.4.2-canary.20260913.1", "bun-linux-x64"),
    "https://registry.npmjs.org/@oven/bun-linux-x64/-/bun-linux-x64-1.4.2-canary.20260913.1.tgz",
  );
  // ONE installer, shared by the CI action and the Workers Builds wrapper, so
  // the two cannot name different tarballs or verify different things for one
  // pin. Two copies is how the CI side grew canary support the deploy side
  // never saw (2026-09-15).
  return Promise.all([
    readFile(new URL(".github/install-bun.sh", ROOT), "utf8"),
    readFile(new URL(".github/actions/setup-bun/action.yml", ROOT), "utf8"),
    readFile(new URL(".github/deploy-wrangler.sh", ROOT), "utf8"),
  ]).then(([installer, action, wrapper]) => {
    assert.match(installer, /packageManager/, "the installer must read the pin from packageManager");
    assert.match(installer, /registry\.npmjs\.org\/@oven\/\$\{platform\}\//, "the installer must fetch from the npm platform package");
    assert.match(installer, /integrity/, "the installer must verify the registry's sha512");
    assert.match(installer, /package\/package\.json/, "the installer must read the tarball's own version, since a canary binary reports the next release");
    assert.match(installer, /--revision/, "the installer must check the binary's revision against the pin's sha");
    for (const [name, body] of [["setup-bun", action], ["deploy-wrangler.sh", wrapper]]) {
      assert.match(body, /bash \.github\/install-bun\.sh /, `${name} must install through the shared installer`);
      assert.doesNotMatch(body, /registry\.npmjs\.org|releases\/download/, `${name} must not carry its own download path`);
    }
    assert.match(wrapper, /bun install --frozen-lockfile/, "the wrapper must lay out node_modules itself, since SKIP_DEPENDENCY_INSTALL turns the image's install off");
  });
});

test("the release-age window is read from bunfig rather than restated", async () => {
  const bunfig = await readFile(new URL("bunfig.toml", ROOT), "utf8");
  const match = /^\s*minimumReleaseAge\s*=\s*(\d+)/m.exec(bunfig);
  assert.ok(match, "bunfig.toml declares no minimumReleaseAge");
  const declared = Number(match[1]);
  assert.equal(minimumReleaseAgeSeconds(root), declared);

  // UNIT TRAP, and the reason this is asserted at all: pnpm counted MINUTES and
  // bun counts SECONDS, so a faithful-looking port of the same number cuts a
  // 24-hour window to 24 minutes. Anything under an hour is that mistake.
  assert.ok(declared >= 3600, `minimumReleaseAge is ${declared}s, which is the minutes-versus-seconds trap`);

  const bumper = await readFile(new URL("tools/bump-bun-pin.ts", ROOT), "utf8");
  assert.ok(
    !new RegExp(`\\b${declared}\\b`).test(bumper),
    "bump-bun-pin.ts hardcodes the window instead of reading bunfig.toml",
  );
});

test("the bumper walks the pin's channel and never crosses it", async () => {
  const body = await readFile(new URL("tools/bump-bun-pin.ts", ROOT), "utf8");
  // STABLE: `releases/latest` skips drafts and prereleases, so the rolling
  // `canary` tag can never become a release-channel target.
  assert.match(body, /releases\/latest/, "the stable target must come from releases/latest, which excludes prereleases");
  assert.match(body, /\^bun-v\(\\d\+\\\.\\d\+\\\.\\d\+\)\$/, "the tag must be matched as a plain bun-vX.Y.Z");
  // CANARY: npm's dist-tag names a DATED, immutable canary, which is the only
  // shape of canary that can be a pin.
  assert.match(body, /\["dist-tags"\]\?\.canary/, "the canary target must come from npm's canary dist-tag");
  assert.match(body, /channelOf\(target\) !== channel/, "a target on the other channel must be refused");
  assert.match(body, /npmBunDist\(npmVersion\(target\)\)/, "a canary must be fetched with the registry's integrity, by the version npm names");

  // The baseline guard. Without it a stale bun on PATH compares the candidate
  // against a third runtime and reports a byte-identical build that says nothing
  // about what production ships. check-bun.ts refused the mirror image of this
  // (being invoked through bun, which would have compared bun with bun) and the
  // assertion moved here when it was retired.
  assert.match(body, /baselineVersion !== pin\.version/, "the bumper must refuse a baseline that is not the pin");
});

test("the release asset names match what oven-sh/bun tags", () => {
  assert.equal(releaseAsset("linux", "x64"), "bun-linux-x64.zip");
  assert.equal(releaseAsset("darwin", "arm64"), "bun-darwin-aarch64.zip");
  assert.throws(() => releaseAsset("sunos", "sparc"), /no bun release asset known/); // a platform pair bun has no asset for
  assert.equal(
    releaseUrl("1.4.0", "bun-linux-x64.zip"),
    "https://github.com/oven-sh/bun/releases/download/bun-v1.4.0/bun-linux-x64.zip",
  );
});
